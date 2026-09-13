# The data layer — NodeBB's backend-agnostic `db`

NodeBB supports **Redis, MongoDB, and PostgreSQL only** (no MySQL, no SQLite).
Everything you persist should go through `nbb('./src/database')` so the plugin
runs on all three unchanged.

## The operations you get

```js
const db = nbb('./src/database');
```

**Hashes** — your main record store:

- `getObject(key)` · `getObjectField(key, field)` · `getObjects(keys)`
- `setObject(key, obj)` · `setObjectField(key, field, value)`
- `incrObjectField(key, field)` · `incrObjectFieldBy(key, field, n)`
- `deleteObjectField(key, field)` · `delete(key)`

**Sets** — unordered membership:

- `setAdd(key, member)` · `setRemove(key, member)`
- `getSetMembers(key)` · `isSetMember(key, member)`

**Sorted sets** — ordered indexes and queues:

- `sortedSetAdd(key, score, member)` · `sortedSetRemove(key, member)`
- `getSortedSetRange(key, start, stop)` · `getSortedSetRevRange(...)`
- `getSortedSetRangeByScore(key, start, count, min, max)`
- `sortedSetCard(key)`

**Lists** — append-only logs:

- `listAppend(key, value)` · `getListRange(key, start, stop)`

## Design your keys up front

Centralize key construction in one place. It documents your schema, prevents
typos, and makes migrations findable.

```js
const K = Store.keys = {
  teams: 'example:teams',                         // set of teamIds
  team: id => `example:team:${id}`,                // hash (config; arrays JSON-encoded)
  cid: cid => `example:cid:${cid}`,                // set of teamIds owning a category
  topic: tid => `example:topic:${tid}`,            // hash of per-topic fields
  queueTeam: id => `example:queue:team:${id}`,     // zset of active tids
  statusIdx: (cid, key) => `example:status:${cid}:${key}`,  // set of tids in a status
  backlog: id => `example:backlog:${id}`,          // zset, score = updatedAt
  done: id => `example:done:${id}`,                // zset of terminal tids
  auditTid: tid => `example:audit:tid:${tid}`,     // list
  auditGlobal: 'example:audit:global',             // list
};
```

Rules of thumb:

- **Namespace everything** with your plugin id so you never collide with core or
  another plugin.
- A **hash per entity**, a **set for membership**, a **sorted set per view** you
  need ordered or paginated. Sorted-set score is usually a timestamp.
- Keep an index for each query you intend to serve. There is no `WHERE` clause
  here — if you need "all open items for team X", maintain that zset on write.

## Backend-safe encoding

Redis stores strings; Mongo and Postgres round-trip richer types. Normalize so
all three behave identically:

```js
const ARRAY_FIELDS = ['members', 'managers', 'categories', 'columns'];
const NUM_FIELDS = ['intervalDays', 'staleDays'];
const BOOL_FIELDS = ['autoResponded', 'allowAdHoc'];

function encode(team) {
  const out = {};
  Object.keys(team).forEach((k) => {
    out[k] = ARRAY_FIELDS.includes(k) ? JSON.stringify(team[k] || []) : team[k];
  });
  BOOL_FIELDS.forEach((k) => { out[k] = team[k] ? 1 : 0; });   // booleans as 0/1
  return out;
}

function decode(raw) {
  if (!raw || !raw.id) return null;
  const team = Object.assign({}, raw);
  ARRAY_FIELDS.forEach((k) => {
    try { team[k] = JSON.parse(raw[k]); } catch (e) { team[k] = []; }
    if (!Array.isArray(team[k])) team[k] = [];                  // never trust the decode
  });
  NUM_FIELDS.forEach((k) => { team[k] = parseInt(raw[k], 10) || 0; });
  BOOL_FIELDS.forEach((k) => { team[k] = String(raw[k]) === '1' || raw[k] === true; });
  ['members', 'managers'].forEach((k) => { team[k] = (team[k] || []).map(Number); });
  return team;
}
```

The four rules:

1. **JSON-encode arrays and objects** on the way in; `JSON.parse` inside a
   try/catch with a safe fallback on the way out.
2. **Booleans as `0`/`1`**, decoded with `String(v) === '1' || v === true`.
3. **Coerce numeric ids** with `.map(Number)` — Redis hands you strings.
4. **Decode defensively.** Bad data should yield an empty array, not a crash.

Pair `encode`/`decode` next to each other in the same module so they can't drift.

## Reads that are cached, and reads that aren't

- `db.getObject` on **your own** key is **not** cached — you always see current
  data.
- NodeBB **does** cache `topics`, `categories`, and `users` reads.

The consequence matters: writing a topic field directly with
`db.setObjectField('topic:<tid>', …)` from **outside** the running process won't
be visible to the live server until it drops that cache (a restart). See
`60-gotchas.md` #6 — it is the single most common "my change didn't take".

Inside the running process, prefer the core module's own setter
(`topics.setTopicFields`) over a raw `db.setObjectField` on a core key, so cache
invalidation happens properly.

## Read fan-out without N+1

`getObjects`, `getUsersFields`, `getTopicsFields`, and `getCategoriesFields` all
take arrays. Batch, then index by id:

```js
async function enrichUsers(uids) {
  const unique = [...new Set(uids.filter(Boolean).map(Number))];
  const data = await user.getUsersFields(unique,
    ['uid', 'username', 'userslug', 'picture', 'icon:text', 'icon:bgColor']);
  const byUid = {};
  data.forEach((u) => { byUid[u.uid] = u; });
  return byUid;
}
```

Ask for **only the fields you need**. `getUsersFields(uids, [...])` is much
cheaper than loading full user objects for a board of fifty cards.

## Keep writes behind one function

Scatter `db.setObjectField` calls through controllers and sockets and the
invariants rot. Funnel state changes through a single method that does authz, the
optimistic check, the index maintenance, and the audit write in one place:

```js
Store.transition = async function (tid, to, opts = {}) {
  // 1. load current state
  // 2. validate the target status exists in the team's schema
  // 3. optimistic check: opts.expectedFrom must match current, else throw conflict
  // 4. write the topic hash fields
  // 5. move the tid between the zsets/sets that index it
  // 6. append an audit entry
  // 7. return the new state (callers broadcast from it)
};
```

Everything else — sockets, API controllers, hooks, cron — calls that one
function. Unit tests then cover the state machine once, and there is exactly one
place to look when an index goes stale.

## Audit trails

Append-only lists are cheap and invaluable. Write both a per-entity log and a
global one:

```js
Store.audit = async function ({ tid, cid, actorUid, action, from, to, note, teamId }) {
  const entry = JSON.stringify({ ts: Date.now(), tid, cid, actorUid, action, from, to, note, teamId });
  await db.listAppend(K.auditTid(tid), entry);
  await db.listAppend(K.auditGlobal, entry);
};
```

Keep a tombstone when the underlying entity is deleted — record the deletion in
the audit instead of erasing the history with it.
