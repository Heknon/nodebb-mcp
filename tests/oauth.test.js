/**
 * The shared HTTP server with OAuth sign-in, against the fake forum. Each test
 * drives the SDK's real OAuth client (tests/oauth-harness.js), so discovery,
 * registration, PKCE and refresh are exercised as an MCP client does them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { loadConfig } from '../dist/config.js';
import { startHttpServer } from '../dist/http.js';
import { OAuthStore } from '../dist/oauth/store.js';
import { PASSWORDS, startFakeForum } from './fake-forum.js';
import { TestOAuthClient, connectWithSignIn, signInWithBrowser, submitSignInForm, tryConnect } from './oauth-harness.js';

const MAINTAINER = { username: 'maintainer', password: PASSWORDS[8] };
const OUTSIDER = { username: 'outsider', password: PASSWORDS[9] };

function freePort() {
	return new Promise((resolve) => {
		const probe = createServer().listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

async function stateFile() {
	return join(await mkdtemp(join(tmpdir(), 'nodebb-mcp-oauth-')), 'oauth.json');
}

async function setup(t, { env = {}, forumOpts = {}, file } = {}) {
	const forum = await startFakeForum(forumOpts);
	const config = loadConfig({
		NODEBB_URL: forum.url,
		NODEBB_MCP_HTTP_PORT: '0',
		NODEBB_MCP_STATE_FILE: file ?? await stateFile(),
		NODEBB_SESSION_CHECK_MS: '0',
		...env,
	});
	const server = await startHttpServer(config);
	const open = [];
	t.after(async () => {
		await Promise.all(open.map(c => c.close()));
		await server.close();
		await forum.close();
	});
	const signIn = async (credentials, oauth) => {
		const mcp = await connectWithSignIn(server.url, credentials, oauth);
		open.push(mcp);
		return mcp;
	};
	return { forum, server, config, signIn };
}

test('advertises OAuth discovery metadata for the MCP endpoint', async (t) => {
	const { server } = await setup(t);
	const as = await (await fetch(`${server.url}/.well-known/oauth-authorization-server`)).json();
	assert.equal(as.issuer, `${server.url}/`);
	assert.equal(as.authorization_endpoint, `${server.url}/authorize`);
	assert.equal(as.token_endpoint, `${server.url}/token`);
	assert.equal(as.registration_endpoint, `${server.url}/register`);
	assert.ok(as.code_challenge_methods_supported.includes('S256'));

	const prm = await (await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`)).json();
	assert.equal(prm.resource, `${server.url}/mcp`);
	assert.deepEqual(prm.authorization_servers, [`${server.url}/`]);
	assert.match(prm.resource_name, /Fake Forum/);

	const anonymous = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	assert.equal(anonymous.status, 401);
	assert.match(anonymous.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('a person signs in with their forum account and the tools act as them', async (t) => {
	const { forum, signIn } = await setup(t);
	const mcp = await signIn(MAINTAINER);

	// The page says who is asking and where the person is sent back to.
	assert.match(mcp.signIn.signInPage, /Sign in to Fake Forum/);
	assert.match(mcp.signIn.signInPage, /nodebb-mcp test client<\/strong> wants to use the forum as you/);
	assert.match(mcp.signIn.signInPage, /sent back to <strong>localhost:53682<\/strong>/);

	const caps = await mcp.call('forum_capabilities');
	assert.match(caps.text, /Acting as:\*\* maintainer \(uid 8\) — verified by the forum/);
	const note = await mcp.call('add_ticket_note', { tid: 13, body: 'via OAuth' });
	assert.equal(note.isError, false, note.text);
	assert.equal(forum.notes[13][0].author, 'maintainer');
});

test('several people on one server each act as themselves', async (t) => {
	const { signIn } = await setup(t);
	const [maintainer, outsider] = await Promise.all([signIn(MAINTAINER, new TestOAuthClient('A')), signIn(OUTSIDER, new TestOAuthClient('B'))]);
	const [a, b] = await Promise.all([maintainer.call('get_triage_board'), outsider.call('get_triage_board')]);
	assert.match(a.text, /# Triage board — Core Support/);
	assert.match(b.text, /outsider is not a member of any triage team/);
	assert.match((await outsider.call('forum_capabilities')).text, /Acting as:\*\* outsider \(uid 9\)/);
});

test('a wrong password re-shows the page with the reason and issues no code', async (t) => {
	const { forum, server } = await setup(t);
	const oauth = new TestOAuthClient();
	const first = await tryConnect(server.url, oauth);
	assert.equal(first.client, null);

	const wrong = await signInWithBrowser(oauth.authorizationUrl, { username: 'maintainer', password: 'not-the-password' });
	assert.equal(wrong.status, 401);
	assert.equal(wrong.code, undefined);
	assert.match(wrong.html, /Wrong username or password\./);
	assert.match(wrong.html, /value="maintainer"/, 'the username is kept');
	assert.equal(forum.loginAttempts.at(-1).ok, false);

	// The person retries *from the page they were shown* — its form, its action,
	// resolved against that page's URL, exactly as a browser submits it.
	const retry = await submitSignInForm(wrong.pageUrl, wrong.html, { username: 'maintainer', password: PASSWORDS[8] });
	assert.equal(retry.status, 302, `retry from the error page failed: HTTP ${retry.status}`);
	assert.ok(retry.code);
	assert.equal(retry.location.href.split('?')[0], 'http://localhost:53682/callback');
});

test('cancelling sends the person back with access_denied', async (t) => {
	const { server } = await setup(t);
	const oauth = new TestOAuthClient();
	await tryConnect(server.url, oauth);
	const result = await signInWithBrowser(oauth.authorizationUrl, { username: '', password: '', action: 'deny' });
	assert.equal(result.error, 'access_denied');
	assert.equal(result.code, undefined);
});

test('a locked account is explained on the page', async (t) => {
	const { forum, server } = await setup(t);
	forum.lockAccount(8);
	const oauth = new TestOAuthClient();
	await tryConnect(server.url, oauth);
	const result = await signInWithBrowser(oauth.authorizationUrl, MAINTAINER);
	assert.match(result.html, /This account is locked after too many failed sign-ins/);
});

test('refresh tokens rotate, and an old one is refused', async (t) => {
	const { server, signIn } = await setup(t);
	const mcp = await signIn(MAINTAINER);
	const { refresh_token: first } = mcp.oauth.tokens();
	const clientId = mcp.oauth.clientInformation().client_id;

	const refresh = async token => fetch(`${server.url}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }),
	});
	const ok = await refresh(first);
	assert.equal(ok.status, 200);
	const fresh = await ok.json();
	assert.ok(fresh.access_token && fresh.refresh_token && fresh.refresh_token !== first);

	const again = await refresh(first);
	assert.equal(again.status, 400);
	assert.equal((await again.json()).error, 'invalid_grant');
});

test('a refresh token presented by another client is refused without burning it', async (t) => {
	const { server, signIn } = await setup(t);
	const owner = await signIn(MAINTAINER);
	const other = await signIn(OUTSIDER, new TestOAuthClient('another client'));
	const refresh = (token, clientId) => fetch(`${server.url}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }),
	});
	const stolen = await refresh(owner.oauth.tokens().refresh_token, other.oauth.clientInformation().client_id);
	assert.equal(stolen.status, 400);
	const mine = await refresh(owner.oauth.tokens().refresh_token, owner.oauth.clientInformation().client_id);
	assert.equal(mine.status, 200, 'the owner can still refresh');
});

test('a forum in maintenance during a refresh does not end anyone\'s access', async (t) => {
	const { forum, server, signIn } = await setup(t);
	const mcp = await signIn(MAINTAINER);
	forum.interceptNext('/api/config', 503, { contentType: 'application/json', text: '{"error":"maintenance"}' });
	const res = await fetch(`${server.url}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: mcp.oauth.tokens().refresh_token,
			client_id: mcp.oauth.clientInformation().client_id,
		}),
	});
	assert.equal(res.status, 200);
	assert.equal(forum.sessionsFor(8), 1, 'the forum session is kept');
});

test('access tokens that ran out are dropped, so hourly refreshes do not grow the state file forever', async () => {
	const file = await stateFile();
	let clock = Date.now();
	const store = new OAuthStore('http://forum.example', file, () => clock);
	const pending = store.addPending({ clientId: 'c', redirectUri: 'http://localhost/cb', codeChallenge: 'x', scopes: ['forum'] });
	const code = store.completeSignIn(pending, { uid: 8, username: 'maintainer', session: { cookies: { 'express.sid': 's' }, csrf: 't', uid: 8 } });
	const { grantId } = store.peekCode(code);
	for (let hour = 0; hour < 6; hour += 1) {
		store.issueTokens(grantId, 'c', ['forum']);
		clock += 2 * 60 * 60 * 1000;
	}
	const last = store.issueTokens(grantId, 'c', ['forum']);
	assert.ok(store.findAccess(last.access_token), 'the newest token works');
	await new Promise(r => setTimeout(r, 100)); // writes are queued
	const saved = JSON.parse(await readFile(file, 'utf8'));
	assert.equal(Object.values(saved.tokens).filter(token => token.kind === 'access').length, 1);
});

test('PKCE is enforced: a code with the wrong verifier is refused', async (t) => {
	const { server } = await setup(t);
	const oauth = new TestOAuthClient();
	await tryConnect(server.url, oauth);
	const { code } = await signInWithBrowser(oauth.authorizationUrl, MAINTAINER);
	const res = await fetch(`${server.url}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(50),
			redirect_uri: oauth.redirectUrl, client_id: oauth.clientInformation().client_id,
		}),
	});
	assert.equal(res.status, 400);
	assert.equal((await res.json()).error, 'invalid_grant');
});

test('one person\'s token cannot drive another person\'s MCP session', async (t) => {
	const { server, signIn } = await setup(t);
	const maintainer = await signIn(MAINTAINER, new TestOAuthClient('A'));
	const outsider = await signIn(OUTSIDER, new TestOAuthClient('B'));
	const sessionId = maintainer.client.transport.sessionId;
	const res = await fetch(`${server.url}/mcp`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			authorization: `Bearer ${outsider.oauth.tokens().access_token}`,
			'mcp-session-id': sessionId,
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
	});
	assert.equal(res.status, 403);
});

test('when the forum ends the session, the tools say so and the client must sign in again', async (t) => {
	const { forum, server, signIn } = await setup(t);
	const mcp = await signIn(MAINTAINER);
	await mcp.call('forum_capabilities');
	forum.expireSessions();

	const { text, isError } = await mcp.call('get_triage_board');
	assert.equal(isError, true);
	assert.match(text, /forum session for "maintainer" has ended/);
	assert.match(text, /Reconnect this MCP server to sign in/);

	// The grant is gone: the saved tokens no longer work, and refreshing fails.
	const reconnect = await tryConnect(server.url, mcp.oauth);
	assert.equal(reconnect.client, null, 'a fresh sign-in is required');
	assert.ok(mcp.oauth.authorizationUrl, 'the client was sent back to sign in');
	assert.equal(forum.sessionsFor(8), 0);
});

test('revoking the refresh token ends access and signs the forum session out', async (t) => {
	const { forum, server, signIn } = await setup(t);
	const mcp = await signIn(MAINTAINER);
	assert.equal(forum.sessionsFor(8), 1);

	const res = await fetch(`${server.url}/revoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token: mcp.oauth.tokens().refresh_token, client_id: mcp.oauth.clientInformation().client_id }),
	});
	assert.equal(res.status, 200);
	assert.equal(forum.sessionsFor(8), 0, 'the forum session was signed out');

	const call = await fetch(`${server.url}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.oauth.tokens().access_token}` },
		body: '{}',
	});
	assert.equal(call.status, 401);
});

test('sign-ins survive a server restart; the state file holds no password and no usable token', async (t) => {
	const file = await stateFile();
	const forum = await startFakeForum();
	t.after(() => forum.close());
	// A fixed port, so the issuer (and the client's saved discovery) stays the same across the restart.
	const port = await freePort();
	const env = { NODEBB_URL: forum.url, NODEBB_MCP_HTTP_PORT: String(port), NODEBB_MCP_STATE_FILE: file };

	const first = await startHttpServer(loadConfig(env));
	const mcp = await connectWithSignIn(first.url, MAINTAINER);
	await mcp.close();
	await first.close();

	const saved = await readFile(file, 'utf8');
	assert.ok(!saved.includes(PASSWORDS[8]), 'no password');
	assert.ok(!saved.includes(mcp.oauth.tokens().access_token), 'tokens are stored hashed');
	assert.ok(!saved.includes(mcp.oauth.tokens().refresh_token));

	const second = await startHttpServer(loadConfig(env));
	t.after(() => second.close());
	const again = await tryConnect(second.url, mcp.oauth);
	assert.ok(again.client, 'the saved tokens still work after the restart');
	const result = await again.client.callTool({ name: 'forum_capabilities', arguments: {} });
	assert.match(result.content[0].text, /Acting as:\*\* maintainer/);
	await again.client.close();
	assert.equal(forum.loginAttempts.length, 1, 'no second sign-in was needed');
});

test('NODEBB_ENABLE_WRITES still decides the public tools for everyone', async (t) => {
	const off = await setup(t);
	const readOnly = await off.signIn(MAINTAINER);
	const names = (await readOnly.client.listTools()).tools.map(tool => tool.name);
	assert.ok(names.includes('add_ticket_note'));
	assert.ok(!names.includes('reply_to_topic'));

	const on = await setup(t, { env: { NODEBB_ENABLE_WRITES: '1' } });
	const writer = await on.signIn(MAINTAINER);
	const reply = await writer.call('reply_to_topic', { tid: 12, content: 'Hello over OAuth' });
	assert.match(reply.text, /as maintainer/);
});

test('a session that died before the first tool call is reported as such, then the client must sign in again', async (t) => {
	const { forum, signIn } = await setup(t);
	const mcp = await signIn(MAINTAINER);
	forum.expireSessions(); // before any tool has run (no capability probe yet)

	// The first call explains — and never blames a missing plugin.
	const { text, isError } = await mcp.call('get_triage_board');
	assert.equal(isError, true, text);
	assert.match(text, /forum session for "maintainer" has ended/);
	assert.ok(!/No triage board is available|plugin/i.test(text), text);

	// The grant is over: the next request is a 401, and the client goes back to sign-in.
	mcp.oauth.authorizationUrl = undefined;
	await assert.rejects(() => mcp.call('search_tickets'), /Unauthorized/);
	assert.ok(mcp.oauth.authorizationUrl, 'the client was sent to sign in again');
});

test('the sign-in page lets the browser follow the redirect back to the client (CSP form-action)', async (t) => {
	// Browsers apply form-action to the redirect after a form post; 'self' alone
	// silently blocks the way back to the client. (Caught in a real browser.)
	const { server } = await setup(t);
	for (const [redirect, expected] of [
		['http://localhost:53682/callback', "form-action 'self' http://localhost:53682"],
		['vscode://anthropic.claude/callback', "form-action 'self' vscode:"],
	]) {
		const oauth = new TestOAuthClient('csp', redirect);
		// eslint-disable-next-line no-await-in-loop
		await tryConnect(server.url, oauth);
		// eslint-disable-next-line no-await-in-loop
		const page = await fetch(oauth.authorizationUrl);
		assert.match(page.headers.get('content-security-policy'), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		// eslint-disable-next-line no-await-in-loop
		assert.match(await page.text(), /<form method="post" action="\/oauth\/sign-in"/, 'an absolute form action');
	}
});
