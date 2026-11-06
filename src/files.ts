/** Owner-only state files: the session cache and the OAuth state. */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const queues = new Map<string, Promise<void>>();

/**
 * Write JSON to `path` atomically (a temp file, then rename) with owner-only
 * permissions, one write at a time per file in call order — two writes never
 * share the temp file. Never throws: callers keep their state in memory and
 * the next write tries again.
 */
export function writePrivateJson(path: string, data: unknown): Promise<void> {
	const text = `${JSON.stringify(data)}\n`;
	const next = (queues.get(path) ?? Promise.resolve()).then(async () => {
		try {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			const tmp = `${path}.${process.pid}.tmp`;
			await writeFile(tmp, text, { mode: 0o600 });
			await rename(tmp, path);
		} catch {
			// Not fatal: see above.
		}
	});
	queues.set(path, next);
	void next.then(() => {
		if (queues.get(path) === next) queues.delete(path);
	});
	return next;
}
