/**
 * Prompts that encode the workflows these tools are built for, so a client can
 * offer them directly instead of the user having to know the tool order.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from './config.js';

export function registerPrompts(server: McpServer, config: Config): void {
	server.registerPrompt(
		'answer_forum_question',
		{
			title: 'Answer a forum question',
			description: 'Search the forum for an existing answer, then draft a reply grounded in what it finds.',
			argsSchema: {
				question: z.string().describe('The question as the user asked it.'),
			},
		},
		({ question }) => ({
			messages: [
				{
					role: 'user',
					content: {
						type: 'text',
						text:
							`A forum user asked:\n\n"${question}"\n\n` +
							'Answer it using this forum\'s own history:\n' +
							'1. Call find_answers with the question.\n' +
							'2. If nothing useful comes back, call investigate_issue for a wider sweep.\n' +
							'3. Open the most promising topics with get_topic to read them in full before relying on them.\n\n' +
							'Then draft a reply that: cites the topic URLs it draws on; states plainly when an answer ' +
							'was accepted by the original asker versus merely upvoted; and says so explicitly if the ' +
							'forum has no prior answer, rather than inventing one.',
					},
				},
			],
		}),
	);

	server.registerPrompt(
		'investigate_report',
		{
			title: 'Investigate a problem report',
			description: 'Work out whether a reported problem is known, solved, or already being worked on.',
			argsSchema: {
				report: z.string().describe('The problem report — symptoms, errors, what broke.'),
			},
		},
		({ report }) => ({
			messages: [
				{
					role: 'user',
					content: {
						type: 'text',
						text:
							`Investigate this report:\n\n"${report}"\n\n` +
							'Call investigate_issue first. Then, for anything it flags as tracked, call ' +
							'get_triage_status to see whether the work is still open.\n\n' +
							'Report back: whether this is a known issue, whether a fix or workaround already exists ' +
							'(and whether it was confirmed), whether anyone is currently on it, and what the ' +
							'reporter should be told. Call forum_capabilities and note the limitation if the ' +
							'investigation ran degraded.',
					},
				},
			],
		}),
	);

	// Acting on a ticket only makes sense when the write tools exist.
	if (!config.enableWrites) return;

	server.registerPrompt(
		'work_ticket',
		{
			title: 'Work a support ticket',
			description: 'Take a triaged topic from report to resolution: research, answer, accept, close.',
			argsSchema: {
				tid: z.string().describe('Topic id of the ticket.'),
			},
		},
		({ tid }) => ({
			messages: [
				{
					role: 'user',
					content: {
						type: 'text',
						text:
							`Work support ticket #${tid} to resolution.\n\n` +
							'1. get_ticket and get_topic — what is reported, what the team already tried (internal notes), ' +
							'who owns it.\n' +
							'2. update_ticket with owner "me" and status in_work if nobody has it; leave an internal note ' +
							'with your plan.\n' +
							'3. find_answers / investigate_issue for an existing fix. Cite the topics you rely on, and say ' +
							'whether each answer was accepted or merely upvoted.\n' +
							'4. reply_to_topic with the answer — public, so plain and self-contained; keep team-only ' +
							'reasoning in update_ticket notes.\n' +
							'5. When the reporter confirms it worked: mark_solved with the answering post, then ' +
							'update_ticket status closed. If they went silent, close with close_reason no_response ' +
							'(a reply reopens it). If it belongs to another team, pass_ticket with the reason.\n\n' +
							'Stop and report back instead of guessing when the forum refuses an action — the refusal ' +
							'says why.',
					},
				},
			],
		}),
	);
}
