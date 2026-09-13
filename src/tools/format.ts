/**
 * Rendering tool results as text.
 *
 * Everything a tool returns is markdown aimed at a model that will cite it, so
 * two rules run through this file: every claim carries its source URL, and any
 * degradation is stated in the result itself rather than left for the reader to
 * infer from thin output.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Capabilities } from '../capabilities.js';
import { NodeBBError } from '../errors.js';
import type { TopicDetail, TopicSummary } from '../nodebb/types.js';
import type { TriageStatus } from '../integrations/shotef.js';
import { answerExcerpt, describeBasis, type AnsweredCandidate, type Candidate, type Investigation } from '../research.js';
import { truncate } from '../text.js';

export type ToolResult = CallToolResult;

export function text(body: string): ToolResult {
	return { content: [{ type: 'text', text: body }] };
}

export function failure(body: string): ToolResult {
	return { content: [{ type: 'text', text: body }], isError: true };
}

/** Turn any thrown value into an explanation a caller can act on. */
export function toolError(action: string, err: unknown): ToolResult {
	if (err instanceof NodeBBError) {
		const parts = [`Could not ${action}: ${err.message}`, err.hint];
		if (err.forumMessage) parts.splice(1, 0, `Forum said: ${err.forumMessage}`);
		return failure(parts.join('\n'));
	}
	return failure(`Could not ${action}: ${err instanceof Error ? err.message : String(err)}`);
}

export function formatDate(ts: number | undefined): string {
	if (!ts) return 'unknown date';
	const date = new Date(ts);
	return Number.isNaN(date.getTime()) ? 'unknown date' : date.toISOString().slice(0, 10);
}

/** A note about missing optional features, or '' when everything is present. */
export function degradationNote(capabilities: Capabilities): string {
	const missing: string[] = [];
	if (!capabilities.search || capabilities.search.state !== 'available') {
		missing.push('full-text search');
	}
	if (capabilities.qna.state !== 'available') missing.push('Q&A (accepted answers)');
	if (capabilities.shotef.state !== 'available') missing.push('Shotef (triage status)');
	if (!missing.length) return '';
	return `_Running without: ${missing.join(', ')}. Results are correspondingly limited._`;
}

export function formatTopicSummary(topic: TopicSummary): string {
	const facts: string[] = [];
	if (topic.categoryName) facts.push(topic.categoryName);
	facts.push(`${topic.postcount} post${topic.postcount === 1 ? '' : 's'}`);
	if (topic.viewcount) facts.push(`${topic.viewcount} views`);
	facts.push(formatDate(topic.timestamp));
	if (topic.qna?.isQuestion) facts.push(topic.qna.isSolved ? '**solved**' : '**unsolved**');
	if (topic.locked) facts.push('locked');
	if (topic.tags.length) facts.push(`tags: ${topic.tags.join(', ')}`);

	return `**#${topic.tid} ${topic.title}**\n${facts.join(' · ')}\n${topic.url}`;
}

export function formatTriage(status: TriageStatus | undefined): string {
	if (!status || !status.available || !status.tracked) return '';
	const bits = [status.label ?? status.status ?? 'tracked'];
	if (status.teamName) bits.push(`handled by ${status.teamName}`);
	if (status.parked) bits.push(status.holdReason ? `on hold (${status.holdReason})` : 'on hold');
	if (status.closeReason === 'no_response') bits.push('closed: no reply from reporter');
	if (status.updatedAt) bits.push(`updated ${formatDate(status.updatedAt)}`);
	return `Triage: ${bits.join(' · ')}`;
}

export function formatTopicDetail(topic: TopicDetail, triage?: TriageStatus): string {
	const lines = [formatTopicSummary(topic)];

	const triageLine = formatTriage(triage);
	if (triageLine) lines.push(triageLine);

	if (topic.truncated) {
		lines.push(`_Showing ${topic.posts.length} of ${topic.totalPosts} posts._`);
	}
	lines.push('');

	for (const post of topic.posts) {
		const who = post.author?.username ?? 'unknown';
		const marks: string[] = [];
		if (post.isAcceptedAnswer) marks.push('✅ ACCEPTED ANSWER');
		if ((post.votes ?? 0) !== 0) marks.push(`${post.votes! > 0 ? '+' : ''}${post.votes} votes`);
		const header = `### ${(post.index ?? 0) === 0 ? 'Original post' : `Reply #${post.index}`} — ${who}` +
			` · ${formatDate(post.timestamp)}${marks.length ? ` · ${marks.join(' · ')}` : ''}`;
		lines.push(header, post.content || '_(empty)_', `<${post.url}>`, '');
	}

	return lines.join('\n').trim();
}

export function formatCandidate(candidate: Candidate, index: number): string {
	const facts: string[] = [];
	if (candidate.categoryName) facts.push(candidate.categoryName);
	if (candidate.isSolved === true) facts.push('**solved**');
	if (candidate.isSolved === false) facts.push('unsolved');
	if (candidate.postcount !== undefined) facts.push(`${candidate.postcount} posts`);
	if (candidate.timestamp) facts.push(formatDate(candidate.timestamp));

	const lines = [`${index}. **#${candidate.tid} ${candidate.title}**`];
	if (facts.length) lines.push(`   ${facts.join(' · ')}`);
	if (candidate.snippet) lines.push(`   > ${truncate(candidate.snippet.replace(/\n+/g, ' '), 260)}`);
	lines.push(`   ${candidate.url}`);
	return lines.join('\n');
}

export function formatAnswered(item: AnsweredCandidate, index: number): string {
	const lines = [
		`${index}. **#${item.topic.tid} ${item.topic.title}**`,
		`   ${[item.topic.categoryName, formatDate(item.topic.timestamp), `${item.topic.postcount} posts`]
			.filter(Boolean)
			.join(' · ')}`,
		`   Source: ${describeBasis(item.basis)}`,
	];

	const excerpt = answerExcerpt(item.answer);
	if (excerpt) {
		lines.push('', indent(excerpt), '');
		if (item.answer?.url) lines.push(`   Answer: ${item.answer.url}`);
	} else if (item.note) {
		lines.push(`   ${item.note}`);
	}
	lines.push(`   Topic: ${item.topic.url}`);
	return lines.join('\n');
}

function indent(body: string): string {
	return body
		.split('\n')
		.map(line => `   ${line}`)
		.join('\n');
}

export function formatInvestigation(investigation: Investigation): string {
	const { query, answered, unresolved, triage, notes, capabilities } = investigation;
	const lines = [`# Investigation: ${query}`, ''];

	const banner = degradationNote(capabilities);
	if (banner) lines.push(banner, '');
	for (const note of notes) lines.push(`_${note}_`);
	if (notes.length) lines.push('');

	const withAnswers = answered.filter(item => item.answer);
	if (withAnswers.length) {
		lines.push('## Existing answers', '');
		withAnswers.forEach((item, i) => lines.push(formatAnswered(item, i + 1), ''));
	} else {
		lines.push('## Existing answers', '', '_None found — no topic in range carried a usable answer._', '');
	}

	const openQuestions = answered.filter(item => !item.answer);
	if (openQuestions.length) {
		lines.push('## Related but unanswered', '');
		openQuestions.forEach((item, i) => {
			const triageLine = formatTriage(triage.get(item.topic.tid));
			lines.push(
				`${i + 1}. **#${item.topic.tid} ${item.topic.title}** — ${item.note ?? 'no answer yet'}`,
				triageLine ? `   ${triageLine}` : '',
				`   ${item.topic.url}`,
			);
		});
		lines.push('');
	}

	if (unresolved.length) {
		lines.push('## Other possibly related topics', '');
		unresolved.slice(0, 10).forEach((candidate, i) => {
			const triageLine = formatTriage(triage.get(candidate.tid));
			lines.push(formatCandidate(candidate, i + 1));
			if (triageLine) lines.push(`   ${triageLine}`);
		});
		lines.push('');
	}

	const tracked = [...triage.values()].filter(status => status.tracked);
	if (tracked.length) {
		const open = tracked.filter(status => status.status && status.status !== 'closed').length;
		lines.push(
			'## Triage',
			'',
			`${tracked.length} of the related topics are tracked on a triage board; ${open} still open.`,
			'',
		);
	}

	lines.push('## Suggested next steps', '', ...suggestNextSteps(investigation).map(step => `- ${step}`));
	return lines.join('\n').trim();
}

function suggestNextSteps(investigation: Investigation): string[] {
	const steps: string[] = [];
	const accepted = investigation.answered.filter(item => item.basis === 'accepted');
	const unverified = investigation.answered.filter(
		item => item.answer && item.basis !== 'accepted',
	);

	if (accepted.length) {
		steps.push(
			`Reuse the accepted answer on #${accepted[0]!.topic.tid} — it was confirmed by the asker.`,
		);
	}
	if (unverified.length) {
		steps.push(
			`Verify the unconfirmed reply on #${unverified[0]!.topic.tid} before relying on it; ` +
				'it was never marked as the accepted answer.',
		);
	}
	if (!investigation.answered.some(item => item.answer)) {
		steps.push('No prior answer exists — this looks like a genuinely new report.');
		steps.push('Read the closest related topics above for partial context before answering.');
	}
	if (investigation.degraded) {
		steps.push(
			'Search is unavailable on this forum, so this only covers recent topics — ' +
				'widen scan_pages or name a category to look further back.',
		);
	}
	if (investigation.capabilities.qna.state !== 'available') {
		steps.push(
			'Without the Q&A plugin, no answer here is author-confirmed; treat every excerpt as a lead.',
		);
	}
	return steps;
}
