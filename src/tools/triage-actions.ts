/**
 * Working the Shotef triage board: one tool per action.
 *
 * These are always registered — they are not behind NODEBB_ENABLE_WRITES. That
 * flag guards *public* content (posts, replies, edits, votes, the accepted
 * answer). What lives here is the team's own working state: internal notes,
 * where a ticket sits, who owns it, how urgent it is, which team has it. Shotef
 * authorizes every one of these against membership of the handling team (and
 * the manager role for assigning someone else), so a token outside the team is
 * refused by the forum, with its reason.
 *
 * Each tool does exactly one kind of change, so its annotations are true for
 * every input, a client can approve them separately, and a failure is about one
 * thing. Each re-reads the ticket afterwards and shows where it now stands.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Capabilities } from '../capabilities.js';
import { isUsable } from '../capabilities.js';
import { NodeBBError } from '../errors.js';
import {
	applyTicketAction, explainShotefError, getTicket, type TicketAction,
} from '../integrations/shotef.js';
import type { ToolContext } from './context.js';
import { failure, stageLabel, text, toolError, type ToolResult } from './format.js';

/** Changes the team's state, never public content; safe to repeat unless noted. */
const TRIAGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Refuse before sending anything when Shotef is missing or we have no identity. */
export function triageBlocker(caps: Capabilities): ToolResult | undefined {
	if (isUsable(caps.triage)) return undefined;
	const lines = [`Triage actions are not possible right now: ${caps.triage.reason ?? 'unknown reason'}`];
	if (!isUsable(caps.shotef)) {
		lines.push('Without Shotef, reply_to_topic is the way to respond to a report.');
	}
	return failure(lines.join('\n'));
}

export const actingAs = (caps: Capabilities) => caps.forum.username ?? `uid ${caps.forum.uid}`;

/** "Now: `in_work` (In progress) · owner: … · priority: …" — the ticket after a change. */
async function ticketNow(ctx: ToolContext, tid: number): Promise<string[]> {
	const ticket = await getTicket(ctx.client, ctx.config, tid).catch(() => undefined);
	if (!ticket) return [];
	return [
		`**Now:** \`${ticket.status}\` (${stageLabel(ticket.publicStatus)})` +
			`${ticket.closeReason ? ` · closed: ${ticket.closeReason}` : ''}` +
			` · owner: ${ticket.claimedBy ?? 'unclaimed'} · priority: ${ticket.priority ?? 'normal'}` +
			`${ticket.helpWanted ? ' · help wanted' : ''}`,
		ticket.url,
	];
}

/** Run one ticket action as a tool: refuse early, apply, confirm with the new state. */
async function runAction(
	ctx: ToolContext,
	tid: number,
	action: TicketAction,
	describe: { doing: string; done: (caps: Capabilities) => string },
): Promise<ToolResult> {
	try {
		const caps = await ctx.capabilities.get();
		const blocked = triageBlocker(caps);
		if (blocked) return blocked;
		await applyTicketAction(ctx.client, ctx.config, tid, action);
		return text([describe.done(caps), '', ...(await ticketNow(ctx, tid))].join('\n').trim());
	} catch (err) {
		return toolError(describe.doing, err, explainShotefError);
	}
}

export function registerTriageActions(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		'add_ticket_note',
		{
			title: 'Add an internal ticket note',
			description:
				'Leave an internal note on a triage ticket: visible to the handling team only, never to the ' +
				'reporter or the public. Use it to record what was checked, a hypothesis, or a hand-off for ' +
				'whoever picks the ticket up next; get_ticket lists the notes. Members of the handling team only.',
			inputSchema: {
				tid: z.number().int().positive().describe('Topic id of the ticket.'),
				body: z.string().min(1).describe('The note, in plain text or markdown.'),
			},
			// Each call adds another note.
			annotations: { ...TRIAGE, idempotentHint: false },
		},
		async ({ tid, body }) => runAction(ctx, tid, { kind: 'note', body }, {
			doing: `add a note to ticket ${tid}`,
			done: caps => `Added an internal note to ticket #${tid} as ${actingAs(caps)} — visible to the team only.`,
		}),
	);

	server.registerTool(
		'set_ticket_status',
		{
			title: 'Move a ticket',
			description:
				'Move a triage ticket to another status column — e.g. in_work when starting, waiting when the ' +
				'team owes the next step, blocked/deferred to park it, closed when done. Closing records why: ' +
				'resolved (default) or no_response (the reporter went silent; a reply reopens it). An unsolved ' +
				'Q&A question cannot be closed as resolved until an answer is accepted. The reporter sees only ' +
				'the coarse stage (received / in progress / answered / closed) and is notified when it changes. ' +
				'Column keys come from get_triage_board. Members of the handling team only.',
			inputSchema: {
				tid: z.number().int().positive().describe('Topic id of the ticket.'),
				status: z
					.string()
					.min(1)
					.describe('Column key, e.g. todo, in_work, waiting, responded, closed, blocked, deferred, feature.'),
				close_reason: z
					.enum(['resolved', 'no_response'])
					.optional()
					.describe('When closing: resolved (default) or no_response.'),
				reason: z
					.string()
					.min(1)
					.optional()
					.describe('Why — recorded on the ticket\'s timeline, which only the team sees.'),
			},
			annotations: TRIAGE,
		},
		async ({ tid, status, close_reason, reason }) => runAction(
			ctx, tid, { kind: 'status', status, closeReason: close_reason, note: reason },
			{
				doing: `move ticket ${tid} to ${status}`,
				done: caps => `Moved ticket #${tid} to \`${status}\`${close_reason ? ` (${close_reason})` : ''} as ${actingAs(caps)}.`,
			},
		),
	);

	server.registerTool(
		'assign_ticket',
		{
			title: 'Take, release or assign a ticket',
			description:
				'Set who owns a triage ticket: "me" to claim it, "nobody" to release it back to the queue, or a ' +
				'team member\'s uid to assign it to them (team managers only). Members of the handling team only.',
			inputSchema: {
				tid: z.number().int().positive().describe('Topic id of the ticket.'),
				owner: z
					.union([z.enum(['me', 'nobody']), z.number().int().positive()])
					.describe('"me", "nobody", or the uid of a member of the handling team.'),
			},
			annotations: TRIAGE,
		},
		async ({ tid, owner }) => {
			const action: TicketAction = owner === 'me'
				? { kind: 'claim' }
				: owner === 'nobody' ? { kind: 'unclaim' } : { kind: 'assign', uid: owner };
			return runAction(ctx, tid, action, {
				doing: owner === 'me' ? `claim ticket ${tid}` : owner === 'nobody' ? `release ticket ${tid}` : `assign ticket ${tid} to uid ${owner}`,
				done: caps => owner === 'me'
					? `Claimed ticket #${tid} as ${actingAs(caps)}.`
					: owner === 'nobody'
						? `Released ticket #${tid} back to the queue.`
						: `Assigned ticket #${tid} to uid ${owner} as ${actingAs(caps)}.`,
			});
		},
	);

	server.registerTool(
		'set_ticket_priority',
		{
			title: 'Set ticket priority',
			description:
				'Change how urgent a triage ticket is, and/or flag that help is wanted on it (flagging pings ' +
				'the rest of the team). Members of the handling team only.',
			inputSchema: {
				tid: z.number().int().positive().describe('Topic id of the ticket.'),
				priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority.'),
				help_wanted: z.boolean().optional().describe('true to ask the team for backup, false to clear it.'),
			},
			annotations: TRIAGE,
		},
		async ({ tid, priority, help_wanted }) => {
			if (!priority && help_wanted === undefined) {
				return failure('Nothing to change: pass priority, help_wanted, or both.');
			}
			try {
				const caps = await ctx.capabilities.get();
				const blocked = triageBlocker(caps);
				if (blocked) return blocked;
				// Two independent fields: apply both, report each.
				const lines = [`# Ticket #${tid} — as ${actingAs(caps)}`, ''];
				let failed = 0;
				const steps: [string, TicketAction][] = [];
				if (priority) steps.push([`priority → ${priority}`, { kind: 'priority', priority }]);
				if (help_wanted !== undefined) {
					steps.push([help_wanted ? 'flag help wanted' : 'clear help wanted', { kind: 'help-wanted', on: help_wanted }]);
				}
				for (const [label, action] of steps) {
					try {
						// eslint-disable-next-line no-await-in-loop
						await applyTicketAction(ctx.client, ctx.config, tid, action);
						lines.push(`- ✅ ${label}`);
					} catch (err) {
						failed += 1;
						const said = err instanceof NodeBBError ? (err.forumMessage ?? err.message) : String(err);
						const advice = explainShotefError(said);
						lines.push(`- ❌ ${label} — ${said}${advice ? ` ${advice}` : ''}`);
					}
				}
				lines.push('', ...(await ticketNow(ctx, tid)));
				return failed === steps.length ? failure(lines.join('\n').trim()) : text(lines.join('\n').trim());
			} catch (err) {
				return toolError(`update priority on ticket ${tid}`, err, explainShotefError);
			}
		},
	);

	server.registerTool(
		'pass_ticket',
		{
			title: 'Pass a ticket to another team',
			description:
				'Hand a triage ticket to another team, with a reason. The other team\'s on-duty person is ' +
				'notified, and your team keeps a read-only mirror. Use when an issue belongs to someone else ' +
				'(e.g. billing vs. technical). Team ids are listed by get_triage_board.',
			inputSchema: {
				tid: z.number().int().positive().describe('Topic id of the ticket.'),
				to_team: z.string().min(1).describe('Id of the receiving team.'),
				reason: z.string().optional().describe('Why it is being passed — shown to the receiving team.'),
			},
			annotations: TRIAGE,
		},
		async ({ tid, to_team, reason }) => runAction(ctx, tid, { kind: 'pass', toTeam: to_team, reason }, {
			doing: `pass ticket ${tid} to ${to_team}`,
			done: caps => `Passed ticket #${tid} to team ${to_team} as ${actingAs(caps)}.`,
		}),
	);
}
