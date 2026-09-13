/** Connects a real MCP client to a real server instance over an in-memory pair. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { loadConfig } from '../dist/config.js';
import { buildServer } from '../dist/server.js';

export async function connect(url, env = {}) {
	const config = loadConfig({ NODEBB_URL: url, ...env });
	const { server } = await buildServer(config);

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'test-client', version: '0.0.0' });

	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

	return {
		client,
		async call(name, args = {}) {
			const result = await client.callTool({ name, arguments: args });
			return {
				text: result.content.map(part => part.text ?? '').join('\n'),
				isError: Boolean(result.isError),
			};
		},
		async close() {
			await client.close();
			await server.close();
		},
	};
}
