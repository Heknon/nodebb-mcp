/**
 * One error type for everything that can go wrong talking to a forum, so tools
 * can turn failures into useful text instead of stack traces.
 */

export type FailureKind =
	| 'network'      // could not reach the forum at all
	| 'timeout'      // the forum did not answer in time
	| 'auth'         // 401/403 — missing or insufficient token
	| 'not-found'    // 404 — no such topic/category/route
	| 'unavailable'  // the route exists but the feature is not installed
	| 'rate-limit'   // 429
	| 'server'       // 5xx
	| 'bad-response' // unparseable body
	| 'bad-request'; // 4xx we caused

export class NodeBBError extends Error {
	readonly kind: FailureKind;
	readonly status: number | undefined;
	readonly path: string | undefined;
	/** NodeBB's `[[namespace:key]]` message, when it sent one. */
	readonly forumMessage: string | undefined;

	constructor(
		kind: FailureKind,
		message: string,
		opts: { status?: number; path?: string; forumMessage?: string; cause?: unknown } = {},
	) {
		super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
		this.name = 'NodeBBError';
		this.kind = kind;
		this.status = opts.status;
		this.path = opts.path;
		this.forumMessage = opts.forumMessage;
	}

	/** Actionable one-liner for a tool result. */
	get hint(): string {
		switch (this.kind) {
			case 'network':
				return 'Check NODEBB_URL and that the forum is reachable from this machine.';
			case 'timeout':
				return 'The forum did not respond in time; raise NODEBB_TIMEOUT_MS or retry.';
			case 'auth':
				return 'Set NODEBB_API_TOKEN (ACP -> Settings -> API Access). If it is a master token, also set NODEBB_UID.';
			case 'not-found':
				return 'The item does not exist, or is not visible to this token.';
			case 'unavailable':
				return 'The forum does not have the plugin that provides this feature.';
			case 'rate-limit':
				return 'The forum is rate-limiting this token; slow down and retry.';
			case 'server':
				return 'The forum returned a server error; check its logs.';
			case 'bad-response':
				return 'The response was not valid JSON — NODEBB_URL may point at a proxy or the wrong host.';
			case 'bad-request':
				return 'The request was rejected; check the arguments.';
		}
	}
}

/** True when a failure is worth retrying as-is. */
export function isTransient(err: unknown): boolean {
	return err instanceof NodeBBError &&
		(err.kind === 'network' || err.kind === 'timeout' || err.kind === 'server' || err.kind === 'rate-limit');
}
