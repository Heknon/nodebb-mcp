/** Assembles the MCP server: client, capabilities, tools, resources, prompts. */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CapabilityRegistry } from './capabilities.js';
import { NodeBBClient } from './client.js';
import type { Config } from './config.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerAllTools } from './tools/index.js';

export const SERVER_NAME = 'nodebb-mcp';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `Tools for investigating issues and finding answers on a NodeBB forum.

Start with find_answers for a question, or investigate_issue for a problem report — both
work out what the forum already knows before you write anything new. get_topic reads a
thread in full; list_categories and list_recent_topics are for exploring.

Two forum plugins make the results sharper when they are installed, and everything still
works when they are not:
  - question-and-answer  -> author-accepted answers, a real unsolved queue
  - shotef               -> triage status: is anyone working on this, was it resolved

Call forum_capabilities to see which are live on this forum, and who this server acts as.
When a feature is missing the tools degrade and say so in their output — treat that note as
part of the answer, and never present an unconfirmed reply as an accepted one.

With Shotef and a team member's token, the server works the triage board: get_ticket reads a
ticket with its internal notes; add_ticket_note, set_ticket_status, assign_ticket,
set_ticket_priority and pass_ticket change it. These are the team's own workflow (notes and
timeline are team-only), and Shotef refuses them to anyone outside the handling team.

Public writes — create_topic, reply_to_topic, edit_post, vote_post and mark_solved (which sets
the thread's accepted answer) — exist only when the operator set NODEBB_ENABLE_WRITES. They are
public the moment they succeed: read the thread first, check find_answers for an existing
answer before posting a new one, and keep team-only reasoning in add_ticket_note rather than in
public replies.`;

export interface BuiltServer {
	server: McpServer;
	capabilities: CapabilityRegistry;
}

export async function buildServer(config: Config): Promise<BuiltServer> {
	const client = new NodeBBClient(config);
	const capabilities = new CapabilityRegistry(client, config);

	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ instructions: INSTRUCTIONS },
	);

	registerAllTools(server, { client, config, capabilities });
	registerPrompts(server, config);
	await registerResources(server);

	return { server, capabilities };
}
