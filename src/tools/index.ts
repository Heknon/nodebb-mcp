import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ToolContext } from './context.js';
import { registerAnswerTools } from './answer-tools.js';
import { registerForumTools } from './forum-tools.js';
import { registerTriageTools } from './triage-tools.js';

export type { ToolContext } from './context.js';

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
	registerForumTools(server, ctx);
	registerAnswerTools(server, ctx);
	registerTriageTools(server, ctx);
}
