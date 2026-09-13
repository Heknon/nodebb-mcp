# Testing a NodeBB plugin

Three layers, cheapest first. Most of your coverage should be layer 1.

1. **`node:test` units** for all pure logic — fast, no forum, runs in CI.
2. **HTTP/curl** against a running forum to confirm real payloads (decoding,
   auth gating, counts).
3. **Playwright** only for genuinely visual or interaction confirmation.

## Layer 1 — unit tests with zero infrastructure

The trick: your modules bind core dependencies at load through `nbb`, which reads
the `nodebb` global. Set a **stub `nodebb` global before requiring your modules**
and they load with fakes, never touching NodeBB or a database.

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

let lastResponse = null;
global.nodebb = {
  require(p) {
    switch (p) {
      case 'validator':
        return { unescape: s => String(s == null ? '' : s)
          .replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') };
      case './src/user':
        return { getUsersFields: async uids => uids.map(uid => ({ uid })) };
      case './src/topics':
        return { getTopicsFields: async tids => tids.map(tid => ({ tid, title: `T${tid}`, cid: 5 })) };
      case './src/categories':
        return { getCategoriesFields: async cids => cids.map(cid => ({ cid, name: `Cat${cid}` })) };
      case './src/controllers/helpers':
        return { formatApiResponse: (status, res, payload) => { lastResponse = { status, payload }; } };
      case './src/database':
        return { getSortedSetRange: async () => [] };
      default:
        return {};   // deps not exercised on this path
    }
  },
};

// Require AFTER the stub is installed.
const Store = require('../lib/store');
const Controllers = require('../lib/controllers');
```

Run: `node --test "tests/*.test.js"`.

**Capturing the response.** Stubbing `formatApiResponse` to record into
`lastResponse` lets you drive a controller with a fake `res` and assert on the
exact payload the client would receive:

```js
test('board splits active and backlog items', async () => {
  Store.getTeams = async () => [team];
  Store.getBoard = async () => ({ topics: [ /* fixtures */ ] });

  await Controllers.apiBoard({ uid: 1, query: { team: 'a' } }, {});

  assert.strictEqual(lastResponse.status, 200);
  assert.deepStrictEqual(lastResponse.payload.columns.map(c => c.key), ['todo', 'in_work']);
});
```

**Capturing writes.** Patch the `Store.*` methods a unit calls, push the writes
into an array, and assert on them:

```js
const writes = [];
Store.getTopic = async () => ({ tid: 1, status: 'todo', team: 'a', handlingTeam: 'a' });
Store.isMember = async () => true;
Store.setTopicFields = async (tid, fields) => { writes.push(fields); };
Store.audit = async () => {};

await Store.transition(1, 'closed', { actorUid: 1 });
assert.strictEqual(writes[0].closeReason, 'resolved');
```

**What to cover this way:** state transitions, routing rules, model projection,
filtering and sorting, notification-target selection, encode/decode round-trips —
all the logic that has nothing to do with the database.

Structure your code so this is possible: keep pure decisions in pure functions.
A helper like `Notify.reporterStageChange(before, after, actorUid)` that takes
plain objects and returns a key or `null` is trivially testable, whereas the same
logic inlined into a socket handler is not.

**Gotcha:** adding a top-level `nbb('newdep')` to any lib means every test's stub
needs a matching `case`, or you get a `TypeError` at load (see `60-gotchas.md`
#7). A shared `tests/stub.js` keeps that in one place.

## Layer 2 — seeding mock data via a NodeBB-context script

To create categories and topics or probe the database with your own `Store`, run
a standalone Node script that boots NodeBB's db and config. This bootstrap avoids
the `uploads.js` and post-cache crashes:

```js
'use strict';
const path = require('path');
const NBB = '/path/to/NodeBB';
process.chdir(NBB);

const nconf = require(NBB + '/node_modules/nconf');
nconf.argv().env({ separator: '__' }).file({ file: NBB + '/config.json' });
nconf.set('base_dir', NBB);
nconf.set('upload_path', path.resolve(NBB, 'public/uploads'));   // else uploads.js throws
nconf.set('upload_url', '/assets/uploads');
const db = require(NBB + '/src/database');

(async () => {
  await db.init();
  await require(NBB + '/src/meta').configs.init();   // else the post LRU cache throws

  const categories = require(NBB + '/src/categories');
  const topics = require(NBB + '/src/topics');
  const Store = require('/path/to/your-plugin/lib/store');

  const { cid } = await categories.create({ name: 'Demo', description: 'demo' });
  const r = await topics.post({ uid: 1, cid, title: 'Hello', content: 'body' });
  const tid = r.topicData.tid;

  // Mock another plugin's state by writing the fields it owns:
  await db.setObjectField('topic:' + tid, 'isQuestion', 1);
  await db.setObjectField('topic:' + tid, 'isSolved', 1);

  process.exit(0);
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
```

Filter the noise: `node seed.js 2>&1 | grep -vE 'winston|Redis|minifier|deprecat'`.

Two facts worth holding while mocking:

- The stored title is **unescaped**; `getTopicsFields` and `post().topicData`
  return it **escaped**.
- `topics.getTopicData(tid)` **does** include custom fields written by other
  plugins.

And the big one: these writes sit **behind the running server's caches**.
Restart the server, or drive the change through it, before concluding your code
is wrong.

## Layer 3a — driving the running forum over HTTP

Write endpoints need a session cookie plus a CSRF token:

```bash
J=/tmp/cj.txt
CSRF=$(curl -s -c $J <url>/api/config \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['csrf_token'])")

curl -s -b $J -c $J -H "x-csrf-token: $CSRF" -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<pw>"}' \
  <url>/api/v3/utilities/login -o /dev/null -w "login:%{http_code}\n"

curl -s -b $J "<url>/api/v3/plugins/example/board?team=x" | python3 -m json.tool
curl -s -b $J -H "x-csrf-token: $CSRF" -X POST <url>/api/v3/plugins/example/thing/1
```

This is the **fastest faithful** way to check API output — it goes through the
live server's caches correctly, so it catches the decoding and gating bugs that
unit tests with stubs cannot.

## Layer 3b — browser verification with Playwright

```js
const { chromium } = require('playwright-core');
const EXE = '/path/to/chromium/chrome';   // preinstalled browser in CI

(async () => {
  const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1600, height: 950 } })).newPage();

  await p.goto('<url>/login', { waitUntil: 'networkidle' });
  await p.fill('#username', 'admin');
  await p.fill('#password', '<pw>');
  await Promise.all([
    p.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
    p.click('#login'),
  ]);

  await p.goto('<url>/example', { waitUntil: 'networkidle' });
  await p.waitForSelector('.example-cols', { timeout: 8000 });

  // An element screenshot only captures the visible box. If content overflows a
  // scroll container, expand it first so the whole thing is captured.
  await p.addStyleTag({ content: '.example-cols{overflow:visible !important;width:max-content !important;}' });
  await (await p.$('.example-cols')).screenshot({ path: '/tmp/shot.png' });

  await b.close();
})();
```

Notes learned in practice:

- A menu item wired with a jQuery `.on('click')` handler **won't fire** from a raw
  DOM `element.click()` inside `page.evaluate`. Use Playwright's real
  `p.click('selector:has-text("…")')` so the handler runs.
- After any client rebuild, use a **fresh browser context** (or hard refresh) so
  you don't screenshot a cached bundle.
- Take the screenshot, read it back, and iterate — don't assume the CSS landed.
