/**
 * The plugin's OAuth store, on an in-memory stand-in for NodeBB's database
 * (the same calls, the same string-valued hashes). The real database is
 * exercised by tests/e2e/plugin.e2e.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PluginStore } from '../dist/plugin/store.js';
import { PluginOAuthProvider } from '../dist/plugin/provider.js';

function memoryDb() {
	const hashes = new Map();
	const zsets = new Map();
	const zset = key => (zsets.has(key) ? zsets.get(key) : zsets.set(key, new Map()).get(key));
	const sorted = (key, dir) => [...zset(key)].sort((a, b) => dir * (a[1] - b[1])).map(([member]) => member);
	const slice = (list, start, stop) => (stop === -1 ? list.slice(start) : list.slice(start, stop + 1));
	return {
		hashes,
		async getObject(key) { return hashes.has(key) ? { ...hashes.get(key) } : null; },
		async getObjects(keys) { return keys.map(key => (hashes.has(key) ? { ...hashes.get(key) } : null)); },
		async setObject(key, data) { hashes.set(key, { ...(hashes.get(key) ?? {}), ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) }); },
		async setObjectField(key, field, value) { hashes.set(key, { ...(hashes.get(key) ?? {}), [field]: String(value) }); },
		async incrObjectField(key, field) {
			const object = hashes.get(key) ?? {};
			const next = (Number(object[field]) || 0) + 1;
			hashes.set(key, { ...object, [field]: String(next) });
			return next;
		},
		async delete(key) { hashes.delete(key); zsets.delete(key); },
		async deleteAll(keys) { keys.forEach((key) => { hashes.delete(key); zsets.delete(key); }); },
		async expireAt() {},
		async sortedSetAdd(key, score, value) { zset(key).set(String(value), score); },
		async sortedSetRemove(key, value) { zset(key).delete(String(value)); },
		async sortedSetScore(key, value) { return zset(key).has(String(value)) ? zset(key).get(String(value)) : null; },
		async sortedSetsRemoveRangeByScore(keys, min, max) {
			const lo = min === '-inf' ? -Infinity : min;
			const hi = max === '+inf' ? Infinity : max;
			for (const key of keys) for (const [member, score] of zset(key)) if (score >= lo && score <= hi) zset(key).delete(member);
		},
		async getSortedSetRange(key, start, stop) { return slice(sorted(key, 1), start, stop); },
		async getSortedSetRevRange(key, start, stop) { return slice(sorted(key, -1), start, stop); },
	};
}

function nodebbTokens() {
	const live = new Map();
	return {
		live,
		async generate({ uid, description }) { const token = `nbb-${live.size + 1}`; live.set(token, { uid, description }); return token; },
		async get(token) { return live.get(token) ?? null; },
		async delete(token) { live.delete(token); },
	};
}

async function connected(store, provider, uid = 8, username = 'maintainer') {
	const client = await store.registerClient({ client_name: 'Claude Code', redirect_uris: ['http://localhost:9/cb'] });
	const res = { redirect: (_status, to) => { res.to = to; } };
	await provider.authorize(client, { redirectUri: 'http://localhost:9/cb', codeChallenge: 'c', state: 's', scopes: [] }, res);
	const request = new URL(res.to).searchParams.get('request');
	const back = await provider.decide(request, { uid, username }, true);
	return { client, request, code: back.searchParams.get('code'), back };
}

test('consent: allowing gives a one-time code; redeeming it makes the connection and its NodeBB token', async () => {
	const tokens = nodebbTokens();
	const store = new PluginStore(memoryDb());
	const provider = new PluginOAuthProvider(store, tokens, 'https://forum.example/mcp/connect');
	const { client, request, code, back } = await connected(store, provider);
	assert.equal(back.origin + back.pathname, 'http://localhost:9/cb');
	assert.equal(back.searchParams.get('state'), 's');
	assert.equal(tokens.live.size, 0, 'an Allow that is never redeemed leaves no token behind');
	assert.deepEqual(await store.listGrants(), []);

	assert.equal(await provider.decide(request, { uid: 8, username: 'maintainer' }, true), undefined, 'a request is answered once');
	assert.equal(await provider.challengeForAuthorizationCode(client, code), 'c');
	const issued = await provider.exchangeAuthorizationCode(client, code);
	assert.deepEqual([...tokens.live.values()], [{ uid: 8, description: 'MCP: Claude Code (maintainer)' }]);
	assert.ok(issued.access_token && issued.refresh_token);
	await assert.rejects(provider.exchangeAuthorizationCode(client, code), /Invalid or expired authorization code/, 'codes are single-use');

	const auth = await provider.verifyAccessToken(issued.access_token);
	assert.equal(auth.extra.uid, 8);
});

test('connecting the same app again replaces its earlier connection and token', async () => {
	const tokens = nodebbTokens();
	const store = new PluginStore(memoryDb());
	const provider = new PluginOAuthProvider(store, tokens, 'https://forum.example/mcp/connect');
	const first = await connected(store, provider);
	const old = await provider.exchangeAuthorizationCode(first.client, first.code);
	// The same client authorizes again (lost its tokens, say).
	const res = { redirect: (_s, to) => { res.to = to; } };
	await provider.authorize(first.client, { redirectUri: 'http://localhost:9/cb', codeChallenge: 'c', scopes: [] }, res);
	const back = await provider.decide(new URL(res.to).searchParams.get('request'), { uid: 8, username: 'maintainer' }, true);
	await provider.exchangeAuthorizationCode(first.client, back.searchParams.get('code'));
	assert.equal((await store.listGrants(8)).length, 1);
	assert.equal(tokens.live.size, 1);
	await assert.rejects(provider.verifyAccessToken(old.access_token), /Invalid, expired or revoked/);
});

test('connections nobody has used for the idle period are found for ending; used ones are not', async () => {
	let now = Date.now();
	const store = new PluginStore(memoryDb(), () => now);
	const provider = new PluginOAuthProvider(store, nodebbTokens(), 'https://forum.example/mcp/connect');
	const a = await connected(store, provider, 8, 'maintainer');
	const issuedA = await provider.exchangeAuthorizationCode(a.client, a.code);
	const b = await connected(store, provider, 9, 'outsider');
	await provider.exchangeAuthorizationCode(b.client, b.code);
	now += 89 * 24 * 60 * 60 * 1000;
	await provider.verifyAccessToken(issuedA.access_token).catch(() => {}); // expired by now; no touch
	const [grantA] = await store.listGrants(8);
	await store.touchGrant(grantA);
	now += 2 * 24 * 60 * 60 * 1000;
	const idle = await store.idleGrants(90 * 24 * 60 * 60 * 1000);
	assert.deepEqual(idle.map(grant => grant.username), ['outsider']);
});

test('two processes racing for the same code: exactly one wins', async () => {
	const store = new PluginStore(memoryDb());
	const provider = new PluginOAuthProvider(store, nodebbTokens(), 'https://forum.example/mcp/connect');
	const { client, code } = await connected(store, provider);
	const results = await Promise.allSettled([1, 2, 3].map(() => provider.exchangeAuthorizationCode(client, code)));
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});

test('declining sends access_denied and makes nothing', async () => {
	const tokens = nodebbTokens();
	const store = new PluginStore(memoryDb());
	const provider = new PluginOAuthProvider(store, tokens, 'https://forum.example/mcp/connect');
	const client = await store.registerClient({ client_name: 'X', redirect_uris: ['http://localhost:9/cb'] });
	const res = { redirect: (_s, to) => { res.to = to; } };
	await provider.authorize(client, { redirectUri: 'http://localhost:9/cb', codeChallenge: 'c', scopes: [] }, res);
	const back = await provider.decide(new URL(res.to).searchParams.get('request'), { uid: 8, username: 'm' }, false);
	assert.equal(back.searchParams.get('error'), 'access_denied');
	assert.equal(tokens.live.size, 0);
	assert.deepEqual(await store.listGrants(), []);
});

test('refresh tokens rotate, stay with their client, and stop when the NodeBB token is deleted', async () => {
	const tokens = nodebbTokens();
	const store = new PluginStore(memoryDb());
	const ended = [];
	const provider = new PluginOAuthProvider(store, tokens, 'https://forum.example/mcp/connect', grant => ended.push(grant.id));
	const { client, code } = await connected(store, provider);
	const first = await provider.exchangeAuthorizationCode(client, code);

	const other = await store.registerClient({ client_name: 'Other', redirect_uris: ['http://localhost:9/cb'] });
	await assert.rejects(provider.exchangeRefreshToken(other, first.refresh_token), /Invalid refresh token/);
	const second = await provider.exchangeRefreshToken(client, first.refresh_token);
	assert.notEqual(second.refresh_token, first.refresh_token, 'the other client did not burn it');
	await assert.rejects(provider.exchangeRefreshToken(client, first.refresh_token), /Invalid refresh token/, 'a used one is refused');

	// An administrator deletes the API token (ACP → API Access): the connection ends.
	tokens.live.clear();
	await assert.rejects(provider.verifyAccessToken(second.access_token), /revoked on the forum/);
	assert.equal(ended.length, 1);
	assert.deepEqual(await store.listGrants(), []);
	await assert.rejects(provider.exchangeRefreshToken(client, second.refresh_token), /Invalid refresh token/);
});

test('ending a grant removes its tokens, its NodeBB token, and its place in both lists', async () => {
	const tokens = nodebbTokens();
	const db = memoryDb();
	const store = new PluginStore(db);
	const provider = new PluginOAuthProvider(store, tokens, 'https://forum.example/mcp/connect');
	const { client, code } = await connected(store, provider, 8, 'maintainer');
	const issued = await provider.exchangeAuthorizationCode(client, code);
	const [grant] = await store.listGrants(8);
	assert.equal((await store.listGrants()).length, 1);

	await provider.endGrant(grant.id);
	assert.deepEqual(await store.listGrants(), []);
	assert.deepEqual(await store.listGrants(8), []);
	assert.equal(tokens.live.size, 0);
	await assert.rejects(provider.verifyAccessToken(issued.access_token), /Invalid, expired or revoked/);
	assert.deepEqual([...db.hashes.keys()].filter(key => key.startsWith('mcp:token:') || key.startsWith('mcp:grant:')), []);
});

test('revoking a refresh token ends the connection; an access token only itself', async () => {
	const tokens = nodebbTokens();
	const store = new PluginStore(memoryDb());
	const provider = new PluginOAuthProvider(store, tokens, 'https://forum.example/mcp/connect');
	const { client, code } = await connected(store, provider);
	const issued = await provider.exchangeAuthorizationCode(client, code);
	await provider.revokeToken(client, { token: issued.access_token });
	assert.equal((await store.listGrants()).length, 1);
	await provider.revokeToken(client, { token: issued.refresh_token });
	assert.equal((await store.listGrants()).length, 0);
	assert.equal(tokens.live.size, 0);
});

test('ids that are not ours are never used to build keys', async () => {
	const store = new PluginStore(memoryDb());
	assert.equal(await store.getGrant('../../user:1'), undefined);
	assert.equal(await store.getPending('x'), undefined);
	assert.equal(await store.getClient('a:b:c'), undefined);
});
