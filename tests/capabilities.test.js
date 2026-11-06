import test from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../dist/capabilities.js';
import { NodeBBClient } from '../dist/client.js';
import { loadConfig } from '../dist/config.js';
import { startFakeForum } from './fake-forum.js';
import { connect } from './mcp-harness.js';

function registryFor(url, env = {}) {
	const config = loadConfig({ NODEBB_URL: url, ...env });
	return { registry: new CapabilityRegistry(new NodeBBClient(config), config), config };
}

test('a fully equipped forum reports every feature available, and who we are', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());

	const caps = await registryFor(forum.url, { NODEBB_API_TOKEN: 'admin-token' }).registry.get();

	assert.equal(caps.forum.reachable, true);
	assert.equal(caps.forum.title, 'Fake Forum');
	// NodeBB v4 does not put its version in /api/config; we must not invent one.
	assert.equal(caps.forum.version, undefined);
	assert.equal(caps.forum.authenticated, true);
	assert.equal(caps.forum.uid, 1);
	assert.equal(caps.forum.username, 'admin');
	assert.equal(caps.search.state, 'available');
	assert.equal(caps.qna.state, 'available');
	assert.equal(caps.shotef.state, 'available');
	assert.equal(caps.shotef.warning, undefined);
});

test('a bare forum reports each optional feature absent, with a reason', async (t) => {
	const forum = await startFakeForum({ plugins: { search: false, qna: false, shotef: false } });
	t.after(() => forum.close());

	const caps = await registryFor(forum.url).registry.get();

	assert.equal(caps.forum.reachable, true);
	for (const key of ['search', 'qna', 'shotef']) {
		assert.equal(caps[key].state, 'absent', key);
		assert.ok(caps[key].reason, `${key} must explain itself`);
	}
	assert.match(caps.search.reason, /dbsearch/);
	assert.match(caps.qna.reason, /question-and-answer/);
	assert.match(caps.shotef.reason, /Shotef/);
	// searchEnabled:false in /api/config answers the question without a search call.
	assert.ok(!forum.requests.some(r => r.path === '/api/search'));
});

test('features are probed independently', async (t) => {
	const forum = await startFakeForum({ plugins: { search: true, qna: false, shotef: true } });
	t.after(() => forum.close());

	const caps = await registryFor(forum.url, { NODEBB_API_TOKEN: 'admin-token' }).registry.get();
	assert.equal(caps.search.state, 'available');
	assert.equal(caps.qna.state, 'absent');
	assert.equal(caps.shotef.state, 'available');
});

test('guests are refused search by default, and the reason says why', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());

	const caps = await registryFor(forum.url).registry.get();
	assert.equal(caps.forum.authenticated, false);
	assert.equal(caps.search.state, 'forbidden');
	assert.match(caps.search.reason, /guests lack the search:content privilege/);
	assert.match(caps.search.reason, /NODEBB_API_TOKEN/);
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
	// One anonymous sweep is 4 calls: config (which also answers Q&A), search, Shotef's ping and its
	// ticket-API check.
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

test('a token the forum does not recognise is caught, though NodeBB never rejects it', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());

	const caps = await registryFor(forum.url, { NODEBB_API_TOKEN: 'wrong-token' }).registry.get();
	// NodeBB serves the request as a guest, so the forum is perfectly reachable…
	assert.equal(caps.forum.reachable, true);
	assert.equal(caps.forum.credentials, 'token');
	// …but we must not claim to be authenticated.
	assert.equal(caps.forum.authenticated, false);
	assert.equal(caps.forum.uid, 0);
	assert.match(caps.forum.authProblem, /not accepted/);
	assert.match(caps.forum.authProblem, /silently/);
});

test('a master token without NODEBB_UID is explained, not reported as a server error', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());

	const caps = await registryFor(forum.url, { NODEBB_API_TOKEN: 'master-token' }).registry.get();
	assert.equal(caps.forum.reachable, true);
	assert.equal(caps.forum.authenticated, false);
	assert.match(caps.forum.authProblem, /master token/);
	assert.match(caps.forum.authProblem, /NODEBB_UID/);
});

test('a master token with NODEBB_UID acts as that user', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());

	const caps = await registryFor(forum.url, { NODEBB_API_TOKEN: 'master-token', NODEBB_UID: '8' }).registry.get();
	assert.equal(caps.forum.authenticated, true);
	assert.equal(caps.forum.uid, 8);
	assert.equal(caps.forum.username, 'maintainer');
	assert.ok(forum.requests.every(r => r.query._uid === '8'), 'every call must carry _uid');
});

test('a Shotef that ignores API tokens is flagged', async (t) => {
	const forum = await startFakeForum({ shotefIgnoresTokens: true });
	t.after(() => forum.close());

	const caps = await registryFor(forum.url, { NODEBB_API_TOKEN: 'admin-token' }).registry.get();
	assert.equal(caps.shotef.state, 'available');
	assert.match(caps.shotef.warning, /ignores API tokens.*NODEBB_USERNAME/);
	// Such builds also predate the ticket routes: triage actions are off, with the reason.
	assert.equal(caps.triage.state, 'absent');
	assert.match(caps.triage.reason, /no HTTP ticket API .* the board stays readable\. Update Shotef/);
});

test('without the ticket API, ticket actions are refused up front with the reason, not a bare 404', async (t) => {
	const forum = await startFakeForum({ shotefIgnoresTokens: true });
	const mcp = await connect(forum.url, { NODEBB_API_TOKEN: 'admin-token' });
	t.after(async () => { await mcp.close(); await forum.close(); });
	const { text, isError } = await mcp.call('add_ticket_note', { tid: 13, body: 'x' });
	assert.equal(isError, true);
	assert.match(text, /no HTTP ticket API/);
	assert.doesNotMatch(text, /Invalid API call/);
	assert.ok(!forum.requests.some(r => r.path.endsWith('/tickets/13/notes')), 'nothing was sent');
});

test('writes are off unless enabled, and need a real identity when they are', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());

	const off = await registryFor(forum.url, { NODEBB_API_TOKEN: 'admin-token' }).registry.get();
	assert.equal(off.writes.state, 'absent');
	assert.match(off.writes.reason, /NODEBB_ENABLE_WRITES/);

	const guest = await registryFor(forum.url, { NODEBB_ENABLE_WRITES: '1' }).registry.get();
	assert.equal(guest.writes.state, 'forbidden');

	const badToken = await registryFor(forum.url, { NODEBB_ENABLE_WRITES: '1', NODEBB_API_TOKEN: 'nope' }).registry.get();
	assert.equal(badToken.writes.state, 'forbidden');
	assert.match(badToken.writes.reason, /not accepted/);

	const on = await registryFor(forum.url, { NODEBB_ENABLE_WRITES: 'true', NODEBB_API_TOKEN: 'admin-token' }).registry.get();
	assert.equal(on.writes.state, 'available');
});

test('NODEBB_ENABLE_WRITES rejects values that are not booleans', () => {
	assert.throws(() => loadConfig({ NODEBB_URL: 'http://x', NODEBB_ENABLE_WRITES: 'maybe' }), /NODEBB_ENABLE_WRITES/);
});

test('triage actions need Shotef and an identity, but not NODEBB_ENABLE_WRITES', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());

	const member = await registryFor(forum.url, { NODEBB_API_TOKEN: 'admin-token' }).registry.get();
	assert.equal(member.writes.state, 'absent', 'public writes stay off without the flag');
	assert.equal(member.triage.state, 'available', 'team workflow does not need it');

	const guest = await registryFor(forum.url).registry.get();
	assert.equal(guest.triage.state, 'forbidden');
	assert.match(guest.triage.reason, /team member's identity/);

	const bare = await startFakeForum({ plugins: { shotef: false } });
	t.after(() => bare.close());
	const noShotef = await registryFor(bare.url, { NODEBB_API_TOKEN: 'admin-token' }).registry.get();
	assert.equal(noShotef.triage.state, 'absent');
	assert.match(noShotef.triage.reason, /Triage actions need the Shotef plugin/);
});
