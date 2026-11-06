/**
 * The public write tools, against the fake forum. These pin the contract:
 * public writes are opt-in, refuse cleanly without a verified identity, report
 * every refusal with advice, and leave the forum in the state they claim.
 * (Shotef's team-workflow actions are not behind the flag: triage-actions.test.js.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startFakeForum } from './fake-forum.js';
import { connect } from './mcp-harness.js';

const PUBLIC_WRITES = ['create_topic', 'edit_post', 'mark_solved', 'reply_to_topic', 'vote_post'];

async function writable(t, env = {}, forumOpts = {}) {
	const forum = await startFakeForum(forumOpts);
	const mcp = await connect(forum.url, { NODEBB_ENABLE_WRITES: '1', NODEBB_API_TOKEN: 'admin-token', ...env });
	t.after(async () => {
		await mcp.close();
		await forum.close();
	});
	return { forum, mcp };
}

test('public write tools are not advertised unless NODEBB_ENABLE_WRITES is set', async (t) => {
	const forum = await startFakeForum();
	const mcp = await connect(forum.url, { NODEBB_API_TOKEN: 'admin-token' });
	t.after(async () => { await mcp.close(); await forum.close(); });

	const { tools } = await mcp.client.listTools();
	for (const name of PUBLIC_WRITES) assert.ok(!tools.some(tool => tool.name === name), `${name} leaked`);
});

test('with writes enabled every public write tool is advertised and annotated as a write', async (t) => {
	const { mcp } = await writable(t);
	const { tools } = await mcp.client.listTools();
	for (const name of PUBLIC_WRITES) {
		const tool = tools.find(candidate => candidate.name === name);
		assert.ok(tool, `${name} missing`);
		assert.equal(tool.annotations.readOnlyHint, false, name);
	}
	assert.equal(tools.find(tool => tool.name === 'edit_post').annotations.destructiveHint, true);
	assert.ok(!tools.some(tool => tool.name === 'update_ticket'), 'the bundled tool is gone, not kept alongside');

	const prompt = await mcp.client.getPrompt({ name: 'work_ticket', arguments: { tid: '13' } });
	assert.match(prompt.messages[0].content.text, /Work support ticket #13/);
	assert.match(prompt.messages[0].content.text, /reply_to_topic with the answer/);
	assert.match(prompt.messages[0].content.text, /mark_solved/);
});

test('a guest cannot write, and is told why before anything is sent', async (t) => {
	const { forum, mcp } = await writable(t, { NODEBB_API_TOKEN: '' });
	const before = forum.requests.filter(r => r.method !== 'GET').length;
	const { text, isError } = await mcp.call('reply_to_topic', { tid: 12, content: 'hello' });
	assert.equal(isError, true);
	assert.match(text, /Public writes are not possible/);
	assert.match(text, /NODEBB_API_TOKEN/);
	assert.equal(forum.requests.filter(r => r.method !== 'GET').length, before, 'no write may be attempted');
});

test('a token the forum silently downgraded to guest is caught before writing', async (t) => {
	const { mcp } = await writable(t, { NODEBB_API_TOKEN: 'revoked-token' });
	const { text, isError } = await mcp.call('create_topic', { cid: 1, title: 'Hello there', content: 'body' });
	assert.equal(isError, true);
	assert.match(text, /not accepted/);
});

test('create_topic posts a question that lands on the triage board', async (t) => {
	const { forum, mcp } = await writable(t);
	const { text, isError } = await mcp.call('create_topic', {
		cid: 3, title: 'Cron jobs stopped running', content: 'Since Monday.', tags: ['cron'], as_question: true,
	});
	assert.equal(isError, false, text);
	const tid = Number(/#(\d+) Cron jobs stopped running/.exec(text)[1]);
	assert.match(text, /as admin/);
	assert.match(text, /Posted as an unsolved Q&A question/);
	assert.match(text, /Tracked on a triage board — Triage: Received — not picked up yet/);
	assert.equal(forum.topics[tid].isQuestion, 1);
	assert.deepEqual(forum.requests.find(r => r.method === 'POST' && r.path === '/api/v3/topics').body.tags, ['cron']);
});

test('create_topic ignores as_question without the Q&A plugin, and says so', async (t) => {
	const { forum, mcp } = await writable(t, {}, { plugins: { qna: false } });
	const { text } = await mcp.call('create_topic', { cid: 1, title: 'General chat', content: 'hi', as_question: true });
	assert.match(text, /as_question was ignored/);
	const sent = forum.requests.find(r => r.method === 'POST' && r.path === '/api/v3/topics').body;
	assert.ok(!('isQuestion' in sent), 'the Q&A key must not be sent when it would be meaningless');
});

test('reply_to_topic reports the post and the ticket move it caused', async (t) => {
	const { forum, mcp } = await writable(t);
	const { text, isError } = await mcp.call('reply_to_topic', { tid: 11, content: 'Recreate the symlink, then rebuild.' });
	assert.equal(isError, false, text);
	assert.match(text, /Replied to topic #11 as admin — post \d+/);
	assert.match(text, /Ticket moved — Triage: Answered — waiting on the reporter/);
	assert.equal(forum.tickets[11].status, 'responded');
});

test('vote_post reports the new score, and the forum\'s refusal of a self-vote', async (t) => {
	const { mcp } = await writable(t);
	const up = await mcp.call('vote_post', { pid: 101, vote: 'up' });
	assert.match(up.text, /Upvoted post 101 as admin — score now 1/);
	const none = await mcp.call('vote_post', { pid: 101, vote: 'none' });
	assert.match(none.text, /score now 0/);

	const self = await mcp.call('vote_post', { pid: 120, vote: 'up' });
	assert.equal(self.isError, true);
	assert.match(self.text, /You cannot vote on your own post/);
});

test('edit_post replaces the body', async (t) => {
	const { forum, mcp } = await writable(t);
	const { isError } = await mcp.call('edit_post', { pid: 120, content: 'Hello, everyone!' });
	assert.equal(isError, false);
	assert.match(forum.topics[12].posts[0].content, /Hello, everyone!/);
});

test('mark_solved accepts an answer, unlocking a resolved close', async (t) => {
	const { forum, mcp } = await writable(t);
	forum.topics[11].posts.push({ pid: 111, index: 1, uid: 8, timestamp: 1, votes: 0, content: '<p>Recreate it.</p>' });

	const refused = await mcp.call('set_ticket_status', { tid: 11, status: 'closed' });
	assert.equal(refused.isError, true);
	assert.match(refused.text, /Mark this question as solved before closing it/);
	assert.match(refused.text, /mark_solved/);

	const solved = await mcp.call('mark_solved', { tid: 11, pid: 111 });
	assert.equal(solved.isError, false, solved.text);
	assert.match(solved.text, /accepting post 111 as the answer/);
	assert.match(solved.text, /closed as resolved with set_ticket_status/);

	const closed = await mcp.call('set_ticket_status', { tid: 11, status: 'closed' });
	assert.equal(closed.isError, false, closed.text);
	assert.match(closed.text, /\*\*Now:\*\* `closed` \(Closed\) · closed: resolved/);

	// And the read side now reports the accepted answer.
	const answer = await mcp.call('get_topic_answer', { tid: 11 });
	assert.match(answer.text, /## Answer \(accepted answer\)/);
	assert.match(answer.text, /Recreate it\./);
});

test('mark_solved explains a forum without Q&A', async (t) => {
	const { mcp } = await writable(t, {}, { plugins: { qna: false } });
	const { text, isError } = await mcp.call('mark_solved', { tid: 11 });
	assert.equal(isError, true);
	assert.match(text, /no accepted answer to set/);
});

test('a master token acts as NODEBB_UID for writes too', async (t) => {
	const { forum, mcp } = await writable(t, { NODEBB_API_TOKEN: 'master-token', NODEBB_UID: '8' });
	const { text } = await mcp.call('reply_to_topic', { tid: 12, content: 'Welcome!' });
	assert.match(text, /as maintainer/);
	const write = forum.requests.find(r => r.method === 'POST' && r.path === '/api/v3/topics/12');
	assert.equal(write.query._uid, '8');
});
