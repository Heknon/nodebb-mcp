/**
 * Optional integration: the Shotef triage plugin.
 *
 * Shotef turns categories into a team-gated triage board: every tracked topic
 * carries a workflow status internally and a coarse, reporter-facing stage
 * publicly (received / in_progress / answered / closed). For issue
 * investigation that stage is the useful part — it says whether anyone is
 * already working on a problem and whether it was ever resolved.
 *
 * Access model, mirrored here so tools can explain what they can and cannot see:
 *   - public-status / public-statuses: any user who can read the topic
 *   - board / teams: team members and admins only
 *
 * Every function degrades to an explicit "not tracked" rather than throwing when
 * the plugin is absent.
 */

import type { NodeBBClient } from '../client.js';
import type { Capabilities } from '../capabilities.js';
import { isUsable } from '../capabilities.js';
import type { Config } from '../config.js';
import { NodeBBError } from '../errors.js';
import { decodeTitle } from '../text.js';

type Raw = Record<string, any>;

export interface TriageStatus {
	available: boolean;
	tracked: boolean;
	/** received | in_progress | answered | closed */
	status?: string;
	label?: string;
	/** Only meaningful when closed: 'resolved' | 'no_response' | … */
	closeReason?: string;
	updatedAt?: number;
	teamName?: string;
	/** True when the item is parked (blocked/deferred/backlog). */
	parked?: boolean;
	/** Internal sub-status; only returned to members of the handling team. */
	holdReason?: string;
	reason?: string;
}

const notAvailable = (reason?: string): TriageStatus => ({
	available: false,
	tracked: false,
	reason: reason ?? 'Shotef triage plugin not available.',
});

function base(config: Config): string {
	return `/plugins/${config.shotefNamespace}`;
}

/** Triage stage for one topic. */
export async function getTriageStatus(
	client: NodeBBClient,
	config: Config,
	capabilities: Capabilities,
	tid: number,
): Promise<TriageStatus> {
	if (!isUsable(capabilities.shotef)) return notAvailable(capabilities.shotef.reason);

	try {
		const raw = await client.v3<Raw>(`${base(config)}/public-status/${tid}`, undefined, true);
		if (!raw || !raw.tracked) return { available: true, tracked: false };

		return {
			available: true,
			tracked: true,
			status: typeof raw.status === 'string' ? raw.status : undefined,
			label: typeof raw.label === 'string' ? raw.label : undefined,
			closeReason: raw.closeReason || undefined,
			updatedAt: Number(raw.updatedAt) || undefined,
			teamName: decodeTitle(raw.teamName) || undefined,
			parked: Boolean(raw.parked),
			holdReason: raw.holdReason || undefined,
		};
	} catch (err) {
		// A topic we cannot read is a permission fact, not a crash.
		if (err instanceof NodeBBError && (err.kind === 'auth' || err.kind === 'not-found')) {
			return { available: true, tracked: false, reason: err.hint };
		}
		throw err;
	}
}

/** Triage stages for many topics at once (batched, max 200 per the plugin). */
export async function getTriageStatuses(
	client: NodeBBClient,
	config: Config,
	capabilities: Capabilities,
	tids: number[],
): Promise<Map<number, TriageStatus>> {
	const result = new Map<number, TriageStatus>();
	if (!isUsable(capabilities.shotef) || !tids.length) return result;

	const unique = [...new Set(tids.filter(Boolean))].slice(0, 200);
	try {
		const raw = await client.v3<Raw>(`${base(config)}/public-statuses`, { tids: unique.join(',') }, true);
		const statuses = (raw?.statuses ?? {}) as Record<string, Raw>;
		for (const [tid, value] of Object.entries(statuses)) {
			result.set(Number(tid), {
				available: true,
				tracked: true,
				status: typeof value.status === 'string' ? value.status : undefined,
				label: typeof value.label === 'string' ? value.label : undefined,
				updatedAt: Number(value.updatedAt) || undefined,
				parked: Boolean(value.parked),
			});
		}
	} catch {
		// Badges are a nice-to-have; a failure here must not sink the caller.
	}
	return result;
}

export interface TriageBoard {
	available: boolean;
	reason?: string;
	teamId?: string;
	teams: { id: string; name: string; selected?: boolean }[];
	columns: { key: string; label: string; class?: string; publicStatus?: string }[];
	items: {
		tid: number;
		title: string;
		url: string;
		status: string;
		priority?: string;
		claimedBy?: string;
		updatedAt?: number;
		helpWanted?: boolean;
	}[];
}

/**
 * The triage board for a team. Members only — a non-member token gets an
 * explicit permission note rather than an error.
 */
export async function getBoard(
	client: NodeBBClient,
	config: Config,
	capabilities: Capabilities,
	teamId?: string,
): Promise<TriageBoard> {
	const empty: TriageBoard = { available: false, teams: [], columns: [], items: [] };
	if (!isUsable(capabilities.shotef)) {
		return { ...empty, reason: capabilities.shotef.reason };
	}

	let raw: Raw | undefined;
	try {
		raw = await client.v3<Raw>(`${base(config)}/board`, teamId ? { team: teamId } : undefined);
	} catch (err) {
		if (err instanceof NodeBBError && err.kind === 'auth') {
			return {
				...empty,
				available: true,
				reason:
					'The triage board is restricted to members of the handling team. ' +
					'Use a token belonging to a team member, or read per-topic triage status instead.',
			};
		}
		throw err;
	}

	if (!raw || raw.noTeam) {
		return {
			...empty,
			available: true,
			reason: 'This token is not a member of any triage team, so no board is visible.',
		};
	}

	const columns: Raw[] = Array.isArray(raw.columns) ? raw.columns : [];
	const topics: Raw[] = Array.isArray(raw.topics) ? raw.topics : [];
	const teams: Raw[] = Array.isArray(raw.teams) ? raw.teams : [];

	return {
		available: true,
		teamId: typeof raw.team === 'string' ? raw.team : teamId,
		teams: teams.map(team => ({
			id: String(team.id),
			name: decodeTitle(team.name, String(team.id)),
			selected: Boolean(team.selected),
		})),
		columns: columns.map(column => ({
			key: String(column.key),
			label: decodeTitle(column.label, String(column.key)),
			class: column.class ? String(column.class) : undefined,
			publicStatus: column.publicStatus ? String(column.publicStatus) : undefined,
		})),
		items: topics.map(topic => ({
			tid: Number(topic.tid),
			title: decodeTitle(topic.title, `Topic #${topic.tid}`),
			url: client.link(`/topic/${topic.slug || topic.tid}`),
			status: String(topic.status ?? ''),
			priority: topic.priority ? String(topic.priority) : undefined,
			claimedBy: topic.claimedByUser?.username
				? decodeTitle(topic.claimedByUser.username)
				: undefined,
			updatedAt: Number(topic.updatedAt) || undefined,
			helpWanted: Boolean(topic.helpWanted),
		})),
	};
}
