import test from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../dist/capabilities.js';
import { NodeBBClient } from '../dist/client.js';
import { loadConfig } from '../dist/config.js';
import { startFakeForum } from './fake-forum.js';

function registryFor(url, env = {}) {
	const config = loadConfig({ NODEBB_URL: url, ...env });
	return { registry: new CapabilityRegistry(new NodeBBClient(config), config), config };
}

test('a fully equipped forum reports every feature available', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());

	const { registry } = registryFor(forum.url);
	const caps = await registry.get();

	assert.equal(caps.forum.reachable, true);
	assert.equal(caps.forum.version, '4.4.2');
	assert.equal(caps.forum.title, 'Fake Forum');
	assert.equal(caps.search.state, 'available');
	assert.equal(caps.qna.state, 'available');
	assert.equal(caps.shotef.state, 'available');
});

test('a bare forum reports each optional feature absent, with a reason', async (t) => {
	const forum = await startFakeForum({ plugins: { search: false, qna: false, shotef: false } });
	t.after(() => forum.close());

	const { registry } = registryFor(forum.url);
	const caps = await registry.get();

	assert.equal(caps.forum.reachable, true);
	for (const key of ['search', 'qna', 'shotef']) {
		assert.equal(caps[key].state, 'absent', key);
		assert.ok(caps[key].reason, `${key} must explain itself`);
	}
	assert.match(caps.search.reason, /dbsearch/);
	assert.match(caps.qna.reason, /question-and-answer/);
	assert.match(caps.shotef.reason, /Shotef/);
});

test('features are probed independently', async (t) => {
	const forum = await startFakeForum({ plugins: { search: true, qna: false, shotef: true } });
	t.after(() => forum.close());

	const caps = await registryFor(forum.url).registry.get();
	assert.equal(caps.search.state, 'available');
	assert.equal(caps.qna.state, 'absent');
	assert.equal(caps.shotef.state, 'available');
});

test('an unreachable forum is reported, not thrown, and features stay unknown', async () => {
	const caps = await registryFor('http://127.0.0.1:1').registry.get();
	assert.equal(caps.forum.reachable, false);
	assert.ok(caps.forum.reason);
	assert.equal(caps.search.state, 'unknown');
	assert.equal(caps.qna.state, 'unknown');
	assert.equal(caps.shotef.state, 'unknown');
});

test('results are cached, and force re-probes', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	const { registry } = registryFor(forum.url);

	await registry.get();
	const afterFirst = forum.requests.length;
	await registry.get();
	assert.equal(forum.requests.length, afterFirst, 'second get() must be served from cache');

	await registry.get(true);
	assert.ok(forum.requests.length > afterFirst, 'force must re-probe');
});

test('concurrent probes collapse into one sweep', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	const { registry } = registryFor(forum.url);

	const [a, b, c] = await Promise.all([registry.get(), registry.get(), registry.get()]);
	assert.equal(a.probedAt, b.probedAt);
	assert.equal(b.probedAt, c.probedAt);
	// One sweep is 4 calls: config, search, unsolved, ping.
	assert.equal(forum.requests.length, 4, JSON.stringify(forum.requests.map(r => r.path)));
});

test('invalidate forces the next get to re-probe', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	const { registry } = registryFor(forum.url);

	await registry.get();
	const before = forum.requests.length;
	registry.invalidate();
	await registry.get();
	assert.ok(forum.requests.length > before);
});

test('a token that is rejected marks features forbidden rather than absent', async (t) => {
	const forum = await startFakeForum({ token: 'right-token' });
	t.after(() => forum.close());

	const caps = await registryFor(forum.url, { NODEBB_API_TOKEN: 'wrong-token' }).registry.get();
	// The forum probe itself fails auth, so nothing downstream is claimed.
	assert.equal(caps.forum.reachable, false);
	assert.match(caps.forum.reason, /NODEBB_API_TOKEN/);
});
