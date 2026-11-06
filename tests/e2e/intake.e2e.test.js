/**
 * e2e: tickets in a category two teams share. Each starts contended — in both
 * teams' intake lane, taken by neither — and real Shotef then refuses a plain
 * read for the second team's members and any claim that does not name a team.
 * The fixture (e2e/seed.mjs ensureIntake): teams e2e-intake-a / e2e-intake-b
 * share one category; e2e_intake is on A, e2e_intake_b on B. Each test posts its
 * own ticket, since taking one ends its time in intake.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { e2e, spawnMcp } from './harness.js';

const { fixture: fx, opts: forumOpts } = await e2e({ needs: 'full' });
const opts = forumOpts.skip || fx?.intake ? forumOpts : { skip: 'fixture has no shared-category intake (run e2e/seed.mjs)' };
const RUN = `r${Date.now().toString(36)}`;

const open = [];
const posted = [];
test.after(async () => {
	await Promise.all(open.map(mcp => mcp.close()));
	// Leave no new unanswered topics behind: other suites list the forum's recent ones.
	for (const tid of posted) {
		// eslint-disable-next-line no-await-in-loop
		await fetch(`${fx.url}/api/v3/topics/${tid}?_uid=1`, { method: 'DELETE', headers: { authorization: `Bearer ${fx.tokens.master}` } });
	}
});

async function as(username) {
	const mcp = await spawnMcp(fx, { as: { username, password: fx.password }, env: { NODEBB_SESSION_FILE: 'off' } });
	open.push(mcp);
	return mcp;
}

/** A new ticket in the shared category, posted by the reporter. */
async function postShared(title) {
	const url = new URL(`${fx.url}/api/v3/topics`);
	url.searchParams.set('_uid', String(fx.uids.reporter));
	const res = await fetch(url, {
		method: 'POST',
		headers: { authorization: `Bearer ${fx.tokens.master}`, 'content-type': 'application/json' },
		body: JSON.stringify({ cid: fx.intake.cid, title: `${title} ${RUN}`, content: `Shared-category report (${RUN}).` }),
	});
	assert.equal(res.status, 200, await res.clone().text());
	const tid = Number((await res.json()).response.tid);
	posted.push(tid);
	return tid;
}

test('a member of the first owning team sees it in intake, opens it, and takes it by claiming', opts, async () => {
	const tid = await postShared('Shared: export button does nothing');
	const mcp = await as('e2e_intake');

	const board = await mcp.call('get_triage_board');
	assert.match(board.text, new RegExp(`## Intake — shared tickets nobody has taken[\\s\\S]*#${tid} Shared: export button does nothing[\\s\\S]*shared by Intake A, Intake B: a claim takes it for your team`));

	const before = await mcp.call('get_ticket', { tid });
	assert.equal(before.isError, false, before.text);
	assert.match(before.text, /\*\*Team:\*\* none yet — it is in the intake lane/);

	const claim = await mcp.call('assign_ticket', { tid, owner: 'me' });
	assert.equal(claim.isError, false, claim.text);
	assert.match(claim.text, new RegExp(`Claimed ticket #${tid} as e2e_intake`));
	assert.match(claim.text, /owner: e2e_intake/);

	const after = await mcp.call('get_ticket', { tid });
	assert.match(after.text, /\*\*Team:\*\* Intake A \(e2e-intake-a\)/);
	assert.match(after.text, /\*\*Owner:\*\* e2e_intake/);
});

test('a member of the second owning team: the plain read is refused by Shotef, the view from their intake works', opts, async () => {
	const tid = await postShared('Shared: password reset mail is late');
	const mcp = await as('e2e_intake_b');

	const ticket = await mcp.call('get_ticket', { tid });
	assert.equal(ticket.isError, false, ticket.text);
	assert.match(ticket.text, /\*\*Team:\*\* none yet/);

	const note = await mcp.call('add_ticket_note', { tid, body: `before taking it ${RUN}` });
	assert.equal(note.isError, true, 'nothing but a claim acts on an untaken ticket');

	const claim = await mcp.call('assign_ticket', { tid, owner: 'me', team: 'e2e-intake-b' });
	assert.equal(claim.isError, false, claim.text);
	assert.match((await mcp.call('get_ticket', { tid })).text, /\*\*Team:\*\* Intake B \(e2e-intake-b\)/);
});
