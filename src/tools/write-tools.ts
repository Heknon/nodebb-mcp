/**
 * Tools that change the forum: posting, voting, and working triage tickets.
 *
 * Registered only when NODEBB_ENABLE_WRITES is on — everything here is visible
 * to the forum's users the moment it succeeds. Each tool re-checks at call time
 * that the forum actually honours our identity (NodeBB silently downgrades a bad
 * token to a guest, and a guest write would fail with a confusing message).
 *
 * Authorization is the forum's, not ours: posting privileges come from NodeBB,
 * and every triage action is checked by Shotef against team membership (and,
 * for assigning someone else, the manager role). A refusal comes back as a tool
 * error with advice, never as a silent no-op.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Capabilities } from '../capabilities.js';
import { isUsable } from '../capabilities.js';
import { NodeBBError } from '../errors.js';
import {
	applyTicketAction, explainShotefError, getTicket, getTriageStatus, type TicketAction,
} from '../integrations/shotef.js';
import { createTopic, editPost, replyToTopic, votePost } from '../nodebb/forum.js';
import type { ToolContext } from './context.js';
import { failure, formatTriage, stageLabel, text, toolError, type ToolResult } from './format.js';

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

/** Refuse early, with the reason, when this server cannot write as anyone. */
function writeBlocker(caps: Capabilities): ToolResult | undefined {
	if (isUsable(caps.writes)) return undefined;
	return failure(`Writes are not possible right now: ${caps.writes.reason ?? 'unknown reason'}`);
}

function triageBlocker(caps: Capabilities): ToolResult | undefined {
	const blocked = writeBlocker(caps);
	if (blocked) return blocked;
	if (isUsable(caps.shotef)) return undefined;
	return failure(
		`Triage actions need the Shotef plugin. ${caps.shotef.reason ?? ''} ` +
			'Without it, reply_to_topic is the way to respond to a report.',
	);
}

const actingAs = (caps: Capabilities) => caps.forum.username ?? `uid ${caps.forum.uid}`;

/** A one-line "where does it stand now" after a write that may have moved a ticket. */
async function triageAfter(ctx: ToolContext, caps: Capabilities, tid: number): Promise<string> {
	if (!isUsable(caps.shotef)) return '';
	const status = await getTriageStatus(ctx.client, ctx.config, caps, tid).catch(() => undefined);
	return formatTriage(status);
}

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		'create_topic',
		{
			title: 'Create a topic',
			description:
				'Start a new topic in a category, as the configured forum user. Set as_question to post it as ' +
				'a Q&A question (needs the Q&A plugin). In a category a triage team owns, the new topic lands ' +
				'on that team\'s board automatically. Check with find_answers first that the topic does not ' +
				'already exist — duplicate reports fragment the answers.',
			inputSchema: {
				cid: z.number().int().positive().describe('Category id (from list_categories).'),
				title: z.string().min(3).describe('Topic title.'),
				content: z.string().min(1).describe('Body, in markdown.'),
				tags: z.array(z.string().min(1)).optional().describe('Tags to attach.'),
				as_question: z.boolean().optional().describe('Post as a Q&A question. Ignored without the Q&A plugin.'),
			},
			annotations: WRITE,
		},
		async ({ cid, title, content, tags, as_question }) => {
			try {
				const caps = await ctx.capabilities.get();
				const blocked = writeBlocker(caps);
				if (blocked) return blocked;

				const asQuestion = Boolean(as_question) && isUsable(caps.qna);
				const created = await createTopic(ctx.client, { cid, title, content, tags, asQuestion });
				const lines = [
					`Created topic **#${created.tid} ${created.title ?? title}** as ${actingAs(caps)}.`,
					created.url,
				];
				if (as_question && !asQuestion) {
					lines.push('', '_as_question was ignored: the Q&A plugin is not active on this forum._');
				} else if (asQuestion) {
					lines.push('', 'Posted as an unsolved Q&A question.');
				}
				const triage = await triageAfter(ctx, caps, created.tid);
				if (triage) lines.push('', `Tracked on a triage board — ${triage}`);
				return text(lines.join('\n'));
			} catch (err) {
				return toolError(`create the topic in category ${cid}`, err);
			}
		},
	);

	server.registerTool(
		'reply_to_topic',
		{
			title: 'Reply to a topic',
			description:
				'Post a public reply to a topic, as the configured forum user. On a triaged topic the reply ' +
				'also moves the ticket the way a human reply would (a team member\'s reply hands the ball to ' +
				'the reporter, the reporter\'s reply hands it back). Read the thread with get_topic first, and ' +
				'cite the topics an answer draws on.',
			inputSchema: {
				tid: z.number().int().positive().describe('Topic id.'),
				content: z.string().min(1).describe('Reply body, in markdown.'),
				reply_to_pid: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('Post id this replies to, which threads it under that post.'),
			},
			annotations: WRITE,
		},
		async ({ tid, content, reply_to_pid }) => {
			try {
				const caps = await ctx.capabilities.get();
				const blocked = writeBlocker(caps);
				if (blocked) return blocked;

				const before = await triageAfter(ctx, caps, tid);
				const posted = await replyToTopic(ctx.client, { tid, content, toPid: reply_to_pid });
				const lines = [`Replied to topic #${tid} as ${actingAs(caps)} — post ${posted.pid}.`, posted.url];
				const after = await triageAfter(ctx, caps, tid);
				if (after && after !== before) lines.push('', `Ticket moved — ${after}`);
				else if (after) lines.push('', after);
				return text(lines.join('\n'));
			} catch (err) {
				return toolError(`reply to topic ${tid}`, err);
			}
		},
	);

	server.registerTool(
		'edit_post',
		{
			title: 'Edit a post',
			description:
				'Replace the body of a post (and, for a topic\'s first post, optionally its title). The forum ' +
				'keeps an edit history, but the previous text is no longer shown — use only to correct your ' +
				'own posts or when explicitly asked.',
			inputSchema: {
				pid: z.number().int().positive().describe('Post id.'),
				content: z.string().min(1).describe('The complete new body, in markdown (not a diff).'),
				title: z.string().min(3).optional().describe('New topic title; only valid on a topic\'s first post.'),
			},
			annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
		},
		async ({ pid, content, title }) => {
			try {
				const caps = await ctx.capabilities.get();
				const blocked = writeBlocker(caps);
				if (blocked) return blocked;
				const edited = await editPost(ctx.client, { pid, content, title });
				return text(`Edited post ${pid} as ${actingAs(caps)}.\n${edited.url}`);
			} catch (err) {
				return toolError(`edit post ${pid}`, err);
			}
		},
	);

	server.registerTool(
		'vote_post',
		{
			title: 'Vote on a post',
			description:
				'Upvote or downvote a post, or withdraw your vote. Upvoting a helpful reply is how a forum ' +
				'without the Q&A plugin surfaces its best answer — find_answers ranks by votes there.',
			inputSchema: {
				pid: z.number().int().positive().describe('Post id.'),
				vote: z.enum(['up', 'down', 'none']).describe('up, down, or none to withdraw a vote.'),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ pid, vote }) => {
			try {
				const caps = await ctx.capabilities.get();
				const blocked = writeBlocker(caps);
				if (blocked) return blocked;
				const { votes } = await votePost(ctx.client, { pid, vote });
				const verb = vote === 'none' ? 'Withdrew the vote on' : vote === 'up' ? 'Upvoted' : 'Downvoted';
				return text(`${verb} post ${pid} as ${actingAs(caps)}${votes !== undefined ? ` — score now ${votes}` : ''}.`);
			} catch (err) {
				return toolError(`vote on post ${pid}`, err);
			}
		},
	);

	server.registerTool(
		'update_ticket',
		{
			title: 'Update a triage ticket',
			description:
				'Work a ticket on the Shotef triage board: move it to another status (including closing it as ' +
				'resolved or as no-response), take or hand off ownership, change priority, flag that help is ' +
				'wanted, and leave a team-only internal note — any combination in one call. Changes apply in ' +
				'that order with the status move last, and each is reported separately. Only members of the ' +
				'handling team may act; assigning someone else needs a team manager. To accept an answer use ' +
				'mark_solved; to hand the ticket to another team use pass_ticket.',
			inputSchema: {
				tid: z.number().int().positive().describe('Topic id of the ticket.'),
				status: z
					.string()
					.min(1)
					.optional()
					.describe('Column key to move to, e.g. in_work, waiting, closed, blocked (see get_triage_board).'),
				close_reason: z
					.enum(['resolved', 'no_response'])
					.optional()
					.describe('When closing: resolved (default) or no_response (reporter went silent; a reply reopens it).'),
				owner: z
					.union([z.enum(['me', 'nobody']), z.number().int().positive()])
					.optional()
					.describe('"me" to claim it, "nobody" to release it, or a team member\'s uid to assign (managers only).'),
				priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority.'),
				help_wanted: z.boolean().optional().describe('Flag (true) or clear (false) a call for backup; flagging pings the team.'),
				note: z
					.string()
					.min(1)
					.optional()
					.describe('Internal note, visible to the team only — never to the reporter. Also recorded on the status move.'),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async (args) => {
			try {
				const caps = await ctx.capabilities.get();
				const blocked = triageBlocker(caps);
				if (blocked) return blocked;

				const actions: { label: string; action: TicketAction }[] = [];
				if (args.owner === 'me') actions.push({ label: 'claim', action: { kind: 'claim' } });
				else if (args.owner === 'nobody') actions.push({ label: 'release', action: { kind: 'unclaim' } });
				else if (typeof args.owner === 'number') {
					actions.push({ label: `assign to uid ${args.owner}`, action: { kind: 'assign', uid: args.owner } });
				}
				if (args.priority) actions.push({ label: `priority → ${args.priority}`, action: { kind: 'priority', priority: args.priority } });
				if (args.help_wanted !== undefined) {
					actions.push({ label: args.help_wanted ? 'flag help wanted' : 'clear help wanted', action: { kind: 'help-wanted', on: args.help_wanted } });
				}
				if (args.note) actions.push({ label: 'internal note', action: { kind: 'note', body: args.note } });
				if (args.status) {
					actions.push({
						label: `status → ${args.status}${args.close_reason ? ` (${args.close_reason})` : ''}`,
						action: { kind: 'status', status: args.status, closeReason: args.close_reason, note: args.note },
					});
				}
				if (!actions.length) {
					return failure('Nothing to do: pass at least one of status, owner, priority, help_wanted, note.');
				}

				const lines = [`# Ticket #${args.tid} — changes as ${actingAs(caps)}`, ''];
				let failed = 0;
				for (const { label, action } of actions) {
					try {
						// eslint-disable-next-line no-await-in-loop
						await applyTicketAction(ctx.client, ctx.config, args.tid, action);
						lines.push(`- ✅ ${label}`);
					} catch (err) {
						failed += 1;
						const said = err instanceof NodeBBError ? (err.forumMessage ?? err.message) : String(err);
						const advice = err instanceof NodeBBError ? explainShotefError(err.forumMessage) : undefined;
						lines.push(`- ❌ ${label} — ${said}${advice ? ` ${advice}` : ''}`);
					}
				}

				const ticket = await getTicket(ctx.client, ctx.config, args.tid).catch(() => undefined);
				if (ticket) {
					lines.push(
						'',
						`**Now:** \`${ticket.status}\` (${stageLabel(ticket.publicStatus)})` +
							`${ticket.closeReason ? ` · closed: ${ticket.closeReason}` : ''}` +
							` · owner: ${ticket.claimedBy ?? 'unclaimed'} · priority: ${ticket.priority ?? 'normal'}` +
							`${ticket.helpWanted ? ' · help wanted' : ''}`,
						ticket.url,
					);
				}
				if (failed === actions.length) return failure(lines.join('\n'));
				if (failed) lines.push('', `_${failed} of ${actions.length} changes were refused; the rest were applied._`);
				return text(lines.join('\n'));
			} catch (err) {
				return toolError(`update ticket ${args.tid}`, err, explainShotefError);
			}
		},
	);

	server.registerTool(
		'mark_solved',
		{
			title: 'Accept an answer',
			description:
				'Mark a Q&A question as solved, accepting a specific reply as its answer (or the thread as a ' +
				'whole when no pid is given). After this, find_answers and get_topic_answer report that reply ' +
				'as the accepted answer, and the ticket can be closed as resolved. Needs the Q&A plugin and — ' +
				'because Q&A offers this only over socket.io, which API tokens cannot reach — the Shotef ' +
				'plugin, acting as a member of the team handling the topic.',
			inputSchema: {
				tid: z.number().int().positive().describe('Topic id of the question.'),
				pid: z.number().int().positive().optional().describe('Post id of the reply to accept.'),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ tid, pid }) => {
			try {
				const caps = await ctx.capabilities.get();
				const blocked = triageBlocker(caps);
				if (blocked) return blocked;
				if (!isUsable(caps.qna)) {
					return failure(`There is no accepted answer to set: ${caps.qna.reason ?? 'the Q&A plugin is not active.'}`);
				}
				await applyTicketAction(ctx.client, ctx.config, tid, { kind: 'solved', pid });
				return text(
					`Marked topic #${tid} solved as ${actingAs(caps)}` +
						`${pid ? `, accepting post ${pid} as the answer` : ''}.\n` +
						'The ticket can now be closed as resolved with update_ticket.',
				);
			} catch (err) {
				return toolError(`mark topic ${tid} solved`, err, explainShotefError);
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
			annotations: WRITE,
		},
		async ({ tid, to_team, reason }) => {
			try {
				const caps = await ctx.capabilities.get();
				const blocked = triageBlocker(caps);
				if (blocked) return blocked;
				await applyTicketAction(ctx.client, ctx.config, tid, { kind: 'pass', toTeam: to_team, reason });
				const after = await triageAfter(ctx, caps, tid);
				return text(`Passed ticket #${tid} to team ${to_team} as ${actingAs(caps)}.${after ? `\n${after}` : ''}`);
			} catch (err) {
				return toolError(`pass ticket ${tid} to ${to_team}`, err, explainShotefError);
			}
		},
	);
}
