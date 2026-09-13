/**
 * Turning forum content into text an LLM can actually read.
 *
 * Two NodeBB facts drive this file:
 *  - Titles and category names come back HTML-*escaped* (`&#x27;`, `&amp;`)
 *    even though they are stored unescaped. They must be decoded exactly once.
 *  - Post content comes back as rendered HTML, not the markdown the user typed.
 */

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
	hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
	lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

/** Decode HTML entities once. Safe on already-decoded text. */
export function decodeEntities(input: string): string {
	if (!input) return '';
	return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, entity: string) => {
		if (entity.startsWith('#')) {
			const isHex = entity[1] === 'x' || entity[1] === 'X';
			const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
			try {
				return String.fromCodePoint(code);
			} catch {
				return match;
			}
		}
		const named = NAMED_ENTITIES[entity.toLowerCase()];
		return named ?? match;
	});
}

/**
 * Reduce rendered post HTML to readable plain text, keeping the structure that
 * carries meaning in a support thread: code blocks, list items, links, quotes.
 */
export function htmlToText(html: string): string {
	if (!html) return '';
	let out = html;

	// Drop non-content elements entirely, including their contents.
	out = out.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

	// Fenced code survives as fenced code — it is usually the answer.
	out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
		const code = stripTags(String(inner)).replace(/\n{3,}/g, '\n\n').trim();
		return code ? `\n\n\`\`\`\n${code}\n\`\`\`\n\n` : '\n';
	});
	out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => {
		const code = stripTags(String(inner)).trim();
		return code ? `\`${code}\`` : '';
	});

	// Quoted text is context, not the answer — mark it so.
	out = out.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
		const quoted = stripTags(String(inner)).trim();
		if (!quoted) return '';
		return `\n${quoted.split(/\n+/).map(line => `> ${line}`).join('\n')}\n`;
	});

	out = out.replace(/<li\b[^>]*>/gi, '\n- ');
	out = out.replace(/<br\s*\/?>/gi, '\n');
	out = out.replace(/<\/(p|div|h[1-6]|tr|ul|ol|table|section)>/gi, '\n\n');

	// Keep a link's target when the text alone would lose it.
	out = out.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
		const text = stripTags(String(label)).trim();
		if (!text) return String(href);
		return text === href ? text : `${text} (${href})`;
	});

	out = stripTags(out);
	out = decodeEntities(out);
	return collapseWhitespace(out);
}

function stripTags(input: string): string {
	return input.replace(/<[^>]*>/g, ' ');
}

function collapseWhitespace(input: string): string {
	return input
		.replace(/[ \t\f\v ]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Decode a title/category name exactly once. */
export function decodeTitle(raw: unknown, fallback = ''): string {
	if (typeof raw !== 'string' || !raw) return fallback;
	return decodeEntities(raw).trim() || fallback;
}

/** Shorten to `max` characters on a word boundary, with an ellipsis. */
export function truncate(input: string, max: number): string {
	if (input.length <= max) return input;
	const cut = input.slice(0, max);
	const lastSpace = cut.lastIndexOf(' ');
	return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * A snippet centred on the best-matching query term, so search results show why
 * they matched rather than just their opening words.
 */
export function snippetAround(text: string, query: string, width = 320): string {
	if (!text) return '';
	const terms = tokenize(query);
	if (!terms.length) return truncate(text, width);

	const haystack = text.toLowerCase();
	let best = -1;
	for (const term of terms) {
		const at = haystack.indexOf(term);
		if (at !== -1 && (best === -1 || at < best)) best = at;
	}
	if (best === -1) return truncate(text, width);

	const start = Math.max(0, best - Math.floor(width / 3));
	const slice = text.slice(start, start + width);
	return `${start > 0 ? '…' : ''}${slice.trim()}${start + width < text.length ? '…' : ''}`;
}

const STOP_WORDS = new Set([
	'the', 'and', 'for', 'you', 'your', 'are', 'not', 'but', 'with', 'this', 'that', 'from',
	'have', 'has', 'was', 'were', 'can', 'cant', 'does', 'doesnt', 'how', 'why', 'what', 'when',
	'who', 'which', 'there', 'here', 'get', 'got', 'any', 'all', 'its', 'it', 'is', 'a', 'an',
	'of', 'to', 'in', 'on', 'at', 'my', 'me', 'i', 'we', 'they', 'them', 'be', 'do', 'if', 'or',
	'as', 'by', 'so', 'no', 'yes', 'about', 'after', 'before', 'into', 'out', 'up', 'down',
]);

/** Lowercase content words, deduped, stop words dropped. */
export function tokenize(input: string): string[] {
	if (!input) return [];
	const seen = new Set<string>();
	for (const raw of input.toLowerCase().split(/[^a-z0-9_.+#-]+/)) {
		const word = raw.replace(/^[.\-+]+|[.\-+]+$/g, '');
		if (word.length < 3 || STOP_WORDS.has(word)) continue;
		seen.add(word);
	}
	return [...seen];
}

/**
 * Overlap score in [0, 1] between a query and a candidate text — the fallback
 * ranking signal when the forum has no search plugin to rank for us.
 */
export function overlapScore(query: string, candidate: string): number {
	const queryTerms = tokenize(query);
	if (!queryTerms.length) return 0;
	const candidateTerms = new Set(tokenize(candidate));
	if (!candidateTerms.size) return 0;

	let hits = 0;
	for (const term of queryTerms) {
		if (candidateTerms.has(term)) {
			hits += 1;
			continue;
		}
		// Credit partial matches ("plugins" vs "plugin") at half weight.
		for (const candidateTerm of candidateTerms) {
			if (candidateTerm.length >= 4 && (candidateTerm.startsWith(term) || term.startsWith(candidateTerm))) {
				hits += 0.5;
				break;
			}
		}
	}
	return Math.min(1, hits / queryTerms.length);
}
