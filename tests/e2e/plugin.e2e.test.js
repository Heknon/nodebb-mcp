/**
 * e2e: the forum serves MCP itself (nodebb-plugin-mcp, active on the test forum).
 * People connect with the SDK's own OAuth client and a scripted browser that
 * signs in to the forum and answers its Connect page. Everything runs against
 * the real NodeBB: its login, its API tokens, its ACP, real Shotef.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TestOAuthClient, allowInBrowser, connectWithSignIn, forumSignIn, tryConnect } from '../oauth-harness.js';
import { e2e, revokeTestConnections } from './harness.js';

const { fixture: fx, opts: forumOpts } = await e2e({ needs: 'full' });

// The forum's own URL (its config.json "url") and the MCP endpoint, which is also the OAuth issuer.
let FORUM;
let ENDPOINT;
let opts = forumOpts;
if (!forumOpts.skip) {
	const prm = await fetch(`${fx.url}/.well-known/oauth-protected-resource/api/mcp`).catch(() => undefined);
	if (prm?.ok) {
		ENDPOINT = (await prm.json()).resource;
		FORUM = ENDPOINT.replace(/\/api\/mcp$/, '');
	}
	else opts = { skip: 'nodebb-plugin-mcp is not active on the test forum (e2e/forum.sh provision)' };
}

const RUN = `r${Date.now().toString(36)}`;
const T = () => fx.topics;
const open = [];
test.after(async () => {
	await Promise.all(open.map(mcp => mcp.close()));
	await revokeTestConnections(fx);
});

const person = name => ({ username: name, password: fx.password });
async function connect(name, client = `e2e ${name}`) {
	const mcp = await connectWithSignIn(ENDPOINT, { forumUrl: FORUM, ...person(name) }, new TestOAuthClient(client));
	open.push(mcp);
	return mcp;
}
const asAdmin = { authorization: `Bearer ${fx.tokens.admin}` };
/** NodeBB's API tokens whose description mentions `text` (ACP → API Access; every page). */
async function forumTokens(text) {
	const found = [];
	for (let page = 1; ; page += 1) {
		// eslint-disable-next-line no-await-in-loop
		const body = await (await fetch(`${fx.url}/api/admin/manage/api?page=${page}`, { headers: asAdmin })).json();
		found.push(...body.tokens.filter(token => token.description.includes(text)));
		if (page >= (body.pagination?.pageCount ?? 1)) return found;
	}
}
async function grantsOf(username) {
	const { grants } = await (await fetch(`${fx.url}/api/admin/plugins/mcp`, { headers: asAdmin })).json();
	return grants.filter(grant => grant.username === username);
}

test('the forum advertises MCP and OAuth at its own address, and asks for a token', opts, async () => {
	const prm = await (await fetch(`${FORUM}/.well-known/oauth-protected-resource/api/mcp`)).json();
	assert.equal(prm.resource, `${FORUM}/api/mcp`);
	const as = await (await fetch(`${FORUM}/.well-known/oauth-authorization-server/api/mcp`)).json();
	assert.equal(as.issuer, `${FORUM}/api/mcp`);
	assert.equal(as.authorization_endpoint, `${FORUM}/api/mcp/oauth/authorize`);
	assert.deepEqual(as.code_challenge_methods_supported, ['S256']);

	const anonymous = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	assert.equal(anonymous.status, 401);
	assert.match(anonymous.headers.get('www-authenticate') ?? '', /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/api\/mcp"/);
	// NodeBB keeps its own routes: /register is still the forum's sign-up page.
	assert.equal((await fetch(`${FORUM}/register`)).status, 200);
	// The endpoint lives in NodeBB's API namespace; there is no top-level /mcp.
	assert.equal(ENDPOINT, `${FORUM}/api/mcp`);
	const top = await fetch(`${FORUM}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	assert.notEqual(top.status, 401, 'not an MCP endpoint');
	assert.equal((await fetch(`${ENDPOINT}`)).status, 405, 'GET: stateless, POST only');
});

test('the Connect page refuses to be framed, and keeps NodeBB\'s JSON side for the forum\'s own navigation', opts, async () => {
	const jar = await forumSignIn(FORUM, person('e2e_reporter'));
	const page = await jar.fetch(`${FORUM}/mcp/connect?request=nothing-here`);
	assert.equal(page.status, 200);
	assert.equal(page.headers.get('x-frame-options'), 'DENY');
	assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
	assert.match(await page.text(), /This connection link has expired/);
	const json = await jar.fetch(`${FORUM}/api/mcp/connections`);
	assert.equal(json.status, 200);
	assert.equal((await json.json()).title, 'Connected apps');
});

test('two people connect with their own forum accounts and each acts as themselves', opts, async () => {
	const [helper, outsider] = await Promise.all([connect('e2e_helper'), connect('e2e_outsider')]);
	assert.match((await helper.call('forum_capabilities')).text,
		new RegExp(`Acting as:\\*\\* e2e_helper \\(uid ${fx.uids.helper}\\) — verified by the forum`));
	assert.match((await outsider.call('forum_capabilities')).text, /Acting as:\*\* e2e_outsider/);

	const [board, refused] = await Promise.all([
		helper.call('get_triage_board', { team: fx.teamId }),
		outsider.call('get_triage_board'),
	]);
	assert.match(board.text, /# Triage board — Support & Ops \(e2e-support\)/);
	assert.match(refused.text, /e2e_outsider is not a member of any triage team/);

	// A Shotef ticket action, through the person's own NodeBB token.
	const note = await helper.call('add_ticket_note', { tid: T().symlink.tid, body: `via the plugin ${RUN}` });
	assert.equal(note.isError, false, note.text);
	assert.match((await helper.call('get_ticket', { tid: T().symlink.tid })).text, new RegExp(`e2e_helper: via the plugin ${RUN}`));

	// Public writes are off unless an administrator turns them on.
	const { tools } = await helper.client.listTools();
	assert.ok(!tools.some(tool => tool.name === 'create_topic'));
	assert.match((await helper.call('forum_capabilities')).text, /Public writes .* An administrator can turn them on in ACP → Plugins → MCP/);
});

test('each connection is a NodeBB API token for the person, listed in the ACP', opts, async () => {
	await connect('e2e_reporter', `e2e token ${RUN}`);
	const [token] = await forumTokens(`e2e token ${RUN}`);
	assert.ok(token, 'a token described after the app');
	assert.equal(token.uid, fx.uids.reporter);
	assert.equal(token.description, `MCP: e2e token ${RUN} (e2e_reporter)`);
	const [grant] = (await grantsOf('e2e_reporter')).filter(g => g.clientName === `e2e token ${RUN}`);
	assert.ok(grant, 'and a row on the ACP page');
});

test('declining on the Connect page sends the client back with access_denied', opts, async () => {
	const oauth = new TestOAuthClient(`e2e decline ${RUN}`);
	assert.equal((await tryConnect(ENDPOINT, oauth)).client, null);
	const answer = await allowInBrowser(oauth.authorizationUrl, { forumUrl: FORUM, ...person('e2e_reporter'), action: 'deny' });
	assert.equal(answer.error, 'access_denied');
	assert.equal(answer.code, undefined);
	assert.match(answer.page, new RegExp(`Connect e2e decline ${RUN}`));
	assert.equal((await forumTokens(`e2e decline ${RUN}`)).length, 0, 'no token was made');
});

test('a Connect link works once: the page says it expired after that', opts, async () => {
	const oauth = new TestOAuthClient(`e2e once ${RUN}`);
	await tryConnect(ENDPOINT, oauth);
	const jar = await forumSignIn(FORUM, person('e2e_reporter'));
	const first = await allowInBrowser(oauth.authorizationUrl, { forumUrl: FORUM, jar });
	assert.ok(first.code);
	const again = await jar.fetch(first.page.match(/action="([^"]+)"/) ? `${FORUM}/mcp/connect?request=${/name="request" value="([^"]+)"/.exec(first.page)[1]}` : FORUM);
	assert.match(await again.text(), /This connection link has expired/);
});

test('a person disconnects an app from their Connected apps page, and it is cut off at once', opts, async () => {
	const name = `e2e disconnect ${RUN}`;
	const mcp = await connect('e2e_helper', name);
	assert.equal((await mcp.call('forum_capabilities')).isError, false);

	const jar = await forumSignIn(FORUM, person('e2e_helper'));
	const page = await (await jar.fetch(`${FORUM}/mcp/connections`)).text();
	assert.match(page, new RegExp(name));
	assert.match(page, new RegExp(`claude mcp add --transport http forum ${ENDPOINT}`));
	const [grant] = (await grantsOf('e2e_helper')).filter(g => g.clientName === name);
	const csrf = /name="csrf_token" value="([^"]+)"/.exec(page)[1];
	const res = await jar.fetch(`${FORUM}/mcp/connections/disconnect`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ csrf_token: csrf, grant: grant.id }),
	});
	assert.equal(res.status, 302);

	await assert.rejects(mcp.call('forum_capabilities'), /401|Unauthorized|invalid_token/i);
	assert.equal((await tryConnect(ENDPOINT, mcp.oauth)).client, null, 'the client must connect again');
	assert.equal((await forumTokens(name)).length, 0, 'its NodeBB token is gone');
});

test('someone else cannot disconnect your app; an administrator can revoke it', opts, async () => {
	const name = `e2e revoke ${RUN}`;
	const mcp = await connect('e2e_helper', name);
	const [grant] = (await grantsOf('e2e_helper')).filter(g => g.clientName === name);

	const outsider = { authorization: `Bearer ${fx.tokens.outsider}` };
	const refused = await fetch(`${fx.url}/api/v3/plugins/mcp/grants/${grant.id}`, { method: 'DELETE', headers: outsider });
	assert.equal(refused.status, 403);
	assert.equal((await mcp.call('forum_capabilities')).isError, false, 'still connected');

	const revoked = await fetch(`${fx.url}/api/v3/plugins/mcp/grants/${grant.id}`, { method: 'DELETE', headers: asAdmin });
	assert.equal(revoked.status, 200);
	await assert.rejects(mcp.call('forum_capabilities'), /401|Unauthorized|invalid_token/i);
});

test('deleting the connection\'s API token in the ACP ends the connection too', opts, async () => {
	const name = `e2e token-delete ${RUN}`;
	const mcp = await connect('e2e_reporter', name);
	const [token] = await forumTokens(name);
	const res = await fetch(`${fx.url}/api/v3/admin/tokens/${token.tokenId}`, { method: 'DELETE', headers: asAdmin });
	assert.equal(res.status, 200);
	await assert.rejects(mcp.call('forum_capabilities'), /401|Unauthorized|invalid_token/i);
	assert.equal((await grantsOf('e2e_reporter')).filter(g => g.clientName === name).length, 0, 'the connection is gone from the ACP');
});

test('refresh tokens rotate; a used one is refused', opts, async () => {
	const mcp = await connect('e2e_reporter', `e2e refresh ${RUN}`);
	const { refresh_token: first } = mcp.oauth.tokens();
	const refresh = token => fetch(`${ENDPOINT}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: mcp.oauth.clientInformation().client_id }),
	});
	const ok = await refresh(first);
	assert.equal(ok.status, 200);
	const fresh = await ok.json();
	assert.ok(fresh.access_token && fresh.refresh_token !== first);
	const again = await refresh(first);
	assert.equal(again.status, 400);
	assert.equal((await again.json()).error, 'invalid_grant');
});
