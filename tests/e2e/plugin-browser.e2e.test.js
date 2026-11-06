/**
 * e2e in a real browser (headless Chromium): connecting an app the way a person
 * does — the forum's real login page, its Connect page, the redirect back — and
 * an administrator turning public writes on in the ACP. A browser enforces what
 * fetch does not (NodeBB's ajaxified login and redirects, form posts, CSP).
 * Skipped where Playwright is not installed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

import { TestOAuthClient, tryConnect } from '../oauth-harness.js';
import { e2e } from './harness.js';

const { fixture: fx, opts: forumOpts } = await e2e({ needs: 'full' });

let chromium;
try {
	({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
	chromium = undefined;
}
let FORUM;
let opts = forumOpts.skip ? forumOpts : chromium ? {} : { skip: 'Playwright is not installed' };
if (!opts.skip) {
	const prm = await fetch(`${fx.url}/.well-known/oauth-protected-resource/mcp`).catch(() => undefined);
	if (prm?.ok) FORUM = (await prm.json()).resource.replace(/\/mcp$/, '');
	else opts = { skip: 'nodebb-plugin-mcp is not active on the test forum' };
}

const RUN = `r${Date.now().toString(36)}`;

/** A client's redirect target that captures the code. */
async function callbackServer() {
	let deliver;
	const received = new Promise((resolve) => { deliver = resolve; });
	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://localhost');
		deliver(url.searchParams);
		res.writeHead(200, { 'content-type': 'text/html' }).end('<p>Connected. You can close this tab.</p>');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return { url: `http://localhost:${server.address().port}/callback`, received, close: () => server.close() };
}

async function signIn(context, username, password) {
	const page = await context.newPage();
	await page.goto(`${FORUM}/login`, { waitUntil: 'networkidle' });
	await page.fill('#username', username);
	await page.fill('#password', password);
	await Promise.all([page.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 15_000 }), page.click('#login')]);
	return page;
}

test('a person connects an app: forum login, the Connect page, Allow, and back to the app', opts, async (t) => {
	const callback = await callbackServer();
	const browser = await chromium.launch();
	t.after(async () => { callback.close(); await browser.close(); });

	const oauth = new TestOAuthClient(`e2e browser ${RUN}`, callback.url);
	const first = await tryConnect(FORUM, oauth);
	assert.equal(first.client, null);

	// Not signed in yet: the forum's own login page comes first, then the Connect page.
	const page = await (await browser.newContext()).newPage();
	await page.goto(oauth.authorizationUrl.href, { waitUntil: 'networkidle' });
	assert.match(page.url(), /\/login/);
	await page.fill('#username', 'e2e_reporter');
	await page.fill('#password', fx.password);
	await page.click('#login');
	const allow = page.locator('form[action$="/mcp/connect"] button[value="allow"]');
	await allow.waitFor({ timeout: 15_000 });
	assert.match(await page.locator('.mcp-connect').innerText(), new RegExp(`e2e browser ${RUN} wants to use .* as you, e2e_reporter`));

	await allow.click();
	const params = await callback.received;
	assert.ok(params.get('code'), `the app got a code (${params})`);
	await first.transport.finishAuth(params.get('code'));

	const second = await tryConnect(FORUM, oauth);
	assert.ok(second.client, 'connected');
	const result = await second.client.callTool({ name: 'forum_capabilities', arguments: {} });
	assert.match(result.content[0].text, /Acting as:\*\* e2e_reporter/);
	await second.client.close();
});

test('an administrator turns public writes on in the ACP, and connected apps get the write tools', opts, async (t) => {
	const callback = await callbackServer();
	const browser = await chromium.launch();
	t.after(async () => { callback.close(); await browser.close(); });

	const admin = await signIn(await browser.newContext(), 'admin', 'Test1234!');
	const toggle = async (on) => {
		await admin.goto(`${FORUM}/admin/plugins/mcp`, { waitUntil: 'networkidle' });
		await admin.locator('#publicWrites').setChecked(on);
		await admin.click('#mcp-save');
		await admin.locator('[component="toaster/tray"] .alert-success').first().waitFor({ timeout: 10_000 });
	};
	await toggle(false);
	t.after(() => toggle(false).catch(() => {}));

	// Connect an app through the real pages.
	const oauth = new TestOAuthClient(`e2e writes ${RUN}`, callback.url);
	const first = await tryConnect(FORUM, oauth);
	const person = await signIn(await browser.newContext(), 'e2e_reporter', fx.password);
	await person.goto(oauth.authorizationUrl.href, { waitUntil: 'networkidle' });
	await person.locator('form[action$="/mcp/connect"] button[value="allow"]').click();
	await first.transport.finishAuth((await callback.received).get('code'));
	const { client } = await tryConnect(FORUM, oauth);
	t.after(() => client.close());
	const names = async () => (await client.listTools()).tools.map(tool => tool.name);
	assert.ok(!(await names()).includes('create_topic'), 'off');

	await admin.goto(`${FORUM}/admin/plugins/mcp`, { waitUntil: 'networkidle' });
	assert.match(await admin.locator('.acp-page-container').innerText(), new RegExp(`e2e writes ${RUN}`), 'the connection is listed');
	await toggle(true);

	// NodeBB publishes the save to every forum process: the very next request has the tools.
	assert.ok((await names()).includes('create_topic'), 'write tools appear at once');
	await toggle(false);
	assert.ok(!(await names()).includes('create_topic'), 'and go again');
});
