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

export interface BoardCard {
	tid: number;
	title: string;
	url: string;
	/** Internal column key (todo, in_work, …). */
	status: string;
	column: string;
	/** 'board' = active lanes, 'backlog' = parked, 'intake' = contended, not yet taken. */
	lane: 'board' | 'backlog' | 'intake';
	priority?: string;
	claimedBy?: string;
	helpWanted?: boolean;
	isQuestion?: boolean;
	isSolved?: boolean;
	/** Read-only mirror of a ticket passed to another team. */
	ghost?: boolean;
	handledBy?: string;
	openDays?: number;
	idleDays?: number;
	/** Days the reporter has been silent, on an answered ticket. */
	noReplyDays?: number;
	closeReason?: string;
	updatedAt?: number;
}

export interface BoardColumn {
	key: string;
	label: string;
	class?: string;
	publicStatus?: string;
	lane: 'board' | 'backlog';
	count: number;
}

export interface TriageBoard {
	available: boolean;
	reason?: string;
	teamId?: string;
	teamName?: string;
	teams: { id: string; name: string; selected?: boolean }[];
	columns: BoardColumn[];
	items: BoardCard[];
	/** Who is on duty (the "shotef") for this team, if anyone. */
	onDuty?: string;
	isManager?: boolean;
}

function toCard(client: NodeBBClient, raw: Raw, column: string, lane: BoardCard['lane']): BoardCard {
	const tid = Number(raw.tid);
	const days = (value: unknown) => (value === null || value === undefined ? undefined : Number(value));
	return {
		tid,
		title: decodeTitle(raw.title, `Topic #${tid}`),
		url: client.link(`/topic/${raw.slug || tid}`),
		status: String(raw.status ?? column),
		column,
		lane,
		priority: raw.priority ? String(raw.priority) : undefined,
		claimedBy: raw.claimedBy?.username ? decodeTitle(raw.claimedBy.username) : undefined,
		helpWanted: Boolean(raw.helpWanted),
		...(raw.isQuestion ? { isQuestion: true, isSolved: Boolean(raw.isSolved) } : {}),
		ghost: Boolean(raw.ghost) || undefined,
		handledBy: raw.handledByName ? decodeTitle(raw.handledByName) : undefined,
		openDays: days(raw.openDays),
		idleDays: days(raw.idleDays),
		noReplyDays: days(raw.noReplyDays),
		closeReason: raw.closeReason || undefined,
		updatedAt: Number(raw.updatedAt) || undefined,
	};
}

/**
 * The triage board for a team. Members only — a non-member token gets an
 * explicit permission note rather than an error.
 *
 * Shape (shotef `buildBoardModel`): `columns[]` are the active lanes and
 * `backlog[]` the parked ones, each `{ key, label, class, publicStatus, cards[] }`;
 * `intake[]` is contended shared-category tickets nobody has taken; `team` is
 * `{ id, name }`. A viewer on no team gets `{ noTeam: true, teams: [] }`.
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
			reason: capabilities.forum.authenticated
				? `${capabilities.forum.username ?? `uid ${capabilities.forum.uid}`} is not a member of any triage team, so no board is visible.`
				: 'No board is visible to a guest. Set NODEBB_API_TOKEN to a team member\'s token.',
		};
	}

	const teams: Raw[] = Array.isArray(raw.teams) ? raw.teams : [];
	const team = (raw.team && typeof raw.team === 'object' ? raw.team : { id: raw.team }) as Raw;
	const columns: BoardColumn[] = [];
	const items: BoardCard[] = [];

	for (const [lane, list] of [['board', raw.columns], ['backlog', raw.backlog]] as const) {
		for (const column of (Array.isArray(list) ? list : []) as Raw[]) {
			const cards: Raw[] = Array.isArray(column.cards) ? column.cards : [];
			columns.push({
				key: String(column.key),
				label: decodeTitle(column.label, String(column.key)),
				class: column.class ? String(column.class) : undefined,
				publicStatus: column.publicStatus ? String(column.publicStatus) : undefined,
				lane,
				count: cards.length,
			});
			for (const card of cards) items.push(toCard(client, card, String(column.key), lane));
		}
	}
	for (const card of (Array.isArray(raw.intake) ? raw.intake : []) as Raw[]) {
		items.push(toCard(client, card, String(card.status ?? 'intake'), 'intake'));
	}

	return {
		available: true,
		teamId: team.id ? String(team.id) : teamId,
		teamName: team.name ? decodeTitle(team.name) : undefined,
		teams: teams.map(entry => ({
			id: String(entry.id),
			name: decodeTitle(entry.name, String(entry.id)),
			selected: Boolean(entry.selected),
		})),
		columns,
		items,
		onDuty: raw.shotef?.username ? decodeTitle(raw.shotef.username) : undefined,
		isManager: Boolean(raw.isManager),
	};
}

/* -------------------------------------------------------- ticket detail */

export interface TicketDetail {
	tid: number;
	title: string;
	url: string;
	category?: string;
	team: string;
	teamName: string;
	status: string;
	publicStatus?: string;
	closeReason?: string;
	priority?: string;
	claimedBy?: string;
	helpWanted?: boolean;
	isQuestion?: boolean;
	isSolved?: boolean;
	readOnly: boolean;
	description?: string;
	createdAt?: number;
	updatedAt?: number;
	timeline: { ts: number; action: string; from?: string; to?: string; actor?: string; note?: string }[];
	/** Team-only internal notes; empty for viewers outside the handling team. */
	notes: { ts: number; author: string; body: string }[];
}

const ticketPath = (config: Config, tid: number, rest = '') => `${base(config)}/tickets/${tid}${rest}`;

/** Full ticket for a team member: fields, audit timeline, and internal notes. */
export async function getTicket(
	client: NodeBBClient,
	config: Config,
	tid: number,
): Promise<TicketDetail> {
	const raw = await client.v3<Raw>(ticketPath(config, tid));
	const name = (who: Raw | undefined) => (who?.username ? decodeTitle(who.username) : undefined);
	return {
		tid: Number(raw.tid),
		title: decodeTitle(raw.title, `Topic #${tid}`),
		url: client.link(`/topic/${raw.slug || tid}`),
		category: decodeTitle(raw.category) || undefined,
		team: String(raw.handlingTeam ?? ''),
		teamName: decodeTitle(raw.handlingTeamName, String(raw.handlingTeam ?? '')),
		status: String(raw.status ?? ''),
		publicStatus: raw.publicStatus || undefined,
		closeReason: raw.closeReason || undefined,
		priority: raw.priority || undefined,
		claimedBy: name(raw.claimedBy),
		helpWanted: Boolean(raw.helpWanted),
		isQuestion: Boolean(raw.isQuestion),
		isSolved: Boolean(raw.isSolved),
		readOnly: Boolean(raw.readOnly),
		description: raw.description ? String(raw.description) : undefined,
		createdAt: Number(raw.createdAt) || undefined,
		updatedAt: Number(raw.updatedAt) || undefined,
		// `actor` is a username string ('system' for automatic moves); claim/assign
		// entries carry the assignee's name in `toUsername`.
		timeline: (Array.isArray(raw.timeline) ? raw.timeline : []).map((entry: Raw) => ({
			ts: Number(entry.ts) || 0,
			action: String(entry.action ?? ''),
			from: entry.from ? String(entry.from) : undefined,
			to: entry.toUsername ? String(entry.toUsername) : (entry.to ? String(entry.to) : undefined),
			actor: typeof entry.actor === 'string' ? decodeTitle(entry.actor) : name(entry.actor),
			note: entry.note ? String(entry.note) : undefined,
		})),
		// Empty unless the viewer is on the handling team (shotef gates them).
		notes: (Array.isArray(raw.notes) ? raw.notes : []).map((entry: Raw) => ({
			ts: Number(entry.ts) || 0,
			author: typeof entry.author === 'string' ? decodeTitle(entry.author) : (name(entry.author) ?? 'unknown'),
			body: String(entry.body ?? ''),
		})),
	};
}

/* --------------------------------------------------------------- writes */

export type TicketAction =
	| { kind: 'status'; status: string; closeReason?: string; note?: string }
	| { kind: 'claim' }
	| { kind: 'unclaim' }
	| { kind: 'assign'; uid: number }
	| { kind: 'priority'; priority: string }
	| { kind: 'help-wanted'; on: boolean }
	| { kind: 'note'; body: string }
	| { kind: 'solved'; pid?: number }
	| { kind: 'pass'; toTeam: string; reason?: string };

/** One ticket action through Shotef's HTTP routes. Throws NodeBBError on refusal. */
export async function applyTicketAction(
	client: NodeBBClient,
	config: Config,
	tid: number,
	action: TicketAction,
): Promise<Raw> {
	const path = (rest: string) => `/api/v3${ticketPath(config, tid, rest)}`;
	switch (action.kind) {
		case 'status':
			return client.request(path('/status'), {
				method: 'PUT',
				body: { status: action.status, closeReason: action.closeReason, note: action.note },
			});
		case 'claim':
			return client.request(path('/claim'), { method: 'PUT', body: {} });
		case 'unclaim':
			return client.request(path('/claim'), { method: 'DELETE', body: {} });
		case 'assign':
			return client.request(path('/assignee'), { method: 'PUT', body: { uid: action.uid } });
		case 'priority':
			return client.request(path('/priority'), { method: 'PUT', body: { priority: action.priority } });
		case 'help-wanted':
			return client.request(path('/help-wanted'), { method: 'PUT', body: { on: action.on } });
		case 'note':
			return client.request(path('/notes'), { method: 'POST', body: { body: action.body } });
		case 'solved':
			return client.request(path('/solved'), { method: 'PUT', body: action.pid ? { pid: action.pid } : {} });
		case 'pass':
			return client.request(path('/pass'), { method: 'POST', body: { toTeamId: action.toTeam, reason: action.reason } });
	}
}

/**
 * Advice for the Shotef refusals a caller can act on. Over HTTP the message
 * arrives translated ("You are not a member of this team"); a raw
 * `[[shotef:err-…]]` key appears only when translation is unavailable, so both
 * forms are matched.
 */
const SHOTEF_ADVICE: [key: string, english: string, advice: string][] = [
	['err-not-team-member', 'You are not a member of this team',
		'The acting user is not on the team handling this ticket.'],
	['err-not-a-shotef-topic', 'This topic is not tracked by Shotef',
		'This topic is not on any triage board (its category is not owned by a team).'],
	['err-unknown-status', 'Unknown status',
		'Use a column key from get_triage_board (default schema: todo, in_work, waiting, responded, closed, ' +
			'blocked, deferred, feature).'],
	['err-must-solve-first', 'Mark this question as solved before closing it',
		'This is an unsolved Q&A question, so it cannot be closed as resolved: accept an answer first ' +
			'(mark_solved — it changes the public thread, so it needs NODEBB_ENABLE_WRITES), or close it with ' +
			'close_reason "no_response".'],
	['err-conflict', 'This item changed since you loaded it',
		'Someone else moved this ticket in the meantime; re-read it with get_ticket and retry.'],
	['err-bad-priority', 'Invalid priority', 'Priority must be one of: low, normal, high, urgent.'],
	['err-not-team-manager', 'Only a team manager can do that',
		'Only a team manager can do that (e.g. assign a ticket to someone other than yourself).'],
	['err-target-not-team-member', 'That user is not a member of this team',
		'The assignee must be a member of the handling team.'],
	['err-qa-inactive', "The Q&A plugin isn't active", 'The Q&A plugin is not active, so there is no answer to accept.'],
	['err-not-a-question', "This topic isn't a Q&A question",
		'This topic is not a Q&A question, so it has no accepted answer to set.'],
	['err-reply-not-on-topic', "That reply doesn't belong to this ticket", 'That post does not belong to this topic.'],
	['err-pass-self', 'That ticket is already handled by this team', 'The ticket is already handled by that team.'],
	['err-no-team', 'No such team', 'No such team — get_triage_board lists the teams you can see.'],
];

export function explainShotefError(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const hit = SHOTEF_ADVICE.find(([key, english]) => message.includes(`[[shotef:${key}]]`) || message.startsWith(english));
	return hit?.[2];
}
