/**
 * Optional integration: nodebb-plugin-question-and-answer.
 *
 * The plugin stores state as topic fields (isQuestion / isSolved / solvedPid)
 * and decorates core payloads in place, so most of what we need arrives free on
 * ordinary topic and search reads. This module adds the parts that need its own
 * routes, plus core-only fallbacks so every caller keeps working without it.
 *
 * Nothing here throws when the plugin is absent: callers get an explicit
 * `available: false` and a usable degraded result.
 */

import type { NodeBBClient } from '../client.js';
import type { Capabilities } from '../capabilities.js';
import { isUsable } from '../capabilities.js';
import { getTopic, toTopicSummary } from '../nodebb/forum.js';
import type { PostItem, TopicSummary } from '../nodebb/types.js';

type Raw = Record<string, any>;

export interface QnaStatus {
	available: boolean;
	tracked: boolean;
	isQuestion: boolean;
	isSolved: boolean;
	solvedPid?: number;
	reason?: string;
}

/** Q&A state for one topic, via the plugin's own `/api/v3/plugins/qna/:tid`. */
export async function getQuestionStatus(
	client: NodeBBClient,
	capabilities: Capabilities,
	tid: number,
): Promise<QnaStatus> {
	if (!isUsable(capabilities.qna)) {
		return {
			available: false,
			tracked: false,
			isQuestion: false,
			isSolved: false,
			reason: capabilities.qna.reason ?? 'Q&A plugin not available.',
		};
	}

	const raw = await client.v3<Raw>(`/plugins/qna/${tid}`, undefined, true);
	if (!raw) {
		return { available: true, tracked: false, isQuestion: false, isSolved: false };
	}
	const isQuestion = String(raw.isQuestion) === '1' || raw.isQuestion === 1 || raw.isQuestion === true;
	const isSolved = String(raw.isSolved) === '1' || raw.isSolved === 1 || raw.isSolved === true;
	return { available: true, tracked: isQuestion, isQuestion, isSolved };
}

/**
 * Unsolved questions. Uses the plugin's /unsolved listing when present;
 * otherwise falls back to recent topics that have no replies, which is the
 * closest core-only approximation of "nobody has answered this".
 */
export async function listUnsolved(
	client: NodeBBClient,
	capabilities: Capabilities,
	opts: { page?: number; limit?: number } = {},
): Promise<{ topics: TopicSummary[]; degraded: boolean; note?: string }> {
	const limit = Math.min(opts.limit ?? 20, 50);

	if (isUsable(capabilities.qna)) {
		const raw = await client.read<Raw>('/unsolved', { page: opts.page ?? 1 });
		const list: Raw[] = Array.isArray(raw?.topics) ? raw.topics : [];
		return { topics: list.slice(0, limit).map(t => toTopicSummary(client, t)), degraded: false };
	}

	const raw = await client.read<Raw>('/recent', { page: opts.page ?? 1 });
	const list: Raw[] = Array.isArray(raw?.topics) ? raw.topics : [];
	const unanswered = list
		.map(t => toTopicSummary(client, t))
		// postcount 1 means the opening post and nothing else.
		.filter(t => t.postcount <= 1)
		.slice(0, limit);

	return {
		topics: unanswered,
		degraded: true,
		note:
			`${capabilities.qna.reason ?? 'Q&A plugin not available.'} ` +
			'Falling back to recent topics with no replies, which approximates "unanswered" ' +
			'but cannot tell a question from a discussion.',
	};
}

/** Solved questions, newest first. Empty (not an error) without the plugin. */
export async function listSolved(
	client: NodeBBClient,
	capabilities: Capabilities,
	opts: { page?: number; limit?: number } = {},
): Promise<{ topics: TopicSummary[]; available: boolean; reason?: string }> {
	if (!isUsable(capabilities.qna)) {
		return { topics: [], available: false, reason: capabilities.qna.reason };
	}
	const raw = await client.read<Raw>('/solved', { page: opts.page ?? 1 });
	const list: Raw[] = Array.isArray(raw?.topics) ? raw.topics : [];
	return {
		topics: list.slice(0, Math.min(opts.limit ?? 20, 50)).map(t => toTopicSummary(client, t)),
		available: true,
	};
}

export interface AnswerResult {
	topic: TopicSummary;
	answer?: PostItem;
	/** How the answer was identified. */
	basis: 'accepted' | 'most-upvoted' | 'first-reply' | 'none';
	degraded: boolean;
	note?: string;
}

/**
 * The best answer in a topic.
 *
 * With the Q&A plugin this is the author-accepted answer — authoritative. Without
 * it we fall back to the most-upvoted reply, then to the first reply, and label
 * which it was so the caller never presents a guess as an accepted answer.
 */
export async function getBestAnswer(
	client: NodeBBClient,
	capabilities: Capabilities,
	tid: number,
	maxPosts: number,
): Promise<AnswerResult> {
	const topic = await getTopic(client, tid, { maxPosts });
	const replies = topic.posts.filter(post => (post.index ?? 0) > 0);

	const accepted = topic.posts.find(post => post.isAcceptedAnswer);
	if (accepted) {
		return { topic, answer: accepted, basis: 'accepted', degraded: false };
	}

	// The plugin is live and says this question is unsolved — that is a real
	// answer ("nobody has accepted one"), not a reason to guess.
	if (isUsable(capabilities.qna) && topic.qna?.isQuestion && !topic.qna.isSolved) {
		return {
			topic,
			basis: 'none',
			degraded: false,
			note: 'This is an open question — no answer has been accepted yet.',
		};
	}

	if (!replies.length) {
		return { topic, basis: 'none', degraded: !isUsable(capabilities.qna), note: 'This topic has no replies.' };
	}

	const ranked = [...replies].sort((a, b) => (b.votes ?? b.upvotes ?? 0) - (a.votes ?? a.upvotes ?? 0));
	const top = ranked[0]!;
	const hasVotes = (top.votes ?? top.upvotes ?? 0) > 0;
	const pick = hasVotes ? top : replies[0]!;

	return {
		topic,
		answer: pick,
		basis: hasVotes ? 'most-upvoted' : 'first-reply',
		degraded: true,
		note: isUsable(capabilities.qna)
			? 'No answer is marked accepted on this topic; showing the strongest reply instead.'
			: `${capabilities.qna.reason ?? 'Q&A plugin not available.'} ` +
				'Showing the strongest reply instead of an author-accepted answer.',
	};
}
