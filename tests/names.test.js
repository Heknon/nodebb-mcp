/**
 * Teams, categories and people by name. Reads act on a unique near miss and
 * say what it matched; changes act only on an exact name (case and punctuation
 * aside) and otherwise answer with the closest name.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize, resolveName } from '../dist/resolve.js';
import { startFakeForum } from './fake-forum.js';
import { connect } from './mcp-harness.js';

async function as(t, token = 'maintainer-token', env = {}) {
	const forum = await startFakeForum();
	const mcp = await connect(forum.url, { NODEBB_API_TOKEN: token, ...env });
	t.after(async () => { await mcp.close(); await forum.close(); });
	return { forum, mcp };
}

const named = list => list.map(([id, name]) => ({ item: id, ids: [String(id)], names: [name] }));
const TEAMS = named([['e2e-support', 'Support & Ops'], ['billing', 'Billing'], ['core', 'Core Support'], ['a', 'Intake A'], ['b', 'Intake B']]);
const CATEGORIES = named([[12, 'E2E General Discussion'], [2, 'General Discussion'], [11, 'E2E Support & Help'], [1, 'Announcements']]);
const pick = (query, list) => {
	const found = resolveName(query, list);
	return [found.kind, found.item ?? found.options ?? found.nearest];
};

test('the matcher: exact, partial, typo, ambiguous, filler words', () => {
	assert.equal(normalize('Support & Ops!'), 'support and ops');
	assert.equal(normalize('Café–Ünïcode'), 'cafe unicode');
	assert.equal(normalize('תמיכה טכנית'), 'תמיכה טכנית', 'letters of any script survive');

	assert.deepEqual(pick('support and ops', TEAMS), ['exact', 'e2e-support']);
	assert.deepEqual(pick('BILLING', TEAMS), ['exact', 'billing']);
	assert.deepEqual(pick('e2e-support', TEAMS), ['exact', 'e2e-support']);
	assert.deepEqual(pick('biling', TEAMS), ['guess', 'billing']);
	assert.deepEqual(pick('supprot ops', TEAMS), ['guess', 'e2e-support']);
	assert.deepEqual(pick('s&o', TEAMS), ['guess', 'e2e-support'], 'initials');
	assert.deepEqual(pick('the billing team', TEAMS), ['guess', 'billing'], 'describing words dropped');
	assert.deepEqual(pick('inteke a', TEAMS), ['guess', 'a']);
	assert.deepEqual(pick('support', TEAMS), ['ambiguous', ['e2e-support', 'core']], 'never picks between two');
	assert.deepEqual(pick('intake', TEAMS), ['ambiguous', ['a', 'b']]);
	assert.equal(pick('xyzzy', TEAMS)[0], 'none');

	assert.deepEqual(pick('general discussion', CATEGORIES), ['exact', 2]);
	assert.deepEqual(pick('generel discusion', CATEGORIES), ['guess', 2], 'every typed word, no extras: the full name wins');
	assert.deepEqual(pick('general', CATEGORIES), ['ambiguous', [12, 2]]);
	assert.deepEqual(pick('annoucements', CATEGORIES), ['guess', 1]);
	assert.deepEqual(pick('11', CATEGORIES), ['exact', 11]);
});

test('a board by a near-miss team name: found, and the match is reported', async (t) => {
	const { mcp } = await as(t);
	const board = await mcp.call('get_triage_board', { team: 'cor suport' });
	assert.match(board.text, /# Triage board — Core Support \(core\)/);
	assert.match(board.text, /_Team: "cor suport" → Core Support \(`core`\) — the closest of your teams/);

	const exact = await mcp.call('get_triage_board', { team: 'CORE SUPPORT' });
	assert.doesNotMatch(exact.text, /closest/, 'an exact name needs no note');

	const search = await mcp.call('search_tickets', { team: 'core suport', lane: 'all' });
	assert.match(search.text, /_Team: "core suport" → Core Support/);
});

test('a team that exists but is not yours: said so, not swapped for your board', async (t) => {
	const { mcp } = await as(t);
	const board = await mcp.call('get_triage_board', { team: 'billing' });
	assert.match(board.text, /maintainer is not on Billing \(`billing`\), so its board is not visible/);
	assert.doesNotMatch(board.text, /# Triage board — Core Support/);
});

test('pass_ticket by name: an exact name passes; a near miss is answered, not acted on', async (t) => {
	const { forum, mcp } = await as(t);
	const guess = await mcp.call('pass_ticket', { tid: 13, to_team: 'biling', reason: 'invoice question' });
	assert.equal(guess.isError, true);
	assert.match(guess.text, /No team is called "biling"\. Did you mean Billing \(`billing`\)\?.*call again with to_team: "billing"/);
	assert.deepEqual(forum.passes, [], 'nothing was passed on a guess');

	const ok = await mcp.call('pass_ticket', { tid: 13, to_team: 'Billing', reason: 'invoice question' });
	assert.equal(ok.isError, false, ok.text);
	assert.match(ok.text, /Passed ticket #13 to Billing \(`billing`\)/);
	assert.deepEqual(forum.passes, [{ tid: 13, to: 'billing', reason: 'invoice question' }]);

	const unknown = await mcp.call('pass_ticket', { tid: 13, to_team: 'legal', reason: 'x' });
	assert.match(unknown.text, /No team matches "legal"\. The closest:/);
});

test('assign_ticket by username: exact (any case) assigns; a near miss is answered, not acted on', async (t) => {
	const { forum, mcp } = await as(t, 'admin-token');
	const guess = await mcp.call('assign_ticket', { tid: 13, owner: 'maintaner' });
	assert.equal(guess.isError, true);
	assert.match(guess.text, /No member of Core Support is called "maintaner"\. Did you mean maintainer \(uid 8\)\?/);
	assert.equal(forum.tickets[13].claimedBy, 0, 'not assigned on a guess');

	const ok = await mcp.call('assign_ticket', { tid: 13, owner: 'Maintainer' });
	assert.equal(ok.isError, false, ok.text);
	assert.match(ok.text, /Assigned ticket #13 to maintainer as admin/);
	assert.equal(forum.tickets[13].claimedBy, 8);

	const stranger = await mcp.call('assign_ticket', { tid: 13, owner: 'outsider' });
	assert.equal(stranger.isError, true);
	assert.match(stranger.text, /member of Core Support/);
});

test('categories by name in reads: matched and reported; an ambiguous one lists the options', async (t) => {
	const { forum, mcp } = await as(t);
	const recent = await mcp.call('list_recent_topics', { cid: 'suport' });
	assert.match(recent.text, /^_Category "suport" → Support & Help \(cid 3\), the closest name\._/);
	assert.ok(forum.requests.some(r => r.path === '/api/recent' && r.query.cid === '3'));

	const exact = await mcp.call('list_recent_topics', { cid: 'support & help' });
	assert.doesNotMatch(exact.text, /closest name/);

	const search = await mcp.call('search_forum', { query: 'redis', categories: ['Support & Help'] });
	assert.equal(search.isError, false, search.text);
	assert.ok(forum.requests.some(r => r.path === '/api/search' && JSON.stringify(r.query).includes('3')));

	const none = await mcp.call('find_answers', { question: 'redis', categories: ['marketing'] });
	assert.equal(none.isError, true);
	assert.match(none.text, /No category matches "marketing"/);
});

test('create_topic posts only to an exactly named category', async (t) => {
	const { mcp } = await as(t, 'maintainer-token', { NODEBB_ENABLE_WRITES: '1' });
	const guess = await mcp.call('create_topic', { cid: 'suport', title: 'A new problem report', content: 'Details of the problem.' });
	assert.equal(guess.isError, true);
	assert.match(guess.text, /No category is called "suport"\. Did you mean Support & Help \(cid 3\)\?.*call again with cid 3/);

	const ok = await mcp.call('create_topic', { cid: 'Support & Help', title: 'A new problem report', content: 'Details of the problem.' });
	assert.equal(ok.isError, false, ok.text);
});
