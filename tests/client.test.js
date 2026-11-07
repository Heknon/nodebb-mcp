import test from 'node:test';
import assert from 'node:assert/strict';

import { NodeBBClient } from '../dist/client.js';
import { loadConfig, normalizeUrl, ConfigError } from '../dist/config.js';
import { NodeBBError, isTransient } from '../dist/errors.js';
import { startFakeForum } from './fake-forum.js';

function configFor(url, extra = {}) {
	return loadConfig({ NODEBB_URL: url, ...extra });
}

test('normalizeUrl strips trailing slashes and keeps a subdirectory mount', () => {
	assert.equal(normalizeUrl('https://f.example.com/'), 'https://f.example.com');
	assert.equal(normalizeUrl('https://f.example.com/forum/'), 'https://f.example.com/forum');
});

test('loadConfig rejects a missing or non-http URL', () => {
	assert.throws(() => loadConfig({}), ConfigError);
	assert.throws(() => loadConfig({ NODEBB_URL: 'ftp://x.com' }), ConfigError);
	assert.throws(() => loadConfig({ NODEBB_URL: 'not a url' }), ConfigError);
});

test('loadConfig clamps numeric settings and applies defaults', () => {
	const config = configFor('https://f.example.com', { NODEBB_TIMEOUT_MS: '1' });
	assert.equal(config.timeoutMs, 1000); // clamped up to the floor
	assert.equal(config.shotefNamespace, 'shotef');
	assert.equal(config.maxPostsPerTopic, 50);
	assert.throws(() => configFor('https://f.example.com', { NODEBB_TIMEOUT_MS: 'abc' }), ConfigError);
});

test('read unwraps nothing and v3 unwraps the envelope', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	const client = new NodeBBClient(configFor(forum.url));

	const config = await client.read('/config');
	assert.equal(config.siteTitle, 'Fake Forum');

	// /api/v3/... is wrapped in { status, response } and must come back unwrapped.
	const ping = await client.v3('/plugins/shotef/ping');
	assert.equal(ping.ok, 1);
	assert.equal(ping.status, undefined);
});

test('a bearer token is sent when configured, and the forum acts as its user', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());

	const authed = new NodeBBClient(configFor(forum.url, { NODEBB_API_TOKEN: 'maintainer-token' }));
	const config = await authed.read('/config');
	assert.equal(forum.requests.at(-1).auth, 'Bearer maintainer-token');
	assert.equal(config.uid, 8);

	// NodeBB does not reject an unknown token: the request quietly runs as a guest.
	const wrong = new NodeBBClient(configFor(forum.url, { NODEBB_API_TOKEN: 'not-a-token' }));
	const asGuest = await wrong.read('/config');
	assert.equal(asGuest.uid, 0);
});

test('NODEBB_UID is sent as _uid, satisfying a master token', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());

	const withoutUid = new NodeBBClient(configFor(forum.url, { NODEBB_API_TOKEN: 'master-token' }));
	// The Write API explains; the Read API just fails with a 500.
	await assert.rejects(() => withoutUid.v3('/ping'), (err) => {
		assert.equal(err.kind, 'bad-request');
		assert.match(err.forumMessage, /master token was received without/);
		return true;
	});
	await assert.rejects(() => withoutUid.read('/config'), /HTTP 500/);

	const withUid = new NodeBBClient(configFor(forum.url, { NODEBB_API_TOKEN: 'master-token', NODEBB_UID: '1' }));
	const config = await withUid.read('/config');
	assert.equal(forum.requests.at(-1).query._uid, '1');
	assert.equal(config.uid, 1);
});

test('array query params are sent in NodeBB bracket form', async (t) => {
	const forum = await startFakeForum({ guestSearch: true });
	t.after(() => forum.close());
	const client = new NodeBBClient(configFor(forum.url));

	await client.read('/search', { term: 'redis', categories: ['3', '4'], searchOnly: 1 });
	const last = forum.requests.at(-1);
	assert.equal(last.query['categories[]'], '4'); // last wins in a flat map; both were sent
	assert.equal(last.query.term, 'redis');
});

test('a guest write fails CSRF with a plain-text 403, mapped to an auth failure', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	const client = new NodeBBClient(configFor(forum.url));
	await assert.rejects(() => client.write('POST', '/topics', { cid: 1, title: 'x', content: 'y' }), (err) => {
		assert.equal(err.kind, 'auth');
		assert.equal(err.status, 403);
		return true;
	});
});

test('an HTML 404 maps to not-found, and allowNotFound yields undefined', async (t) => {
	const forum = await startFakeForum({ plugins: { search: false } });
	t.after(() => forum.close());
	const client = new NodeBBClient(configFor(forum.url));

	await assert.rejects(() => client.read('/search', { term: 'x' }), (err) => {
		assert.equal(err.kind, 'not-found');
		return true;
	});

	const soft = await client.request('/api/search', { allowNotFound: true });
	assert.equal(soft, undefined);
});

test('an unreachable host is a network failure, not a crash', async () => {
	// Port 1 on loopback refuses connections immediately.
	const client = new NodeBBClient(configFor('http://127.0.0.1:1'));
	await assert.rejects(() => client.read('/config'), (err) => {
		assert.ok(err instanceof NodeBBError);
		assert.equal(err.kind, 'network');
		assert.ok(isTransient(err));
		assert.match(err.hint, /NODEBB_URL/);
		return true;
	});
});

test('a failure names the address tried and why', async () => {
	const client = new NodeBBClient(configFor('http://127.0.0.1:1'));
	await assert.rejects(() => client.read('/config'), (err) => {
		assert.match(err.message, /http:\/\/127\.0\.0\.1:1\/api\/config \(.+\)$/);
		return true;
	});
});

test('a loopback address that refuses falls back to the public URL, and stays there', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	const client = new NodeBBClient({ ...configFor(forum.url), apiUrl: 'http://127.0.0.1:1' });
	assert.equal((await client.read('/config')).siteTitle, 'Fake Forum');
	assert.equal((await client.read('/config')).siteTitle, 'Fake Forum');
});

test('when both addresses fail, the error names the public one', async () => {
	const client = new NodeBBClient({ ...configFor('http://127.0.0.1:2'), apiUrl: 'http://127.0.0.1:1' });
	await assert.rejects(() => client.read('/config'), (err) => {
		assert.equal(err.kind, 'network');
		assert.match(err.message, /127\.0\.0\.1:2\/api\/config/);
		return true;
	});
});

test('link() builds absolute forum URLs', async () => {
	const client = new NodeBBClient(configFor('https://f.example.com/forum'));
	assert.equal(client.link('/topic/10'), 'https://f.example.com/forum/topic/10');
	assert.equal(client.link('topic/10'), 'https://f.example.com/forum/topic/10');
});
