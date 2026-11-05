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
 * Q&A state, only when the plugin is live *and* the topic carries it.
 *
 * The plugin keeps its state as plain topic-hash fields, and NodeBB returns
 * every hash field on every topic read — so after the plugin is deactivated or
 * uninstalled, `isSolved`/`solvedPid` keep arriving. That state is stale (no one
 * can see or change it any more), so it is only trusted while the plugin runs.
 * Callers say whether it does; see the `qna` capability.
 */
function toQna(raw: Raw, qnaActive: boolean): TopicSummary['qna'] {
	if (!qnaActive) return undefined;
	const hasQna = 'isQuestion' in raw || 'isSolved' in raw;
	if (!hasQna) return undefined;
	const solvedPid = num(raw.solvedPid, 0);
	return {
		isQuestion: bool(raw.isQuestion),
		isSolved: bool(raw.isSolved),
		...(solvedPid ? { solvedPid } : {}),
	};
}

export function toTopicSummary(client: NodeBBClient, raw: Raw, qnaActive: boolean): TopicSummary {
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
		qna: toQna(raw, qnaActive),
	};
}

function toPost(client: NodeBBClient, raw: Raw, tid: number, slug: string | undefined, qnaActive: boolean): PostItem {
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
		...(qnaActive && ('isAnswer' in raw) ? { isAcceptedAnswer: bool(raw.isAnswer) } : {}),
	};
}

/**
 * The Q&A plugin's filter:topic.getPosts hook *inserts a copy* of the accepted
 * answer right after the opening post (flagged `navigatorIgnore`/`allowDupe`)
 * whenever the answer is not already the first reply, so the thread page can
 * show it on top. A reader must not see that post twice or out of order: keep
 * each pid once, in thread order.
 */
function dedupePosts(rawPosts: Raw[]): Raw[] {
	const seen = new Set<number>();
	const kept: Raw[] = [];
	// Originals before injected copies, so the copy is the one dropped.
	const ordered = [...rawPosts].sort((a, b) => Number(bool(a.navigatorIgnore)) - Number(bool(b.navigatorIgnore)));
	for (const post of ordered) {
		const pid = num(post?.pid);
		if (!pid || seen.has(pid)) continue;
		seen.add(pid);
		kept.push(post);
	}
	return kept.sort((a, b) => num(a.index) - num(b.index));
}

/** One topic with its posts. */
export async function getTopic(
	client: NodeBBClient,
	tid: number,
	opts: { maxPosts: number; page?: number; qna: boolean },
): Promise<TopicDetail> {
	const raw = await client.read<Raw>(`/topic/${tid}`, opts.page ? { page: opts.page } : undefined);
	if (!raw || !raw.tid) {
		throw new NodeBBError('not-found', `Topic ${tid} was not found or is not readable.`, {
			path: `/api/topic/${tid}`,
		});
	}

	const summary = toTopicSummary(client, raw, opts.qna);
	const rawPosts: Raw[] = Array.isArray(raw.posts) ? raw.posts : [];
	const solvedPid = summary.qna?.solvedPid;

	let posts = dedupePosts(rawPosts).map(post => toPost(client, post, summary.tid, summary.slug, opts.qna));

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

/**
 * A single post, with the topic it belongs to.
 *
 * `/api/v3/posts/:pid` returns raw markdown and no author object, so read the
 * `/summary` variant (rendered HTML, `user`, Q&A-decorated `topic`), and mark
 * the post as the accepted answer when it is the topic's `solvedPid`.
 */
export async function getPost(
	client: NodeBBClient,
	pid: number,
	opts: { qna: boolean },
): Promise<{ post: PostItem; topic?: TopicSummary }> {
	let raw = await client.v3<Raw>(`/posts/${pid}/summary`, undefined, true).catch(() => undefined);
	if (!raw?.pid) raw = await client.v3<Raw>(`/posts/${pid}`, undefined, true);
	if (!raw || !raw.pid) {
		throw new NodeBBError('not-found', `Post ${pid} was not found or is not readable.`, {
			path: `/api/v3/posts/${pid}`,
		});
	}
	const tid = num(raw.tid, num(raw.topic?.tid));
	let topic: TopicSummary | undefined;
	if (tid) {
		try {
			const rawTopic = await client.v3<Raw>(`/topics/${tid}`, undefined, true);
			if (rawTopic?.tid) topic = toTopicSummary(client, rawTopic, opts.qna);
		} catch {
			// The post is still useful without its topic header.
		}
	}
	const post = toPost(client, raw, tid, topic?.slug, opts.qna);
	post.url = client.link(`/post/${pid}`);
	if (topic?.qna?.solvedPid === pid) post.isAcceptedAnswer = true;
	return { post, topic };
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
	opts: { source?: TopicListSource; cid?: number; page?: number; limit?: number; qna: boolean },
): Promise<{ topics: TopicSummary[]; source: string }> {
	const { source = 'recent', cid, page = 1, limit = 20 } = opts;

	const path = cid ? `/category/${cid}` : `/${source}`;
	const raw = await client.read<Raw>(path, { page });
	const list: Raw[] = Array.isArray(raw?.topics) ? raw.topics : [];

	return {
		topics: list.slice(0, limit).map(topic => toTopicSummary(client, topic, opts.qna)),
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
	/** Whether the Q&A plugin is live (its decorations are trusted only then). */
	qna: boolean;
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

	// dbsearch can return the same post more than once (it matched on both the
	// title and the body); keep the first, which is the better-ranked one.
	const seen = new Set<number>();
	const rawPosts: Raw[] = Array.isArray(raw?.posts) ? raw.posts : [];
	const list: Raw[] = rawPosts.filter((post) => {
		const pid = num(post?.pid);
		if (!pid || seen.has(pid)) return false;
		seen.add(pid);
		return true;
	});
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
			// Search summaries carry no index; /post/:pid is NodeBB's permalink.
			url: 'index' in post ? postUrl(client, tid, slug, num(post.index, 0)) : client.link(`/post/${num(post.pid)}`),
			categoryName: decodeTitle(category.name) || undefined,
			author: toAuthor(post.user as Raw),
			timestamp: num(post.timestamp) || undefined,
			snippet: snippetAround(text, params.query),
			// The forum ranked these; preserve that order as a descending score.
			score: list.length > 1 ? 1 - position / list.length : 1,
			// Set by the Q&A plugin's filter:post.getPostSummaryByPids hook — for every
			// hit, as parseInt() of the topic field, so a non-question arrives as null.
			// Only a question can be solved or unsolved.
			...(params.qna && bool(topic.isQuestion) ? { isSolved: bool(topic.isSolved) } : {}),
		};
	});

	return {
		hits,
		// The forum's count includes the duplicates dropped above.
		matchCount: Math.max(hits.length, num(raw?.matchCount, hits.length) - (rawPosts.length - list.length)),
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

/* ------------------------------------------------------------------ writes */

export interface WriteResult {
	tid: number;
	pid: number;
	url: string;
	title?: string;
}

/** Create a topic. With the Q&A plugin, `asQuestion` makes it a question. */
export async function createTopic(
	client: NodeBBClient,
	input: { cid: number; title: string; content: string; tags?: string[]; asQuestion?: boolean },
): Promise<WriteResult> {
	const raw = await client.write<Raw>('POST', '/topics', {
		cid: input.cid,
		title: input.title,
		content: input.content,
		...(input.tags?.length ? { tags: input.tags } : {}),
		// The Q&A plugin's filter:topic.create only checks that the key exists.
		...(input.asQuestion ? { isQuestion: 1 } : {}),
	});
	const tid = num(raw?.tid);
	return {
		tid,
		pid: num(raw?.mainPid),
		title: decodeTitle(raw?.title, input.title),
		url: topicUrl(client, tid, typeof raw?.slug === 'string' ? raw.slug : undefined),
	};
}

/** Reply to a topic, optionally quoting/answering a specific post. */
export async function replyToTopic(
	client: NodeBBClient,
	input: { tid: number; content: string; toPid?: number },
): Promise<WriteResult> {
	const raw = await client.write<Raw>('POST', `/topics/${input.tid}`, {
		content: input.content,
		...(input.toPid ? { toPid: input.toPid } : {}),
	});
	const pid = num(raw?.pid);
	return { tid: num(raw?.tid, input.tid), pid, url: client.link(`/post/${pid}`) };
}

/** Edit a post's body (and, for a topic's first post, its title). */
export async function editPost(
	client: NodeBBClient,
	input: { pid: number; content: string; title?: string },
): Promise<WriteResult> {
	const raw = await client.write<Raw>('PUT', `/posts/${input.pid}`, {
		content: input.content,
		...(input.title ? { title: input.title } : {}),
	});
	const post = (raw?.post ?? raw ?? {}) as Raw;
	return { tid: num(post.tid ?? raw?.topic?.tid), pid: input.pid, url: client.link(`/post/${input.pid}`) };
}

/** Up/down-vote a post, or withdraw a vote. Returns the post's new score. */
export async function votePost(
	client: NodeBBClient,
	input: { pid: number; vote: 'up' | 'down' | 'none' },
): Promise<{ votes?: number }> {
	if (input.vote === 'none') {
		await client.write('DELETE', `/posts/${input.pid}/vote`);
	} else {
		await client.write('PUT', `/posts/${input.pid}/vote`, { delta: input.vote === 'up' ? 1 : -1 });
	}
	const after = await client.v3<Raw>(`/posts/${input.pid}`, undefined, true).catch(() => undefined);
	return after && 'votes' in after ? { votes: num(after.votes) } : {};
}
