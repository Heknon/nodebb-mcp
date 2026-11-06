/**
 * Shotef team-workflow tools, against the fake forum — deliberately WITHOUT
 * NODEBB_ENABLE_WRITES. Notes, status, assignment, priority and passing are the
 * team's own working state, authorized by Shotef against team membership, so
 * they need an identity and the plugin, not the public-writes flag.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startFakeForum } from './fake-forum.js';
import { connect } from './mcp-harness.js';

const TRIAGE_ACTIONS = ['add_ticket_note', 'assign_ticket', 'pass_ticket', 'set_ticket_priority', 'set_ticket_status'];

async function member(t, env = { NODEBB_API_TOKEN: 'admin-token' }, forumOpts = {}) {
	const forum = await startFakeForum(forumOpts);
	const mcp = await connect(forum.url, env);
	t.after(async () => {
		await mcp.close();
		await forum.close();
	});
	return { forum, mcp };
}

test('triage actions are advertised without NODEBB_ENABLE_WRITES, each with honest annotations', async (t) => {
	const { mcp } = await member(t);
	const { tools } = await mcp.client.listTools();
	for (const name of TRIAGE_ACTIONS) {
		const tool = tools.find(candidate => candidate.name === name);
		assert.ok(tool, `${name} missing`);
		assert.equal(tool.annotations.readOnlyHint, false, name);
		assert.equal(tool.annotations.destructiveHint, false, name);
	}
	const byName = Object.fromEntries(tools.map(tool => [tool.name, tool.annotations]));
	// Each call adds a note; every other action converges on its target state.
	assert.equal(byName.add_ticket_note.idempotentHint, false);
	for (const name of ['set_ticket_status', 'assign_ticket', 'set_ticket_priority']) {
		assert.equal(byName[name].idempotentHint, true, name);
	}

	const caps = await mcp.call('forum_capabilities');
	assert.match(caps.text, /Triage actions \(notes, status, assign, priority, pass\) \| ✅ available/);
});

test('add_ticket_note writes a team-only note that get_ticket shows', async (t) => {
	const { forum, mcp } = await member(t);
	const { text, isError } = await mcp.call('add_ticket_note', { tid: 13, body: 'Checking the SMTP plugin first.' });
	assert.equal(isError, false, text);
	assert.match(text, /Added an internal note to ticket #13 as admin — visible to the team only/);
	assert.match(text, /\*\*Now:\*\* `todo`/);
	assert.equal(forum.notes[13][0].body, 'Checking the SMTP plugin first.');
	assert.ok(!forum.requests.some(r => r.method === 'POST' && r.path.startsWith('/api/v3/topics')),
		'a note must never become a public post');

	const ticket = await mcp.call('get_ticket', { tid: 13 });
	assert.match(ticket.text, /admin: Checking the SMTP plugin first\./);
});

test('set_ticket_status moves a ticket and records the reason on the timeline', async (t) => {
	const { forum, mcp } = await member(t);
	const { text, isError } = await mcp.call('set_ticket_status', { tid: 13, status: 'in_work', reason: 'starting on it' });
	assert.equal(isError, false, text);
	assert.match(text, /Moved ticket #13 to `in_work` as admin/);
	assert.match(text, /\*\*Now:\*\* `in_work` \(In progress\)/);
	assert.equal(forum.tickets[13].status, 'in_work');

	const ticket = await mcp.call('get_ticket', { tid: 13 });
	assert.match(ticket.text, /status_change: todo → in_work — starting on it/);
});

test('set_ticket_status explains an unknown column key', async (t) => {
	const { mcp } = await member(t);
	const { text, isError } = await mcp.call('set_ticket_status', { tid: 13, status: 'no-such-column' });
	assert.equal(isError, true);
	assert.match(text, /Unknown status/);
	assert.match(text, /Use a column key from get_triage_board/);
});

test('a no-response close skips the accept-an-answer gate', async (t) => {
	const { forum, mcp } = await member(t);
	const { isError, text } = await mcp.call('set_ticket_status', { tid: 11, status: 'closed', close_reason: 'no_response' });
	assert.equal(isError, false, text);
	assert.equal(forum.tickets[11].closeReason, 'no_response');
});

test('closing an unsolved question as resolved is refused, pointing at mark_solved and the flag it needs', async (t) => {
	const { mcp } = await member(t);
	const { text, isError } = await mcp.call('set_ticket_status', { tid: 11, status: 'closed' });
	assert.equal(isError, true);
	assert.match(text, /Mark this question as solved before closing it/);
	assert.match(text, /mark_solved — it changes the public thread, so it needs NODEBB_ENABLE_WRITES/);
});

test('assign_ticket: claim, release, and manager-only assignment', async (t) => {
	const { forum, mcp } = await member(t, { NODEBB_API_TOKEN: 'maintainer-token' });

	const claimed = await mcp.call('assign_ticket', { tid: 13, owner: 'me' });
	assert.match(claimed.text, /Claimed ticket #13 as maintainer/);
	assert.match(claimed.text, /owner: maintainer/);
	assert.equal(forum.tickets[13].claimedBy, 8);

	const released = await mcp.call('assign_ticket', { tid: 13, owner: 'nobody' });
	assert.match(released.text, /Released ticket #13 back to the queue/);
	assert.equal(forum.tickets[13].claimedBy, 0);

	const refused = await mcp.call('assign_ticket', { tid: 13, owner: 1 });
	assert.equal(refused.isError, true);
	assert.match(refused.text, /Only a team manager can do that/);
});

test('set_ticket_priority sets priority and help-wanted, and needs at least one', async (t) => {
	const { forum, mcp } = await member(t);
	const both = await mcp.call('set_ticket_priority', { tid: 13, priority: 'urgent', help_wanted: true });
	assert.equal(both.isError, false, both.text);
	assert.match(both.text, /- ✅ priority → urgent\n- ✅ flag help wanted/);
	assert.match(both.text, /priority: urgent · help wanted/);
	assert.equal(forum.tickets[13].priority, 'urgent');

	const none = await mcp.call('set_ticket_priority', { tid: 13 });
	assert.equal(none.isError, true);
	assert.match(none.text, /Nothing to change/);
});

test('pass_ticket refusals carry advice', async (t) => {
	const { mcp } = await member(t);
	const self = await mcp.call('pass_ticket', { tid: 13, to_team: 'core', reason: 'test' });
	assert.equal(self.isError, true);
	assert.match(self.text, /already handled by/);
});

test('a non-member is refused by Shotef, with advice', async (t) => {
	const { mcp } = await member(t, { NODEBB_API_TOKEN: 'outsider-token' });
	const { text, isError } = await mcp.call('add_ticket_note', { tid: 13, body: 'drive-by' });
	assert.equal(isError, true);
	assert.match(text, /You are not a member of this team/);
	assert.match(text, /not on the team handling this ticket/);
});

test('a guest or a downgraded token is refused before anything is sent', async (t) => {
	for (const env of [{}, { NODEBB_API_TOKEN: 'revoked-token' }]) {
		// eslint-disable-next-line no-await-in-loop
		const { forum, mcp } = await member(t, env);
		const before = forum.requests.filter(r => r.method !== 'GET').length;
		// eslint-disable-next-line no-await-in-loop
		const { text, isError } = await mcp.call('set_ticket_status', { tid: 13, status: 'in_work' });
		assert.equal(isError, true);
		assert.match(text, /Triage actions are not possible right now/);
		assert.match(text, env.NODEBB_API_TOKEN ? /not accepted/ : /team member's identity/);
		assert.equal(forum.requests.filter(r => r.method !== 'GET').length, before, 'no action may be attempted');
	}
});

test('triage actions explain themselves on a forum without Shotef', async (t) => {
	const { mcp } = await member(t, { NODEBB_API_TOKEN: 'admin-token' }, { plugins: { shotef: false } });
	const { text, isError } = await mcp.call('add_ticket_note', { tid: 13, body: 'x' });
	assert.equal(isError, true);
	assert.match(text, /Triage actions need the Shotef plugin/);
	assert.match(text, /reply_to_topic/);
});

test('an intake ticket (shared between teams, taken by none): listed, opened from your intake, and taken by claiming it', async (t) => {
	const { forum, mcp } = await member(t, { NODEBB_API_TOKEN: 'maintainer-token' }, { intake: true });

	const board = await mcp.call('get_triage_board');
	assert.match(board.text, /## Intake — shared tickets nobody has taken[\s\S]*#15 SSO login loops back[\s\S]*shared by Ops, Core Support: a claim takes it for your team/);

	// Shotef refuses the plain read (Ops is the first owner); the view from our intake works.
	const ticket = await mcp.call('get_ticket', { tid: 15 });
	assert.equal(ticket.isError, false, ticket.text);
	assert.match(ticket.text, /\*\*Team:\*\* none yet — it is in the intake lane/);
	assert.doesNotMatch(ticket.text, /Read-only for you: you are not on the handling team/);
	assert.ok(forum.requests.some(r => r.path === '/api/v3/plugins/shotef/tickets/15' && r.query.team === 'core'));

	// Other actions are refused until a team takes it.
	const note = await mcp.call('add_ticket_note', { tid: 15, body: 'before taking it' });
	assert.equal(note.isError, true);

	const claim = await mcp.call('assign_ticket', { tid: 15, owner: 'me' });
	assert.equal(claim.isError, false, claim.text);
	assert.match(claim.text, /Claimed ticket #15 as maintainer/);
	assert.equal(forum.tickets[15].team, 'core');
	assert.equal(forum.tickets[15].claimedBy, 8);
	assert.match((await mcp.call('get_ticket', { tid: 15 })).text, /\*\*Team:\*\* Core Support \(core\)/);
});

test('claiming an intake ticket for a team you are not on is refused with the reason', async (t) => {
	const { forum, mcp } = await member(t, { NODEBB_API_TOKEN: 'maintainer-token' }, { intake: true });
	const claim = await mcp.call('assign_ticket', { tid: 15, owner: 'me', team: 'ops' });
	assert.equal(claim.isError, true);
	assert.match(claim.text, /Ops \(`ops`\) is not one of your teams\. Yours: Core Support \(`core`\)/);
	assert.equal(forum.tickets[15].contended, true, 'still untaken');
});
