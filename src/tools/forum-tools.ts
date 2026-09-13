/** Tools for reading the forum: search, topics, posts, categories, listings. */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { isUsable } from '../capabilities.js';
import { getTriageStatus } from '../integrations/shotef.js';
import { getPost, getTopic, listCategories, listTopics, search } from '../nodebb/forum.js';
import type { CategoryNode } from '../nodebb/types.js';
import { gatherCandidates } from '../research.js';
import type { ToolContext } from './context.js';
import {
	degradationNote, formatCandidate, formatDate, formatTopicDetail, formatTopicSummary, text, toolError,
} from './format.js';

export function registerForumTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		'forum_capabilities',
		{
			title: 'Forum capabilities',
			description:
				'Report which forum features this server can actually use: reachability, authentication, ' +
				'full-text search, the Q&A plugin (accepted answers), and the Shotef triage plugin. ' +
				'Call this first when a result looks thin or a tool reports a feature as unavailable — ' +
				'it explains what is missing and what would enable it.',
			inputSchema: {
				refresh: z
					.boolean()
					.optional()
					.describe('Re-probe the forum instead of using the cached result. Use after installing a plugin.'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ refresh }) => {
			try {
				const caps = await ctx.capabilities.get(Boolean(refresh));
				const lines = ['# Forum capabilities', ''];

				lines.push(`**Forum:** ${caps.forum.url}`);
				if (!caps.forum.reachable) {
					lines.push('', `❌ Unreachable — ${caps.forum.reason ?? 'no detail'}`);
					return text(lines.join('\n'));
				}
				if (caps.forum.title) lines.push(`**Title:** ${caps.forum.title}`);
				if (caps.forum.version) lines.push(`**NodeBB version:** ${caps.forum.version}`);
				lines.push(
					`**Authentication:** ${caps.forum.authenticated
						? 'API token configured'
						: 'anonymous — only publicly readable content is visible'}`,
					'',
					'| Feature | State | Detail |',
					'| --- | --- | --- |',
				);

				const row = (label: string, cap: { state: string; reason?: string }) =>
					`| ${label} | ${cap.state === 'available' ? '✅ available' : `⚠️ ${cap.state}`} | ${cap.reason ?? '—'} |`;

				lines.push(
					row('Full-text search', caps.search),
					row('Q&A (accepted answers)', caps.qna),
					row('Shotef (triage board)', caps.shotef),
					'',
					`_Probed ${formatDate(caps.probedAt)}; cached for ${Math.round(ctx.config.capabilityTtlMs / 1000)}s._`,
				);

				if (!isUsable(caps.search)) {
					lines.push(
						'',
						'Without search, `search_forum` is unavailable and `find_answers` / `investigate_issue` ' +
							'fall back to scanning recent topics by title.',
					);
				}
				return text(lines.join('\n'));
			} catch (err) {
				return toolError('read forum capabilities', err);
			}
		},
	);

	server.registerTool(
		'search_forum',
		{
			title: 'Search the forum',
			description:
				'Full-text search across topic titles and post bodies. Returns ranked matches with a ' +
				'snippet showing why each matched. Requires a search plugin on the forum (NodeBB core has ' +
				'none); when one is absent this falls back to scanning recent topics by title and says so. ' +
				'For answering a question, prefer find_answers, which also extracts the answers.',
			inputSchema: {
				query: z.string().min(1).describe('What to search for. Plain words work best; quotes are not special.'),
				in: z
					.enum(['titles', 'titlesposts', 'posts', 'tags'])
					.optional()
					.describe('Where to look. Default titlesposts (titles and post bodies).'),
				categories: z.array(z.number().int().positive()).optional().describe('Restrict to these category ids.'),
				tags: z.array(z.string()).optional().describe('Only topics carrying all of these tags.'),
				posted_by: z.string().optional().describe('Only posts by this username.'),
				within_days: z.number().int().positive().optional().describe('Only content newer than this many days.'),
				sort_by: z
					.enum(['relevance', 'timestamp', 'votes', 'topic.lastposttime'])
					.optional()
					.describe('Ordering. Default relevance.'),
				limit: z.number().int().min(1).max(50).optional().describe('Maximum results. Default 15.'),
				page: z.number().int().min(1).optional().describe('Result page, for paging past the first set.'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			try {
				const caps = await ctx.capabilities.get();

				if (!isUsable(caps.search)) {
					const fallback = await gatherCandidates(ctx.client, caps, {
						query: args.query,
						categories: args.categories,
						tags: args.tags,
						limit: args.limit ?? 15,
					});
					const lines = [
						`# Scan results for "${args.query}"`,
						'',
						...fallback.notes.map(note => `_${note}_`),
						'',
					];
					if (!fallback.candidates.length) {
						lines.push('No recent topic title overlapped this query.');
					} else {
						fallback.candidates.forEach((candidate, i) => lines.push(formatCandidate(candidate, i + 1), ''));
					}
					return text(lines.join('\n').trim());
				}

				const { hits, matchCount, pageCount } = await search(ctx.client, {
					query: args.query,
					in: args.in,
					categories: args.categories,
					tags: args.tags,
					postedBy: args.posted_by,
					withinDays: args.within_days,
					sortBy: args.sort_by,
					limit: args.limit,
					page: args.page,
				});

				if (!hits.length) {
					return text(
						`No matches for "${args.query}".\n\n` +
							'Try fewer or more general words, drop the category or tag filters, or widen within_days.',
					);
				}

				const lines = [
					`# ${matchCount} match${matchCount === 1 ? '' : 'es'} for "${args.query}"`,
					pageCount > 1 ? `_Page ${args.page ?? 1} of ${pageCount}._` : '',
					'',
				];
				hits.forEach((hit, i) => {
					const facts = [hit.categoryName, hit.author?.username, formatDate(hit.timestamp)]
						.filter(Boolean)
						.join(' · ');
					lines.push(
						`${i + 1}. **#${hit.tid} ${hit.title}**${hit.isSolved ? ' · **solved**' : ''}`,
						`   ${facts}`,
						`   > ${hit.snippet.replace(/\n+/g, ' ')}`,
						`   ${hit.url}`,
						'',
					);
				});
				return text(lines.join('\n').trim());
			} catch (err) {
				return toolError('search the forum', err);
			}
		},
	);

	server.registerTool(
		'get_topic',
		{
			title: 'Read a topic',
			description:
				'Read a topic in full: the original post, replies in order, and — when the relevant plugins ' +
				'are installed — which reply is the accepted answer and where the topic sits on the triage ' +
				'board. This is the tool for understanding a reported issue in the reporter\'s own words.',
			inputSchema: {
				tid: z.number().int().positive().describe('Topic id (the number in /topic/<tid>/...).'),
				max_posts: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe('Cap on posts returned. Default comes from server config (50).'),
				page: z.number().int().min(1).optional().describe('Page of posts, for long topics.'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ tid, max_posts, page }) => {
			try {
				const caps = await ctx.capabilities.get();
				const topic = await getTopic(ctx.client, tid, {
					maxPosts: max_posts ?? ctx.config.maxPostsPerTopic,
					page,
				});
				const triage = await getTriageStatus(ctx.client, ctx.config, caps, tid);
				const banner = degradationNote(caps);
				return text([formatTopicDetail(topic, triage), banner ? `\n${banner}` : ''].join('').trim());
			} catch (err) {
				return toolError(`read topic ${tid}`, err);
			}
		},
	);

	server.registerTool(
		'get_post',
		{
			title: 'Read a single post',
			description:
				'Read one post by its id, with the topic it belongs to. Use when a search result or a link ' +
				'points at a specific reply and you only need that reply.',
			inputSchema: {
				pid: z.number().int().positive().describe('Post id (the number in /post/<pid>).'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ pid }) => {
			try {
				const { post, topic } = await getPost(ctx.client, pid);
				const lines: string[] = [];
				if (topic) lines.push(formatTopicSummary(topic), '');
				lines.push(
					`### Post ${pid} — ${post.author?.username ?? 'unknown'} · ${formatDate(post.timestamp)}` +
						`${post.isAcceptedAnswer ? ' · ✅ ACCEPTED ANSWER' : ''}`,
					'',
					post.content || '_(empty)_',
					'',
					post.url,
				);
				return text(lines.join('\n'));
			} catch (err) {
				return toolError(`read post ${pid}`, err);
			}
		},
	);

	server.registerTool(
		'list_categories',
		{
			title: 'List categories',
			description:
				'List the forum\'s category tree with ids, descriptions and topic counts. Use it to find the ' +
				'category id to pass to search_forum, list_recent_topics, or investigate_issue.',
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () => {
			try {
				const categories = await listCategories(ctx.client);
				if (!categories.length) {
					return text('No categories are visible to this token.');
				}

				const lines = ['# Categories', ''];
				const walk = (nodes: CategoryNode[], depth: number) => {
					for (const node of nodes) {
						const facts = [
							node.topicCount !== undefined ? `${node.topicCount} topics` : '',
							node.postCount !== undefined ? `${node.postCount} posts` : '',
						].filter(Boolean).join(' · ');
						lines.push(
							`${'  '.repeat(depth)}- **[cid ${node.cid}] ${node.name}**${facts ? ` — ${facts}` : ''}`,
						);
						if (node.description) {
							lines.push(`${'  '.repeat(depth + 1)}${node.description}`);
						}
						if (node.children.length) walk(node.children, depth + 1);
					}
				};
				walk(categories, 0);
				return text(lines.join('\n'));
			} catch (err) {
				return toolError('list categories', err);
			}
		},
	);

	server.registerTool(
		'list_recent_topics',
		{
			title: 'List recent topics',
			description:
				'Browse topic listings — recent, popular, top, or unread — optionally inside one category. ' +
				'Useful for getting a feel for what is being reported lately, and as the way to explore a ' +
				'forum that has no search plugin.',
			inputSchema: {
				source: z
					.enum(['recent', 'popular', 'top', 'unread'])
					.optional()
					.describe('Which listing. Default recent. unread requires an authenticated token.'),
				cid: z.number().int().positive().optional().describe('Restrict to one category id.'),
				limit: z.number().int().min(1).max(50).optional().describe('Maximum topics. Default 20.'),
				page: z.number().int().min(1).optional().describe('Listing page.'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ source, cid, limit, page }) => {
			try {
				const { topics, source: usedSource } = await listTopics(ctx.client, { source, cid, limit, page });
				if (!topics.length) {
					return text(`No topics found in ${usedSource}.`);
				}
				const lines = [`# Topics (${usedSource})`, ''];
				topics.forEach(topic => lines.push(formatTopicSummary(topic), ''));
				return text(lines.join('\n').trim());
			} catch (err) {
				return toolError('list topics', err);
			}
		},
	);
}
