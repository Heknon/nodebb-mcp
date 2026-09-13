/**
 * Tools backed by the Shotef triage plugin.
 *
 * Both degrade to an explanation rather than an error when the plugin is
 * absent, because "is anyone working on this?" is a reasonable question to ask
 * of a forum that has no triage board — the honest answer is just that it
 * cannot be known from here.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { isUsable } from '../capabilities.js';
import { getBoard, getTriageStatus } from '../integrations/shotef.js';
import { getTopic } from '../nodebb/forum.js';
import type { ToolContext } from './context.js';
import { formatDate, formatTopicSummary, text, toolError } from './format.js';

const UNAVAILABLE_ADVICE =
	'Triage state is provided by the Shotef plugin. Without it, use get_topic to read the thread ' +
	'and judge from the replies whether anyone has picked the issue up.';

export function registerTriageTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		'get_triage_status',
		{
			title: 'Get triage status',
			description:
				'Where a topic stands in the support workflow: received, in progress, awaiting the ' +
				'reporter, or closed — plus which team handles it and whether it is parked. Answers ' +
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

				const topic = await getTopic(ctx.client, tid, { maxPosts: 1 }).catch(() => undefined);
				const lines: string[] = [];
				if (topic) lines.push(formatTopicSummary(topic), '');

				lines.push(
					'## Triage',
					'',
					`**Stage:** ${status.label ?? status.status}`,
					status.teamName ? `**Handled by:** ${status.teamName}` : '',
					status.parked
						? `**Parked:** yes${status.holdReason ? ` (${status.holdReason})` : ''}`
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
				'The team\'s triage board: every open ticket by workflow column, with priority, owner and ' +
				'age. Use it to see the current support workload, or to find which issues are stalled. ' +
				'Requires the Shotef plugin and a token belonging to a team member — a non-member gets an ' +
				'explanation rather than an error.',
			inputSchema: {
				team: z
					.string()
					.optional()
					.describe('Team id. Omit for the token holder\'s default team.'),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ team }) => {
			try {
				const caps = await ctx.capabilities.get();
				if (!isUsable(caps.shotef)) {
					return text(
						`No triage board is available.\n\n${caps.shotef.reason ?? ''}\n\n${UNAVAILABLE_ADVICE}`.trim(),
					);
				}

				const board = await getBoard(ctx.client, ctx.config, caps, team);
				if (!board.items.length) {
					return text(
						[
							'# Triage board',
							'',
							board.reason ?? 'The board is empty — nothing is currently queued.',
							board.teams.length
								? `\nVisible teams: ${board.teams.map(t => `${t.name} (${t.id})`).join(', ')}`
								: '',
						].filter(Boolean).join('\n'),
					);
				}

				const byColumn = new Map<string, typeof board.items>();
				for (const item of board.items) {
					const bucket = byColumn.get(item.status) ?? [];
					bucket.push(item);
					byColumn.set(item.status, bucket);
				}

				const lines = [`# Triage board${board.teamId ? ` — ${board.teamId}` : ''}`, ''];
				if (board.teams.length > 1) {
					lines.push(`_Teams: ${board.teams.map(t => `${t.name} (${t.id})`).join(', ')}_`, '');
				}

				const columns = board.columns.length
					? board.columns
					: [...byColumn.keys()].map(key => ({ key, label: key }));

				for (const column of columns) {
					const items = byColumn.get(column.key) ?? [];
					if (!items.length) continue;
					lines.push(`## ${column.label} (${items.length})`, '');
					for (const item of items) {
						const facts = [
							item.priority && item.priority !== 'normal' ? `priority: ${item.priority}` : '',
							item.claimedBy ? `claimed by ${item.claimedBy}` : 'unclaimed',
							item.helpWanted ? 'help wanted' : '',
							item.updatedAt ? `updated ${formatDate(item.updatedAt)}` : '',
						].filter(Boolean).join(' · ');
						lines.push(`- **#${item.tid} ${item.title}**`, `  ${facts}`, `  ${item.url}`);
					}
					lines.push('');
				}

				return text(lines.join('\n').trim());
			} catch (err) {
				return toolError('read the triage board', err);
			}
		},
	);
}
