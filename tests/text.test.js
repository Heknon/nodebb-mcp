import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeEntities, decodeTitle, htmlToText, overlapScore, snippetAround, tokenize, truncate } from '../dist/text.js';

test('decodeEntities decodes named, decimal and hex entities', () => {
	assert.equal(decodeEntities('Can&#x27;t sign in &amp; &quot;reset&quot;'), `Can't sign in & "reset"`);
	assert.equal(decodeEntities('a &lt;x&gt; b'), 'a <x> b');
	assert.equal(decodeEntities('&#8230;'), '…');
});

test('decodeEntities is a no-op on plain text and leaves unknown entities alone', () => {
	assert.equal(decodeEntities('nothing to do here'), 'nothing to do here');
	assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
});

test('decodeEntities does not double-decode a decoded string', () => {
	const once = decodeEntities('Tom &amp;amp; Jerry');
	assert.equal(once, 'Tom &amp; Jerry');
	// A second pass would yield 'Tom & Jerry' — callers must decode exactly once.
	assert.equal(decodeEntities(once), 'Tom & Jerry');
});

test('htmlToText keeps code blocks fenced', () => {
	const html = '<p>Run this:</p><pre><code>redis-server --dir /data</code></pre><p>Then restart.</p>';
	const out = htmlToText(html);
	assert.match(out, /```\nredis-server --dir \/data\n```/);
	assert.match(out, /Then restart\./);
});

test('htmlToText preserves inline code, lists, quotes and link targets', () => {
	assert.match(htmlToText('<p>use <code>npm ci</code></p>'), /`npm ci`/);
	assert.match(htmlToText('<ul><li>one</li><li>two</li></ul>'), /- one/);
	assert.match(htmlToText('<blockquote>earlier point</blockquote>'), /^> earlier point/m);
	assert.match(htmlToText('<a href="https://e.com/x">docs</a>'), /docs \(https:\/\/e\.com\/x\)/);
});

test('htmlToText drops scripts and styles entirely', () => {
	const out = htmlToText('<p>safe</p><script>alert("x")</script><style>.a{}</style>');
	assert.equal(out, 'safe');
});

test('htmlToText decodes entities in the extracted text', () => {
	assert.equal(htmlToText('<p>NodeBB won&#x27;t start</p>'), `NodeBB won't start`);
});

test('decodeTitle falls back when the title is missing', () => {
	assert.equal(decodeTitle(undefined, 'Topic #7'), 'Topic #7');
	assert.equal(decodeTitle('', 'Topic #7'), 'Topic #7');
	assert.equal(decodeTitle('  Real &amp; title  '), 'Real & title');
});

test('truncate cuts on a word boundary and marks the cut', () => {
	const out = truncate('the quick brown fox jumps over the lazy dog', 20);
	assert.ok(out.length <= 21, out);
	assert.match(out, /…$/);
	assert.ok(!out.includes('jumps'));
	assert.equal(truncate('short', 20), 'short');
});

test('tokenize drops stop words and short tokens', () => {
	const tokens = tokenize('How do I fix the redis connection?');
	assert.ok(tokens.includes('redis'));
	assert.ok(tokens.includes('connection'));
	assert.ok(!tokens.includes('how'));
	assert.ok(!tokens.includes('the'));
});

test('overlapScore ranks a matching title above an unrelated one', () => {
	const query = 'redis connection refused';
	const good = overlapScore(query, 'Redis connection refused after upgrade');
	const bad = overlapScore(query, 'Welcome to the forum');
	assert.ok(good > bad, `${good} !> ${bad}`);
	assert.ok(good > 0.5, String(good));
	assert.equal(bad, 0);
});

test('overlapScore credits partial stem matches at half weight', () => {
	assert.ok(overlapScore('plugin symlink', 'Plugins and symlinks') > 0);
});

test('overlapScore is bounded to [0,1] and handles empty input', () => {
	assert.equal(overlapScore('', 'anything'), 0);
	assert.ok(overlapScore('redis redis redis', 'redis') <= 1);
});

test('snippetAround centres on the matched term', () => {
	const body = `${'padding '.repeat(40)}ECONNREFUSED happened here${' trailing'.repeat(40)}`;
	const snippet = snippetAround(body, 'ECONNREFUSED', 120);
	assert.match(snippet, /ECONNREFUSED/);
	assert.ok(snippet.length < body.length);
});

test('snippetAround falls back to the head when nothing matches', () => {
	const snippet = snippetAround('alpha beta gamma', 'zzz', 50);
	assert.match(snippet, /^alpha/);
});
