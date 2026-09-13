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
	assert.equal(config.version, '4.4.2');

	// /api/v3/... is wrapped in { status, response } and must come back unwrapped.
	const ping = await client.v3('/plugins/shotef/ping');
	assert.equal(ping.ok, 1);
	assert.equal(ping.status, undefined);
});

test('a bearer token is sent when configured', async (t) => {
	const forum = await startFakeForum({ token: 'secret-token' });
	t.after(() => forum.close());

	const authed = new NodeBBClient(configFor(forum.url, { NODEBB_API_TOKEN: 'secret-token' }));
	await authed.read('/config');
	assert.equal(forum.requests.at(-1).auth, 'Bearer secret-token');

	const anon = new NodeBBClient(configFor(forum.url));
	await assert.rejects(() => anon.read('/config'), (err) => {
		assert.ok(err instanceof NodeBBError);
		assert.equal(err.kind, 'auth');
		assert.match(err.hint, /NODEBB_API_TOKEN/);
		return true;
	});
});

test('NODEBB_UID is sent as _uid, satisfying a master token', async (t) => {
	const forum = await startFakeForum({ requireUid: true });
	t.after(() => forum.close());

	const withoutUid = new NodeBBClient(configFor(forum.url));
	await assert.rejects(() => withoutUid.read('/config'), /master-token-no-uid|HTTP 400/);

	const withUid = new NodeBBClient(configFor(forum.url, { NODEBB_UID: '1' }));
	await withUid.read('/config');
	assert.equal(forum.requests.at(-1).query._uid, '1');
});

test('array query params are sent in NodeBB bracket form', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	const client = new NodeBBClient(configFor(forum.url));

	await client.read('/search', { term: 'redis', categories: ['3', '4'], searchOnly: 1 });
	const last = forum.requests.at(-1);
	assert.equal(last.query['categories[]'], '4'); // last wins in a flat map; both were sent
	assert.equal(last.query.term, 'redis');
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

test('link() builds absolute forum URLs', async () => {
	const client = new NodeBBClient(configFor('https://f.example.com/forum'));
	assert.equal(client.link('/topic/10'), 'https://f.example.com/forum/topic/10');
	assert.equal(client.link('topic/10'), 'https://f.example.com/forum/topic/10');
});
