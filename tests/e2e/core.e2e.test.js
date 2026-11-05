/**
 * e2e: the same seeded forum with dbsearch, Q&A and Shotef *deactivated* — a
 * real core-only NodeBB, not a simulation. `e2e/run.sh` flips the plugins off,
 * runs this file, and flips them back; at any other time it is skipped.
 *
 * The data written while the plugins were active is still in the database —
 * Q&A's isQuestion/isSolved/solvedPid fields stay on the topic hashes, and
 * NodeBB keeps serving them. With the plugin gone that state is stale, so the
 * tools must degrade exactly as on a forum that never had Q&A, and must not
 * resurrect an "accepted answer" nobody can see or change any more.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { e2e, spawnMcp } from './harness.js';

const { fixture: fx, opts } = await e2e({ needs: 'core' });

let admin;
let writer;
test.before(async () => {
	if (opts.skip) return;
	admin = await spawnMcp(fx, { as: 'admin' });
	writer = await spawnMcp(fx, { as: 'maintainer', env: { NODEBB_ENABLE_WRITES: '1' } });
});
test.after(async () => {
	await Promise.all([admin, writer].filter(Boolean).map(server => server.close()));
});

const T = () => fx.topics;

test('forum_capabilities: each plugin absent, with what would enable it', opts, async () => {
	const { text } = await admin.call('forum_capabilities');
	assert.match(text, /Acting as:\*\* admin \(uid 1\)/);
	assert.match(text, /Full-text search \| ⚠️ absent \| No search plugin is active.*nodebb-plugin-dbsearch/);
	assert.match(text, /Q&A \(accepted answers\) \| ⚠️ absent \| nodebb-plugin-question-and-answer is not active/);
	assert.match(text, /Shotef \(triage board\) \| ⚠️ absent \| The Shotef triage plugin is not active/);
});

test('search_forum falls back to a title scan and says so', opts, async () => {
	const { text, isError } = await admin.call('search_forum', { query: 'redis connection refused' });
	assert.equal(isError, false);
	assert.match(text, /# Scan results/);
	assert.match(text, /cannot match post bodies/);
	assert.match(text, new RegExp(`#${T().redis.tid} Redis connection refused`));
});

test('stale Q&A fields are not passed off as an accepted answer', opts, async () => {
	const { text } = await admin.call('get_topic_answer', { tid: T().redis.tid });
	assert.ok(!/## Answer \(accepted answer\)/.test(text), `stale solvedPid was trusted:\n${text}`);
	assert.match(text, /## Answer \(most-upvoted reply \(not marked accepted\)\)/);
	assert.match(text, /By e2e_maintainer/);
	assert.match(text, /question-and-answer is not active/);

	const topic = await admin.call('get_topic', { tid: T().redis.tid });
	assert.ok(!topic.text.includes('ACCEPTED ANSWER'), topic.text);
	assert.ok(!/\*\*solved\*\*|\*\*unsolved\*\*/.test(topic.text), 'no solved state without the plugin');
});

test('an open question with an upvoted reply now yields that reply, labelled unconfirmed', opts, async () => {
	const { text } = await admin.call('get_topic_answer', { tid: T().images.tid });
	assert.match(text, /most-upvoted reply \(not marked accepted\)/);
	assert.match(text, /upload_url/);
});

test('find_answers still answers, every excerpt labelled unconfirmed', opts, async () => {
	const { text, isError } = await admin.call('find_answers', { question: 'redis connection refused' });
	assert.equal(isError, false);
	assert.match(text, /Running without: full-text search, Q&A \(accepted answers\), Shotef \(triage status\)/);
	assert.ok(!text.includes('Source: accepted answer'), text);
	assert.match(text, /were never marked accepted — verify before relying on them/);
});

test('list_unanswered_questions approximates the queue and says it cannot tell questions apart', opts, async () => {
	const { text } = await admin.call('list_unanswered_questions', { limit: 50 });
	assert.match(text, /cannot tell a question from a discussion/);
	assert.match(text, new RegExp(`#${T().symlink.tid} Plugin symlink disappears`));
	assert.ok(!text.includes(`#${T().images.tid} `), 'a topic with replies is not "unanswered" by the fallback');
});

test('triage tools report themselves unknowable, not broken', opts, async () => {
	const status = await admin.call('get_triage_status', { tid: T().symlink.tid });
	assert.equal(status.isError, false);
	assert.match(status.text, /Triage status is unavailable/);
	assert.match(status.text, /use get_topic to read the thread/);

	const board = await admin.call('get_triage_board');
	assert.match(board.text, /No triage board is available/);
});

test('core writes still work; triage writes explain the missing plugin', opts, async () => {
	const reply = await writer.call('reply_to_topic', { tid: T().welcome.tid, content: `Core-only reply ${Date.now()}` });
	assert.equal(reply.isError, false, reply.text);
	assert.match(reply.text, /Replied to topic #\d+ as e2e_maintainer/);
	assert.ok(!/Triage:/.test(reply.text));

	const update = await writer.call('update_ticket', { tid: T().symlink.tid, status: 'closed' });
	assert.equal(update.isError, true);
	assert.match(update.text, /Triage actions need the Shotef plugin/);
});
