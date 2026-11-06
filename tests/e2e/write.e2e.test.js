/**
 * e2e: one support ticket worked through its whole life on the real forum, by
 * real identities, each its own MCP process:
 *
 *   reporter (e2e_outsider,         team (e2e_maintainer,          team, public writes
 *   public writes on)               NO NODEBB_ENABLE_WRITES)       (same user, flag on)
 *   ─────────────────────           ─────────────────────────      ────────────────────
 *   create_topic (question)
 *     → board: Todo
 *                                   assign_ticket me, set_ticket_
 *                                   priority, add_ticket_note,
 *                                   set_ticket_status in_work
 *                                                                  reply_to_topic
 *                                                                    → ball to reporter
 *   vote_post, reply_to_topic
 *     → ball to team
 *                                   set_ticket_status closed
 *                                     → refused (unsolved)
 *                                                                  mark_solved
 *                                   set_ticket_status closed → resolved
 *   find_answers now returns the accepted answer, via dbsearch's live index.
 *
 * The middle column is the point of the split: Shotef's team workflow needs a
 * team member's identity, not the public-writes flag. Every step runs through
 * Shotef's and NodeBB's own hooks (ball-in-court routing, the Q&A close gate,
 * search indexing). Topics carry a per-run marker so repeated runs never collide.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { e2e, eventually, grabId, spawnMcp } from './harness.js';

const { fixture: fx, opts } = await e2e({ needs: 'full' });

const RUN = `r${Date.now().toString(36)}`;
const MARKER = `quokkaflux${RUN}`; // a word no other topic contains, for search

const WRITES = { NODEBB_ENABLE_WRITES: '1' };
const TRIAGE_ACTIONS = ['add_ticket_note', 'assign_ticket', 'pass_ticket', 'set_ticket_priority', 'set_ticket_status'];
const PUBLIC_WRITES = ['create_topic', 'edit_post', 'mark_solved', 'reply_to_topic', 'vote_post'];

let reporter;
let team;
let teamPublic;
let reader;
const state = {};

test.before(async () => {
	if (opts.skip) return;
	[reporter, team, teamPublic, reader] = await Promise.all([
		spawnMcp(fx, { as: 'outsider', env: WRITES }),
		spawnMcp(fx, { as: 'maintainer' }),
		spawnMcp(fx, { as: 'maintainer', env: WRITES }),
		spawnMcp(fx, { as: 'admin' }),
	]);
});
test.after(async () => {
	await Promise.all([reporter, team, teamPublic, reader].filter(Boolean).map(server => server.close()));
});

test('triage actions need no writes flag; public writes do', opts, async () => {
	const withoutFlag = (await team.client.listTools()).tools.map(tool => tool.name);
	for (const name of TRIAGE_ACTIONS) assert.ok(withoutFlag.includes(name), `${name} missing without the flag`);
	for (const name of PUBLIC_WRITES) assert.ok(!withoutFlag.includes(name), `${name} leaked without the flag`);
	assert.ok(!withoutFlag.includes('update_ticket'));

	const withFlag = (await teamPublic.client.listTools()).tools.map(tool => tool.name);
	for (const name of [...TRIAGE_ACTIONS, ...PUBLIC_WRITES]) assert.ok(withFlag.includes(name), `${name} missing`);

	const caps = await team.call('forum_capabilities');
	assert.match(caps.text, /Triage actions \(notes, status, assign, priority, pass\) \| ✅ available/);
	assert.match(caps.text, /Public writes \(post, reply, edit, vote, accept answer\) \| ⚠️ absent/);
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

	const board = await team.call('get_triage_board', { team: fx.teamId });
	assert.match(board.text, new RegExp(`## Todo \`todo\` \\(\\d+\\)[\\s\\S]*#${state.tid} Webhook deliveries retry forever`));
});

test('reporter: cannot work the ticket — Shotef refuses a non-member', opts, async () => {
	const claim = await reporter.call('assign_ticket', { tid: state.tid, owner: 'me' });
	assert.equal(claim.isError, true);
	assert.match(claim.text, /You are not a member of this team/);
	assert.match(claim.text, /not on the team handling this ticket/);

	const note = await reporter.call('add_ticket_note', { tid: state.tid, body: 'let me in' });
	assert.equal(note.isError, true);
	assert.match(note.text, /You are not a member of this team/);
});

test('team (no writes flag): claim, prioritise, note, and start work', opts, async () => {
	const claimed = await team.call('assign_ticket', { tid: state.tid, owner: 'me' });
	assert.equal(claimed.isError, false, claimed.text);
	assert.match(claimed.text, /Claimed ticket #\d+ as e2e_maintainer/);

	const priority = await team.call('set_ticket_priority', { tid: state.tid, priority: 'high' });
	assert.equal(priority.isError, false, priority.text);
	assert.match(priority.text, /- ✅ priority → high/);

	const note = await team.call('add_ticket_note', { tid: state.tid, body: `Suspect the retry worker ignores 2xx. (${RUN})` });
	assert.equal(note.isError, false, note.text);
	assert.match(note.text, /visible to the team only/);

	const moved = await team.call('set_ticket_status', { tid: state.tid, status: 'in_work', reason: `picked up (${RUN})` });
	assert.equal(moved.isError, false, moved.text);
	assert.match(moved.text, /\*\*Now:\*\* `in_work` \(In progress\) · owner: e2e_maintainer · priority: high/);

	const ticket = await team.call('get_ticket', { tid: state.tid });
	assert.match(ticket.text, new RegExp(`e2e_maintainer: Suspect the retry worker ignores 2xx\\. \\(${RUN}\\)`));
	assert.match(ticket.text, new RegExp(`status_change: todo → in_work — picked up \\(${RUN}\\)`));
	assert.match(ticket.text, /claim: — → e2e_maintainer/);

	// The note is internal: the reporter's view of the topic never shows it.
	const publicView = await reporter.call('get_topic', { tid: state.tid });
	assert.ok(!publicView.text.includes('Suspect the retry worker'), publicView.text);
});

test('team: reassigning to someone else needs a manager', opts, async () => {
	const { text, isError } = await team.call('assign_ticket', { tid: state.tid, owner: fx.uids.admin });
	assert.equal(isError, true);
	assert.match(text, /Only a team manager can do that/);
});

test('team (writes on): a public reply hands the ball to the reporter', opts, async () => {
	const { text, isError } = await teamPublic.call('reply_to_topic', {
		tid: state.tid,
		content: 'The retry worker treated any non-JSON body as a failure. Set `webhooks:strictJson` to false, then restart.',
	});
	assert.equal(isError, false, text);
	state.answerPid = grabId(text, /— post (\d+)\./);
	assert.match(text, /Ticket moved — Triage: Answered — waiting on the reporter/);
});

test('reporter: upvote the answer', opts, async () => {
	const up = await reporter.call('vote_post', { pid: state.answerPid, vote: 'up' });
	assert.equal(up.isError, false, up.text);
	assert.match(up.text, /Upvoted post \d+ as e2e_outsider — score now 1/);
});

test('reporter: replying hands the ball back to the team', opts, async () => {
	const { text, isError } = await reporter.call('reply_to_topic', { tid: state.tid, content: 'That fixed it, thank you!' });
	assert.equal(isError, false, text);
	assert.match(text, /Ticket moved — Triage: In progress/);
});

test('team: an unsolved question cannot be closed as resolved — the forum says what to do', opts, async () => {
	const { text, isError } = await team.call('set_ticket_status', { tid: state.tid, status: 'closed' });
	assert.equal(isError, true);
	assert.match(text, /Mark this question as solved before closing it/);
	assert.match(text, /mark_solved — it changes the public thread, so it needs NODEBB_ENABLE_WRITES/);
});

test('team: accept the answer (public write), then close as resolved (triage)', opts, async () => {
	const solved = await teamPublic.call('mark_solved', { tid: state.tid, pid: state.answerPid });
	assert.equal(solved.isError, false, solved.text);
	assert.match(solved.text, new RegExp(`accepting post ${state.answerPid} as the answer`));

	const closed = await team.call('set_ticket_status', { tid: state.tid, status: 'closed', close_reason: 'resolved' });
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
	const self = await team.call('pass_ticket', { tid: state.tid, to_team: fx.teamId, reason: 'test' });
	assert.equal(self.isError, true);
	assert.match(self.text, /already handled by/);
});

test('a guest server refuses public writes and triage actions before sending anything', opts, async () => {
	const guest = await spawnMcp(fx, { as: 'anon', env: WRITES });
	try {
		const reply = await guest.call('reply_to_topic', { tid: state.tid, content: 'drive-by' });
		assert.equal(reply.isError, true);
		assert.match(reply.text, /Public writes are not possible right now/);

		const note = await guest.call('add_ticket_note', { tid: state.tid, body: 'drive-by note' });
		assert.equal(note.isError, true);
		assert.match(note.text, /Triage actions are not possible right now/);
	} finally {
		await guest.close();
	}
	const topic = await reader.call('get_topic', { tid: state.tid });
	assert.ok(!topic.text.includes('drive-by'));
	const ticket = await team.call('get_ticket', { tid: state.tid });
	assert.ok(!ticket.text.includes('drive-by note'));
});
