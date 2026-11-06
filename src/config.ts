/**
 * Runtime configuration, read from the environment.
 *
 * Only NODEBB_URL is required. Everything else has a working default so the
 * server can run against a public forum with no credentials at all.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';


export interface Config {
	/** Base URL of the forum, no trailing slash. May include a subdirectory mount. */
	url: string;
	/** NodeBB API token (ACP -> Settings -> API Access). Optional. Wins over a password. */
	token: string | undefined;
	/**
	 * Sign in with a username and password instead of a token: the server logs
	 * in like a browser would and keeps the session. Both or neither.
	 */
	username: string | undefined;
	password: string | undefined;
	/**
	 * Where the signed-in session is cached between server processes, so a new
	 * process reuses it instead of logging in again (NodeBB rate-limits logins
	 * per account and per IP). `undefined` disables the cache.
	 */
	sessionFile: string | undefined;
	/**
	 * How long a password session counts as confirmed. Write API reads carry no
	 * sign of who they were served to, so before one, a session not confirmed
	 * within this window is re-checked via /api/config (and renewed if needed).
	 */
	sessionCheckMs: number;
	/**
	 * Acts-as uid. Required by NodeBB when the token is a *master* token; ignored
	 * for user tokens. Sent as the `_uid` query parameter.
	 */
	uid: string | undefined;
	/** Per-request timeout in milliseconds. */
	timeoutMs: number;
	/**
	 * Plugin id namespace of the Shotef triage plugin under /api/v3/plugins/<id>.
	 * Configurable because a fork may mount elsewhere.
	 */
	shotefNamespace: string;
	/** How long a capability probe result is trusted before re-probing. */
	capabilityTtlMs: number;
	/** Max posts pulled per topic read. */
	maxPostsPerTopic: number;
	/**
	 * Register the public write tools (posting, replying, editing, voting,
	 * accepting an answer). Off by default: anything they write is immediately
	 * visible to the forum's users. Shotef's team-internal triage actions are not
	 * behind this flag — Shotef authorizes those itself.
	 */
	enableWrites: boolean;
	/**
	 * Run as a shared HTTP server instead of over stdio. Each person then signs
	 * in with their own forum account through OAuth (this server is its own
	 * authorization server, so nothing outside the forum is involved).
	 */
	http: HttpConfig | undefined;
}

export interface HttpConfig {
	port: number;
	/** Interface to bind; 127.0.0.1 unless told otherwise. */
	host: string;
	/**
	 * The URL clients reach this server at — the OAuth issuer, with the MCP
	 * endpoint at /mcp. An origin only (the OAuth endpoints live at its root).
	 * Undefined: http://localhost:<bound port>.
	 */
	publicUrl: string | undefined;
	/** Where OAuth clients, hashed tokens and each user's forum session are kept; undefined = memory. */
	stateFile: string | undefined;
}

export class ConfigError extends Error {}

function intFromEnv(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw === '') return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) {
		throw new ConfigError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
	}
	return Math.min(max, Math.max(min, n));
}

/** Normalize a base URL: absolute http(s), no trailing slash. */
export function normalizeUrl(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new ConfigError(
			`NODEBB_URL must be an absolute URL such as https://forum.example.com — got ${JSON.stringify(raw)}`,
		);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new ConfigError(`NODEBB_URL must be http or https, got ${parsed.protocol}`);
	}
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string): boolean {
	const raw = env[name]?.trim().toLowerCase();
	if (!raw) return false;
	if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
	if (['0', 'false', 'no', 'off'].includes(raw)) return false;
	throw new ConfigError(`${name} must be true/false (or 1/0), got ${JSON.stringify(env[name])}`);
}

/**
 * The session cache path: NODEBB_SESSION_FILE, or a per-forum, per-user file in
 * the user's cache directory. `off` disables it.
 */
function sessionFileFromEnv(env: NodeJS.ProcessEnv, url: string, username: string | undefined): string | undefined {
	if (!username) return undefined;
	const raw = env.NODEBB_SESSION_FILE?.trim();
	if (raw && ['off', 'none', 'false', '0'].includes(raw.toLowerCase())) return undefined;
	if (raw) return resolve(raw);
	const cacheHome = env.XDG_CACHE_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.cache');
	const key = createHash('sha256').update(`${url}\n${username}`).digest('hex').slice(0, 16);
	return join(cacheHome, 'nodebb-mcp', `session-${key}.json`);
}

function httpFromEnv(env: NodeJS.ProcessEnv, forumUrl: string): HttpConfig | undefined {
	const rawPort = env.NODEBB_MCP_HTTP_PORT?.trim();
	if (!rawPort) return undefined;
	const port = intFromEnv(env, 'NODEBB_MCP_HTTP_PORT', 0, 0, 65_535);
	const host = env.NODEBB_MCP_HTTP_HOST?.trim() || '127.0.0.1';
	const rawPublic = env.NODEBB_MCP_PUBLIC_URL?.trim();
	let publicUrl: string | undefined;
	if (rawPublic) {
		let parsed: URL;
		try {
			parsed = new URL(rawPublic);
		} catch {
			throw new ConfigError(`NODEBB_MCP_PUBLIC_URL must be an absolute URL, got ${JSON.stringify(rawPublic)}`);
		}
		if (parsed.pathname.replace(/\/+$/, '') || parsed.search) {
			throw new ConfigError(
				'NODEBB_MCP_PUBLIC_URL must be an origin such as https://mcp.example.com — the OAuth endpoints ' +
					'live at its root, so serve this server at the root of its own host name.',
			);
		}
		publicUrl = parsed.origin;
	}
	const rawState = env.NODEBB_MCP_STATE_FILE?.trim();
	let stateFile: string | undefined;
	if (!rawState) {
		const stateHome = env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.local', 'state');
		const key = createHash('sha256').update(forumUrl).digest('hex').slice(0, 16);
		stateFile = join(stateHome, 'nodebb-mcp', `oauth-${key}.json`);
	} else if (!['off', 'none', 'false', '0'].includes(rawState.toLowerCase())) {
		stateFile = resolve(rawState);
	}
	return { port, host, publicUrl, stateFile };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const url = env.NODEBB_URL?.trim();
	if (!url) {
		throw new ConfigError(
			'NODEBB_URL is required. Set it to your forum root, e.g. NODEBB_URL=https://forum.example.com',
		);
	}

	const token = env.NODEBB_API_TOKEN?.trim() || undefined;
	const uid = env.NODEBB_UID?.trim() || undefined;
	const username = env.NODEBB_USERNAME?.trim() || undefined;
	// Passwords may legitimately start or end with spaces: do not trim.
	const password = env.NODEBB_PASSWORD || undefined;
	if (Boolean(username) !== Boolean(password)) {
		throw new ConfigError(
			`Set both NODEBB_USERNAME and NODEBB_PASSWORD to sign in with a password (only ${username ? 'NODEBB_USERNAME' : 'NODEBB_PASSWORD'} is set).`,
		);
	}
	const base = normalizeUrl(url);

	return {
		url: base,
		token,
		uid,
		username,
		password,
		sessionFile: sessionFileFromEnv(env, base, username),
		sessionCheckMs: intFromEnv(env, 'NODEBB_SESSION_CHECK_MS', 30_000, 0, 3_600_000),
		timeoutMs: intFromEnv(env, 'NODEBB_TIMEOUT_MS', 15_000, 1_000, 120_000),
		shotefNamespace: env.NODEBB_SHOTEF_NAMESPACE?.trim() || 'shotef',
		capabilityTtlMs: intFromEnv(env, 'NODEBB_CAPABILITY_TTL_MS', 300_000, 0, 86_400_000),
		maxPostsPerTopic: intFromEnv(env, 'NODEBB_MAX_POSTS_PER_TOPIC', 50, 1, 200),
		enableWrites: boolFromEnv(env, 'NODEBB_ENABLE_WRITES'),
		http: httpFromEnv(env, base),
	};
}
