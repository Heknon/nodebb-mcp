/**
 * Prompts that encode the workflows these tools are built for, so a client can
 * offer them directly instead of the user having to know the tool order.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer): void {
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
}
