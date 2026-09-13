/**
 * The optional plugins are optional. These tests run the same tools against a
 * bare NodeBB — no search plugin, no Q&A, no Shotef — and assert that each one
 * still returns something useful and states its own limitation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startFakeForum } from './fake-forum.js';
import { connect } from './mcp-harness.js';

async function bareForum(t, plugins = { search: false, qna: false, shotef: false }) {
	const forum = await startFakeForum({ plugins });
	const mcp = await connect(forum.url);
	t.after(async () => {
		await mcp.close();
		await forum.close();
	});
	return { forum, mcp };
}

test('forum_capabilities names each missing plugin and what it costs', async (t) => {
	const { mcp } = await bareForum(t);
	const { text, isError } = await mcp.call('forum_capabilities');

	assert.equal(isError, false);
	assert.match(text, /Full-text search \| ⚠️ absent/);
	assert.match(text, /nodebb-plugin-dbsearch/);
	assert.match(text, /question-and-answer/);
	assert.match(text, /Shotef/);
	assert.match(text, /find_answers.*fall back to scanning recent topics/s);
});

test('search_forum falls back to a local scan and says so', async (t) => {
	const { mcp } = await bareForum(t);
	const { text, isError } = await mcp.call('search_forum', { query: 'redis connection' });

	assert.equal(isError, false, 'a missing search plugin must not be an error');
	assert.match(text, /# Scan results/);
	assert.match(text, /Falling back to a local scan/);
	assert.match(text, /cannot match post bodies/);
	// The scan still finds the topic, because its title overlaps.
	assert.match(text, /#10 Redis connection refused/);
});

test('the scan ranks by title overlap and excludes unrelated topics', async (t) => {
	const { mcp } = await bareForum(t);
	const { text } = await mcp.call('search_forum', { query: 'redis connection' });
	assert.ok(!text.includes('Welcome to the forum'), 'unrelated topics must not be returned');
});

test('find_answers works without Q&A, labelling answers as unconfirmed', async (t) => {
	const { mcp } = await bareForum(t);
	const { text, isError } = await mcp.call('find_answers', { question: 'redis connection refused' });

	assert.equal(isError, false);
	assert.match(text, /#10 Redis connection refused/);
	// Without Q&A there is no accepted answer; the most-upvoted reply stands in,
	// and must be labelled as such.
	assert.match(text, /most-upvoted reply \(not marked accepted\)/);
	assert.match(text, /redis-server --dir/);
	assert.ok(!text.includes('Source: accepted answer'), 'must never claim an accepted answer without Q&A');
	assert.match(text, /Running without: full-text search, Q&A \(accepted answers\), Shotef/);
});

test('find_answers ignores solved_only without Q&A instead of returning nothing', async (t) => {
	const { mcp } = await bareForum(t);
	const { text } = await mcp.call('find_answers', { question: 'redis connection refused', solved_only: true });
	assert.match(text, /solved_only was ignored/);
	assert.match(text, /#10 Redis connection refused/);
});

test('get_topic_answer degrades to the strongest reply, flagged as unconfirmed', async (t) => {
	const { mcp } = await bareForum(t);
	const { text } = await mcp.call('get_topic_answer', { tid: 10 });

	assert.match(text, /## Answer \(most-upvoted reply \(not marked accepted\)\)/);
	assert.match(text, /Showing the strongest reply instead of an author-accepted answer/);
});

test('get_topic_answer says so plainly when a topic has no replies at all', async (t) => {
	const { mcp } = await bareForum(t);
	const { text } = await mcp.call('get_topic_answer', { tid: 11 });
	assert.match(text, /No answer available/);
	assert.match(text, /no replies/);
});

test('list_unanswered_questions approximates the queue and admits the approximation', async (t) => {
	const { mcp } = await bareForum(t);
	const { text, isError } = await mcp.call('list_unanswered_questions');

	assert.equal(isError, false);
	assert.match(text, /cannot tell a question from a discussion/);
	// Topic 11 has a single post, so it qualifies as unanswered.
	assert.match(text, /#11 Plugin symlink disappears/);
	// Topic 10 has replies, so it does not.
	assert.ok(!text.includes('#10 Redis'));
});

test('get_topic works without either plugin and shows no phantom triage', async (t) => {
	const { mcp } = await bareForum(t);
	const { text, isError } = await mcp.call('get_topic', { tid: 10 });

	assert.equal(isError, false);
	assert.match(text, /Original post — reporter/);
	assert.match(text, /```\nredis-server/);
	assert.ok(!text.includes('ACCEPTED ANSWER'), 'no accepted answer without the Q&A plugin');
	assert.ok(!text.includes('Triage:'), 'no triage line without the Shotef plugin');
	assert.match(text, /Running without:/);
});

test('triage tools explain their absence and offer an alternative', async (t) => {
	const { mcp } = await bareForum(t);

	const status = await mcp.call('get_triage_status', { tid: 10 });
	assert.equal(status.isError, false);
	assert.match(status.text, /Triage status is unavailable/);
	assert.match(status.text, /Shotef triage plugin is not active/);
	assert.match(status.text, /use get_topic to read the thread/);

	const board = await mcp.call('get_triage_board');
	assert.equal(board.isError, false);
	assert.match(board.text, /No triage board is available/);
});

test('investigate_issue completes on a bare forum with honest caveats', async (t) => {
	const { mcp } = await bareForum(t);
	const { text, isError } = await mcp.call('investigate_issue', { issue: 'redis connection refused' });

	assert.equal(isError, false);
	assert.match(text, /# Investigation: redis connection refused/);
	assert.match(text, /Running without: full-text search/);
	assert.match(text, /Falling back to a local scan/);
	assert.match(text, /## Suggested next steps/);
	assert.match(text, /Search is unavailable on this forum/);
	assert.match(text, /no answer here is author-confirmed/);
	assert.ok(!text.includes('Reuse the accepted answer'), 'must not claim an accepted answer');
});

test('investigate_issue reports a genuinely unknown issue as new', async (t) => {
	const { mcp } = await bareForum(t);
	const { text } = await mcp.call('investigate_issue', { issue: 'quantum flux capacitor misalignment' });
	assert.match(text, /genuinely new report|No answers found|None found/);
});

test('Q&A alone still gives accepted answers without search or triage', async (t) => {
	const { mcp } = await bareForum(t, { search: false, qna: true, shotef: false });
	const { text } = await mcp.call('find_answers', { question: 'redis connection refused' });

	assert.match(text, /Source: accepted answer/);
	assert.match(text, /Falling back to a local scan/);
	assert.match(text, /Running without: full-text search, Shotef/);
});

test('search alone still ranks properly without Q&A or triage', async (t) => {
	const { mcp } = await bareForum(t, { search: true, qna: false, shotef: false });
	const { text } = await mcp.call('search_forum', { query: 'redis' });

	assert.match(text, /#10 Redis connection refused/);
	assert.ok(!text.includes('scan'), 'real search must be used');
	assert.ok(!text.includes('**solved**'), 'no solved marker without Q&A');
});

test('Shotef alone still reports triage without search or Q&A', async (t) => {
	const { mcp } = await bareForum(t, { search: false, qna: false, shotef: true });
	const { text } = await mcp.call('get_triage_status', { tid: 11 });
	assert.match(text, /\*\*Stage:\*\* In progress/);
});
