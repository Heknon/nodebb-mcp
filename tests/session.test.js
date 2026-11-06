/**
 * Signing in with NODEBB_USERNAME / NODEBB_PASSWORD, against the fake forum's
 * model of NodeBB's real login: cookie + CSRF handshake, refusals as raw keys,
 * account lockout, and sessions that expire silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NodeBBClient } from '../dist/client.js';
import { ConfigError, loadConfig } from '../dist/config.js';
import { PasswordSession, SignInError } from '../dist/session.js';
import { PASSWORDS, startFakeForum } from './fake-forum.js';
import { connect } from './mcp-harness.js';

const maintainer = { NODEBB_USERNAME: 'maintainer', NODEBB_PASSWORD: PASSWORDS[8] };

async function tempFile() {
	return join(await mkdtemp(join(tmpdir(), 'nodebb-mcp-session-')), 'session.json');
}

async function signedIn(t, env = maintainer, forumOpts = {}) {
	const forum = await startFakeForum(forumOpts);
	const sessionFile = await tempFile();
	// Check the session before every Write API read, so expiry tests need no clock.
	const mcp = await connect(forum.url, { NODEBB_SESSION_FILE: sessionFile, NODEBB_SESSION_CHECK_MS: '0', ...env });
	t.after(async () => { await mcp.close(); await forum.close(); });
	return { forum, mcp, sessionFile };
}

test('config: username and password go together; a token wins over them', () => {
	assert.throws(() => loadConfig({ NODEBB_URL: 'http://x', NODEBB_USERNAME: 'a' }), ConfigError);
	assert.throws(() => loadConfig({ NODEBB_URL: 'http://x', NODEBB_PASSWORD: 'b' }), /NODEBB_USERNAME/);

	const both = new NodeBBClient(loadConfig({ NODEBB_URL: 'http://x', NODEBB_API_TOKEN: 't', ...maintainer }));
	assert.equal(both.authMode, 'token');
	assert.equal(both.session, undefined);

	assert.equal(new NodeBBClient(loadConfig({ NODEBB_URL: 'http://x', ...maintainer })).authMode, 'password');
	assert.equal(new NodeBBClient(loadConfig({ NODEBB_URL: 'http://x' })).authMode, 'none');
});

test('config: the session file defaults to a per-forum, per-user cache file, and can be turned off', () => {
	const a = loadConfig({ NODEBB_URL: 'http://f.example', XDG_CACHE_HOME: '/c', ...maintainer });
	assert.match(a.sessionFile, /^\/c\/nodebb-mcp\/session-[0-9a-f]{16}\.json$/);
	const other = loadConfig({ NODEBB_URL: 'http://g.example', XDG_CACHE_HOME: '/c', ...maintainer });
	assert.notEqual(other.sessionFile, a.sessionFile);
	assert.equal(loadConfig({ NODEBB_URL: 'http://f.example', NODEBB_SESSION_FILE: 'off', ...maintainer }).sessionFile, undefined);
	// Passwords are not trimmed: spaces can be part of one.
	assert.equal(loadConfig({ NODEBB_URL: 'http://x', NODEBB_USERNAME: 'u', NODEBB_PASSWORD: ' pw ' }).password, ' pw ');
});

test('signs in and acts as that user, verified by the forum', async (t) => {
	const { forum, mcp } = await signedIn(t);
	const { text } = await mcp.call('forum_capabilities');
	assert.match(text, /Acting as:\*\* maintainer \(uid 8\) — verified by the forum/);
	assert.match(text, /Triage actions .* \| ✅ available/);
	assert.deepEqual(forum.loginAttempts, [{ username: 'maintainer', ok: true }]);
	// NodeBB labels the session on the person's sessions page from this.
	assert.match(forum.loginUserAgents[0], /^nodebb-mcp\/\d+\.\d+\.\d+ \(\w[^)]*\)$/);
	// Never a bearer token, never _uid: this is a cookie session.
	assert.ok(forum.requests.every(r => !r.auth && !('_uid' in r.query)));
});

test('cookie-session writes carry the CSRF token — triage actions and public writes', async (t) => {
	const { forum, mcp } = await signedIn(t, { ...maintainer, NODEBB_ENABLE_WRITES: '1' });
	const note = await mcp.call('add_ticket_note', { tid: 13, body: 'Signed in with a password.' });
	assert.equal(note.isError, false, note.text);
	assert.equal(forum.notes[13][0].author, 'maintainer');

	const reply = await mcp.call('reply_to_topic', { tid: 12, content: 'Hello from a password session.' });
	assert.equal(reply.isError, false, reply.text);
	assert.match(reply.text, /as maintainer/);

	const writes = forum.requests.filter(r => r.method !== 'GET' && r.path !== '/api/v3/utilities/login');
	assert.ok(writes.length >= 2);
	assert.ok(writes.every(r => r.cookie && r.csrf), 'every write sends the cookie and x-csrf-token');
});

test('concurrent first requests share one sign-in', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	const client = new NodeBBClient(loadConfig({ NODEBB_URL: forum.url, NODEBB_SESSION_FILE: 'off', ...maintainer }));
	const results = await Promise.all([client.read('/config'), client.read('/recent'), client.read('/categories')]);
	assert.equal(results[0].uid, 8);
	assert.equal(forum.loginAttempts.length, 1);
});

test('an expired session is renewed transparently on a read', async (t) => {
	const { forum, mcp } = await signedIn(t);
	await mcp.call('forum_capabilities');
	forum.expireSessions();

	// Expiry is silent in NodeBB — the board would quietly come back as a guest's.
	const { text, isError } = await mcp.call('get_triage_board');
	assert.equal(isError, false, text);
	assert.match(text, /# Triage board — Core Support/);
	assert.equal(forum.loginAttempts.length, 2, 'signed in again exactly once');
});

test('an expired session is renewed transparently on a write', async (t) => {
	const { forum, mcp } = await signedIn(t);
	await mcp.call('forum_capabilities');
	forum.expireSessions();

	const { text, isError } = await mcp.call('add_ticket_note', { tid: 13, body: 'after expiry' });
	assert.equal(isError, false, text);
	assert.equal(forum.notes[13].at(-1).body, 'after expiry');
	assert.equal(forum.loginAttempts.length, 2);
});

test('a wrong password fails loudly and is tried exactly once', async (t) => {
	const { forum, mcp } = await signedIn(t, { NODEBB_USERNAME: 'maintainer', NODEBB_PASSWORD: 'wrong-password' });

	const caps = await mcp.call('forum_capabilities');
	assert.match(caps.text, /Acting as:\*\* guest/);
	assert.match(caps.text, /Sign-in problem:\*\* The forum rejected the sign-in for "maintainer": invalid username or password/);
	assert.match(caps.text, /Fix NODEBB_USERNAME \/ NODEBB_PASSWORD/);

	// A tool does not quietly fall back to guest results: it says why it cannot work.
	const topic = await mcp.call('get_topic', { tid: 10 });
	assert.equal(topic.isError, true);
	assert.match(topic.text, /rejected the sign-in/);
	await mcp.call('search_forum', { query: 'redis' });
	await mcp.call('get_triage_board');

	assert.equal(forum.loginAttempts.length, 1, 'never retried in-process');
});

test('a refused password is remembered across processes, so restarts cannot lock the account', async (t) => {
	const forum = await startFakeForum();
	const sessionFile = await tempFile();
	t.after(() => forum.close());
	const wrong = { NODEBB_SESSION_FILE: sessionFile, NODEBB_USERNAME: 'maintainer', NODEBB_PASSWORD: 'wrong-password' };

	for (let i = 0; i < 6; i += 1) {
		// eslint-disable-next-line no-await-in-loop
		const mcp = await connect(forum.url, wrong);
		// eslint-disable-next-line no-await-in-loop
		const { text } = await mcp.call('forum_capabilities');
		assert.match(text, /invalid username or password/);
		// eslint-disable-next-line no-await-in-loop
		await mcp.close();
	}
	assert.equal(forum.loginAttempts.length, 1, 'six restarts, one attempt');

	// Fixing the password is tried straight away.
	const fixed = await connect(forum.url, { ...wrong, NODEBB_PASSWORD: PASSWORDS[8] });
	t.after(() => fixed.close());
	const { text } = await fixed.call('forum_capabilities');
	assert.match(text, /Acting as:\*\* maintainer/);
	assert.equal(forum.loginAttempts.length, 2);

	// The file never holds the password itself.
	assert.ok(!(await readFile(sessionFile, 'utf8')).includes('wrong-password'));
});

test('a new process reuses the cached session instead of signing in again', async (t) => {
	const forum = await startFakeForum();
	const sessionFile = await tempFile();
	t.after(() => forum.close());
	const env = { NODEBB_SESSION_FILE: sessionFile, ...maintainer };

	const first = await connect(forum.url, env);
	await first.call('forum_capabilities');
	await first.close();

	const second = await connect(forum.url, env);
	t.after(() => second.close());
	const { text } = await second.call('forum_capabilities');
	assert.match(text, /Acting as:\*\* maintainer/);
	assert.equal(forum.loginAttempts.length, 1, 'one sign-in across two processes');

	const mode = (await stat(sessionFile)).mode & 0o777;
	assert.equal(mode, 0o600, 'the session file is private to its owner');
	const cached = JSON.parse(await readFile(sessionFile, 'utf8'));
	assert.ok(cached.cookies['express.sid']);
	assert.ok(!JSON.stringify(cached).includes(PASSWORDS[8]));
});

test('a stale cached session is replaced by a fresh sign-in', async (t) => {
	const forum = await startFakeForum();
	const sessionFile = await tempFile();
	t.after(() => forum.close());
	const env = { NODEBB_SESSION_FILE: sessionFile, ...maintainer };

	const first = await connect(forum.url, env);
	await first.call('forum_capabilities');
	await first.close();
	forum.expireSessions();

	const second = await connect(forum.url, env);
	t.after(() => second.close());
	const { text } = await second.call('get_ticket', { tid: 11 });
	assert.match(text, /\*\*Status:\*\* `in_work`/);
	assert.equal(forum.loginAttempts.length, 2);
});

test('a locked account is explained and not retried', async (t) => {
	const forum = await startFakeForum();
	forum.lockAccount(8);
	const mcp = await connect(forum.url, { NODEBB_SESSION_FILE: 'off', ...maintainer });
	t.after(async () => { await mcp.close(); await forum.close(); });

	const { text } = await mcp.call('forum_capabilities');
	assert.match(text, /locked "maintainer" after too many failed sign-ins/);
	await mcp.call('get_topic', { tid: 10 });
	assert.equal(forum.loginAttempts.length, 0, 'a locked account is not counted, and we stop at once');
});

test('a password accepted without a session (2FA pending) is explained', async (t) => {
	const { mcp } = await signedIn(t, maintainer, { loginWithoutSession: true });
	const { text } = await mcp.call('forum_capabilities');
	assert.match(text, /accepted the password for "maintainer" but did not grant a session/);
});

test('the password never appears in tool output', async (t) => {
	const secret = 'Sup3r-secret-pw';
	const { mcp } = await signedIn(t, { NODEBB_USERNAME: 'maintainer', NODEBB_PASSWORD: secret, NODEBB_ENABLE_WRITES: '1' });
	for (const [name, args] of [['forum_capabilities', {}], ['get_topic', { tid: 10 }], ['reply_to_topic', { tid: 12, content: 'x' }]]) {
		// eslint-disable-next-line no-await-in-loop
		const { text } = await mcp.call(name, args);
		assert.ok(!text.includes(secret), `${name} leaked the password`);
	}
});

test('within the default window, Write API reads add no extra session checks', async (t) => {
	const forum = await startFakeForum();
	const mcp = await connect(forum.url, { NODEBB_SESSION_FILE: 'off', ...maintainer });
	t.after(async () => { await mcp.close(); await forum.close(); });

	await mcp.call('get_triage_board');
	const configsBefore = forum.requests.filter(r => r.path === '/api/config').length;
	await mcp.call('get_triage_board');
	await mcp.call('get_ticket', { tid: 11 });
	const configsAfter = forum.requests.filter(r => r.path === '/api/config').length;
	assert.equal(configsAfter, configsBefore, 'a session confirmed moments ago is not re-checked');
});

test('a malformed session file is ignored, not fatal', async (t) => {
	const forum = await startFakeForum();
	const sessionFile = await tempFile();
	t.after(() => forum.close());
	const { writeFile } = await import('node:fs/promises');
	await writeFile(sessionFile, JSON.stringify({
		version: 1, url: forum.url, username: 'maintainer',
		refused: { reason: 'credentials', message: 'x', until: Date.now() + 1e6, salt: 'zz', hash: 'abc' },
	}));
	const mcp = await connect(forum.url, { NODEBB_SESSION_FILE: sessionFile, ...maintainer });
	t.after(() => mcp.close());
	const { text } = await mcp.call('forum_capabilities');
	assert.match(text, /Acting as:\*\* maintainer/);
});

test('"no session granted" is not remembered across processes', async (t) => {
	const forum = await startFakeForum({ loginWithoutSession: true });
	const sessionFile = await tempFile();
	t.after(() => forum.close());
	for (let i = 0; i < 2; i += 1) {
		// eslint-disable-next-line no-await-in-loop
		const mcp = await connect(forum.url, { NODEBB_SESSION_FILE: sessionFile, ...maintainer });
		// eslint-disable-next-line no-await-in-loop
		const { text } = await mcp.call('forum_capabilities');
		assert.match(text, /did not grant a session/);
		assert.ok(!text.includes('Remembered'));
		// eslint-disable-next-line no-await-in-loop
		await mcp.close();
	}
	assert.equal(forum.loginAttempts.length, 2, 'each process may try again once the user fixes it');
});

/* ------------------------------------------- races, holds, proxies (CR round 1) */

const sessionFor = (forum, extra = {}) => new PasswordSession({
	url: forum.url,
	username: 'maintainer',
	password: PASSWORDS[8],
	sessionFile: undefined,
	timeoutMs: 5000,
	...extra,
});

async function until(check, what) {
	for (let i = 0; i < 200; i += 1) {
		if (check()) return;
		// eslint-disable-next-line no-await-in-loop
		await new Promise(r => setTimeout(r, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}

test('a request that arrives mid-sign-in waits for it instead of going out as a guest', async (t) => {
	const forum = await startFakeForum({ loginDelayMs: 150 });
	t.after(() => forum.close());
	const session = sessionFor(forum);
	const first = session.ensure();
	// Step 1 (the anonymous session and its CSRF token) is done; the login is in flight.
	await until(() => forum.requests.some(r => r.path === '/api/config'), 'step 1 of the sign-in');
	await session.ensure();
	assert.equal(session.uid, 8, 'the second caller holds the signed-in session, not the anonymous one');
	await first;
	assert.equal(session.logins, 1);
});

test('concurrent first callers read the session file once and do not sign in again', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	const sessionFile = await tempFile();
	await sessionFor(forum, { sessionFile }).ensure();
	assert.equal(forum.loginAttempts.length, 1);

	const next = sessionFor(forum, { sessionFile });
	await Promise.all([next.ensure(), next.ensure(), next.ensure()]);
	assert.equal(next.logins, 0, 'the cached session was used by every caller');
	assert.equal(forum.loginAttempts.length, 1);
	assert.equal(next.uid, 8);
});

test('a sign-in that fails part-way leaves no anonymous session that passes for a signed-in one', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	const session = sessionFor(forum);
	forum.interceptNext('/api/v3/utilities/login', 502, { text: 'Bad Gateway' });
	await assert.rejects(session.ensure(), /HTTP 502/);
	await session.ensure();
	assert.equal(session.uid, 8, 'the next call signed in for real');
	assert.equal(session.logins, 2);
});

test('a lock is held for an hour in a long-running process, then sign-in is tried again', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	let clock = Date.now();
	const session = sessionFor(forum, { now: () => clock });
	forum.lockAccount(8);
	await assert.rejects(session.ensure(), err => err instanceof SignInError && err.reason === 'account-locked');
	await assert.rejects(session.ensure(), /locked/);
	assert.equal(session.logins, 1, 'not retried while the lock holds');

	forum.unlockAccount(8);
	clock += 61 * 60 * 1000;
	await session.ensure();
	assert.equal(session.uid, 8);
	assert.equal(session.logins, 2);
});

test('a proxy\'s plain 403 on a write does not spend a sign-in when the forum still honours the session', async (t) => {
	const { forum, mcp } = await signedIn(t);
	await mcp.call('forum_capabilities');
	forum.interceptNext('/api/v3/plugins/shotef/tickets/13/notes', 403, { method: 'POST', text: 'Forbidden' });

	const { text, isError } = await mcp.call('add_ticket_note', { tid: 13, body: 'past the proxy' });
	assert.equal(isError, false, text);
	assert.equal(forum.notes[13].at(-1).body, 'past the proxy');
	assert.equal(forum.loginAttempts.length, 1, 'no second sign-in');
});

test('a password-less (OAuth) session survives a proxy\'s 401, and still ends when the forum ends it', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	const state = await sessionFor(forum).signInNow();
	let ended = 0;
	const session = new PasswordSession({
		url: forum.url, username: 'maintainer', initial: state, sessionFile: undefined, timeoutMs: 5000,
		onEnded: () => { ended += 1; },
	});
	const config = loadConfig({ NODEBB_URL: forum.url, NODEBB_SESSION_CHECK_MS: '0' });
	const client = new NodeBBClient(config, { session });

	forum.interceptNext('/api/v3/plugins/shotef/board', 401, { contentType: 'application/json', text: '{}' });
	const board = await client.v3('/plugins/shotef/board');
	assert.equal(board.team.id, 'core');
	assert.equal(ended, 0, 'a 401 from in front of the forum does not end the grant');

	forum.interceptNext('/api/config', 503, { contentType: 'application/json', text: '{"error":"maintenance"}' });
	assert.equal(await session.check(), undefined, 'maintenance is "cannot tell", not "ended"');

	forum.expireSessions();
	await assert.rejects(client.v3('/plugins/shotef/board'), /has ended/);
	assert.equal(ended, 1);
});
