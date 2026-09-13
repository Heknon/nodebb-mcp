# Hooks — the only way plugin code runs

A hook is declared in `plugin.json` and implemented as a method on your
library's `module.exports`:

```json
{ "hook": "static:app.load", "method": "init" }
```

```js
plugin.init = async function (params) { /* ... */ };
```

If a method named in `plugin.json` doesn't exist on the export, nothing happens
and nothing warns loudly. Mismatched names are a common silent failure.

## The three families

### `static:*` — awaited lifecycle hooks

Run sequentially and **awaited**. Use them to set things up.

| Hook | Payload | Use |
| --- | --- | --- |
| `static:app.load` | `{ router, middleware, controllers }` | Register page routes, admin routes, socket handlers; one-time async init |
| `static:api.routes` | `{ router, middleware, helpers }` | Register JSON routes under `/api/v3/plugins` |
| `static:app.preload` | app internals | Rare; earlier than `app.load` |

### `filter:*` — transform and **return**

The handler receives a payload, may mutate it, and **must return it**. Forgetting
the return breaks the chain for every plugin after you.

```js
plugin.adminMenu = async function (header) {
  header.plugins.push({ route: '/plugins/example', icon: 'fa-list', name: 'Example' });
  return header;                    // <-- required
};
```

Commonly used: `filter:admin.header.build` (ACP menu entry), `filter:topic.build`,
`filter:register.check`.

### `action:*` — fire-and-forget side effects

The return value is ignored. This is where you react to forum activity.

| Hook | Payload shape | Notes |
| --- | --- | --- |
| `action:topic.save` | `{ topic }` | A new topic was created |
| `action:post.save` | `{ post }` | A post was created — includes the topic's main post, so filter it out if you only want replies |
| `action:topic.move` | `{ tid, toCid, uid }` | Topic moved between categories |
| `action:topics.purge` | `{ topics: [...], uid }` | v4.9+ (plural). Older cores fired singular `action:topic.purge` with `{ topic, uid }` |
| `action:user.create` | `{ user }` | New registration |

Because the return value is ignored, an `action:*` handler must **never let an
error escape** — wrap the whole body and log:

```js
const winston = nbb('winston');

Hooks.onTopicSave = async function (data) {
  try {
    const topic = data && data.topic;
    if (!topic || !topic.tid) return;
    // ...
  } catch (err) {
    winston.error(`[plugin/example] onTopicSave: ${err.stack}`);
  }
};
```

## Firing semantics you can trip on

`fireStaticHook` runs handlers **sequentially**. If a handler throws and the hook
is **not** in NodeBB's `noErrorHooks` set, the error **propagates and aborts the
remaining handlers** — including other plugins' handlers registered after yours.

`static:app.load` *is* in `noErrorHooks`: errors there are logged and the loop
continues. That's why a broken third-party plugin (for example
`nodebb-plugin-web-push`'s VAPID error on `http://localhost`) logs loudly without
stopping your routes from registering. Don't rely on this for your own hooks — a
throw in a non-exempt static hook can silently drop later plugins.

## Handling payload-shape drift across versions

NodeBB renamed and re-shaped some action hooks between majors. Handle both shapes
rather than pinning to one core:

```js
// action:topics.purge (v4.9+) fires { topics: [...], uid };
// older singular action:topic.purge fired { topic, uid }.
Hooks.onTopicPurge = async function (data) {
  const list = (data && data.topics) || (data && data.topic ? [data.topic] : []);
  for (const topic of list) { /* ... */ }
};
```

## Filtering out the noise in `action:post.save`

`action:post.save` fires for the topic's **first** post too. If you only care
about replies, compare against the topic's `mainPid`:

```js
const mainPid = await topics.getTopicField(post.tid, 'mainPid');
if (parseInt(post.pid, 10) === parseInt(mainPid, 10)) return;   // creation, not a reply
```

## Re-entrancy: don't react to your own writes

If your plugin creates topics or posts itself, its own `action:*` handlers will
fire for them. Keep a short-lived in-flight marker so the handler can skip work
the calling code already did:

```js
// in the create path
Store.markCreateInFlight(uid, cid);
const result = await topics.post({ uid, cid, title, content });

// in the hook
if (Store.isCreateInFlight(topic.uid, topic.cid)) return;
```

Without this you get double-enqueues, duplicate audit entries, and duplicate
notifications that are very hard to trace back.

## Discovering hooks

There is no complete published catalog that stays current. To find the hook for
an event, grep the NodeBB source for the firing call:

```bash
grep -rn "hooks.fire('action:topic" src/
grep -rn "fireHook\|hooks.fire" src/topics/ | head -40
```

The call site also shows you the exact payload shape, which is more reliable than
any documentation.
