/**
 * Thin HTTP client for a NodeBB forum.
 *
 * Covers both surfaces NodeBB exposes:
 *   - the Read API  (`/api/...`)    — every page route also answers JSON here
 *   - the Write API (`/api/v3/...`) — wrapped in a { status, response } envelope
 *
 * Two ways to have an identity:
 *   - an API token (ACP -> Settings -> API Access), sent as a bearer token. A
 *     *master* token also needs a `_uid` on every call (NODEBB_UID). Bearer auth
 *     is exempt from CSRF.
 *   - a username and password (session.ts): the client signs in like a browser,
 *     sends the session cookie and, on writes, the CSRF token, and signs in again
 *     by itself when the session expires.
 * A token wins when both are configured.
 */

import type { Config } from './config.js';
import { NodeBBError, type FailureKind } from './errors.js';
import { PasswordSession } from './session.js';
import { USER_AGENT } from './version.js';

export interface RequestOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
	query?: Record<string, string | number | boolean | string[] | undefined>;
	body?: unknown;
	/** Treat a 404 as an empty result rather than an error. */
	allowNotFound?: boolean;
	signal?: AbortSignal;
}

function kindForStatus(status: number): FailureKind {
	if (status === 401 || status === 403) return 'auth';
	if (status === 404) return 'not-found';
	if (status === 429) return 'rate-limit';
	if (status >= 500) return 'server';
	return 'bad-request';
}

/** Pull NodeBB's `[[namespace:key]]` message out of whatever it sent back. */
function extractForumMessage(payload: unknown): string | undefined {
	if (typeof payload === 'string') return payload || undefined;
	if (!payload || typeof payload !== 'object') return undefined;
	const obj = payload as Record<string, unknown>;

	const status = obj.status as Record<string, unknown> | undefined;
	if (status && typeof status.message === 'string' && status.message !== 'OK') {
		return status.message;
	}
	for (const key of ['message', 'error']) {
		const v = obj[key];
		if (typeof v === 'string' && v) return v;
	}
	return undefined;
}

/** NodeBB v3 wraps payloads in { status: {...}, response: {...} }. */
function unwrapEnvelope(payload: unknown): unknown {
	if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
		const obj = payload as Record<string, unknown>;
		if ('response' in obj && 'status' in obj) return obj.response;
	}
	return payload;
}

export type AuthMode = 'token' | 'password' | 'none';

interface SendResult {
	status: number;
	ok: boolean;
	contentType: string;
	text: string;
	/** Session generation the request was sent on (password mode). */
	generation: number;
}

export class NodeBBClient {
	/** Present when signing in with NODEBB_USERNAME / NODEBB_PASSWORD (and no token). */
	readonly session: PasswordSession | undefined;
	private readonly sessionCheckMs: number = 30_000;

	/**
	 * @param session a signed-in session to use instead of the configured
	 *        credentials — how the HTTP server gives each OAuth user their own.
	 */
	constructor(private readonly config: Config, opts: { session?: PasswordSession } = {}) {
		if (opts.session) {
			this.session = opts.session;
			this.sessionCheckMs = config.sessionCheckMs;
		} else if (!config.token && config.username && config.password) {
			this.session = new PasswordSession({
				url: config.url,
				username: config.username,
				password: config.password,
				sessionFile: config.sessionFile,
				timeoutMs: config.timeoutMs,
			});
			this.sessionCheckMs = config.sessionCheckMs;
		}
	}

	/** Set once the loopback address (`apiUrl`) refused a connection: use the public URL from then on. */
	private loopbackFailed = false;

	get baseUrl(): string {
		return this.config.url;
	}

	/** How this client authenticates. A token wins over a username/password pair. */
	get authMode(): AuthMode {
		if (this.session) return 'password';
		return this.config.token ? 'token' : 'none';
	}

	/** Absolute forum URL for a path — used to cite sources in tool output. */
	link(path: string): string {
		return `${this.config.url}${path.startsWith('/') ? path : `/${path}`}`;
	}

	private buildUrl(path: string, query: RequestOptions['query']): string {
		const base = this.loopbackFailed ? this.config.url : (this.config.apiUrl ?? this.config.url);
		const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === undefined) continue;
			if (Array.isArray(value)) {
				// NodeBB reads repeated params as arrays (categories, hasTags).
				for (const item of value) url.searchParams.append(`${key}[]`, String(item));
			} else {
				url.searchParams.set(key, String(value));
			}
		}
		// Master tokens are rejected without an acting uid.
		if (!this.session && this.config.token && this.config.uid && !url.searchParams.has('_uid')) {
			url.searchParams.set('_uid', this.config.uid);
		}
		return url.toString();
	}

	async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
		const method = options.method ?? 'GET';
		// Write API reads (e.g. Shotef's board) carry no sign of who they were
		// served to, so a dead session would silently give guest results. Confirm
		// the session first when it has not been confirmed recently.
		if (this.session && method === 'GET' && path.startsWith('/api/v3') &&
			this.session.needsConfirmation(this.sessionCheckMs)) {
			await this.read('/config');
		}

		let result = await this.send(path, options);
		// A password session can expire or be revoked. NodeBB does not say so with
		// an error: reads quietly come back as a guest. Sign in again and retry once.
		if (this.session && this.sessionLost(result, method)) {
			const changed = await this.session.renew(result.generation);
			// A read is safe to send again. A write only when the session changed (a new
			// sign-in, a fresh CSRF token): otherwise the refusal stands, and repeating a
			// write a proxy refused after the forum applied it would apply it twice.
			if (changed || method === 'GET') result = await this.send(path, options);
		}
		if (this.session && result.ok && result.text.includes('"loggedIn":true')) this.session.confirm();
		return this.interpret<T>(result, path, options);
	}

	/**
	 * Signs that the password session no longer works: an explicit 401; a
	 * CSRF refusal on a write (plain-text 403 — a new session has a new token);
	 * or a page payload served to a guest while we believed we were signed in.
	 */
	private sessionLost(result: SendResult, method: string): boolean {
		if (result.status === 401) return true;
		const json = result.contentType.includes('json');
		if (result.status === 403 && !json && method !== 'GET') return true;
		if (json && result.ok && this.session && this.session.uid > 0 && result.text.includes('"loggedIn":false')) {
			try {
				return (JSON.parse(result.text) as Record<string, unknown>).loggedIn === false;
			} catch {
				return false;
			}
		}
		return false;
	}

	private async send(path: string, options: RequestOptions): Promise<SendResult> {
		const { method = 'GET', query, body } = options;
		const url = this.buildUrl(path, query);

		if (this.session) await this.session.ensure();
		const generation = this.session?.currentGeneration ?? 0;

		const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT };
		if (this.session) Object.assign(headers, this.session.headers(method));
		else if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
		if (body !== undefined) headers['content-type'] = 'application/json';

		const timeout = AbortSignal.timeout(this.config.timeoutMs);
		const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers,
				signal,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (cause) {
			const aborted = cause instanceof Error &&
				(cause.name === 'TimeoutError' || cause.name === 'AbortError');
			// Inside the plugin, requests go to the forum over loopback. Where that address
			// does not answer (a container, a bind address, a port NodeBB was not told about),
			// the connection fails at once: fall back to the public URL for good and retry.
			if (!aborted && !this.loopbackFailed && this.config.apiUrl && this.config.apiUrl !== this.config.url) {
				this.loopbackFailed = true;
				return this.send(path, options);
			}
			const where = new URL(url);
			where.search = '';
			throw new NodeBBError(
				aborted ? 'timeout' : 'network',
				aborted
					? `Request to ${path} timed out after ${this.config.timeoutMs}ms`
					: `Could not reach the forum at ${where.href}${describeCause(cause)}`,
				{ path, cause },
			);
		}
		this.session?.absorb(response);

		return {
			status: response.status,
			ok: response.ok,
			contentType: response.headers.get('content-type') ?? '',
			text: await response.text(),
			generation,
		};
	}

	private interpret<T>(result: SendResult, path: string, options: RequestOptions): T {
		const { allowNotFound = false } = options;
		const { status, ok, contentType, text } = result;

		// A redirect to the login page comes back as HTML, not an auth status.
		if (!contentType.includes('json')) {
			if (ok) {
				throw new NodeBBError('bad-response', `Expected JSON from ${path} but got ${contentType || 'no content-type'}`, {
					status,
					path,
				});
			}
			if (status === 404 && allowNotFound) return undefined as T;
			throw new NodeBBError(kindForStatus(status), `${path} failed with HTTP ${status}`, { status, path });
		}

		let payload: unknown;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch (cause) {
			throw new NodeBBError('bad-response', `Malformed JSON from ${path}`, { status, path, cause });
		}

		if (!ok) {
			if (status === 404 && allowNotFound) return undefined as T;
			const forumMessage = extractForumMessage(payload);
			throw new NodeBBError(
				kindForStatus(status),
				`${path} failed with HTTP ${status}${forumMessage ? `: ${forumMessage}` : ''}`,
				{ status, path, forumMessage },
			);
		}

		return unwrapEnvelope(payload) as T;
	}

	/** GET a Read API path (`/api/...`). */
	read<T = unknown>(path: string, query?: RequestOptions['query'], allowNotFound = false): Promise<T> {
		return this.request<T>(`/api${path}`, { query, allowNotFound });
	}

	/** GET a Write API path (`/api/v3/...`), envelope already unwrapped. */
	v3<T = unknown>(path: string, query?: RequestOptions['query'], allowNotFound = false): Promise<T> {
		return this.request<T>(`/api/v3${path}`, { query, allowNotFound });
	}

	/**
	 * A mutating Write API call. Bearer auth is exempt from NodeBB's CSRF check,
	 * and a master token's `_uid` rides on the query string like every other call.
	 */
	write<T = unknown>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
		return this.request<T>(`/api/v3${path}`, { method, body: body ?? {} });
	}
}

/** The low-level reason fetch failed (ECONNREFUSED, ENOTFOUND, a certificate error...), for the message. */
function describeCause(cause: unknown): string {
	const inner = cause instanceof Error ? (cause.cause as { code?: string; message?: string } | undefined) : undefined;
	const reason = inner?.code ?? inner?.message ?? (cause instanceof Error ? cause.message : '');
	return reason ? ` (${String(reason).replace(/[^\x20-\x7e]/g, '?')})` : '';
}
