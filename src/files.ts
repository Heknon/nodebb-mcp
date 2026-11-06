/** Owner-only state files: the session cache and the OAuth state. */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The newest content waiting to be written, per file. */
const latest = new Map<string, string>();
/** The writer running for a file, if any. */
const running = new Map<string, Promise<void>>();

async function drain(path: string): Promise<void> {
	for (;;) {
		const text = latest.get(path);
		if (text === undefined) {
			// Checked and cleared in one step: a write queued after this sees no writer and starts one.
			running.delete(path);
			return;
		}
		latest.delete(path);
		try {
			// eslint-disable-next-line no-await-in-loop
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			const tmp = `${path}.${process.pid}.tmp`;
			// eslint-disable-next-line no-await-in-loop
			await writeFile(tmp, text, { mode: 0o600 });
			// eslint-disable-next-line no-await-in-loop
			await rename(tmp, path);
		} catch {
			// Not fatal: callers keep their state in memory and the next write tries again.
		}
	}
}

/**
 * Write JSON to `path` atomically (a temp file, then rename) with owner-only
 * permissions. One writer per file, so two writes never share the temp file;
 * a burst of writes is coalesced into the newest one. Resolves once that
 * content (or newer) is on disk. Never throws.
 */
export function writePrivateJson(path: string, data: unknown): Promise<void> {
	latest.set(path, `${JSON.stringify(data)}\n`);
	let writer = running.get(path);
	if (!writer) {
		writer = drain(path);
		running.set(path, writer);
	}
	return writer;
}
