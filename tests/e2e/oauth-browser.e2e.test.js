/**
 * e2e: the OAuth sign-in in a real browser (headless Chromium via Playwright)
 * against the real forum. A browser enforces what fetch does not — CSP
 * form-action on the redirect back to the client, form actions resolved against
 * the page URL — and both broke sign-in once while every fetch-based test passed.
 * Skipped where Playwright is not installed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

import { loadConfig } from '../../dist/config.js';
import { startHttpServer } from '../../dist/http.js';
import { TestOAuthClient, tryConnect } from '../oauth-harness.js';
import { e2e } from './harness.js';

const { fixture: fx, opts: forumOpts } = await e2e({ needs: 'full' });

let chromium;
try {
	({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
	chromium = undefined;
}
const opts = forumOpts.skip ? forumOpts : chromium ? {} : { skip: 'Playwright is not installed' };

test('a person signs in through the real page in a real browser — after one typo — and the client connects', opts, async (t) => {
	const server = await startHttpServer(loadConfig({ NODEBB_URL: fx.url, NODEBB_MCP_HTTP_PORT: '0', NODEBB_MCP_STATE_FILE: 'off' }));
	t.after(() => server.close());

	// The client's own callback, as Claude Code runs one on localhost.
	let received;
	const gotCode = new Promise((done) => { received = done; });
	const callback = createServer((req, res) => {
		const url = new URL(req.url, 'http://localhost');
		res.end('You can close this window.');
		received(url.searchParams.get('code'));
	});
	await new Promise(done => callback.listen(0, '127.0.0.1', done));
	t.after(() => callback.close());
	const redirect = `http://localhost:${callback.address().port}/callback`;

	const oauth = new TestOAuthClient('Claude Code', redirect);
	const first = await tryConnect(server.url, oauth);
	assert.equal(first.client, null);

	const browser = await chromium.launch();
	t.after(() => browser.close());
	const page = await (await browser.newContext()).newPage();
	const blocked = [];
	page.on('console', (message) => { if (/Content Security Policy/.test(message.text())) blocked.push(message.text()); });

	await page.goto(oauth.authorizationUrl.href);
	await page.fill('#username', 'e2e_helper');
	await page.fill('#password', 'a-typo-in-the-password');
	await page.click('button.primary');
	await page.waitForSelector('.error');
	assert.match(await page.textContent('.error'), /Wrong username or password\./);

	// Retry from the page the person was shown.
	await page.fill('#password', fx.password);
	await page.click('button.primary');
	const code = await Promise.race([gotCode, new Promise((_, fail) => setTimeout(() => fail(new Error(`no redirect back to the client; CSP: ${blocked.join(' | ')}`)), 10000))]);
	assert.ok(code, 'the browser landed on the client callback with a code');
	assert.deepEqual(blocked, [], 'no CSP violations');

	await first.transport.finishAuth(code);
	const connected = await tryConnect(server.url, oauth);
	assert.ok(connected.client);
	t.after(() => connected.client.close());
	const result = await connected.client.callTool({ name: 'forum_capabilities', arguments: {} });
	assert.match(result.content[0].text, new RegExp(`Acting as:\\*\\* e2e_helper \\(uid ${fx.uids.helper}\\)`));
});
