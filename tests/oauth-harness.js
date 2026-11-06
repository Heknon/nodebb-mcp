/**
 * Drives nodebb-mcp's OAuth flow the way a real MCP client does — with the
 * SDK's own OAuth client (discovery, dynamic registration, PKCE, token
 * exchange, refresh) — and a scripted "browser" standing in for the person who
 * fills in the sign-in page.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const REDIRECT = 'http://localhost:53682/callback';

/** An in-memory OAuthClientProvider: the client's side of the flow. */
export class TestOAuthClient {
	constructor(name = 'nodebb-mcp test client', redirect = REDIRECT) {
		this.name = name;
		this.redirect = redirect;
		this.info = undefined;
		this.saved = undefined;
		this.verifier = undefined;
		this.authorizationUrl = undefined;
	}

	get redirectUrl() { return this.redirect; }

	get clientMetadata() {
		return {
			client_name: this.name,
			redirect_uris: [this.redirect],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		};
	}

	clientInformation() { return this.info; }
	saveClientInformation(info) { this.info = info; }
	tokens() { return this.saved; }
	saveTokens(tokens) { this.saved = tokens; }
	saveCodeVerifier(verifier) { this.verifier = verifier; }
	codeVerifier() { return this.verifier; }
	/** "Open the browser": remember where the person would be sent. */
	redirectToAuthorization(url) { this.authorizationUrl = url; }
	invalidateCredentials(scope) {
		if (scope === 'all' || scope === 'tokens') this.saved = undefined;
		if (scope === 'all' || scope === 'client') this.info = undefined;
		if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
	}
}

/**
 * Submit a sign-in page's form the way a browser does: to its `action`,
 * resolved against the URL the page was served from.
 */
export async function submitSignInForm(pageUrl, html, { username, password, action = 'allow' }) {
	const request = /name="request" value="([^"]+)"/.exec(html)?.[1];
	const target = /<form[^>]*action="([^"]*)"/.exec(html)?.[1];
	if (!request || target === undefined) return { status: 0, html };
	const form = new URLSearchParams({ request, username, password, action });
	const res = await fetch(new URL(target, pageUrl), {
		method: 'POST',
		body: form,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		redirect: 'manual',
	});
	const location = res.headers.get('location');
	if (!location) return { status: res.status, html: await res.text(), pageUrl: res.url };
	const back = new URL(location);
	return {
		status: res.status,
		code: back.searchParams.get('code') ?? undefined,
		error: back.searchParams.get('error') ?? undefined,
		state: back.searchParams.get('state') ?? undefined,
		location: back,
	};
}

/**
 * The person's browser: open the authorization URL, fill in the sign-in form,
 * and follow it to the redirect. Returns the code (or error) the client gets.
 */
export async function signInWithBrowser(authorizationUrl, { username, password, action = 'allow' }) {
	const page = await fetch(authorizationUrl, { redirect: 'manual' });
	const html = await page.text();
	const request = /name="request" value="([^"]+)"/.exec(html)?.[1];
	if (!request) return { status: page.status, html };

	const target = /<form[^>]*action="([^"]*)"/.exec(html)?.[1] ?? '';
	const form = new URLSearchParams({ request, username, password, action });
	const res = await fetch(new URL(target, page.url), {
		method: 'POST',
		body: form,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		redirect: 'manual',
	});
	const location = res.headers.get('location');
	if (!location) return { status: res.status, html: await res.text(), pageUrl: res.url, signInPage: html };
	const back = new URL(location);
	return {
		status: res.status,
		code: back.searchParams.get('code') ?? undefined,
		error: back.searchParams.get('error') ?? undefined,
		state: back.searchParams.get('state') ?? undefined,
		location: back,
		signInPage: html,
	};
}

/** Connect an MCP client, re-using `oauth`'s saved tokens; null when sign-in is needed. */
export async function tryConnect(baseUrl, oauth) {
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), { authProvider: oauth });
	const client = new Client({ name: oauth.name, version: '0.0.0' });
	try {
		await client.connect(transport);
	} catch (err) {
		if (err instanceof UnauthorizedError) return { client: null, transport };
		throw err;
	}
	return { client, transport };
}

/**
 * The whole first connection: the client finds it must sign in, the person
 * signs in in the "browser", the client finishes the exchange and reconnects.
 */
export async function connectWithSignIn(baseUrl, credentials, oauth = new TestOAuthClient()) {
	const first = await tryConnect(baseUrl, oauth);
	if (first.client) return wrap(first.client, oauth);
	const signIn = await signInWithBrowser(oauth.authorizationUrl, credentials);
	if (!signIn.code) {
		const err = new Error(`sign-in did not return a code (HTTP ${signIn.status})`);
		err.signIn = signIn;
		throw err;
	}
	await first.transport.finishAuth(signIn.code);
	const second = await tryConnect(baseUrl, oauth);
	if (!second.client) throw new Error('still unauthorized after signing in');
	return wrap(second.client, oauth, signIn);
}

function wrap(client, oauth, signIn) {
	return {
		client,
		oauth,
		signIn,
		async call(name, args = {}) {
			const result = await client.callTool({ name, arguments: args });
			return { text: result.content.map(part => part.text ?? '').join('\n'), isError: Boolean(result.isError) };
		},
		async close() {
			await client.close().catch(() => {});
		},
	};
}
