/**
 * e2e: the read tools against a real NodeBB v4 forum with dbsearch, Q&A and
 * Shotef active, seeded by e2e/seed.mjs. Each identity is a separate MCP server
 * process over stdio, exactly as a client would run it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { e2e, spawnMcp } from './harness.js';

const { fixture: fx, opts } = await e2e({ needs: 'full' });

/** One MCP process per identity, shared by the tests in this file. */
const servers = {};
async function as(identity, env) {
	const key = `${identity}${env ? JSON.stringify(env) : ''}`;
	servers[key] ??= await spawnMcp(fx, { as: identity, env });
	return servers[key];
}
test.after(async () => {
	await Promise.all(Object.values(servers).map(server => server.close()));
});

const T = () => fx.topics;

test('forum_capabilities: every plugin live, identity verified by the forum', opts, async () => {
	const { text, isError } = await (await as('admin')).call('forum_capabilities');
	assert.equal(isError, false);
	assert.match(text, /Acting as:\*\* admin \(uid 1\) — verified by the forum/);
	assert.match(text, /Full-text search \| ✅ available/);
	assert.match(text, /Q&A \(accepted answers\) \| ✅ available/);
	assert.match(text, /Shotef \(triage board\) \| ✅ available \| — \|/);
	// Triage is the team's workflow and needs no writes flag; public writes do.
	assert.match(text, /Triage actions \(notes, status, assign, priority, pass\) \| ✅ available/);
	assert.match(text, /Public writes \(post, reply, edit, vote, accept answer\) \| ⚠️ absent \| Public writes are off/);
});

test('startup log names the verified identity', opts, async () => {
	const server = await as('maintainer');
	await server.call('forum_capabilities');
	assert.match(server.log, /connected to .* as e2e_maintainer \(uid \d+\)/);
});

test('a bogus token is caught even though NodeBB serves it as a guest', opts, async () => {
	const { text } = await (await as('not-a-real-token')).call('forum_capabilities');
	assert.match(text, /Acting as:\*\* guest/);
	assert.match(text, /Sign-in problem:\*\* NODEBB_API_TOKEN was not accepted/);
	// NodeBB does not let guests search, and the reason must say so — not blame the token.
	assert.match(text, /Full-text search \| ⚠️ forbidden \| Search is installed, but guests lack the search:content privilege/);
});

test('a master token without NODEBB_UID is explained (the Read API itself only says HTTP 500)', opts, async () => {
	const { text } = await (await as('master')).call('forum_capabilities');
	assert.match(text, /Sign-in problem:\*\* NODEBB_API_TOKEN is a master token/);
	assert.match(text, /set NODEBB_UID/);
	assert.match(text, /master token was received without a corresponding `_uid`/);
});

test('a master token with NODEBB_UID acts as that user', opts, async () => {
	const server = await as('master', { NODEBB_UID: String(fx.uids.maintainer) });
	const { text } = await server.call('forum_capabilities');
	assert.match(text, new RegExp(`Acting as:\\*\\* e2e_maintainer \\(uid ${fx.uids.maintainer}\\)`));
	const board = await server.call('get_triage_board');
	assert.match(board.text, /# Triage board — Support & Ops \(e2e-support\)/);
});

test('search_forum matches post bodies, decodes titles, and lists each post once', opts, async () => {
	const { text } = await (await as('admin')).call('search_forum', { query: 'ECONNREFUSED' });
	// The word is only in the body of the opening post.
	assert.match(text, new RegExp(`#${T().redis.tid} Redis connection refused after upgrade & restart\\*\\* · \\*\\*solved\\*\\*`));
	assert.match(text, new RegExp(`/post/${T().redis.mainPid}`));
	assert.ok(!text.includes('&amp;'));

	// dbsearch returns the digest opening post twice for this term; it must be listed once.
	const digest = await (await as('admin')).call('search_forum', { query: 'digest' });
	const listed = digest.text.match(/^\d+\. \*\*#\d+/gm) ?? [];
	const pids = [...digest.text.matchAll(/\/post\/(\d+)/g)].map(m => m[1]);
	assert.equal(new Set(pids).size, pids.length, `duplicate posts listed:\n${digest.text}`);
	assert.equal(listed.length, pids.length);
	// A plain discussion is neither solved nor unsolved.
	assert.ok(!/unsolved|\*\*solved\*\*/.test(digest.text), digest.text);
});

test('titles NodeBB would escape survive exactly once', opts, async () => {
	const { text } = await (await as('admin')).call('search_forum', { query: 'bug reports', in: 'titles' });
	assert.match(text, /Tips for writing "good" bug reports <with examples>/);
	assert.ok(!/&quot;|&lt;|&amp;/.test(text), text);
});

test('a guest cannot search; the tools fall back to a scan and say why', opts, async () => {
	const { text, isError } = await (await as('anon')).call('search_forum', { query: 'redis connection' });
	assert.equal(isError, false);
	assert.match(text, /# Scan results/);
	assert.match(text, /guests lack the search:content privilege/);
	assert.match(text, new RegExp(`#${T().redis.tid} Redis connection refused`));
});

test('a private category stays private: guest and member scans never see it', opts, async () => {
	const guest = await (await as('anon')).call('search_forum', { query: 'rotating redis password' });
	assert.ok(!guest.text.includes('Internal: rotating'), guest.text);

	const outsider = await (await as('outsider')).call('search_forum', { query: 'rotating redis password' });
	assert.ok(!outsider.text.includes('Internal: rotating'), outsider.text);

	const admin = await (await as('admin')).call('search_forum', { query: 'rotating redis password' });
	assert.match(admin.text, /Internal: rotating the Redis password/);

	const cats = await (await as('anon')).call('list_categories');
	assert.ok(!cats.text.includes('E2E Staff Only'));
	assert.match(cats.text, new RegExp(`\\[cid ${fx.cids.support}\\] E2E Support & Help`));
});

test('get_topic: accepted answer marked once, in thread order, with triage', opts, async () => {
	const { text } = await (await as('admin')).call('get_topic', { tid: T().redis.tid });
	// Q&A injects a duplicate of the accepted answer after the OP; it must not show twice.
	assert.equal(text.match(/✅ ACCEPTED ANSWER/g)?.length, 1, text);
	assert.equal(text.match(/redis-server --dir \/var\/lib\/redis --appendonly yes/g)?.length, 1);
	const order = ['Original post — e2e_reporter', 'Reply #1 — e2e_helper', 'Reply #2 — e2e_maintainer', 'Reply #3 — e2e_reporter'];
	let at = -1;
	for (const marker of order) {
		const next = text.indexOf(marker);
		assert.ok(next > at, `"${marker}" out of order in:\n${text}`);
		at = next;
	}
	assert.match(text, /```\nError: connect ECONNREFUSED 127\.0\.0\.1:6379\n```/);
	assert.match(text, /Triage: Closed · handled by Support & Ops/);
	assert.match(text, /\+2 votes/);
});

test('get_topic_answer: accepted answer is authoritative', opts, async () => {
	const { text } = await (await as('admin')).call('get_topic_answer', { tid: T().redis.tid });
	assert.match(text, /## Answer \(accepted answer\)/);
	assert.match(text, /By e2e_maintainer/);
	assert.match(text, /redis-server --dir/);
});

test('get_topic_answer: an open question is unanswered even when it has replies', opts, async () => {
	const open = await (await as('admin')).call('get_topic_answer', { tid: T().symlink.tid });
	assert.match(open.text, /No answer available/);
	assert.match(open.text, /open question/);

	const replied = await (await as('admin')).call('get_topic_answer', { tid: T().images.tid });
	assert.match(replied.text, /No answer available/);
	assert.ok(!/## Answer \(/.test(replied.text), 'an upvoted reply on an open question is not its answer');
});

test('get_topic_answer: a plain discussion falls back to the most-upvoted reply, labelled', opts, async () => {
	const { text } = await (await as('admin')).call('get_topic_answer', { tid: T().digest.tid });
	assert.match(text, /## Answer \(most-upvoted reply \(not marked accepted\)\)/);
	assert.match(text, /By e2e_helper · .* · 2 votes/);
	assert.match(text, /ACP → Settings → Email/);
});

test('get_post: author, accepted-answer mark and permalink', opts, async () => {
	const { text } = await (await as('admin')).call('get_post', { pid: T().redis.answerPid });
	assert.match(text, new RegExp(`Post ${T().redis.answerPid} — e2e_maintainer`));
	assert.match(text, /✅ ACCEPTED ANSWER/);
	assert.match(text, new RegExp(`/post/${T().redis.answerPid}$`, 'm'));
});

test('find_answers: the accepted answer for a natural-language question', opts, async () => {
	const { text } = await (await as('admin')).call('find_answers', { question: 'nodebb redis connection refused after upgrading' });
	assert.match(text, new RegExp(`1\\. \\*\\*#${T().redis.tid} Redis connection refused`));
	assert.match(text, /Source: accepted answer/);
	assert.match(text, /redis-server --dir/);
});

test('list_unanswered_questions: the real unsolved queue, with neutral triage labels', opts, async () => {
	const { text } = await (await as('admin')).call('list_unanswered_questions', { limit: 50 });
	assert.match(text, new RegExp(`#${T().symlink.tid} Plugin symlink disappears`));
	assert.match(text, new RegExp(`#${T().images.tid} Can't see uploaded images`));
	assert.ok(!text.includes(`#${T().redis.tid} Redis`), 'a solved question is not unanswered');
	assert.match(text, /Triage: In progress · on hold/);
	assert.ok(!text.includes('Awaiting your reply'));
});

test('investigate_issue: existing answer, open reports, triage, next steps', opts, async () => {
	const { text } = await (await as('admin')).call('investigate_issue', { issue: 'redis ECONNREFUSED after upgrade' });
	assert.match(text, /## Existing answers/);
	assert.match(text, new RegExp(`Reuse the accepted answer on #${T().redis.tid}`));
	assert.match(text, /## Triage/);
});

test('get_triage_status: stage, team, parked sub-status for members only', opts, async () => {
	const member = await (await as('admin')).call('get_triage_status', { tid: T().images.tid });
	assert.match(member.text, /\*\*Stage:\*\* In progress/);
	assert.match(member.text, /\*\*Handled by:\*\* Support & Ops/);
	assert.match(member.text, /\*\*Parked:\*\* yes \(Blocked\)/);

	const outsider = await (await as('outsider')).call('get_triage_status', { tid: T().images.tid });
	assert.match(outsider.text, /\*\*Parked:\*\* yes \(sub-status visible to team members only\)/);

	const answered = await (await as('admin')).call('get_triage_status', { tid: T().digest.tid });
	assert.match(answered.text, /\*\*Stage:\*\* Answered — waiting on the reporter/);

	const closed = await (await as('admin')).call('get_triage_status', { tid: T().redis.tid });
	assert.match(closed.text, /_Closed as resolved\._/);

	const untracked = await (await as('admin')).call('get_triage_status', { tid: T().welcome.tid });
	assert.match(untracked.text, /not tracked on any triage board/);
});

test('get_triage_board: the real board, by column, with the parked backlog', opts, async () => {
	const { text, isError } = await (await as('maintainer')).call('get_triage_board', { team: fx.teamId });
	assert.equal(isError, false);
	assert.match(text, /# Triage board — Support & Ops \(e2e-support\)/);
	assert.match(text, /## In work `in_work` \(\d+\)/);
	assert.match(text, new RegExp(`#${T().symlink.tid} Plugin symlink disappears after npm install\\*\\*\\n  priority: high · claimed by e2e_maintainer · question: unsolved`));
	assert.match(text, /## Backlog: Blocked `blocked` \(\d+\)/);
	assert.match(text, new RegExp(`#${T().images.tid} Can't see uploaded images`));
	assert.match(text, /## Responded `responded`/);
	assert.ok(!text.includes(`#${T().redis.tid} Redis`), 'closed tickets hidden by default');
	assert.match(text, /Status keys for set_ticket_status: `todo`, `in_work`, `waiting`, `responded`, `closed`, `blocked`/);
});

test('get_triage_board: a non-member and a guest get an explanation, not an error', opts, async () => {
	const outsider = await (await as('outsider')).call('get_triage_board');
	assert.equal(outsider.isError, false);
	assert.match(outsider.text, /e2e_outsider is not a member of any triage team/);

	const guest = await (await as('anon')).call('get_triage_board');
	assert.match(guest.text, /No board is visible to a guest/);
});

test('get_ticket: timeline of the seeded moves, refused to outsiders', opts, async () => {
	const { text, isError } = await (await as('admin')).call('get_ticket', { tid: T().symlink.tid });
	assert.equal(isError, false, text);
	assert.match(text, /\*\*Status:\*\* `in_work` \(In progress\)/);
	assert.match(text, /\*\*Owner:\*\* e2e_maintainer · \*\*Priority:\*\* high/);
	assert.match(text, /· admin · assign: — → e2e_maintainer/);
	assert.match(text, /status_change: todo → in_work/);

	const outsider = await (await as('outsider')).call('get_ticket', { tid: T().symlink.tid });
	assert.equal(outsider.isError, true);
	assert.match(outsider.text, /You are not a member of this team/);
});

test('documentation resources are served from the installed package', opts, async () => {
	const { client } = await as('anon');
	const { resources } = await client.listResources();
	assert.equal(resources.length, 10);
	const gotchas = await client.readResource({ uri: 'nodebb://plugin-dev/gotchas' });
	assert.match(gotchas.contents[0].text, /double-escape/i);
});
