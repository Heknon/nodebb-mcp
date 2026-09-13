/**
 * Reading a NodeBB forum through its Read API, normalized into the shapes in
 * ./types.ts.
 *
 * Normalization matters here for two reasons beyond tidiness:
 *  - titles arrive HTML-escaped and post content arrives as rendered HTML, so
 *    both are decoded exactly once on the way through;
 *  - the Q&A plugin decorates core payloads in place (topic.isSolved on search
 *    hits and listings, post.isAnswer inside a topic), so when it is installed
 *    we get its state for free and simply pass it along.
 */

import type { NodeBBClient } from '../client.js';
import { NodeBBError } from '../errors.js';
import { decodeTitle, htmlToText, snippetAround, truncate } from '../text.js';
import type {
	Author, CategoryNode, PostItem, SearchHit, TopicDetail, TopicListSource, TopicSummary,
} from './types.js';

type Raw = Record<string, any>;

const num = (value: unknown, fallback = 0): number => {
	const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
	return Number.isFinite(n) ? n : fallback;
};

const bool = (value: unknown): boolean =>
	value === true || value === 1 || value === '1';

function toAuthor(raw: Raw | undefined): Author | undefined {
	if (!raw) return undefined;
	const uid = num(raw.uid, 0);
	const username = decodeTitle(raw.username ?? raw.displayname, uid ? `uid ${uid}` : 'Guest');
	if (!uid && !username) return undefined;
	return { uid, username, userslug: typeof raw.userslug === 'string' ? raw.userslug : undefined };
}

function topicUrl(client: NodeBBClient, tid: number, slug?: string): string {
	return client.link(`/topic/${slug || tid}`);
}

function postUrl(client: NodeBBClient, tid: number, slug: string | undefined, index?: number): string {
	const base = `/topic/${slug || tid}`;
	return client.link(index && index > 0 ? `${base}/${index}` : base);
}

function toTags(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((tag) => (typeof tag === 'string' ? tag : decodeTitle(tag?.value ?? tag?.valueEscaped)))
		.filter((tag): tag is string => Boolean(tag));
}

/**
 * Q&A state, only when the plugin actually decorated the payload. `isQuestion`
 * is absent on a forum without the plugin, which is how we tell "not a question"
 * apart from "this forum has no questions".
 */
function toQna(raw: Raw): TopicSummary['qna'] {
	const hasQna = 'isQuestion' in raw || 'isSolved' in raw;
	if (!hasQna) return undefined;
	const solvedPid = num(raw.solvedPid, 0);
	return {
		isQuestion: bool(raw.isQuestion),
		isSolved: bool(raw.isSolved),
		...(solvedPid ? { solvedPid } : {}),
	};
}

export function toTopicSummary(client: NodeBBClient, raw: Raw): TopicSummary {
	const tid = num(raw.tid);
	const slug = typeof raw.slug === 'string' ? raw.slug : undefined;
	const category = (raw.category ?? {}) as Raw;
	return {
		tid,
		title: decodeTitle(raw.title, `Topic #${tid}`),
		slug,
		url: topicUrl(client, tid, slug),
		cid: num(raw.cid, num(category.cid, 0)) || undefined,
		categoryName: decodeTitle(category.name) || undefined,
		author: toAuthor(raw.user as Raw) ?? toAuthor({ uid: raw.uid, username: raw.username }),
		postcount: num(raw.postcount),
		viewcount: num(raw.viewcount),
		votes: 'votes' in raw ? num(raw.votes) : undefined,
		timestamp: num(raw.timestamp) || undefined,
		lastposttime: num(raw.lastposttime) || undefined,
		tags: toTags(raw.tags),
		locked: bool(raw.locked),
		deleted: bool(raw.deleted),
		qna: toQna(raw),
	};
}

function toPost(client: NodeBBClient, raw: Raw, tid: number, slug?: string): PostItem {
	const pid = num(raw.pid);
	const index = num(raw.index, 0);
	const content = htmlToText(typeof raw.content === 'string' ? raw.content : '');
	return {
		pid,
		tid: num(raw.tid, tid) || undefined,
		index: index || undefined,
		author: toAuthor(raw.user as Raw) ?? toAuthor({ uid: raw.uid }),
		timestamp: num(raw.timestamp) || undefined,
		votes: 'votes' in raw ? num(raw.votes) : undefined,
		upvotes: 'upvotes' in raw ? num(raw.upvotes) : undefined,
		content,
		url: postUrl(client, tid, slug, index),
		// `isAnswer` is set by the Q&A plugin's filter:topic.getPosts hook.
		...(('isAnswer' in raw) ? { isAcceptedAnswer: bool(raw.isAnswer) } : {}),
	};
}

/** One topic with its posts. */
export async function getTopic(
	client: NodeBBClient,
	tid: number,
	opts: { maxPosts: number; page?: number } = { maxPosts: 50 },
): Promise<TopicDetail> {
	const raw = await client.read<Raw>(`/topic/${tid}`, opts.page ? { page: opts.page } : undefined);
	if (!raw || !raw.tid) {
		throw new NodeBBError('not-found', `Topic ${tid} was not found or is not readable.`, {
			path: `/api/topic/${tid}`,
		});
	}

	const summary = toTopicSummary(client, raw);
	const rawPosts: Raw[] = Array.isArray(raw.posts) ? raw.posts : [];
	const solvedPid = summary.qna?.solvedPid;

	let posts = rawPosts.map(post => toPost(client, post, summary.tid, summary.slug));

	// Backstop: if the plugin flagged the topic but not the post (older versions
	// decorate only the page build), mark the accepted answer from solvedPid.
	if (solvedPid && !posts.some(p => p.isAcceptedAnswer)) {
		posts = posts.map(p => (p.pid === solvedPid ? { ...p, isAcceptedAnswer: true } : p));
	}

	const totalPosts = summary.postcount || posts.length;
	const truncated = posts.length > opts.maxPosts;

	return {
		...summary,
		posts: truncated ? posts.slice(0, opts.maxPosts) : posts,
		totalPosts,
		truncated,
	};
}

/** A single post, with the topic it belongs to. */
export async function getPost(client: NodeBBClient, pid: number): Promise<{ post: PostItem; topic?: TopicSummary }> {
	const raw = await client.v3<Raw>(`/posts/${pid}`);
	if (!raw || !raw.pid) {
		throw new NodeBBError('not-found', `Post ${pid} was not found or is not readable.`, {
			path: `/api/v3/posts/${pid}`,
		});
	}
	const tid = num(raw.tid);
	let topic: TopicSummary | undefined;
	if (tid) {
		try {
			const rawTopic = await client.v3<Raw>(`/topics/${tid}`, undefined, true);
			if (rawTopic?.tid) topic = toTopicSummary(client, rawTopic);
		} catch {
			// The post is still useful without its topic header.
		}
	}
	return { post: toPost(client, raw, tid, topic?.slug), topic };
}

/** Category tree. */
export async function listCategories(client: NodeBBClient): Promise<CategoryNode[]> {
	const raw = await client.read<Raw>('/categories');
	const list: Raw[] = Array.isArray(raw?.categories) ? raw.categories : [];

	const toNode = (node: Raw): CategoryNode => ({
		cid: num(node.cid),
		name: decodeTitle(node.name, `Category ${num(node.cid)}`),
		description: decodeTitle(node.description) || undefined,
		slug: typeof node.slug === 'string' ? node.slug : undefined,
		topicCount: num(node.topic_count, num(node.totalTopicCount)) || undefined,
		postCount: num(node.post_count, num(node.totalPostCount)) || undefined,
		url: client.link(`/category/${node.slug || num(node.cid)}`),
		children: Array.isArray(node.children) ? node.children.map(toNode) : [],
	});

	return list.map(toNode);
}

/** Topic listings: recent / popular / top / unread, optionally within a category. */
export async function listTopics(
	client: NodeBBClient,
	opts: { source?: TopicListSource; cid?: number; page?: number; limit?: number } = {},
): Promise<{ topics: TopicSummary[]; source: string }> {
	const { source = 'recent', cid, page = 1, limit = 20 } = opts;

	const path = cid ? `/category/${cid}` : `/${source}`;
	const raw = await client.read<Raw>(path, { page });
	const list: Raw[] = Array.isArray(raw?.topics) ? raw.topics : [];

	return {
		topics: list.slice(0, limit).map(topic => toTopicSummary(client, topic)),
		source: cid ? `category ${cid}` : source,
	};
}

export interface SearchParams {
	query: string;
	in?: 'titles' | 'titlesposts' | 'posts' | 'tags';
	categories?: number[];
	tags?: string[];
	postedBy?: string;
	sortBy?: 'relevance' | 'timestamp' | 'votes' | 'topic.lastposttime';
	sortDirection?: 'asc' | 'desc';
	/** Only match content newer than this many days. */
	withinDays?: number;
	page?: number;
	limit?: number;
}

/**
 * Full-text search. Requires a search plugin on the forum — NodeBB core has
 * none, and its controller 404s when nothing listens on `filter:search.query`.
 * Callers check the `search` capability first and fall back when it is absent.
 */
export async function search(
	client: NodeBBClient,
	params: SearchParams,
): Promise<{ hits: SearchHit[]; matchCount: number; pageCount: number }> {
	const limit = Math.min(params.limit ?? 15, 50);

	const raw = await client.read<Raw>('/search', {
		term: params.query,
		in: params.in ?? 'titlesposts',
		searchOnly: 1,
		matchWords: 'any',
		page: params.page ?? 1,
		itemsPerPage: limit,
		sortBy: params.sortBy ?? 'relevance',
		sortDirection: params.sortDirection ?? 'desc',
		categories: params.categories?.map(String),
		hasTags: params.tags,
		by: params.postedBy,
		...(params.withinDays
			? { timeFilter: 'newer', timeRange: Math.round(params.withinDays * 86400) }
			: {}),
	});

	const list: Raw[] = Array.isArray(raw?.posts) ? raw.posts : [];
	const hits: SearchHit[] = list.slice(0, limit).map((post, position) => {
		const topic = (post.topic ?? {}) as Raw;
		const category = (post.category ?? {}) as Raw;
		const tid = num(topic.tid, num(post.tid));
		const slug = typeof topic.slug === 'string' ? topic.slug : undefined;
		const text = htmlToText(typeof post.content === 'string' ? post.content : '');

		return {
			pid: num(post.pid),
			tid,
			title: decodeTitle(topic.title, `Topic #${tid}`),
			url: postUrl(client, tid, slug, num(post.index, 0)),
			categoryName: decodeTitle(category.name) || undefined,
			author: toAuthor(post.user as Raw),
			timestamp: num(post.timestamp) || undefined,
			snippet: snippetAround(text, params.query),
			// The forum ranked these; preserve that order as a descending score.
			score: list.length > 1 ? 1 - position / list.length : 1,
			// Set by the Q&A plugin's filter:post.getPostSummaryByPids hook.
			...(('isSolved' in topic) ? { isSolved: bool(topic.isSolved) } : {}),
		};
	});

	return {
		hits,
		matchCount: num(raw?.matchCount, hits.length),
		pageCount: num(raw?.pageCount, 1),
	};
}

/** Compact one-line rendering of a topic, for list output. */
export function formatTopicLine(topic: TopicSummary): string {
	const bits: string[] = [];
	if (topic.categoryName) bits.push(topic.categoryName);
	bits.push(`${topic.postcount} posts`);
	if (topic.viewcount) bits.push(`${topic.viewcount} views`);
	if (topic.qna?.isQuestion) bits.push(topic.qna.isSolved ? 'SOLVED' : 'unsolved');
	if (topic.locked) bits.push('locked');
	return `#${topic.tid} ${truncate(topic.title, 110)}\n  ${bits.join(' · ')}\n  ${topic.url}`;
}
