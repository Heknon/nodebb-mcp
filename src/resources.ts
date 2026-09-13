/**
 * MCP resources: the NodeBB plugin-authoring corpus in ./resources.
 *
 * These are static documents, not forum data — they are what a model needs when
 * a forum question turns out to be "how do I write the plugin that does this?".
 * The manifest is the source of truth for what exists; a document listed but
 * missing on disk is skipped with a warning rather than failing startup.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface ManifestEntry {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	path: string;
}

interface Manifest {
	resources: ManifestEntry[];
}

/** The `resources/` directory, whether running from src (tsx) or dist. */
export function resourcesDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	for (const candidate of [resolve(here, '../resources'), resolve(here, '../../resources')]) {
		if (existsSync(join(candidate, 'index.json'))) return candidate;
	}
	return resolve(here, '../resources');
}

export async function loadManifest(dir = resourcesDir()): Promise<ManifestEntry[]> {
	const raw = await readFile(join(dir, 'index.json'), 'utf8');
	const parsed = JSON.parse(raw) as Manifest;
	if (!parsed || !Array.isArray(parsed.resources)) {
		throw new Error('resources/index.json has no "resources" array');
	}
	return parsed.resources;
}

/**
 * Register every manifest entry as an MCP resource. Returns how many were
 * registered; a failure to read the manifest is logged and returns 0, since
 * missing documentation must not stop the forum tools from working.
 */
export async function registerResources(server: McpServer): Promise<number> {
	const dir = resourcesDir();

	let entries: ManifestEntry[];
	try {
		entries = await loadManifest(dir);
	} catch (err) {
		process.stderr.write(
			`[nodebb-mcp] could not load resource manifest (${err instanceof Error ? err.message : String(err)}); ` +
				'continuing without documentation resources\n',
		);
		return 0;
	}

	let registered = 0;
	for (const entry of entries) {
		const file = join(dir, entry.path);
		if (!existsSync(file)) {
			process.stderr.write(`[nodebb-mcp] resource file missing, skipping: ${entry.path}\n`);
			continue;
		}

		server.registerResource(
			entry.name,
			entry.uri,
			{
				title: entry.title ?? entry.name,
				description: entry.description ?? '',
				mimeType: entry.mimeType ?? 'text/markdown',
			},
			async (uri) => ({
				contents: [
					{
						uri: uri.href,
						mimeType: entry.mimeType ?? 'text/markdown',
						text: await readFile(file, 'utf8'),
					},
				],
			}),
		);
		registered += 1;
	}

	return registered;
}
