/**
 * The part that does the actual thinking: finding the topics that answer a
 * question, and assembling an investigation of an issue.
 *
 * The central constraint is that NodeBB core has no search. A forum without a
 * search plugin still has to be useful here, so every entry point has two
 * implementations:
 *
 *   search available  — ask the forum, keep its relevance ordering
 *   search absent     — scan recent/category listings and rank titles locally
 *
 * The scan is genuinely weaker (titles only, recent only) and always says so,
 * because a confident answer drawn from a shallow scan is worse than an honest
 * partial one.
 */

import type { NodeBBClient } from './client.js';
import type { Capabilities } from './capabilities.js';
import { isUsable } from './capabilities.js';
import type { Config } from './config.js';
import { getBestAnswer } from './integrations/qna.js';
import { getTriageStatuses, type TriageStatus } from './integrations/shotef.js';
import { getTopic, listTopics, search } from './nodebb/forum.js';
import type { PostItem, TopicSummary } from './nodebb/types.js';
import { overlapScore, truncate } from './text.js';

export interface Candidate {
	tid: number;
	title: string;
	url: string;
	categoryName?: string;
	snippet?: string;
	score: number;
	isSolved?: boolean;
	postcount?: number;
	timestamp?: number;
	/** How this candidate was found — 'scan' means no search plugin was available. */
	via: 'search' | 'scan';
}

export interface CandidateSet {
	candidates: Candidate[];
	degraded: boolean;
	notes: string[];
}

/** Run async work with a small concurrency cap, preserving input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await fn(items[index]!);
		}
	});
	await Promise.all(workers);
	return results;
}

function bestPerTopic(candidates: Candidate[]): Candidate[] {
	const byTid = new Map<number, Candidate>();
	for (const candidate of candidates) {
		const existing = byTid.get(candidate.tid);
		if (!existing || candidate.score > existing.score) byTid.set(candidate.tid, candidate);
	}
	return [...byTid.values()];
}

export interface GatherOptions {
	query: string;
	categories?: number[];
	tags?: string[];
	limit?: number;
	/** Pages of listing to sweep when falling back to a local scan. */
	scanPages?: number;
	withinDays?: number;
}

/** Find topics plausibly related to a query, however this forum allows. */
export async function gatherCandidates(
	client: NodeBBClient,
	capabilities: Capabilities,
	opts: GatherOptions,
): Promise<CandidateSet> {
	const limit = Math.min(opts.limit ?? 15, 50);
	const notes: string[] = [];

	if (isUsable(capabilities.search)) {
		const { hits, matchCount } = await search(client, {
			query: opts.query,
			in: 'titlesposts',
			categories: opts.categories,
			tags: opts.tags,
			withinDays: opts.withinDays,
			limit,
		});

		if (!hits.length) {
			notes.push(`Forum search matched nothing for ${JSON.stringify(opts.query)}.`);
		} else if (matchCount > hits.length) {
			notes.push(`Showing ${hits.length} of ${matchCount} matches.`);
		}

		const candidates = bestPerTopic(hits.map(hit => ({
			tid: hit.tid,
			title: hit.title,
			url: hit.url,
			categoryName: hit.categoryName,
			snippet: hit.snippet,
			score: hit.score,
			isSolved: hit.isSolved,
			timestamp: hit.timestamp,
			via: 'search' as const,
		})));

		return { candidates, degraded: false, notes };
	}

	// No search plugin: sweep listings and rank titles ourselves.
	notes.push(
		`${capabilities.search.reason ?? 'Forum search is unavailable.'} ` +
			'Falling back to a local scan of recent topics, ranked by title overlap — ' +
			'this only sees recent activity and cannot match post bodies.',
	);

	const pages = Math.max(1, Math.min(opts.scanPages ?? 3, 10));
	const sources: { cid?: number; page: number }[] = [];
	for (let page = 1; page <= pages; page += 1) {
		if (opts.categories?.length) {
			for (const cid of opts.categories) sources.push({ cid, page });
		} else {
			sources.push({ page });
		}
	}

	const batches = await mapLimit(sources, 4, async (source) => {
		try {
			const { topics } = await listTopics(client, {
				source: 'recent',
				cid: source.cid,
				page: source.page,
				limit: 50,
			});
			return topics;
		} catch {
			return [] as TopicSummary[];
		}
	});

	const scored: Candidate[] = [];
	for (const topic of batches.flat()) {
		const haystack = [topic.title, ...(topic.tags ?? [])].join(' ');
		const score = overlapScore(opts.query, haystack);
		if (score <= 0) continue;
		scored.push({
			tid: topic.tid,
			title: topic.title,
			url: topic.url,
			categoryName: topic.categoryName,
			score,
			isSolved: topic.qna?.isSolved,
			postcount: topic.postcount,
			timestamp: topic.timestamp,
			via: 'scan',
		});
	}

	const candidates = bestPerTopic(scored)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);

	if (!candidates.length) {
		notes.push('The scan found no recent topic whose title overlaps the query.');
	}

	return { candidates, degraded: true, notes };
}

/**
 * Rank candidates for *answering*: a solved question outranks an unsolved one,
 * and a thread with replies outranks a thread with none, but relevance still
 * dominates so we never surface a solved-but-unrelated topic.
 */
export function rankForAnswers(candidates: Candidate[]): Candidate[] {
	return [...candidates].sort((a, b) => weight(b) - weight(a));

	function weight(candidate: Candidate): number {
		let score = candidate.score;
		if (candidate.isSolved === true) score += 0.35;
		if (candidate.isSolved === false) score -= 0.05;
		if ((candidate.postcount ?? 0) > 1) score += 0.05;
		return score;
	}
}

export interface AnsweredCandidate {
	candidate: Candidate;
	topic: TopicSummary;
	answer?: PostItem;
	basis: 'accepted' | 'most-upvoted' | 'first-reply' | 'none';
	note?: string;
}

/** Pull the best answer out of each of the top candidates. */
export async function resolveAnswers(
	client: NodeBBClient,
	capabilities: Capabilities,
	candidates: Candidate[],
	opts: { take: number; maxPosts: number },
): Promise<AnsweredCandidate[]> {
	const top = candidates.slice(0, opts.take);
	const resolved = await mapLimit<Candidate, AnsweredCandidate | undefined>(top, 3, async (candidate) => {
		try {
			const result = await getBestAnswer(client, capabilities, candidate.tid, opts.maxPosts);
			return {
				candidate,
				topic: result.topic,
				answer: result.answer,
				basis: result.basis,
				note: result.note,
			};
		} catch {
			return undefined;
		}
	});
	return resolved.filter((item): item is AnsweredCandidate => Boolean(item));
}

export interface Investigation {
	query: string;
	degraded: boolean;
	notes: string[];
	answered: AnsweredCandidate[];
	unresolved: Candidate[];
	triage: Map<number, TriageStatus>;
	capabilities: Capabilities;
}

/**
 * The full investigation: what the forum already knows about a problem, which
 * reports of it are still open, and whether anyone is working on it.
 */
export async function investigate(
	client: NodeBBClient,
	config: Config,
	capabilities: Capabilities,
	opts: GatherOptions & { depth?: number },
): Promise<Investigation> {
	const { candidates, degraded, notes } = await gatherCandidates(client, capabilities, {
		...opts,
		limit: opts.limit ?? 20,
	});

	const ranked = rankForAnswers(candidates);
	const depth = Math.max(1, Math.min(opts.depth ?? 5, 12));

	const answered = await resolveAnswers(client, capabilities, ranked, {
		take: depth,
		maxPosts: config.maxPostsPerTopic,
	});

	const answeredTids = new Set(answered.map(item => item.candidate.tid));
	const unresolved = ranked.filter(candidate => !answeredTids.has(candidate.tid));

	const triage = await getTriageStatuses(
		client,
		config,
		capabilities,
		ranked.slice(0, 25).map(candidate => candidate.tid),
	);

	return { query: opts.query, degraded, notes, answered, unresolved, triage, capabilities };
}

/** A topic's opening post, for stating the problem in the caller's own terms. */
export async function getOpeningPost(
	client: NodeBBClient,
	tid: number,
	maxPosts: number,
): Promise<{ topic: TopicSummary; opening?: PostItem }> {
	const topic = await getTopic(client, tid, { maxPosts: Math.min(maxPosts, 5) });
	const opening = topic.posts.find(post => (post.index ?? 0) === 0) ?? topic.posts[0];
	return { topic, opening };
}

/** Short label for how confident an answer basis is. */
export function describeBasis(basis: AnsweredCandidate['basis']): string {
	switch (basis) {
		case 'accepted':
			return 'accepted answer';
		case 'most-upvoted':
			return 'most-upvoted reply (not marked accepted)';
		case 'first-reply':
			return 'first reply (unranked, not marked accepted)';
		case 'none':
			return 'no answer found';
	}
}

/** Trim an answer body for inclusion in a brief. */
export function answerExcerpt(post: PostItem | undefined, max = 900): string {
	if (!post || !post.content) return '';
	return truncate(post.content, max);
}
