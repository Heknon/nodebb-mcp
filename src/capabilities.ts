/**
 * What this particular forum can actually do.
 *
 * Every optional feature is probed against the live instance and cached for a
 * TTL. Nothing here throws for a missing feature: an absent plugin is a normal,
 * expected state that tools degrade around. Only an unreachable forum is an
 * error, and even that is reported rather than thrown.
 *
 * Probes, and why each one is the right question to ask:
 *   search — GET /api/search. NodeBB's search controller calls next() when no
 *            plugin listens on `filter:search.query`, so a forum with no search
 *            plugin 404s here. 403 means installed but not permitted.
 *   qna    — GET /api/unsolved. nodebb-plugin-question-and-answer registers
 *            /unsolved and /solved as page routes, so the Read API answers them
 *            only when the plugin is active.
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
}

export interface ForumInfo {
	reachable: boolean;
	url: string;
	version?: string;
	title?: string;
	authenticated: boolean;
	reason?: string;
}

export interface Capabilities {
	forum: ForumInfo;
	search: Capability;
	qna: Capability;
	shotef: Capability;
	probedAt: number;
}

export const AVAILABLE: Capability = { state: 'available' };

export function isUsable(capability: Capability): boolean {
	return capability.state === 'available';
}

/** Classify a probe failure without ever throwing. */
function classify(err: unknown, absentReason: string): Capability {
	if (err instanceof NodeBBError) {
		switch (err.kind) {
			case 'not-found':
				return { state: 'absent', reason: absentReason };
			case 'auth':
				return {
					state: 'forbidden',
					reason: 'Installed, but this token may not use it. Set or widen NODEBB_API_TOKEN.',
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
		const forum = await this.probeForum();

		// No point probing features on a forum we cannot reach.
		if (!forum.reachable) {
			const unknown: Capability = { state: 'unknown', reason: 'Forum unreachable; not probed.' };
			const result: Capabilities = {
				forum,
				search: unknown,
				qna: unknown,
				shotef: unknown,
				probedAt: Date.now(),
			};
			this.cached = result;
			return result;
		}

		const [search, qna, shotef] = await Promise.all([
			this.probeSearch(),
			this.probeQna(),
			this.probeShotef(),
		]);

		const result: Capabilities = { forum, search, qna, shotef, probedAt: Date.now() };
		this.cached = result;
		return result;
	}

	private async probeForum(): Promise<ForumInfo> {
		try {
			const config = await this.client.read<Record<string, unknown>>('/config');
			return {
				reachable: true,
				url: this.client.baseUrl,
				version: typeof config?.version === 'string' ? config.version : undefined,
				title: typeof config?.siteTitle === 'string' ? config.siteTitle : undefined,
				authenticated: this.client.hasToken,
			};
		} catch (err) {
			return {
				reachable: false,
				url: this.client.baseUrl,
				authenticated: this.client.hasToken,
				reason: err instanceof NodeBBError ? `${err.message} ${err.hint}` : String(err),
			};
		}
	}

	private async probeSearch(): Promise<Capability> {
		try {
			await this.client.read('/search', { term: 'nodebb', in: 'titles', searchOnly: 1 });
			return AVAILABLE;
		} catch (err) {
			return classify(
				err,
				'No search plugin is active on this forum (NodeBB core has no search of its own). ' +
					'Install nodebb-plugin-dbsearch to enable it.',
			);
		}
	}

	private async probeQna(): Promise<Capability> {
		try {
			await this.client.read('/unsolved');
			return AVAILABLE;
		} catch (err) {
			return classify(err, 'nodebb-plugin-question-and-answer is not active on this forum.');
		}
	}

	private async probeShotef(): Promise<Capability> {
		try {
			await this.client.v3(`/plugins/${this.config.shotefNamespace}/ping`);
			return AVAILABLE;
		} catch (err) {
			return classify(err, 'The Shotef triage plugin is not active on this forum.');
		}
	}
}
