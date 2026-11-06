/**
 * Drives the plugin's OAuth flow the way a real MCP client does — with the
 * SDK's own OAuth client (discovery, dynamic registration, PKCE, token
 * exchange, refresh) — and a scripted "browser" standing in for the person, who
 * signs in to the forum and answers its Connect page.
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

/** A cookie jar for one scripted browser. */
class Jar {
	constructor() { this.cookies = new Map(); }
	header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
	absorb(res) {
		for (const raw of res.headers.getSetCookie?.() ?? []) {
			const [pair] = raw.split(';');
			const at = pair.indexOf('=');
			if (at > 0) this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
		}
	}
	async fetch(url, init = {}) {
		const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie: this.header() } });
		this.absorb(res);
		return res;
	}
}

/** Sign a scripted browser in to the forum, the way NodeBB's login form does. */
export async function forumSignIn(forumUrl, { username, password }) {
	const jar = new Jar();
	const config = await (await jar.fetch(`${forumUrl}/api/config`)).json();
	const res = await jar.fetch(`${forumUrl}/api/v3/utilities/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-csrf-token': config.csrf_token },
		body: JSON.stringify({ username, password }),
	});
	if (!res.ok) throw new Error(`forum sign-in as ${username} failed: HTTP ${res.status} ${await res.text()}`);
	return jar;
}

/**
 * The person's browser: open the authorization URL (signed in to the forum, or
 * signed in on the way), answer the forum's Connect page, and follow the
 * redirect back. Returns the code (or error) the client receives.
 */
export async function allowInBrowser(authorizationUrl, { forumUrl, username, password, action = 'allow', jar }) {
	jar ??= await forumSignIn(forumUrl, { username, password });
	const start = await jar.fetch(authorizationUrl);
	const connect = start.headers.get('location');
	if (!connect) return { status: start.status, html: await start.text() };
	const page = await jar.fetch(new URL(connect, authorizationUrl));
	const html = await page.text();
	const request = /name="request" value="([^"]+)"/.exec(html)?.[1];
	const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1];
	if (!request || !csrf) return { status: page.status, html, location: page.headers.get('location') };
	const form = /<form[^>]*action="([^"]*\/mcp\/connect)"/.exec(html)?.[1] ?? '/mcp/connect';
	const res = await jar.fetch(new URL(form, page.url || authorizationUrl), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ csrf_token: csrf, request, action }),
	});
	const location = res.headers.get('location');
	if (!location) return { status: res.status, html: await res.text(), page: html };
	const back = new URL(location, authorizationUrl);
	return {
		status: res.status,
		code: back.searchParams.get('code') ?? undefined,
		error: back.searchParams.get('error') ?? undefined,
		state: back.searchParams.get('state') ?? undefined,
		location: back,
		page: html,
		jar,
	};
}

/** Connect an MCP client, re-using `oauth`'s saved tokens; null when sign-in is needed. */
/** Connect an MCP client to `endpoint` (the forum's /api/mcp), re-using `oauth`'s saved tokens. */
export async function tryConnect(endpoint, oauth) {
	const transport = new StreamableHTTPClientTransport(new URL(endpoint), { authProvider: oauth });
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
export async function connectWithSignIn(endpoint, credentials, oauth = new TestOAuthClient()) {
	const first = await tryConnect(endpoint, oauth);
	if (first.client) return wrap(first.client, oauth);
	const signIn = await allowInBrowser(oauth.authorizationUrl, credentials);
	if (!signIn.code) {
		const err = new Error(`sign-in did not return a code (HTTP ${signIn.status})`);
		err.signIn = signIn;
		throw err;
	}
	await first.transport.finishAuth(signIn.code);
	const second = await tryConnect(endpoint, oauth);
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
