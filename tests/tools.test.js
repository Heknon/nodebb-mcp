import test from 'node:test';
import assert from 'node:assert/strict';

import { startFakeForum } from './fake-forum.js';
import { connect } from './mcp-harness.js';

/** Full-featured forum: search + Q&A + Shotef all installed, acting as a team member. */
async function fullStack(t, env = { NODEBB_API_TOKEN: 'admin-token' }) {
	const forum = await startFakeForum();
	const mcp = await connect(forum.url, env);
	t.after(async () => {
		await mcp.close();
		await forum.close();
	});
	return { forum, mcp };
}

test('the server advertises every tool, prompt and documentation resource', async (t) => {
	const { mcp } = await fullStack(t);

	const { tools } = await mcp.client.listTools();
	const names = tools.map(tool => tool.name).sort();
	assert.deepEqual(names, [
		'find_answers',
		'forum_capabilities',
		'get_post',
		'get_ticket',
		'get_topic',
		'get_topic_answer',
		'get_triage_board',
		'get_triage_status',
		'investigate_issue',
		'list_categories',
		'list_recent_topics',
		'list_unanswered_questions',
		'search_forum',
	]);
	for (const tool of tools) {
		assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a real description`);
		assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
		// Without NODEBB_ENABLE_WRITES nothing advertised may change the forum.
		assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`);
	}

	const { prompts } = await mcp.client.listPrompts();
	assert.deepEqual(prompts.map(p => p.name).sort(), ['answer_forum_question', 'investigate_report']);

	const { resources } = await mcp.client.listResources();
	assert.equal(resources.length, 10);
	assert.ok(resources.every(r => r.uri.startsWith('nodebb://plugin-dev/')));
});

test('documentation resources can be read', async (t) => {
	const { mcp } = await fullStack(t);
	const result = await mcp.client.readResource({ uri: 'nodebb://plugin-dev/gotchas' });
	assert.equal(result.contents.length, 1);
	assert.equal(result.contents[0].mimeType, 'text/markdown');
	assert.match(result.contents[0].text, /double-escape/i);
});

test('forum_capabilities reports a healthy forum', async (t) => {
	const { mcp } = await fullStack(t);
	const { text, isError } = await mcp.call('forum_capabilities');
	assert.equal(isError, false);
	assert.ok(!/NodeBB version/.test(text), 'v4 does not expose its version; do not print one');
	assert.match(text, /Acting as:\*\* admin \(uid 1\) — verified by the forum/);
	assert.match(text, /Full-text search \| ✅ available/);
	assert.match(text, /Q&A \(accepted answers\) \| ✅ available/);
	assert.match(text, /Shotef \(triage board\) \| ✅ available/);
	assert.match(text, /Writes \(post, vote, triage\) \| ⚠️ absent \| Read-only mode/);
});

test('search_forum returns ranked hits with snippets and solved markers', async (t) => {
	const { mcp } = await fullStack(t);
	const { text } = await mcp.call('search_forum', { query: 'redis' });
	assert.match(text, /#10 Redis connection refused after upgrade & restart/);
	assert.match(text, /\*\*solved\*\*/);
	// Search summaries have no index, so link the post itself.
	assert.match(text, /http:\/\/127\.0\.0\.1:\d+\/post\/100/);
	// dbsearch returned the post twice; it must be listed once.
	assert.match(text, /# 1 match for "redis"/);
	assert.equal(text.match(/#10 Redis/g).length, 1);
});

test('titles from a forum that HTML-escapes them are decoded exactly once', async (t) => {
	const forum = await startFakeForum({ escapeTitles: true });
	const mcp = await connect(forum.url, { NODEBB_API_TOKEN: 'admin-token' });
	t.after(async () => { await mcp.close(); await forum.close(); });
	const { text } = await mcp.call('search_forum', { query: 'redis' });
	assert.match(text, /upgrade & restart/);
	assert.ok(!text.includes('&amp;'), 'title must not stay HTML-escaped');
});

test('a non-question search hit is not labelled unsolved', async (t) => {
	const { mcp } = await fullStack(t);
	// Q&A sends isSolved: null for a topic that is not a question at all.
	const { text } = await mcp.call('search_forum', { query: 'welcome' });
	assert.match(text, /#12 Welcome to the forum/);
	assert.ok(!/unsolved|\*\*solved\*\*/.test(text), text);
});

test('get_topic renders posts, marks the accepted answer, and shows triage', async (t) => {
	const { mcp } = await fullStack(t);
	const { text } = await mcp.call('get_topic', { tid: 10 });

	assert.match(text, /Original post — reporter/);
	// Q&A injects a copy of the accepted answer after the OP; it must appear once, in order.
	assert.equal(text.match(/✅ ACCEPTED ANSWER/g).length, 1, text);
	assert.ok(text.indexOf('Reply #1') < text.indexOf('Reply #2'), 'replies stay in thread order');
	assert.ok(text.indexOf('Reply #2') < text.indexOf('Reply #3'));
	assert.match(text, /```\nredis-server --dir \/var\/lib\/redis --appendonly yes\n```/);
	assert.match(text, /Triage: Closed · handled by Core Support/);
	// Post content entities decoded, HTML stripped.
	assert.match(text, /NodeBB won't start/);
	assert.ok(!text.includes('<p>'));
});

test('get_topic_answer returns the accepted answer as authoritative', async (t) => {
	const { mcp } = await fullStack(t);
	const { text } = await mcp.call('get_topic_answer', { tid: 10 });
	assert.match(text, /## Answer \(accepted answer\)/);
	assert.match(text, /By maintainer/);
	assert.match(text, /redis-server --dir/);
});

test('get_topic_answer reports an open question as unanswered instead of guessing', async (t) => {
	const { mcp } = await fullStack(t);
	const { text } = await mcp.call('get_topic_answer', { tid: 11 });
	assert.match(text, /No answer available/);
	assert.match(text, /open question/i);
	assert.ok(!/## Answer \(/.test(text), 'must not present a guess as an answer');
});

test('find_answers extracts answers and labels their basis', async (t) => {
	const { mcp } = await fullStack(t);
	const { text } = await mcp.call('find_answers', { question: 'redis connection refused' });
	assert.match(text, /# Answers for "redis connection refused"/);
	assert.match(text, /Source: accepted answer/);
	assert.match(text, /redis-server --dir/);
});

test('list_unanswered_questions uses the real unsolved queue', async (t) => {
	const { mcp } = await fullStack(t);
	const { text } = await mcp.call('list_unanswered_questions');
	assert.match(text, /#11 Plugin symlink disappears after npm install/);
	assert.ok(!text.includes('#10 Redis'), 'a solved question must not appear as unanswered');
	assert.match(text, /Triage: In progress/);
});

test('investigate_issue separates answered from open and suggests next steps', async (t) => {
	const { mcp } = await fullStack(t);
	const { text } = await mcp.call('investigate_issue', { issue: 'redis connection refused on startup' });

	assert.match(text, /# Investigation: redis connection refused on startup/);
	assert.match(text, /## Existing answers/);
	assert.match(text, /accepted answer/);
	assert.match(text, /## Suggested next steps/);
	assert.match(text, /Reuse the accepted answer on #10/);
});

test('get_triage_status explains an open ticket', async (t) => {
	const { mcp } = await fullStack(t);
	const { text } = await mcp.call('get_triage_status', { tid: 11 });
	assert.match(text, /\*\*Stage:\*\* In progress/);
	assert.match(text, /\*\*Handled by:\*\* Core Support/);
});

test('get_triage_status distinguishes untracked topics from missing plugins', async (t) => {
	const { mcp } = await fullStack(t);
	const { text } = await mcp.call('get_triage_status', { tid: 12 });
	assert.match(text, /not tracked on any triage board/);
	assert.match(text, /normal discussion, not a support ticket/);
});

test('get_triage_board groups tickets by column, backlog included, closed hidden', async (t) => {
	const { mcp } = await fullStack(t);
	const { text } = await mcp.call('get_triage_board');
	assert.match(text, /# Triage board — Core Support \(core\)/);
	assert.match(text, /on duty: maintainer/);
	assert.match(text, /## Todo `todo` \(1\)/);
	assert.match(text, /## In work `in_work` \(1\)/);
	assert.match(text, /priority: high · claimed by maintainer · help wanted · question: unsolved/);
	assert.match(text, /## Backlog: Blocked `blocked` \(1\)/);
	assert.match(text, /#14 Avatar upload fails/);
	assert.ok(!text.includes('#10 Redis'), 'closed tickets are hidden by default');
	assert.match(text, /1 closed ticket\(s\) hidden/);
	assert.match(text, /Status keys for update_ticket: `todo`, `in_work`/);

	const withClosed = await mcp.call('get_triage_board', { include_closed: true });
	assert.match(withClosed.text, /## Closed `closed` \(1\)/);
	assert.match(withClosed.text, /#10 Redis connection refused/);
});

test('get_triage_board explains a non-member rather than erroring', async (t) => {
	const { mcp } = await fullStack(t, { NODEBB_API_TOKEN: 'outsider-token' });
	const { text, isError } = await mcp.call('get_triage_board');
	assert.equal(isError, false);
	assert.match(text, /outsider is not a member of any triage team/);
});

test('get_triage_board flags a Shotef that ignores API tokens', async (t) => {
	const forum = await startFakeForum({ shotefIgnoresTokens: true });
	const mcp = await connect(forum.url, { NODEBB_API_TOKEN: 'admin-token' });
	t.after(async () => { await mcp.close(); await forum.close(); });
	const { text } = await mcp.call('get_triage_board');
	assert.match(text, /ignores API tokens/);
});

test('get_ticket shows status, owner and the internal fields to a member', async (t) => {
	const { mcp } = await fullStack(t);
	const { text, isError } = await mcp.call('get_ticket', { tid: 11 });
	assert.equal(isError, false, text);
	assert.match(text, /\*\*Status:\*\* `in_work` \(In progress\)/);
	assert.match(text, /\*\*Owner:\*\* maintainer · \*\*Priority:\*\* high · help wanted/);
	assert.match(text, /\*\*Q&A:\*\* unsolved question/);
	assert.match(text, /## Internal notes \(team only\)/);
});

test('get_ticket refuses a non-member with advice', async (t) => {
	const { mcp } = await fullStack(t, { NODEBB_API_TOKEN: 'outsider-token' });
	const { text, isError } = await mcp.call('get_ticket', { tid: 11 });
	assert.equal(isError, true);
	assert.match(text, /You are not a member of this team/);
	assert.match(text, /not on the team handling this ticket/);
});

test('triage labels are neutral, not addressed to the reporter', async (t) => {
	const { forum, mcp } = await fullStack(t);
	forum.tickets[11].status = 'responded';
	const { text } = await mcp.call('get_triage_status', { tid: 11 });
	assert.match(text, /\*\*Stage:\*\* Answered — waiting on the reporter/);
	assert.ok(!text.includes('Awaiting your reply'));
});

test('list_categories decodes names and exposes ids', async (t) => {
	const { mcp } = await fullStack(t);
	const { text } = await mcp.call('list_categories');
	assert.match(text, /\[cid 3\] Support & Help/);
	assert.match(text, /Help & questions/);
	assert.ok(!text.includes('&amp;'));
});

test('get_post returns one post with its topic header', async (t) => {
	const { mcp } = await fullStack(t);
	const { text } = await mcp.call('get_post', { pid: 102 });
	// The plain v3 post route has no user object; the author must still be named.
	assert.match(text, /Post 102 — maintainer/);
	assert.match(text, /✅ ACCEPTED ANSWER/);
	assert.match(text, /redis-server --dir/);
	assert.match(text, /\/post\/102/);
});

test('a missing topic produces a readable error, not a stack trace', async (t) => {
	const { mcp } = await fullStack(t);
	const { text, isError } = await mcp.call('get_topic', { tid: 9999 });
	assert.equal(isError, true);
	assert.match(text, /Could not read topic 9999/);
	assert.ok(!text.includes('at Object.'), 'must not leak a stack trace');
});

test('invalid arguments are rejected by the schema', async (t) => {
	const { mcp } = await fullStack(t);
	const result = await mcp.client.callTool({ name: 'get_topic', arguments: { tid: -1 } });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Input validation error.*tid/s);

	const missing = await mcp.client.callTool({ name: 'find_answers', arguments: {} });
	assert.equal(missing.isError, true);
	assert.match(missing.content[0].text, /question/);
});

test('an unreachable forum degrades to an explained error', async (t) => {
	const mcp = await connect('http://127.0.0.1:1');
	t.after(() => mcp.close());

	const caps = await mcp.call('forum_capabilities');
	assert.match(caps.text, /Unreachable/);

	const search = await mcp.call('search_forum', { query: 'anything' });
	assert.match(search.text, /Could not|unreachable|reach/i);
});
