/**
 * e2e: the write tools against the real forum — one support ticket worked
 * through its whole life by two real identities, each its own MCP process:
 *
 *   reporter (e2e_outsider, not on the team)      team member (e2e_maintainer)
 *   ───────────────────────────────────────      ─────────────────────────────
 *   create_topic as a question  → board: Todo
 *                                                 update_ticket: claim, priority,
 *                                                   internal note, → in_work
 *                                                 reply_to_topic → ball to reporter
 *   vote_post on the answer
 *   reply_to_topic              → ball to team
 *                                                 close → refused (unsolved question)
 *                                                 mark_solved → close → resolved
 *   find_answers now returns the accepted answer, via dbsearch's live index.
 *
 * Every step goes through Shotef's and NodeBB's own hooks (ball-in-court
 * routing, the Q&A close gate, search indexing) — nothing is stubbed.
 * Topics carry a per-run marker so repeated runs never collide.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { e2e, eventually, grabId, spawnMcp } from './harness.js';

const { fixture: fx, opts } = await e2e({ needs: 'full' });

const RUN = `r${Date.now().toString(36)}`;
const MARKER = `quokkaflux${RUN}`; // a word no other topic contains, for search

const WRITES = { NODEBB_ENABLE_WRITES: '1' };
let reporter;
let member;
let reader;
const state = {};

test.before(async () => {
	if (opts.skip) return;
	[reporter, member, reader] = await Promise.all([
		spawnMcp(fx, { as: 'outsider', env: WRITES }),
		spawnMcp(fx, { as: 'maintainer', env: WRITES }),
		spawnMcp(fx, { as: 'admin' }),
	]);
});
test.after(async () => {
	await Promise.all([reporter, member, reader].filter(Boolean).map(server => server.close()));
});

test('read-only servers do not advertise write tools; writable ones do', opts, async () => {
	const readOnly = (await reader.client.listTools()).tools.map(tool => tool.name);
	assert.ok(!readOnly.includes('reply_to_topic'));
	const writable = (await member.client.listTools()).tools.map(tool => tool.name);
	for (const name of ['create_topic', 'reply_to_topic', 'edit_post', 'vote_post', 'update_ticket', 'mark_solved', 'pass_ticket']) {
		assert.ok(writable.includes(name), `${name} missing`);
	}
	const caps = await member.call('forum_capabilities');
	assert.match(caps.text, /Writes \(post, vote, triage\) \| ✅ available/);
});

test('reporter: create_topic posts a question that lands on the board as Todo', opts, async () => {
	const { text, isError } = await reporter.call('create_topic', {
		cid: fx.cids.support,
		title: `Webhook deliveries retry forever (${RUN})`,
		content: `Every outgoing webhook is retried endlessly, even after a 200 response. Marker: ${MARKER}.`,
		tags: ['webhooks'],
		as_question: true,
	});
	assert.equal(isError, false, text);
	assert.match(text, /as e2e_outsider/);
	assert.match(text, /Posted as an unsolved Q&A question/);
	// Shotef's action:topic.save hook tracked it, live.
	assert.match(text, /Tracked on a triage board — Triage: Received — not picked up yet · handled by Support & Ops/);
	state.tid = grabId(text, /#(\d+) Webhook deliveries/);

	const board = await member.call('get_triage_board', { team: fx.teamId });
	assert.match(board.text, new RegExp(`## Todo \`todo\` \\(\\d+\\)[\\s\\S]*#${state.tid} Webhook deliveries retry forever`));
});

test('reporter: cannot work the ticket — not on the team', opts, async () => {
	const { text, isError } = await reporter.call('update_ticket', { tid: state.tid, owner: 'me' });
	assert.equal(isError, true);
	assert.match(text, /❌ claim — You are not a member of this team/);
	assert.match(text, /not on the team handling this ticket/);
});

test('member: claim, prioritise, note and start work in one call', opts, async () => {
	const { text, isError } = await member.call('update_ticket', {
		tid: state.tid,
		owner: 'me',
		priority: 'high',
		note: `Suspect the retry worker ignores 2xx. (${RUN})`,
		status: 'in_work',
	});
	assert.equal(isError, false, text);
	assert.match(text, /- ✅ claim\n- ✅ priority → high\n- ✅ internal note\n- ✅ status → in_work/);
	assert.match(text, /\*\*Now:\*\* `in_work` \(In progress\) · owner: e2e_maintainer · priority: high/);

	const ticket = await member.call('get_ticket', { tid: state.tid });
	assert.match(ticket.text, new RegExp(`e2e_maintainer: Suspect the retry worker ignores 2xx\\. \\(${RUN}\\)`));
	assert.match(ticket.text, /status_change: todo → in_work/);
	assert.match(ticket.text, /claim: — → e2e_maintainer/);

	// The note is internal: the reporter's view of the topic never shows it.
	const publicView = await reporter.call('get_topic', { tid: state.tid });
	assert.ok(!publicView.text.includes('Suspect the retry worker'), publicView.text);
});

test('member: reassigning to someone else needs a manager', opts, async () => {
	const { text } = await member.call('update_ticket', { tid: state.tid, owner: fx.uids.admin });
	assert.match(text, /❌ assign to uid 1 — Only a team manager can do that/);
});

test('member: a public reply hands the ball to the reporter', opts, async () => {
	const { text, isError } = await member.call('reply_to_topic', {
		tid: state.tid,
		content: 'The retry worker treated any non-JSON body as a failure. Set `webhooks:strictJson` to false, then restart.',
	});
	assert.equal(isError, false, text);
	state.answerPid = grabId(text, /— post (\d+)\./);
	assert.match(text, /Ticket moved — Triage: Answered — waiting on the reporter/);
});

test('reporter: upvote the answer; it cannot upvote its own post', opts, async () => {
	const up = await reporter.call('vote_post', { pid: state.answerPid, vote: 'up' });
	assert.equal(up.isError, false, up.text);
	assert.match(up.text, /Upvoted post \d+ as e2e_outsider — score now 1/);
});

test('reporter: replying hands the ball back to the team', opts, async () => {
	const { text, isError } = await reporter.call('reply_to_topic', { tid: state.tid, content: 'That fixed it, thank you!' });
	assert.equal(isError, false, text);
	assert.match(text, /Ticket moved — Triage: In progress/);
});

test('member: an unsolved question cannot be closed as resolved — the forum says what to do', opts, async () => {
	const { text, isError } = await member.call('update_ticket', { tid: state.tid, status: 'closed' });
	assert.equal(isError, true);
	assert.match(text, /❌ status → closed — Mark this question as solved before closing it/);
	assert.match(text, /mark_solved/);
});

test('member: accept the answer, then close as resolved', opts, async () => {
	const solved = await member.call('mark_solved', { tid: state.tid, pid: state.answerPid });
	assert.equal(solved.isError, false, solved.text);
	assert.match(solved.text, new RegExp(`accepting post ${state.answerPid} as the answer`));

	const closed = await member.call('update_ticket', { tid: state.tid, status: 'closed', close_reason: 'resolved' });
	assert.equal(closed.isError, false, closed.text);
	assert.match(closed.text, /\*\*Now:\*\* `closed` \(Closed\) · closed: resolved/);

	const status = await reader.call('get_triage_status', { tid: state.tid });
	assert.match(status.text, /\*\*Stage:\*\* Closed/);
	assert.match(status.text, /_Closed as resolved\._/);
});

test('readers now get the accepted answer — via dbsearch\'s live index', opts, async () => {
	const answer = await reader.call('get_topic_answer', { tid: state.tid });
	assert.match(answer.text, /## Answer \(accepted answer\)/);
	assert.match(answer.text, /By e2e_maintainer/);
	assert.match(answer.text, /webhooks:strictJson/);

	const found = await eventually(async () => {
		const result = await reader.call('find_answers', { question: `webhook ${MARKER}` });
		return /Source: accepted answer/.test(result.text) && result;
	});
	assert.ok(found, 'find_answers never surfaced the accepted answer');
	assert.match(found.text, new RegExp(`#${state.tid} Webhook deliveries retry forever`));
	assert.match(found.text, /webhooks:strictJson/);

	const topic = await reader.call('get_topic', { tid: state.tid });
	assert.equal(topic.text.match(/✅ ACCEPTED ANSWER/g)?.length, 1);
	assert.match(topic.text, /\+1 votes/);
});

test('reporter: edit its own opening post', opts, async () => {
	// The marker word is only in the opening post, so search pins its pid.
	const hits = await reader.call('search_forum', { query: MARKER });
	const pid = grabId(hits.text, /\/post\/(\d+)/);

	const { text, isError } = await reporter.call('edit_post', {
		pid,
		content: `Every outgoing webhook was retried endlessly. (Solved — see the accepted answer.) Marker: ${MARKER}.`,
	});
	assert.equal(isError, false, text);
	const post = await reader.call('get_post', { pid });
	assert.match(post.text, /\(Solved — see the accepted answer\.\)/);
});

test('pass_ticket refusals carry advice', opts, async () => {
	const self = await member.call('pass_ticket', { tid: state.tid, to_team: fx.teamId, reason: 'test' });
	assert.equal(self.isError, true);
	assert.match(self.text, /already handled by/);
});

test('a guest server with writes enabled refuses before sending anything', opts, async () => {
	const guest = await spawnMcp(fx, { as: 'anon', env: WRITES });
	try {
		const { text, isError } = await guest.call('reply_to_topic', { tid: state.tid, content: 'drive-by' });
		assert.equal(isError, true);
		assert.match(text, /Writes are not possible right now/);
	} finally {
		await guest.close();
	}
	const topic = await reader.call('get_topic', { tid: state.tid });
	assert.ok(!topic.text.includes('drive-by'));
});
