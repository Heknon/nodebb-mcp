/**
 * e2e: nodebb-mcp as a shared HTTP server — started the way it is deployed
 * (`node dist/index.js` with NODEBB_MCP_HTTP_PORT) — with people signing in
 * through OAuth using their real forum accounts on the real forum. Clients are
 * the SDK's own OAuth client; the "browser" is scripted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestOAuthClient, connectWithSignIn, tryConnect } from '../oauth-harness.js';
import { e2e } from './harness.js';

const { fixture: fx, opts } = await e2e({ needs: 'full' });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RUN = `r${Date.now().toString(36)}`;
const T = () => fx.topics;

let child;
let base;
let stateFile;
let log = '';
const open = [];

function freePort() {
	return new Promise((done) => {
		const probe = createServer().listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => done(port));
		});
	});
}

test.before(async () => {
	if (opts.skip) return;
	const port = await freePort();
	stateFile = join(await mkdtemp(join(tmpdir(), 'nodebb-mcp-oauth-e2e-')), 'oauth.json');
	child = spawn(process.execPath, [join(ROOT, 'dist/index.js')], {
		env: {
			PATH: process.env.PATH,
			NODEBB_URL: fx.url,
			NODEBB_MCP_HTTP_PORT: String(port),
			NODEBB_MCP_STATE_FILE: stateFile,
			// Check the forum session before every Write API read, so expiry tests need no clock.
			NODEBB_SESSION_CHECK_MS: '0',
		},
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	child.stderr.on('data', (chunk) => { log += chunk; });
	base = `http://localhost:${port}`;
	for (let i = 0; i < 50; i += 1) {
		try {
			// eslint-disable-next-line no-await-in-loop
			if ((await fetch(`${base}/healthz`)).ok) return;
		} catch {
			// not up yet
		}
		// eslint-disable-next-line no-await-in-loop
		await new Promise(r => setTimeout(r, 100));
	}
	throw new Error(`HTTP server did not start:\n${log}`);
});

test.after(async () => {
	await Promise.all(open.map(mcp => mcp.close()));
	child?.kill('SIGTERM');
});

const credentials = name => ({ username: name, password: fx.password });

async function signIn(name, oauth = new TestOAuthClient(`e2e ${name}`)) {
	const mcp = await connectWithSignIn(base, credentials(name), oauth);
	open.push(mcp);
	return mcp;
}

async function grantCookie(username) {
	const state = JSON.parse(await readFile(stateFile, 'utf8'));
	const grant = Object.values(state.grants).filter(g => g.username === username && !g.endedAt).at(-1);
	return Object.entries(grant.session.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

const uidFor = async cookie => (await (await fetch(`${fx.url}/api/config`, { headers: { cookie } })).json()).uid;

test('the server starts in HTTP mode and advertises OAuth for its MCP endpoint', opts, async () => {
	assert.match(log, new RegExp(`over HTTP at ${base}/mcp — each person signs in with their own forum account`));
	const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
	assert.equal(prm.resource, `${base}/mcp`);
	assert.match(prm.resource_name, /NodeBB/);
	const unauthenticated = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	assert.equal(unauthenticated.status, 401);
});

test('two people sign in with their real forum accounts and each acts as themselves', opts, async () => {
	// e2e_helper (a team member): the session suite revokes e2e_maintainer's
	// sessions in parallel, so the suites never share a person whose sessions die.
	const [maintainer, outsider] = await Promise.all([signIn('e2e_helper'), signIn('e2e_outsider')]);

	assert.match((await maintainer.call('forum_capabilities')).text,
		new RegExp(`Acting as:\\*\\* e2e_helper \\(uid ${fx.uids.helper}\\) — verified by the forum`));
	assert.match((await outsider.call('forum_capabilities')).text,
		new RegExp(`Acting as:\\*\\* e2e_outsider \\(uid ${fx.uids.outsider}\\)`));

	const [board, refused] = await Promise.all([
		maintainer.call('get_triage_board', { team: fx.teamId }),
		outsider.call('get_triage_board'),
	]);
	assert.match(board.text, /# Triage board — Support & Ops \(e2e-support\)/);
	assert.match(refused.text, /e2e_outsider is not a member of any triage team/);

	// A team action through the person's own forum session (cookie + CSRF to real Shotef).
	const note = await maintainer.call('add_ticket_note', { tid: T().symlink.tid, body: `via OAuth ${RUN}` });
	assert.equal(note.isError, false, note.text);
	const ticket = await maintainer.call('get_ticket', { tid: T().symlink.tid });
	assert.match(ticket.text, new RegExp(`e2e_helper: via OAuth ${RUN}`));
});

test('a wrong password is refused by the real forum and shown on the page', opts, async () => {
	const oauth = new TestOAuthClient('e2e wrong password');
	const first = await tryConnect(base, oauth);
	assert.equal(first.client, null);
	const { signInWithBrowser } = await import('../oauth-harness.js');
	const result = await signInWithBrowser(oauth.authorizationUrl, { username: 'e2e_wrongpass', password: 'definitely-not-it-2' });
	assert.equal(result.code, undefined);
	assert.match(result.html, /Wrong username or password\.|This account is locked/);
});

test('signing a session out on the forum ends that person\'s access, and only theirs', opts, async () => {
	const maintainer = await signIn('e2e_helper', new TestOAuthClient('e2e revoke-on-forum'));
	const outsider = await signIn('e2e_reporter', new TestOAuthClient('e2e bystander'));
	const cookie = await grantCookie('e2e_helper');
	assert.equal(await uidFor(cookie), fx.uids.helper);

	// The person signs the session out from their account's sessions page (NodeBB's
	// API, acting as them through the master token).
	const auth = { authorization: `Bearer ${fx.tokens.master}` };
	const asHelper = `_uid=${fx.uids.helper}`;
	const sessions = (await (await fetch(`${fx.url}/api/user/e2e_helper/sessions?${asHelper}`, { headers: auth })).json()).sessions;
	assert.ok(sessions.length, 'the helper has sessions to sign out');
	for (const { uuid } of sessions) {
		// eslint-disable-next-line no-await-in-loop
		await fetch(`${fx.url}/api/v3/users/${fx.uids.helper}/sessions/${uuid}?${asHelper}`, { method: 'DELETE', headers: auth });
	}
	assert.equal(await uidFor(cookie), 0, 'the forum no longer honours it');

	const after = await maintainer.call('get_triage_board', { team: fx.teamId });
	assert.equal(after.isError, true, `never a quiet guest view:\n${after.text}`);
	assert.match(after.text, /forum session for "e2e_helper" has ended/);
	const reconnect = await tryConnect(base, maintainer.oauth);
	assert.equal(reconnect.client, null, 'the client is sent to sign in again');

	// Other people are unaffected.
	assert.match((await outsider.call('forum_capabilities')).text, /Acting as:\*\* e2e_reporter/);
});

test('revoking the OAuth grant signs the forum session out on the real forum', opts, async () => {
	const mcp = await signIn('e2e_helper', new TestOAuthClient('e2e revoke'));
	const cookie = await grantCookie('e2e_helper');
	assert.equal(await uidFor(cookie), fx.uids.helper);

	const res = await fetch(`${base}/revoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token: mcp.oauth.tokens().refresh_token, client_id: mcp.oauth.clientInformation().client_id }),
	});
	assert.equal(res.status, 200);
	assert.equal(await uidFor(cookie), 0, 'NodeBB logged the session out');
});

test('the state file keeps sessions but never a password or a usable token', opts, async () => {
	const mcp = await signIn('e2e_outsider', new TestOAuthClient('e2e state'));
	const saved = await readFile(stateFile, 'utf8');
	assert.ok(!saved.includes(fx.password));
	assert.ok(!saved.includes(mcp.oauth.tokens().access_token));
	assert.ok(!saved.includes(mcp.oauth.tokens().refresh_token));
});
