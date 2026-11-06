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
	claimedByUid?: number;
	tags: string[];
	helpWanted?: boolean;
	isQuestion?: boolean;
	isSolved?: boolean;
	/** Read-only mirror of a ticket passed to another team. */
	ghost?: boolean;
	/** Intake: the teams sharing the ticket's category, one of which must take it. */
	owners?: string[];
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
		claimedByUid: Number(raw.claimedByUid ?? raw.claimedBy?.uid) || undefined,
		tags: (Array.isArray(raw.tags) ? raw.tags : [])
			.map((tag: unknown) => (typeof tag === 'string' ? tag : decodeTitle((tag as Raw)?.value)))
			.filter(Boolean),
		helpWanted: Boolean(raw.helpWanted),
		...(raw.isQuestion ? { isQuestion: true, isSolved: Boolean(raw.isSolved) } : {}),
		ghost: Boolean(raw.ghost) || undefined,
		owners: Array.isArray(raw.owners) ? raw.owners.map((owner: Raw) => decodeTitle(owner?.name, String(owner?.id ?? ''))) : undefined,
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

	teamId = teamId?.trim() || undefined;
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
				: 'No board is visible to a guest. Sign the server in as a team member ' +
					'(NODEBB_USERNAME and NODEBB_PASSWORD, or NODEBB_API_TOKEN).',
		};
	}

	const teams: Raw[] = Array.isArray(raw.teams) ? raw.teams : [];
	const team = (raw.team && typeof raw.team === 'object' ? raw.team : { id: raw.team }) as Raw;
	const visible = teams.map(entry => ({
		id: String(entry.id),
		name: decodeTitle(entry.name, String(entry.id)),
		selected: Boolean(entry.selected),
	}));

	// Shotef answers an unknown or hidden team with the viewer's default team's
	// board, silently. Never pass that off as the team asked for.
	if (teamId && team.id !== undefined && String(team.id) !== teamId) {
		// A team's name in place of its id: the board already served may be that team's.
		const byName = visible.find(entry => entry.name.toLowerCase() === teamId.toLowerCase());
		if (byName && byName.id !== String(team.id)) return getBoard(client, config, capabilities, byName.id);
		if (!byName) {
			const who = capabilities.forum.username ?? (capabilities.forum.uid ? `uid ${capabilities.forum.uid}` : 'a guest');
			return { ...empty, available: true, teams: visible, reason: `No triage team "${teamId}" is visible to ${who}.` };
		}
	}

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
		teams: visible,
		columns,
		items,
		onDuty: raw.shotef?.username ? decodeTitle(raw.shotef.username) : undefined,
		isManager: Boolean(raw.isManager),
	};
}

/* --------------------------------------------------------- ticket search */

export type TicketLane = 'active' | 'backlog' | 'intake' | 'closed';

export interface TicketFilters {
	/** Words that must all appear in the title or tags (case-insensitive). */
	query?: string;
	team?: string;
	/** Default 'open' = everything not closed. */
	lane?: TicketLane | 'open' | 'all';
	status?: string;
	/** 'me', 'unclaimed', a username, or a uid. */
	owner?: string | number;
	priorities?: string[];
	helpWanted?: boolean;
	question?: 'solved' | 'unsolved';
	tag?: string;
	minOpenDays?: number;
	minSilentDays?: number;
}

export interface FoundTicket extends BoardCard {
	teamId: string;
	teamName: string;
	laneName: TicketLane;
	columnLabel: string;
}

export interface TicketSearch {
	available: boolean;
	reason?: string;
	/** Teams whose boards were searched. */
	teams: { id: string; name: string }[];
	tickets: FoundTicket[];
}

const PRIORITY_RANK: Record<string, number> = { urgent: 3, high: 2, normal: 1, low: 0 };

/**
 * Find tickets across every board the acting user can see. Shotef has no search
 * route, but each board payload holds all of a team's tickets — active lanes,
 * the parked backlog, the intake, and closed — so we read the boards and filter
 * here. A ticket passed between teams shows up on both boards (a read-only
 * "ghost" on the origin); the handling team's copy wins.
 */
export async function searchTickets(
	client: NodeBBClient,
	config: Config,
	capabilities: Capabilities,
	filters: TicketFilters,
): Promise<TicketSearch> {
	const first = await getBoard(client, config, capabilities, filters.team);
	if (!first.available || !first.columns.length) {
		const visible = first.teams.map(team => `${team.name} (\`${team.id}\`)`).join(', ');
		const reason = [first.reason, visible ? `Teams they can see: ${visible}.` : ''].filter(Boolean).join(' ');
		return { available: first.available, reason, teams: [], tickets: [] };
	}

	const boards = [first];
	if (!filters.team) {
		for (const team of first.teams) {
			if (team.id === first.teamId) continue;
			// eslint-disable-next-line no-await-in-loop
			const board = await getBoard(client, config, capabilities, team.id).catch(() => undefined);
			if (board?.columns.length && board.teamId === team.id) boards.push(board);
		}
	}

	const byTid = new Map<number, FoundTicket>();
	for (const board of boards) {
		const columnOf = new Map(board.columns.map(column => [column.key, column]));
		for (const card of board.items) {
			const column = columnOf.get(card.column);
			const laneName: TicketLane = card.lane === 'intake'
				? 'intake'
				: card.lane === 'backlog' ? 'backlog' : column?.class === 'terminal' ? 'closed' : 'active';
			const found: FoundTicket = {
				...card,
				teamId: board.teamId ?? '',
				teamName: board.teamName ?? board.teamId ?? '',
				laneName,
				columnLabel: column?.label ?? card.column,
			};
			const existing = byTid.get(card.tid);
			if (!existing || (existing.ghost && !card.ghost)) byTid.set(card.tid, found);
		}
	}

	const me = capabilities.forum;
	const words = (filters.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
	const lane = filters.lane ?? 'open';
	const owner = typeof filters.owner === 'string' ? filters.owner.trim() : filters.owner;

	const tickets = [...byTid.values()].filter((ticket) => {
		if (lane === 'open' && ticket.laneName === 'closed') return false;
		if (lane !== 'open' && lane !== 'all' && ticket.laneName !== lane) return false;
		if (filters.status && ticket.column !== filters.status) return false;
		if (owner !== undefined && owner !== '') {
			if (owner === 'unclaimed') {
				if (ticket.claimedBy) return false;
			} else if (owner === 'me') {
				if (!me.uid || ticket.claimedByUid !== me.uid) return false;
			} else if (typeof owner === 'number' || /^\d+$/.test(owner)) {
				if (ticket.claimedByUid !== Number(owner)) return false;
			} else if (ticket.claimedBy?.toLowerCase() !== owner.toLowerCase()) {
				return false;
			}
		}
		if (filters.priorities?.length && !filters.priorities.includes(ticket.priority ?? 'normal')) return false;
		if (filters.helpWanted !== undefined && Boolean(ticket.helpWanted) !== filters.helpWanted) return false;
		if (filters.question === 'solved' && !(ticket.isQuestion && ticket.isSolved)) return false;
		if (filters.question === 'unsolved' && !(ticket.isQuestion && !ticket.isSolved)) return false;
		if (filters.tag && !ticket.tags.some(tag => tag.toLowerCase() === filters.tag!.toLowerCase())) return false;
		if (filters.minOpenDays !== undefined && (ticket.openDays ?? -1) < filters.minOpenDays) return false;
		if (filters.minSilentDays !== undefined && (ticket.noReplyDays ?? -1) < filters.minSilentDays) return false;
		if (words.length) {
			const haystack = `${ticket.title} ${ticket.tags.join(' ')}`.toLowerCase();
			if (!words.every(word => haystack.includes(word))) return false;
		}
		return true;
	});

	// Most urgent first, then longest open.
	tickets.sort((a, b) =>
		(PRIORITY_RANK[b.priority ?? 'normal'] ?? 1) - (PRIORITY_RANK[a.priority ?? 'normal'] ?? 1) ||
		(b.openDays ?? 0) - (a.openDays ?? 0) ||
		a.tid - b.tid);

	return {
		available: true,
		teams: boards.map(board => ({ id: board.teamId ?? '', name: board.teamName ?? board.teamId ?? '' })),
		tickets,
	};
}

/* -------------------------------------------------------- ticket detail */

export interface TicketDetail {
	tid: number;
	/**
	 * Shared between teams and taken by none (the intake lane). Shotef then names
	 * the first owning team as `team`, and nobody can act on it until a claim takes it.
	 */
	contended: boolean;
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
	/** The board it is viewed from: required for a team's intake (or ghost) copy. */
	viewTeam?: string,
): Promise<TicketDetail> {
	const raw = await client.v3<Raw>(ticketPath(config, tid), viewTeam ? { team: viewTeam } : undefined);
	const name = (who: Raw | undefined) => (who?.username ? decodeTitle(who.username) : undefined);
	return {
		tid: Number(raw.tid),
		contended: Boolean(raw.contended),
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
	// teamId: the team an intake ticket is taken for by the claim.
	| { kind: 'claim'; teamId?: string }
	| { kind: 'unclaim' }
	| { kind: 'assign'; uid: number; teamId?: string }
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
	const path = (rest: string) => ticketPath(config, tid, rest);
	switch (action.kind) {
		case 'status':
			return client.write('PUT', path('/status'), { status: action.status, closeReason: action.closeReason, note: action.note });
		case 'claim':
			return client.write('PUT', path('/claim'), action.teamId ? { teamId: action.teamId } : {});
		case 'unclaim':
			return client.write('DELETE', path('/claim'), {});
		case 'assign':
			return client.write('PUT', path('/assignee'), { uid: action.uid, ...(action.teamId ? { teamId: action.teamId } : {}) });
		case 'priority':
			return client.write('PUT', path('/priority'), { priority: action.priority });
		case 'help-wanted':
			return client.write('PUT', path('/help-wanted'), { on: action.on });
		case 'note':
			return client.write('POST', path('/notes'), { body: action.body });
		case 'solved':
			return client.write('PUT', path('/solved'), action.pid ? { pid: action.pid } : {});
		case 'pass':
			return client.write('POST', path('/pass'), { toTeamId: action.toTeam, reason: action.reason });
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
	['err-not-owning-team', "Your team doesn't own this ticket's category",
		'This ticket is in the intake lane (shared between teams, taken by none). Claim it with team set to one ' +
			'of your teams that shares its category; the claim takes it for that team.'],
	['err-already-taken', 'Another team already took this ticket',
		'Another team took this ticket first; it is now on their board.'],
];

/** Is `err` Shotef's refusal `key` (raw key, or its English translation)? */
export function isShotefRefusal(err: unknown, key: string): boolean {
	if (!(err instanceof NodeBBError)) return false;
	const english = SHOTEF_ADVICE.find(([known]) => known === key)?.[1];
	const said = `${err.forumMessage ?? ''}\n${err.message}`;
	return said.includes(`[[shotef:${key}]]`) || Boolean(english && said.includes(english));
}

/** The acting user's teams that hold this ticket in their intake lane. */
export async function intakeTeamsFor(
	client: NodeBBClient,
	config: Config,
	capabilities: Capabilities,
	tid: number,
): Promise<{ id: string; name: string }[]> {
	const first = await getBoard(client, config, capabilities);
	if (!first.available || !first.columns.length) return [];
	const others = await Promise.all(first.teams
		.filter(team => team.id !== first.teamId)
		.map(team => getBoard(client, config, capabilities, team.id).catch(() => undefined)));
	return [first, ...others]
		.filter((board): board is TriageBoard => Boolean(board?.teamId && board.items.some(card => card.tid === tid && card.lane === 'intake')))
		.map(board => ({ id: board.teamId as string, name: board.teamName ?? (board.teamId as string) }));
}

/**
 * The ticket as the acting user can see it. A refused read may be an intake
 * ticket viewed without its team (Shotef then needs ?team=): retry from the
 * user's own intake.
 */
export async function openTicket(
	client: NodeBBClient,
	config: Config,
	capabilities: Capabilities,
	tid: number,
): Promise<TicketDetail> {
	try {
		return await getTicket(client, config, tid);
	} catch (err) {
		if (!(err instanceof NodeBBError) || err.kind !== 'auth') throw err;
		const [team] = await intakeTeamsFor(client, config, capabilities, tid).catch(() => []);
		if (!team) throw err;
		return getTicket(client, config, tid, team.id);
	}
}

export function explainShotefError(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const hit = SHOTEF_ADVICE.find(([key, english]) => message.includes(`[[shotef:${key}]]`) || message.startsWith(english));
	return hit?.[2];
}
