/**
 * Finding a team, category or person from what someone typed: an id, the exact
 * name, or a near miss ("suport", "billing team", "S&O").
 *
 * Tiers, strongest first; the first tier with any match decides:
 *  1. exact   — the id, or a name that is equal once case, accents and
 *               punctuation are ignored ("support & ops" = "Support and Ops");
 *  2. partial — the name starts with or contains what was typed, every typed
 *               word starts a word of the name, or it is the name's initials;
 *  3. typo    — every typed word is within a small edit distance of a word of
 *               the name (or the whole name is).
 * One match in a tier is the answer. Of several, one whose every word was typed
 * wins ("generel discusion" is General Discussion, not E2E General Discussion);
 * otherwise they are ambiguous and listed, never picked between. Words like
 * "team" or "category" get a second chance without them ("billing team").
 * Nothing at all gives the closest names as suggestions.
 *
 * Callers decide what a guess may do: a read acts on a partial or typo match and
 * says what it matched; a write acts only on an exact one and asks otherwise.
 */

export interface Named<T> {
	item: T;
	/** Ids that match exactly (as typed, case-insensitive). */
	ids: string[];
	/** Names and other spellings (slugs, usernames). */
	names: string[];
}

export type Resolution<T> =
	| { kind: 'exact'; item: T }
	| { kind: 'guess'; item: T; how: 'partial' | 'typo' }
	| { kind: 'ambiguous'; options: T[] }
	| { kind: 'none'; nearest: T[] };

/** Lowercase, no accents or marks, `&` as "and", anything but letters and digits as one space. */
export function normalize(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

const words = (value: string) => normalize(value).split(' ').filter(Boolean);

/** Optimal-string-alignment distance: Levenshtein plus adjacent transpositions. */
export function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j += 1) rows[0]![j] = j;
	for (let i = 1; i <= a.length; i += 1) {
		for (let j = 1; j <= b.length; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
			rows[i]![j] = best;
		}
	}
	return rows[a.length]![b.length]!;
}

/** How many typos a word of this length may carry and still count. */
const tolerance = (length: number) => (length <= 3 ? 0 : length <= 6 ? 1 : 2);

function isPartial(query: string, name: string): boolean {
	const q = normalize(query);
	const n = normalize(name);
	if (!q || !n) return false;
	if (n.startsWith(q) || ` ${n} `.includes(` ${q}`)) return true;
	const typed = words(query);
	const named = words(name);
	if (typed.length > 1 && typed.every(word => named.some(part => part.startsWith(word)))) return true;
	// Initials: "so" or "s&o" for "Support & Ops" ("and" does not count).
	const initials = named.filter(part => part !== 'and').map(part => part[0]).join('');
	const compact = q.replace(/ and /g, ' ').replace(/ /g, '');
	return compact.length >= 2 && compact === initials;
}

/** The typo distance from what was typed to a name, or undefined if it is too far. */
function typoDistance(query: string, name: string): number | undefined {
	const q = normalize(query);
	const n = normalize(name);
	const whole = editDistance(q.replace(/ /g, ''), n.replace(/ /g, ''));
	let best = whole <= tolerance(n.replace(/ /g, '').length) ? whole : undefined;
	const typed = words(query);
	const named = words(name);
	let total = 0;
	for (const word of typed) {
		const closest = Math.min(...named.map(part => editDistance(word, part)));
		if (closest > tolerance(word.length)) return best;
		total += closest;
	}
	if (best === undefined || total < best) best = total;
	return best;
}

/** Words that describe what is being named rather than name it. */
const FILLER = new Set(['the', 'team', 'teams', 'category', 'categories', 'board', 'queue', 'forum', 'section', 'group']);

/** Does every word of one of the names appear (give or take a typo) in what was typed? */
function covers(query: string, candidate: Named<unknown>): boolean {
	const typed = words(query);
	return candidate.names.some((name) => {
		const named = words(name).filter(part => part !== 'and');
		return named.length > 0 && named.every(part => typed.some(word =>
			word === part || part.startsWith(word) || editDistance(word, part) <= tolerance(part.length)));
	});
}

export function resolveName<T>(query: string, candidates: Named<T>[]): Resolution<T> {
	const typed = query.trim();
	if (!typed) return { kind: 'none', nearest: [] };
	const found = match(typed, candidates);
	if (found) return found;
	// "billing team", "the support category": try again without the describing words.
	const trimmed = words(typed).filter(word => !FILLER.has(word));
	if (trimmed.length && trimmed.length < words(typed).length) {
		const retry = match(trimmed.join(' '), candidates);
		if (retry) return retry.kind === 'exact' ? { kind: 'guess', item: retry.item, how: 'partial' } : retry;
	}
	const q = normalize(typed);
	const nearest = candidates
		.map(c => ({ c, d: Math.min(...c.names.map(name => editDistance(q, normalize(name)))) }))
		.sort((a, b) => a.d - b.d)
		.slice(0, 5);
	return { kind: 'none', nearest: [...new Set(nearest.map(entry => entry.c.item))] };
}

function match<T>(typed: string, candidates: Named<T>[]): Resolution<T> | undefined {
	const q = normalize(typed);
	const pick = (hits: Named<T>[]): T[] => [...new Set(hits.map(hit => hit.item))];
	// Several in one tier: the one whose every word was typed, if exactly one.
	const narrow = (hits: Named<T>[]): T | undefined => {
		const full = pick(hits.filter(hit => covers(typed, hit)));
		return full.length === 1 ? full[0] : undefined;
	};

	const exact = candidates.filter(c =>
		c.ids.some(id => id.toLowerCase() === typed.toLowerCase()) || c.names.some(name => normalize(name) === q));
	if (pick(exact).length === 1) return { kind: 'exact', item: exact[0]!.item };
	if (exact.length) return { kind: 'ambiguous', options: pick(exact) };

	const partial = candidates.filter(c => [...c.names, ...c.ids].some(name => isPartial(typed, name)));
	if (pick(partial).length === 1) return { kind: 'guess', item: partial[0]!.item, how: 'partial' };
	if (partial.length) {
		const one = narrow(partial);
		return one === undefined ? { kind: 'ambiguous', options: pick(partial) } : { kind: 'guess', item: one, how: 'partial' };
	}

	const scored = candidates
		.map(c => ({ c, d: Math.min(...[...c.names, ...c.ids].map(name => typoDistance(typed, name) ?? Infinity)) }))
		.filter(entry => Number.isFinite(entry.d))
		.sort((a, b) => a.d - b.d);
	if (!scored.length) return undefined;
	const best = scored.filter(entry => entry.d === scored[0]!.d).map(entry => entry.c);
	if (pick(best).length === 1) return { kind: 'guess', item: best[0]!.item, how: 'typo' };
	const one = narrow(scored.map(entry => entry.c));
	return one === undefined ? { kind: 'ambiguous', options: pick(best) } : { kind: 'guess', item: one, how: 'typo' };
}
