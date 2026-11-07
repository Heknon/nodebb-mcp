/** Who this server is, to MCP clients and to the forum. */

import { platform } from 'node:os';

export const SERVER_NAME = 'nodebb-mcp';
export const SERVER_VERSION = '0.2.0';

/** The platform token NodeBB's user-agent parser recognises for this OS. */
function platformToken(): string {
	switch (platform()) {
		case 'linux': return 'Linux';
		case 'darwin': return 'Macintosh';
		case 'win32': return 'Windows NT';
		default: return platform();
	}
}

/**
 * Sent on every request to the forum. NodeBB labels each session on a person's
 * sessions page from the User-Agent it signed in with, so this reads as
 * "nodebb-mcp 0.2.0 on Linux" there — recognisable when they want to revoke it.
 * Without it, Node's default shows as "unknown unknown on unknown".
 */
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION} (${platformToken()})`;
