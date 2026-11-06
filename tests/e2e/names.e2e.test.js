/**
 * e2e: teams, categories and people by name on the real forum — its real names,
 * including a real ambiguity (General Discussion vs E2E General Discussion).
 * Only refusals are exercised for the changes: nothing here moves a ticket.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { e2e, spawnMcp } from './harness.js';

const { fixture: fx, opts } = await e2e({ needs: 'full' });

let maintainer;
test.before(async () => { if (!opts.skip) maintainer = await spawnMcp(fx, { as: 'maintainer' }); });
test.after(async () => { await maintainer?.close(); });

test('a board by a mistyped team name is found, and the match is reported', opts, async () => {
	const board = await maintainer.call('get_triage_board', { team: 'supprot ops' });
	assert.match(board.text, /# Triage board — Support & Ops \(e2e-support\)/);
	assert.match(board.text, /_Team: "supprot ops" → Support & Ops \(`e2e-support`\)/);

	const theirs = await maintainer.call('get_triage_board', { team: 'intake a' });
	assert.match(theirs.text, /e2e_maintainer is not on Intake A \(`e2e-intake-a`\), so its board is not visible/);
});

test('categories by name: a typo is matched, an ambiguous name lists both', opts, async () => {
	const typo = await maintainer.call('list_recent_topics', { cid: 'e2e suport' });
	assert.match(typo.text, new RegExp(`^_Category "e2e suport" → E2E Support & Help \\(cid ${fx.cids.support}\\), the closest name\\._`));

	const both = await maintainer.call('list_recent_topics', { cid: 'general' });
	assert.equal(both.isError, true);
	assert.match(both.text, new RegExp(`"general" could be .*E2E General Discussion \\(cid ${fx.cids.general}\\)`));
	assert.match(both.text, /General Discussion \(cid \d+\)/);
});

test('changes are not made on a guess: a mistyped team or person gets the closest name back', opts, async () => {
	const pass = await maintainer.call('pass_ticket', { tid: fx.topics.symlink.tid, to_team: 'intke b', reason: 'test' });
	assert.equal(pass.isError, true);
	assert.match(pass.text, /Did you mean Intake B \(`e2e-intake-b`\)\?/);

	const assign = await maintainer.call('assign_ticket', { tid: fx.topics.symlink.tid, owner: 'e2e_maintaner' });
	assert.equal(assign.isError, true);
	assert.match(assign.text, /Did you mean e2e_maintainer \(uid \d+\)\?/);

	const ticket = await maintainer.call('get_ticket', { tid: fx.topics.symlink.tid });
	assert.match(ticket.text, /\*\*Team:\*\* Support & Ops/, 'still with the team');
	assert.match(ticket.text, /\*\*Owner:\*\* e2e_maintainer/);
});
