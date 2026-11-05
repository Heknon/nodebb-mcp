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

When the operator enabled writes (NODEBB_ENABLE_WRITES), the server can also act: create_topic,
reply_to_topic, edit_post and vote_post on the forum, and — with Shotef — get_ticket,
update_ticket, mark_solved and pass_ticket to work the triage board. Everything written is
public to the forum's users at once: read the thread first, check find_answers for an existing
answer before posting a new one, and keep team-only reasoning in update_ticket notes rather
than public replies.`;

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
