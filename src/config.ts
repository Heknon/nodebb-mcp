/**
 * Runtime configuration, read from the environment.
 *
 * Only NODEBB_URL is required. Everything else has a working default so the
 * server can run against a public forum with no credentials at all.
 */

export interface Config {
	/** Base URL of the forum, no trailing slash. May include a subdirectory mount. */
	url: string;
	/** NodeBB API token (ACP -> Settings -> API Access). Optional. */
	token: string | undefined;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const url = env.NODEBB_URL?.trim();
	if (!url) {
		throw new ConfigError(
			'NODEBB_URL is required. Set it to your forum root, e.g. NODEBB_URL=https://forum.example.com',
		);
	}

	const token = env.NODEBB_API_TOKEN?.trim() || undefined;
	const uid = env.NODEBB_UID?.trim() || undefined;

	return {
		url: normalizeUrl(url),
		token,
		uid,
		timeoutMs: intFromEnv(env, 'NODEBB_TIMEOUT_MS', 15_000, 1_000, 120_000),
		shotefNamespace: env.NODEBB_SHOTEF_NAMESPACE?.trim() || 'shotef',
		capabilityTtlMs: intFromEnv(env, 'NODEBB_CAPABILITY_TTL_MS', 300_000, 0, 86_400_000),
		maxPostsPerTopic: intFromEnv(env, 'NODEBB_MAX_POSTS_PER_TOPIC', 50, 1, 200),
	};
}
