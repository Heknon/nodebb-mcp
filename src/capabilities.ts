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

import type { AuthMode, NodeBBClient } from './client.js';
import type { Config } from './config.js';
import { NodeBBError } from './errors.js';
import { SignInError } from './session.js';

/** How to give the server an identity, for messages. */
const SIGN_IN_ADVICE = 'set NODEBB_USERNAME and NODEBB_PASSWORD (or NODEBB_API_TOKEN)';

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
	/** How the server signs in: an API token, a username/password, or not at all. */
	credentials: AuthMode;
	/** The forum accepted our credentials and acts as a real user. */
	authenticated: boolean;
	/** Acting uid as the forum sees it; 0 = guest. */
	uid: number;
	username?: string;
	/** Set when credentials are configured but the forum did not honour them. */
	authProblem?: string;
	/**
	 * Signing in failed or the session ended. Unlike a token the forum silently
	 * downgrades (which degrades to guest results, with a note), this stops every
	 * tool: guest results would be mistaken for the person's own view.
	 */
	signInError?: NodeBBError;
	reason?: string;
}

export interface Capabilities {
	forum: ForumInfo;
	search: Capability;
	qna: Capability;
	shotef: Capability;
	/**
	 * Public writes — posts, replies, edits, votes, accepting an answer: anything
	 * that changes what the forum's readers see. Needs NODEBB_ENABLE_WRITES and an
	 * identity.
	 */
	writes: Capability;
	/**
	 * Shotef team workflow — internal notes, status, assignment, priority, passing.
	 * Not gated by NODEBB_ENABLE_WRITES: it is the team's own working state, and
	 * Shotef authorizes every action against team membership. Needs Shotef and an
	 * identity.
	 */
	triage: Capability;
	probedAt: number;
}

export const AVAILABLE: Capability = { state: 'available' };

const SHOTEF_TICKET_API = '`/api/v3/plugins/shotef/tickets/…`';
const SHOTEF_UPDATE = 'Update Shotef to a build that includes its HTTP API (README → "HTTP API").';

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
	/**
	 * Capabilities for a tool about to act. Throws when signing in failed or the
	 * session ended, so the tool fails with that reason instead of degrading as
	 * if a plugin were missing.
	 */
	async get(force = false): Promise<Capabilities> {
		const caps = await this.report(force);
		if (caps.forum.signInError) throw caps.forum.signInError;
		return caps;
	}

	/** Capabilities as a report — never throws for a sign-in failure (forum_capabilities). */
	async report(force = false): Promise<Capabilities> {
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

		// No point probing features on a forum we cannot reach, or cannot sign in to.
		if (!forum.reachable || forum.signInError) {
			const unknown: Capability = {
				state: 'unknown',
				reason: forum.signInError ? 'Not probed: signing in to the forum failed.' : 'Forum unreachable; not probed.',
			};
			const result: Capabilities = {
				forum,
				search: unknown,
				qna: unknown,
				shotef: unknown,
				writes: this.writesCapability(forum),
				triage: unknown,
				probedAt: Date.now(),
			};
			this.cached = result;
			return result;
		}

		const [search, qna, { shotef, ticketApi }] = await Promise.all([
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
			triage: this.triageCapability(forum, shotef, ticketApi),
			probedAt: Date.now(),
		};
		this.cached = result;
		return result;
	}

	private writesCapability(forum: ForumInfo): Capability {
		if (!this.config.enableWrites) {
			return {
				state: 'absent',
				reason: 'Public writes are off. Set NODEBB_ENABLE_WRITES=1 to post, reply, edit, vote and accept answers.',
			};
		}
		if (!forum.reachable) return { state: 'unknown', reason: 'Forum unreachable.' };
		if (!forum.authenticated) {
			return {
				state: 'forbidden',
				reason: forum.authProblem ??
					`Writes need an identity: ${SIGN_IN_ADVICE}.`,
			};
		}
		return AVAILABLE;
	}

	private triageCapability(forum: ForumInfo, shotef: Capability, ticketApi: boolean): Capability {
		if (!isUsable(shotef)) {
			return { state: shotef.state, reason: `Triage actions need the Shotef plugin. ${shotef.reason ?? ''}`.trim() };
		}
		if (!ticketApi) {
			return {
				state: 'absent',
				reason: `This Shotef build has no HTTP ticket API (${SHOTEF_TICKET_API}), so tickets cannot be worked ` +
					`from here; the board stays readable. ${SHOTEF_UPDATE}`,
			};
		}
		if (!forum.authenticated) {
			return {
				state: 'forbidden',
				reason: forum.authProblem ??
					`Triage actions need a team member's identity: ${SIGN_IN_ADVICE}.`,
			};
		}
		return AVAILABLE;
	}

	private async probeForum(): Promise<{ forum: ForumInfo; siteConfig?: Raw }> {
		const base = {
			url: this.client.baseUrl,
			credentials: this.client.authMode,
			authenticated: false,
			uid: 0,
		};

		let siteConfig: Raw;
		try {
			siteConfig = await this.client.read<Raw>('/config');
		} catch (err) {
			// The forum answered, but refused the password: reachable, not signed in.
			if (err instanceof SignInError) {
				return { forum: { ...base, reachable: true, authProblem: `${err.message} ${err.hint}`, signInError: err } };
			}
			// A master token without _uid makes the Read API answer 500 with no
			// explanation, while the Write API says exactly what is wrong. Ask it.
			const explained = this.client.authMode === 'token' ? await this.explainAuthFailure() : undefined;
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

		if (this.client.authMode === 'token' && uid === 0) {
			forum.authProblem =
				'NODEBB_API_TOKEN was not accepted (invalid, revoked, or for a deleted user), so the forum is ' +
				'treating every request as a guest. NodeBB does not reject a bad token — it silently ' +
				'downgrades it. Generate a new token in ACP → Settings → API Access.';
		}
		if (this.client.authMode === 'password' && uid === 0) {
			// The client already signed in again once; the forum still sees a guest.
			forum.authProblem =
				`Signed in as "${this.client.session?.username}", but the forum still treats this server as a guest.`;
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
						`To search as a user, ${SIGN_IN_ADVICE}.`,
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

	private async probeShotef(forum: ForumInfo): Promise<{ shotef: Capability; ticketApi: boolean }> {
		const ns = this.config.shotefNamespace;
		let shotef: Capability = AVAILABLE;
		try {
			const ping = await this.client.v3<Raw>(`/plugins/${ns}/ping`);
			const seenUid = Number.parseInt(String(ping?.uid ?? 0), 10) || 0;
			// Shotef builds before its HTTP API registered bare routes, which skip
			// NodeBB's token authentication: every token caller is a guest there.
			if (forum.authenticated && seenUid === 0) {
				shotef = {
					state: 'available',
					warning:
						'This Shotef build ignores API tokens (its routes skip NodeBB\'s token authentication), so the ' +
						'board and team-only details are invisible to this server. Sign in with NODEBB_USERNAME / ' +
						`NODEBB_PASSWORD instead, which it honours. ${SHOTEF_UPDATE}`,
				};
			}
		} catch (err) {
			return { shotef: classify(err, 'The Shotef triage plugin is not active on this forum.'), ticketApi: false };
		}
		// The ticket routes arrived with the same change. Ticket 0 never exists: a
		// build that has them refuses it (400); one that does not answers NodeBB's 404.
		let ticketApi = true;
		try {
			await this.client.request(`/api/v3/plugins/${ns}/tickets/0`);
		} catch (err) {
			ticketApi = !(err instanceof NodeBBError && err.kind === 'not-found' && /Invalid API call/i.test(err.forumMessage ?? err.message));
		}
		return { shotef, ticketApi };
	}
}
