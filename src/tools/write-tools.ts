/**
 * Tools that change what the forum's readers see: posting, replying, editing,
 * voting, and accepting an answer.
 *
 * Registered only when NODEBB_ENABLE_WRITES is on — everything here is public
 * the moment it succeeds. (Shotef's team workflow — notes, status, assignment,
 * priority, passing — is team-internal and lives in triage-actions.ts, without
 * that gate.) Each tool re-checks at call time that the forum actually honours
 * our identity: NodeBB silently downgrades a bad token to a guest, and a guest
 * write would fail with a confusing message.
 *
 * Authorization is the forum's, not ours: posting privileges come from NodeBB,
 * and accepting an answer is checked by Shotef against team membership. A
 * refusal comes back as a tool error with advice, never as a silent no-op.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Capabilities } from '../capabilities.js';
import { isUsable } from '../capabilities.js';
import { applyTicketAction, explainShotefError, getTriageStatus } from '../integrations/shotef.js';
import { createTopic, editPost, replyToTopic, votePost } from '../nodebb/forum.js';
import type { ToolContext } from './context.js';
import { failure, formatTriage, text, toolError, type ToolResult } from './format.js';
import { actingAs, triageBlocker } from './triage-actions.js';

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

/** Refuse early, with the reason, when this server cannot write as anyone. */
function writeBlocker(caps: Capabilities): ToolResult | undefined {
	if (isUsable(caps.writes)) return undefined;
	return failure(`Public writes are not possible right now: ${caps.writes.reason ?? 'unknown reason'}`);
}

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
		'mark_solved',
		{
			title: 'Accept an answer',
			description:
				'Mark a Q&A question as solved, accepting a specific reply as its answer (or the thread as a ' +
				'whole when no pid is given). The thread then shows that reply as the accepted answer, ' +
				'find_answers and get_topic_answer report it, and the ticket can be closed as resolved. ' +
				'Needs the Q&A plugin and — ' +
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
				// Public (the thread shows the accepted answer) *and* a Shotef action.
				const blocked = writeBlocker(caps) ?? triageBlocker(caps);
				if (blocked) return blocked;
				if (!isUsable(caps.qna)) {
					return failure(`There is no accepted answer to set: ${caps.qna.reason ?? 'the Q&A plugin is not active.'}`);
				}
				await applyTicketAction(ctx.client, ctx.config, tid, { kind: 'solved', pid });
				return text(
					`Marked topic #${tid} solved as ${actingAs(caps)}` +
						`${pid ? `, accepting post ${pid} as the answer` : ''}.\n` +
						'The ticket can now be closed as resolved with set_ticket_status.',
				);
			} catch (err) {
				return toolError(`mark topic ${tid} solved`, err, explainShotefError);
			}
		},
	);
}
