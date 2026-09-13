/**
 * Thin HTTP client for a NodeBB forum.
 *
 * Covers both surfaces NodeBB exposes:
 *   - the Read API  (`/api/...`)    — every page route also answers JSON here
 *   - the Write API (`/api/v3/...`) — wrapped in a { status, response } envelope
 *
 * Auth is a bearer token (ACP -> Settings -> API Access). A *master* token
 * additionally requires a `_uid` on every call, which is what NODEBB_UID is for;
 * a user token ignores it. Bearer auth bypasses CSRF entirely, so there is no
 * cookie/token dance to perform here.
 */

import type { Config } from './config.js';
import { NodeBBError, type FailureKind } from './errors.js';

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

export class NodeBBClient {
	constructor(private readonly config: Config) {}

	get baseUrl(): string {
		return this.config.url;
	}

	get hasToken(): boolean {
		return Boolean(this.config.token);
	}

	/** Absolute forum URL for a path — used to cite sources in tool output. */
	link(path: string): string {
		return `${this.config.url}${path.startsWith('/') ? path : `/${path}`}`;
	}

	private buildUrl(path: string, query: RequestOptions['query']): string {
		const url = new URL(`${this.config.url}${path.startsWith('/') ? path : `/${path}`}`);
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
		if (this.config.uid && !url.searchParams.has('_uid')) {
			url.searchParams.set('_uid', this.config.uid);
		}
		return url.toString();
	}

	async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
		const { method = 'GET', query, body, allowNotFound = false } = options;
		const url = this.buildUrl(path, query);

		const headers: Record<string, string> = { accept: 'application/json' };
		if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
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
			throw new NodeBBError(
				aborted ? 'timeout' : 'network',
				aborted
					? `Request to ${path} timed out after ${this.config.timeoutMs}ms`
					: `Could not reach the forum at ${this.config.url}${path}`,
				{ path, cause },
			);
		}

		const contentType = response.headers.get('content-type') ?? '';
		const text = await response.text();

		// A redirect to the login page comes back as HTML, not an auth status.
		if (!contentType.includes('json')) {
			if (response.ok) {
				throw new NodeBBError('bad-response', `Expected JSON from ${path} but got ${contentType || 'no content-type'}`, {
					status: response.status,
					path,
				});
			}
			if (response.status === 404 && allowNotFound) return undefined as T;
			throw new NodeBBError(kindForStatus(response.status), `${path} failed with HTTP ${response.status}`, {
				status: response.status,
				path,
			});
		}

		let payload: unknown;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch (cause) {
			throw new NodeBBError('bad-response', `Malformed JSON from ${path}`, {
				status: response.status,
				path,
				cause,
			});
		}

		if (!response.ok) {
			if (response.status === 404 && allowNotFound) return undefined as T;
			const forumMessage = extractForumMessage(payload);
			throw new NodeBBError(
				kindForStatus(response.status),
				`${path} failed with HTTP ${response.status}${forumMessage ? `: ${forumMessage}` : ''}`,
				{ status: response.status, path, forumMessage },
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
}
