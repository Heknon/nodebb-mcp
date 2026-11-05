/**
 * What this particular forum can actually do — and who we actually are on it.
 *
 * Every optional feature is probed against the live instance and cached for a
 * TTL. Nothing here throws for a missing feature: an absent plugin is a normal,
 * expected state that tools degrade around. Only an unreachable forum is an
 * error, and even that is reported rather than thrown.
 *
 * Identity is verified, not assumed. NodeBB treats an invalid or revoked bearer
 * token as a *guest* rather than rejecting the request, so "a token is
 * configured" says nothing about whether it works. `/api/config` reports the
 * acting `uid`; a token with uid 0 behind it was not accepted.
 *
 * Probes, and why each one is the right question to ask:
 *   search — `/api/config` → `searchEnabled` says whether any plugin listens on
 *            `filter:search.query` (NodeBB core has no search of its own; v4
 *            activates nodebb-plugin-dbsearch by default). When it is on we still
 *            call /api/search once: the acting user also needs the
 *            `search:content` privilege, which guests lack by default (401).
 *   qna    — `/api/config` carries a `question-and-answer` key when
 *            nodebb-plugin-question-and-answer is active (filter:config.get).
 *            Falls back to GET /api/unsolved, its page route.
 *   shotef — GET /api/v3/plugins/<ns>/ping, the plugin's own liveness route.
 */

import type { NodeBBClient } from './client.js';
import type { Config } from './config.js';
import { NodeBBError } from './errors.js';

export type CapabilityState = 'available' | 'absent' | 'forbidden' | 'unknown';

export interface Capability {
	state: CapabilityState;
	/** Human-readable explanation, always set when state !== 'available'. */
	reason?: string;
	/** Available, but with a caveat worth surfacing (e.g. an outdated plugin). */
	warning?: string;
}

export interface ForumInfo {
	reachable: boolean;
	url: string;
	/** Only some forums expose it; NodeBB v4 does not in /api/config. */
	version?: string;
	title?: string;
	/** A token is configured (says nothing about whether it was accepted). */
	tokenConfigured: boolean;
	/** The forum accepted our credentials and acts as a real user. */
	authenticated: boolean;
	/** Acting uid as the forum sees it; 0 = guest. */
	uid: number;
	username?: string;
	/** Set when a token is configured but the forum did not honour it. */
	authProblem?: string;
	reason?: string;
}

export interface Capabilities {
	forum: ForumInfo;
	search: Capability;
	qna: Capability;
	shotef: Capability;
	/** Whether this server will perform writes (NODEBB_ENABLE_WRITES + an identity). */
	writes: Capability;
	probedAt: number;
}

export const AVAILABLE: Capability = { state: 'available' };

export function isUsable(capability: Capability): boolean {
	return capability.state === 'available';
}

/** Classify a probe failure without ever throwing. */
function classify(err: unknown, absentReason: string, forbiddenReason?: string): Capability {
	if (err instanceof NodeBBError) {
		switch (err.kind) {
			case 'not-found':
				return { state: 'absent', reason: absentReason };
			case 'auth':
				return {
					state: 'forbidden',
					reason: forbiddenReason ?? 'Installed, but the acting user may not use it.',
				};
			case 'network':
			case 'timeout':
				return { state: 'unknown', reason: `Could not probe: ${err.message}` };
			default:
				return { state: 'unknown', reason: `Probe returned ${err.kind}: ${err.message}` };
		}
	}
	return { state: 'unknown', reason: `Probe failed: ${String(err)}` };
}

type Raw = Record<string, any>;

export class CapabilityRegistry {
	private cached: Capabilities | undefined;
	private inFlight: Promise<Capabilities> | undefined;

	constructor(
		private readonly client: NodeBBClient,
		private readonly config: Config,
	) {}

	/** Cached capabilities, re-probing when the TTL has expired. */
	async get(force = false): Promise<Capabilities> {
		const fresh = this.cached &&
			Date.now() - this.cached.probedAt < this.config.capabilityTtlMs;
		if (!force && fresh) return this.cached!;
		// Collapse concurrent probes — a burst of tool calls should cause one sweep.
		if (this.inFlight) return this.inFlight;

		this.inFlight = this.probe().finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	/** Drop the cache, e.g. after the operator installs a plugin. */
	invalidate(): void {
		this.cached = undefined;
	}

	private async probe(): Promise<Capabilities> {
		const { forum, siteConfig } = await this.probeForum();

		// No point probing features on a forum we cannot reach.
		if (!forum.reachable) {
			const unknown: Capability = { state: 'unknown', reason: 'Forum unreachable; not probed.' };
			const result: Capabilities = {
				forum,
				search: unknown,
				qna: unknown,
				shotef: unknown,
				writes: this.writesCapability(forum),
				probedAt: Date.now(),
			};
			this.cached = result;
			return result;
		}

		const [search, qna, shotef] = await Promise.all([
			this.probeSearch(siteConfig, forum),
			this.probeQna(siteConfig),
			this.probeShotef(forum),
		]);

		const result: Capabilities = {
			forum,
			search,
			qna,
			shotef,
			writes: this.writesCapability(forum),
			probedAt: Date.now(),
		};
		this.cached = result;
		return result;
	}

	private writesCapability(forum: ForumInfo): Capability {
		if (!this.config.enableWrites) {
			return {
				state: 'absent',
				reason: 'Read-only mode. Set NODEBB_ENABLE_WRITES=1 to enable posting and triage actions.',
			};
		}
		if (!forum.reachable) return { state: 'unknown', reason: 'Forum unreachable.' };
		if (!forum.authenticated) {
			return {
				state: 'forbidden',
				reason: forum.authProblem ??
					'Writes need an identity: set NODEBB_API_TOKEN (and NODEBB_UID for a master token).',
			};
		}
		return AVAILABLE;
	}

	private async probeForum(): Promise<{ forum: ForumInfo; siteConfig?: Raw }> {
		const base = {
			url: this.client.baseUrl,
			tokenConfigured: this.client.hasToken,
			authenticated: false,
			uid: 0,
		};

		let siteConfig: Raw;
		try {
			siteConfig = await this.client.read<Raw>('/config');
		} catch (err) {
			// A master token without _uid makes the Read API answer 500 with no
			// explanation, while the Write API says exactly what is wrong. Ask it.
			const explained = this.client.hasToken ? await this.explainAuthFailure() : undefined;
			if (explained) {
				return { forum: { ...base, reachable: true, authProblem: explained } };
			}
			return {
				forum: {
					...base,
					reachable: false,
					reason: err instanceof NodeBBError ? `${err.message} ${err.hint}` : String(err),
				},
			};
		}

		const uid = Number.parseInt(String(siteConfig?.uid ?? 0), 10) || 0;
		const forum: ForumInfo = {
			...base,
			reachable: true,
			version: typeof siteConfig?.version === 'string' ? siteConfig.version : undefined,
			title: typeof siteConfig?.siteTitle === 'string' ? siteConfig.siteTitle : undefined,
			authenticated: uid > 0,
			uid,
		};

		if (this.client.hasToken && uid === 0) {
			forum.authProblem =
				'NODEBB_API_TOKEN was not accepted (invalid, revoked, or for a deleted user), so the forum is ' +
				'treating every request as a guest. NodeBB does not reject a bad token — it silently ' +
				'downgrades it. Generate a new token in ACP → Settings → API Access.';
		}
		if (uid > 0) forum.username = await this.lookupUsername(uid);
		return { forum, siteConfig };
	}

	/** Turn an opaque failure into the Write API's explanation, if it has one. */
	private async explainAuthFailure(): Promise<string | undefined> {
		try {
			await this.client.request('/api/v3/ping');
			return undefined;
		} catch (err) {
			if (!(err instanceof NodeBBError)) return undefined;
			const message = err.forumMessage ?? '';
			if (/master token|master-token|_uid/i.test(message)) {
				return 'NODEBB_API_TOKEN is a master token, which needs an acting user: set NODEBB_UID to the ' +
					`uid it should act as. (Forum said: ${message})`;
			}
			if (err.kind === 'auth') return `The forum rejected NODEBB_API_TOKEN: ${message || err.message}`;
			return undefined;
		}
	}

	private async lookupUsername(uid: number): Promise<string | undefined> {
		try {
			const user = await this.client.v3<Raw>(`/users/${uid}`);
			return typeof user?.username === 'string' ? user.username : undefined;
		} catch {
			return undefined;
		}
	}

	private async probeSearch(siteConfig: Raw | undefined, forum: ForumInfo): Promise<Capability> {
		const absent =
			'No search plugin is active on this forum (NodeBB core has no search of its own). ' +
			'Activate nodebb-plugin-dbsearch to enable it.';
		if (siteConfig && siteConfig.searchEnabled === false) {
			return { state: 'absent', reason: absent };
		}
		try {
			await this.client.read('/search', { term: 'nodebb', in: 'titles', searchOnly: 1 });
			return AVAILABLE;
		} catch (err) {
			return classify(
				err,
				absent,
				forum.authenticated
					? `Search is installed, but ${forum.username ?? `uid ${forum.uid}`} lacks the search:content privilege.`
					: 'Search is installed, but guests lack the search:content privilege (the NodeBB default). ' +
						'Set NODEBB_API_TOKEN to search as a user.',
			);
		}
	}

	private async probeQna(siteConfig: Raw | undefined): Promise<Capability> {
		if (siteConfig && 'question-and-answer' in siteConfig) return AVAILABLE;
		try {
			await this.client.read('/unsolved');
			return AVAILABLE;
		} catch (err) {
			return classify(err, 'nodebb-plugin-question-and-answer is not active on this forum.');
		}
	}

	private async probeShotef(forum: ForumInfo): Promise<Capability> {
		try {
			const ping = await this.client.v3<Raw>(`/plugins/${this.config.shotefNamespace}/ping`);
			const seenUid = Number.parseInt(String(ping?.uid ?? 0), 10) || 0;
			// Shotef releases before the setupApiRoute fix registered bare routes, which
			// skip NodeBB's token authentication: every token caller is a guest there.
			if (forum.authenticated && seenUid === 0) {
				return {
					state: 'available',
					warning:
						'This Shotef version ignores API tokens (its routes skip NodeBB\'s token authentication), ' +
						'so the board and team-only details are invisible to this server. Upgrade the plugin.',
				};
			}
			return AVAILABLE;
		} catch (err) {
			return classify(err, 'The Shotef triage plugin is not active on this forum.');
		}
	}
}
