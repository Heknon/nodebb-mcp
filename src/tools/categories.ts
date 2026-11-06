/**
 * Categories by id or by name. Ids pass straight through; names (and near
 * misses) are looked up in the forum's category tree, as the acting user sees it.
 */

import { z } from 'zod';

import type { NodeBBClient } from '../client.js';
import { listCategories } from '../nodebb/forum.js';
import type { CategoryNode } from '../nodebb/types.js';
import { resolveName } from '../resolve.js';
import type { ToolContext } from './context.js';
import { failure, nameProblem, toolError, type ToolResult } from './format.js';

/** A category as a tool takes it: its id, or its name. */
export const categoryInput = z.union([z.number().int().positive(), z.string().min(1)]);

interface CategoryRef {
	cid: number;
	name: string;
	/** "Parent › Child" for a subcategory. */
	path: string;
	slug?: string;
}

function flatten(nodes: CategoryNode[], parent?: string): CategoryRef[] {
	return nodes.flatMap((node) => {
		const path = parent ? `${parent} › ${node.name}` : node.name;
		return [
			{ cid: node.cid, name: node.name, path, slug: node.slug?.replace(/^\d+\//, '') },
			...flatten(node.children, path),
		];
	});
}

const label = (category: CategoryRef) => `${category.path} (cid ${category.cid})`;

export interface CategoryChoice {
	cids?: number[];
	/** Near misses that were matched, to show the caller. */
	notes: string[];
	/** Set when a name could not be used: the message to return instead. */
	problem?: string;
}

/**
 * Turn ids and names into category ids. `mode: 'read'` takes a unique near miss
 * (and reports it); `'write'` takes only an exact name, so nothing is posted to
 * a guessed category.
 */
export async function chooseCategories(
	client: NodeBBClient,
	inputs: (number | string)[] | undefined,
	mode: 'read' | 'write',
): Promise<CategoryChoice> {
	if (!inputs?.length) return { notes: [] };
	const notes: string[] = [];
	const cids: number[] = [];
	let known: CategoryRef[] | undefined;
	for (const input of inputs) {
		if (typeof input === 'number' || /^\d+$/.test(input.trim())) {
			cids.push(Number(input));
			continue;
		}
		// eslint-disable-next-line no-await-in-loop
		known ??= flatten(await listCategories(client));
		const found = resolveName(input, known.map(category => ({
			item: category,
			ids: [String(category.cid)],
			names: [category.name, category.path, ...(category.slug ? [category.slug] : [])],
		})));
		if (found.kind === 'exact' || (found.kind === 'guess' && mode === 'read')) {
			cids.push(found.item.cid);
			if (found.kind === 'guess') notes.push(`Category "${input}" → ${label(found.item)}, the closest name.`);
			continue;
		}
		return { notes, problem: nameProblem('category', input, found, label, category => `cid ${category.cid}`) };
	}
	return { cids, notes };
}

/** A tool's arguments with its `categories` / `cid` given as ids. */
export type WithCategoryIds<A> = {
	[K in keyof A]: K extends 'categories' ? number[] | undefined : K extends 'cid' ? (undefined extends A[K] ? number | undefined : number) : A[K];
};

/**
 * Wrap a tool handler so its `categories` (array) or `cid` argument may be names:
 * they are turned into ids first. A near miss used by a read is reported at the
 * top of the result; a name that cannot be used returns the reason instead.
 */
export function withCategories<A extends { categories?: (number | string)[]; cid?: number | string }>(
	ctx: ToolContext,
	mode: 'read' | 'write',
	handler: (args: WithCategoryIds<A>) => Promise<ToolResult>,
): (args: A) => Promise<ToolResult> {
	return async (args) => {
		const single = args.cid !== undefined;
		let chosen: CategoryChoice;
		try {
			chosen = await chooseCategories(ctx.client, single ? [args.cid as number | string] : args.categories, mode);
		} catch (err) {
			return toolError('look up the category', err);
		}
		if (chosen.problem) return failure(chosen.problem);
		const resolved = single ? { ...args, cid: chosen.cids?.[0] } : { ...args, categories: chosen.cids ?? args.categories };
		const result = await handler(resolved as WithCategoryIds<A>);
		if (!chosen.notes.length) return result;
		const [first, ...rest] = result.content;
		if (first?.type !== 'text') return result;
		return { ...result, content: [{ ...first, text: `${chosen.notes.map(note => `_${note}_`).join('\n')}\n\n${first.text}` }, ...rest] };
	};
}
