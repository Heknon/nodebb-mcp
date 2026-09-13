/**
 * Tools whose job is answering: finding what the forum already knows, and
 * assembling an investigation when it does not know yet.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { isUsable } from '../capabilities.js';
import { getBestAnswer, listUnsolved } from '../integrations/qna.js';
import { getTriageStatus, getTriageStatuses } from '../integrations/shotef.js';
import {
	answerExcerpt, describeBasis, gatherCandidates, investigate, rankForAnswers, resolveAnswers,
} from '../research.js';
import type { ToolContext } from './context.js';
import {
	degradationNote, formatAnswered, formatCandidate, formatDate, formatInvestigation, formatTriage,
	formatTopicSummary, text, toolError,
} from './format.js';

export function registerAnswerTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		'find_answers',
		{
			title: 'Find existing answers',
			description:
				'Find topics that already answer a question, and extract the answer from each. Prefers ' +
				'author-accepted answers when the Q&A plugin is installed, and falls back to the ' +
				'strongest reply otherwise — always labelling which it used, so an unconfirmed reply is ' +
				'never presented as a confirmed answer. This is the first tool to reach for when someone ' +
				'asks a question the forum may have seen before.',
			inputSchema: {
				question: z.string().min(1).describe('The question, in natural language.'),
				categories: z.array(z.number().int().positive()).optional().describe('Restrict to these category ids.'),
				tags: z.array(z.string()).optional().describe('Only topics carrying all of these tags.'),
				depth: z
					.number()
					.int()
					.min(1)
					.max(12)
					.optional()
					.describe('How many candidate topics to open and extract answers from. Default 5.'),
				solved_only: z
					.boolean()
					.optional()
					.describe('Only return topics with an accepted answer. Requires the Q&A plugin; ignored without it.'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ question, categories, tags, depth, solved_only }) => {
			try {
				const caps = await ctx.capabilities.get();
				const { candidates, notes } = await gatherCandidates(ctx.client, caps, {
					query: question,
					categories,
					tags,
					limit: 20,
				});

				if (!candidates.length) {
					return text(
						[
							`# No answers found for "${question}"`,
							'',
							...notes.map(note => `_${note}_`),
							'',
							'Nothing on this forum looks related. This may be a new issue — use investigate_issue ' +
								'for a fuller sweep, or list_recent_topics to browse manually.',
						].join('\n'),
					);
				}

				let ranked = rankForAnswers(candidates);
				if (solved_only) {
					if (!isUsable(caps.qna)) {
						notes.push(
							'solved_only was ignored: without the Q&A plugin the forum has no notion of a solved topic.',
						);
					} else {
						ranked = ranked.filter(candidate => candidate.isSolved !== false);
					}
				}

				const answered = await resolveAnswers(ctx.client, caps, ranked, {
					take: depth ?? 5,
					maxPosts: ctx.config.maxPostsPerTopic,
				});
				const withAnswers = answered.filter(item => item.answer);

				const lines = [`# Answers for "${question}"`, ''];
				const banner = degradationNote(caps);
				if (banner) lines.push(banner, '');
				notes.forEach(note => lines.push(`_${note}_`));
				if (notes.length) lines.push('');

				if (!withAnswers.length) {
					lines.push(
						'No topic in range carried a usable answer. Closest related topics:',
						'',
						...ranked.slice(0, 5).map((candidate, i) => formatCandidate(candidate, i + 1)),
					);
					return text(lines.join('\n'));
				}

				withAnswers.forEach((item, i) => lines.push(formatAnswered(item, i + 1), ''));

				const unconfirmed = withAnswers.filter(item => item.basis !== 'accepted').length;
				if (unconfirmed) {
					lines.push(
						`_${unconfirmed} of ${withAnswers.length} answers above were never marked accepted — ` +
							'verify before relying on them._',
					);
				}
				return text(lines.join('\n').trim());
			} catch (err) {
				return toolError('find answers', err);
			}
		},
	);

	server.registerTool(
		'get_topic_answer',
		{
			title: 'Get a topic\'s answer',
			description:
				'Get the answer to one specific topic. With the Q&A plugin this is the accepted answer, ' +
				'and an open question is reported as genuinely unanswered rather than guessed at. Without ' +
				'it, returns the most-upvoted reply, labelled as unconfirmed.',
			inputSchema: {
				tid: z.number().int().positive().describe('Topic id.'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ tid }) => {
			try {
				const caps = await ctx.capabilities.get();
				const result = await getBestAnswer(ctx.client, caps, tid, ctx.config.maxPostsPerTopic);
				const triage = await getTriageStatus(ctx.client, ctx.config, caps, tid);

				const lines = [formatTopicSummary(result.topic), ''];
				const triageLine = formatTriage(triage);
				if (triageLine) lines.push(triageLine, '');

				if (!result.answer) {
					lines.push(
						`**No answer available** — ${result.note ?? 'nothing in this topic answers it.'}`,
						'',
						'Use find_answers with the topic\'s title to look for the answer elsewhere on the forum.',
					);
					return text(lines.join('\n'));
				}

				lines.push(
					`## Answer (${describeBasis(result.basis)})`,
					'',
					`By ${result.answer.author?.username ?? 'unknown'} · ${formatDate(result.answer.timestamp)}` +
						`${result.answer.votes ? ` · ${result.answer.votes} votes` : ''}`,
					'',
					answerExcerpt(result.answer, 4000) || '_(empty)_',
					'',
					result.answer.url,
				);
				if (result.note) lines.push('', `_${result.note}_`);
				return text(lines.join('\n'));
			} catch (err) {
				return toolError(`get the answer for topic ${tid}`, err);
			}
		},
	);

	server.registerTool(
		'list_unanswered_questions',
		{
			title: 'List unanswered questions',
			description:
				'List questions nobody has answered yet — the queue for someone who wants to help. With ' +
				'the Q&A plugin this is the forum\'s real unsolved list; without it, recent topics that have ' +
				'no replies, which approximates it but cannot tell a question from a discussion. Shows ' +
				'triage status per item when the Shotef plugin is installed.',
			inputSchema: {
				limit: z.number().int().min(1).max(50).optional().describe('Maximum questions. Default 20.'),
				page: z.number().int().min(1).optional().describe('Listing page.'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ limit, page }) => {
			try {
				const caps = await ctx.capabilities.get();
				const { topics, degraded, note } = await listUnsolved(ctx.client, caps, { limit, page });

				if (!topics.length) {
					return text(
						[
							'# No unanswered questions',
							'',
							note ? `_${note}_` : '',
							degraded ? '' : 'Every open question on this forum has an accepted answer.',
						].filter(Boolean).join('\n'),
					);
				}

				const triage = await getTriageStatuses(
					ctx.client,
					ctx.config,
					caps,
					topics.map(topic => topic.tid),
				);

				const lines = [
					`# ${topics.length} unanswered question${topics.length === 1 ? '' : 's'}`,
					'',
				];
				if (note) lines.push(`_${note}_`, '');

				topics.forEach((topic) => {
					lines.push(formatTopicSummary(topic));
					const triageLine = formatTriage(triage.get(topic.tid));
					if (triageLine) lines.push(triageLine);
					lines.push('');
				});
				return text(lines.join('\n').trim());
			} catch (err) {
				return toolError('list unanswered questions', err);
			}
		},
	);

	server.registerTool(
		'investigate_issue',
		{
			title: 'Investigate an issue',
			description:
				'The full sweep for a reported problem: find every related topic, extract the answers that ' +
				'already exist, separate them from the reports still open, fold in triage status, and end ' +
				'with concrete next steps. Use this when someone reports a problem and you need to know ' +
				'whether the forum has seen it before, whether it was solved, and whether anyone is ' +
				'already on it. Slower than find_answers because it opens several topics — prefer ' +
				'find_answers for a plain question.',
			inputSchema: {
				issue: z
					.string()
					.min(1)
					.describe('The problem, described as the reporter would — symptoms, error text, what broke.'),
				categories: z
					.array(z.number().int().positive())
					.optional()
					.describe('Restrict to these category ids (from list_categories).'),
				tags: z.array(z.string()).optional().describe('Only topics carrying all of these tags.'),
				depth: z
					.number()
					.int()
					.min(1)
					.max(12)
					.optional()
					.describe('How many candidate topics to open in full. Default 5; raise for a stubborn issue.'),
				within_days: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('Only consider content newer than this many days. Requires search.'),
				scan_pages: z
					.number()
					.int()
					.min(1)
					.max(10)
					.optional()
					.describe('Listing pages to sweep when the forum has no search plugin. Default 3.'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			try {
				const caps = await ctx.capabilities.get();
				const result = await investigate(ctx.client, ctx.config, caps, {
					query: args.issue,
					categories: args.categories,
					tags: args.tags,
					depth: args.depth,
					withinDays: args.within_days,
					scanPages: args.scan_pages,
				});
				return text(formatInvestigation(result));
			} catch (err) {
				return toolError('investigate the issue', err);
			}
		},
	);
}
