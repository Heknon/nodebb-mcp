/**
 * Read tools backed by the Shotef triage plugin.
 *
 * All of them degrade to an explanation rather than an error when the plugin is
 * absent, because "is anyone working on this?" is a reasonable question to ask
 * of a forum that has no triage board — the honest answer is just that it
 * cannot be known from here. The write side lives in write-tools.ts.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { isUsable } from '../capabilities.js';
import {
	explainShotefError, getBoard, getTicket, getTriageStatus, type BoardCard,
} from '../integrations/shotef.js';
import { getTopic } from '../nodebb/forum.js';
import type { ToolContext } from './context.js';
import { formatDate, formatTopicSummary, stageLabel, text, toolError } from './format.js';

const UNAVAILABLE_ADVICE =
	'Triage state is provided by the Shotef plugin. Without it, use get_topic to read the thread ' +
	'and judge from the replies whether anyone has picked the issue up.';

function cardLine(item: BoardCard): string[] {
	const facts = [
		item.priority && item.priority !== 'normal' ? `priority: ${item.priority}` : '',
		item.claimedBy ? `claimed by ${item.claimedBy}` : 'unclaimed',
		item.helpWanted ? 'help wanted' : '',
		item.isQuestion ? (item.isSolved ? 'question: solved' : 'question: unsolved') : '',
		item.ghost ? `passed on, now handled by ${item.handledBy ?? 'another team'}` : '',
		item.openDays !== undefined ? `open ${item.openDays}d` : '',
		item.noReplyDays !== undefined ? `reporter silent ${item.noReplyDays}d` : '',
		item.closeReason === 'no_response' ? 'closed: no response' : '',
	].filter(Boolean).join(' · ');
	return [`- **#${item.tid} ${item.title}**`, `  ${facts}`, `  ${item.url}`];
}

export function registerTriageTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		'get_triage_status',
		{
			title: 'Get triage status',
			description:
				'Where a topic stands in the support workflow: received, in progress, answered and waiting ' +
				'on the reporter, or closed — plus which team handles it and whether it is parked. Answers ' +
				'"is anyone working on this, and was it ever resolved?". Requires the Shotef triage ' +
				'plugin; without it, reports that cleanly and suggests reading the topic instead.',
			inputSchema: {
				tid: z.number().int().positive().describe('Topic id.'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ tid }) => {
			try {
				const caps = await ctx.capabilities.get();
				const status = await getTriageStatus(ctx.client, ctx.config, caps, tid);

				if (!status.available) {
					return text(
						`Triage status is unavailable for topic ${tid}.\n\n${status.reason ?? ''}\n\n${UNAVAILABLE_ADVICE}`.trim(),
					);
				}
				if (!status.tracked) {
					const extra = status.reason ? `\n\n${status.reason}` : '';
					return text(
						`Topic ${tid} is not tracked on any triage board.${extra}\n\n` +
							'That usually means its category is not owned by a triage team — the topic is a normal ' +
							'discussion, not a support ticket.',
					);
				}

				const topic = await getTopic(ctx.client, tid, { maxPosts: 1, qna: isUsable(caps.qna) }).catch(() => undefined);
				const lines: string[] = [];
				if (topic) lines.push(formatTopicSummary(topic), '');

				lines.push(
					'## Triage',
					'',
					`**Stage:** ${stageLabel(status.status, status.label)}`,
					status.teamName ? `**Handled by:** ${status.teamName}` : '',
					status.parked
						? `**Parked:** yes${status.holdReason ? ` (${status.holdReason})` : ' (sub-status visible to team members only)'}`
						: '',
					status.updatedAt ? `**Last moved:** ${formatDate(status.updatedAt)}` : '',
				);

				if (status.status === 'closed') {
					lines.push(
						'',
						status.closeReason === 'no_response'
							? '_Closed because the reporter never replied — a reply reopens it._'
							: '_Closed as resolved._',
					);
				} else if (status.status === 'answered') {
					lines.push('', '_The team has replied and is waiting on the reporter._');
				}

				return text(lines.filter(Boolean).join('\n'));
			} catch (err) {
				return toolError(`get triage status for topic ${tid}`, err);
			}
		},
	);

	server.registerTool(
		'get_triage_board',
		{
			title: 'Get the triage board',
			description:
				'The team\'s triage board: every ticket by workflow column (active lanes, the parked ' +
				'backlog, and the intake of shared tickets nobody has taken), with priority, owner and age. ' +
				'Use it to see the current support workload, to find stalled issues, or to look up the ' +
				'status keys update_ticket accepts. Requires the Shotef plugin and a token belonging to a ' +
				'team member — a non-member gets an explanation rather than an error.',
			inputSchema: {
				team: z
					.string()
					.optional()
					.describe('Team id. Omit for the token holder\'s default team.'),
				include_closed: z
					.boolean()
					.optional()
					.describe('Also list closed tickets. Default false — closed work is usually noise.'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ team, include_closed }) => {
			try {
				const caps = await ctx.capabilities.get();
				if (!isUsable(caps.shotef)) {
					return text(
						`No triage board is available.\n\n${caps.shotef.reason ?? ''}\n\n${UNAVAILABLE_ADVICE}`.trim(),
					);
				}

				const board = await getBoard(ctx.client, ctx.config, caps, team);
				const teamList = board.teams.length
					? `Visible teams: ${board.teams.map(t => `${t.name} (${t.id})`).join(', ')}`
					: '';
				if (!board.columns.length) {
					const lines = ['# Triage board', '', board.reason ?? 'No board is visible.'];
					if (caps.shotef.warning) lines.push('', `⚠️ ${caps.shotef.warning}`);
					if (teamList) lines.push('', teamList);
					return text(lines.join('\n'));
				}

				const title = board.teamName ? `${board.teamName} (${board.teamId})` : board.teamId ?? '';
				const lines = [`# Triage board — ${title}`, ''];
				const facts = [
					board.onDuty ? `on duty: ${board.onDuty}` : 'nobody on duty',
					board.teams.length > 1 ? teamList : '',
				].filter(Boolean);
				lines.push(`_${facts.join(' · ')}_`, '');

				const isClosed = (key: string) =>
					board.columns.find(column => column.key === key)?.class === 'terminal';
				const visible = board.items.filter(item => include_closed || !isClosed(item.column));
				if (!visible.length) lines.push('_No open tickets — the queue is clear._', '');

				const section = (heading: string, items: BoardCard[]) => {
					if (!items.length) return;
					lines.push(heading, '');
					for (const item of items) lines.push(...cardLine(item));
					lines.push('');
				};

				for (const column of board.columns) {
					if (column.lane !== 'board' || (!include_closed && column.class === 'terminal')) continue;
					section(
						`## ${column.label} \`${column.key}\` (${column.count})`,
						visible.filter(item => item.lane === 'board' && item.column === column.key),
					);
				}
				for (const column of board.columns.filter(c => c.lane === 'backlog')) {
					section(
						`## Backlog: ${column.label} \`${column.key}\` (${column.count})`,
						visible.filter(item => item.lane === 'backlog' && item.column === column.key),
					);
				}
				section('## Intake — shared tickets nobody has taken', visible.filter(item => item.lane === 'intake'));

				const closedCount = board.items.length - visible.length;
				if (closedCount) lines.push(`_${closedCount} closed ticket(s) hidden; pass include_closed to list them._`, '');
				lines.push(
					`_Status keys for update_ticket: ${board.columns.map(column => `\`${column.key}\``).join(', ')}._`,
				);
				return text(lines.join('\n').trim());
			} catch (err) {
				return toolError('read the triage board', err);
			}
		},
	);

	server.registerTool(
		'get_ticket',
		{
			title: 'Get a triage ticket',
			description:
				'The full internal ticket behind a tracked topic, for members of the team handling it: ' +
				'workflow status, owner, priority, the audit timeline of every move, and the team-only ' +
				'internal notes. Use before acting on a ticket, or to learn what the team already tried. ' +
				'Requires the Shotef plugin; non-members are refused (use get_triage_status instead).',
			inputSchema: {
				tid: z.number().int().positive().describe('Topic id of the ticket.'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ tid }) => {
			try {
				const caps = await ctx.capabilities.get();
				if (!isUsable(caps.shotef)) {
					return text(`No ticket is available.\n\n${caps.shotef.reason ?? ''}\n\n${UNAVAILABLE_ADVICE}`.trim());
				}
				const ticket = await getTicket(ctx.client, ctx.config, tid);
				const lines = [
					`# Ticket #${ticket.tid} ${ticket.title}`,
					ticket.url,
					'',
					`**Status:** \`${ticket.status}\` (${stageLabel(ticket.publicStatus)})` +
						(ticket.closeReason ? ` · closed: ${ticket.closeReason}` : ''),
					`**Team:** ${ticket.teamName} (${ticket.team})`,
					`**Owner:** ${ticket.claimedBy ?? 'unclaimed'} · **Priority:** ${ticket.priority ?? 'normal'}` +
						(ticket.helpWanted ? ' · help wanted' : ''),
					ticket.isQuestion ? `**Q&A:** ${ticket.isSolved ? 'solved' : 'unsolved question'}` : '',
					ticket.category ? `**Category:** ${ticket.category}` : '',
					ticket.readOnly ? '_Read-only for you: you are not on the handling team._' : '',
				].filter(Boolean);

				if (ticket.description) lines.push('', '## Description', '', ticket.description);

				lines.push('', '## Timeline', '');
				if (!ticket.timeline.length) lines.push('_No recorded moves._');
				for (const entry of ticket.timeline) {
					const change = entry.from || entry.to ? `: ${entry.from ?? '—'} → ${entry.to ?? '—'}` : '';
					lines.push(
						`- ${formatDate(entry.ts)} · ${entry.actor ?? 'unknown'} · ${entry.action}${change}` +
							(entry.note ? ` — ${entry.note}` : ''),
					);
				}

				lines.push('', '## Internal notes (team only)', '');
				if (!ticket.notes.length) lines.push('_None._');
				for (const note of ticket.notes) {
					lines.push(`- ${formatDate(note.ts)} · ${note.author}: ${note.body.replace(/\n+/g, ' ')}`);
				}
				return text(lines.join('\n'));
			} catch (err) {
				return toolError(`read ticket ${tid}`, err, explainShotefError);
			}
		},
	);
}
