# NodeBB plugin architecture

The moving parts of a plugin and how NodeBB loads them.

## The `nbb` core-module loader

NodeBB v4 exposes a global `nodebb.require(...)`; older versions only have
`require.main.require(...)`. Bind one helper and use it everywhere:

```js
// lib/nbb.js
'use strict';
/* eslint-disable no-undef */
module.exports = (typeof nodebb !== 'undefined' && nodebb && typeof nodebb.require === 'function')
  ? nodebb.require.bind(nodebb)
  : require.main.require;
```

Both forms resolve from the NodeBB install root, so they load **core modules**
(`nbb('./src/user')`) *and* **bare npm packages shipped with NodeBB**
(`nbb('validator')`, `nbb('nconf')`, `nbb('cron')`, `nbb('winston')`). Using
`nbb` instead of raw `require.main.require` also silences v4's deprecation
warning.

Going through a single helper is what makes the plugin unit-testable: tests stub
the `nodebb` global before requiring your modules, and every core dependency
becomes a fake (see `70-testing.md`).

Core modules you will reach for most:

| Module | Use |
| --- | --- |
| `./src/database` | The backend-agnostic `db` (see `40-data-layer.md`) |
| `./src/user` | `getUsersFields`, `isAdministrator` |
| `./src/topics` | `getTopicData`, `getTopicsFields`, `setTopicFields`, `post`, `events.log` |
| `./src/posts` | `getPostField`, post lookups |
| `./src/categories` | `getCategoriesFields`, `create` |
| `./src/privileges` | `privileges.topics.can('topics:read', tid, uid)` |
| `./src/notifications` | `create` + `push` |
| `./src/plugins` | `isActive(id)`, `hooks.fire(...)` |
| `./src/meta` | `configs.init()` in standalone scripts |
| `./src/utils` | misc helpers |
| `./src/routes/helpers` | `setupPageRoute`, `setupAdminPageRoute` |
| `./src/controllers/helpers` | `formatApiResponse` |
| `./src/socket.io/plugins` | the `SocketPlugins` registry |
| `./src/socket.io` | the io server, for room broadcasts |

## Plugin layout that scales

A one-file `library.js` stops being workable fast. The layout that holds up:

```
library.js        # thin: wires hooks -> modules, registers routes/sockets
lib/nbb.js        # the core-module loader
lib/controllers.js # page renders + JSON API handlers
lib/sockets.js    # socket.io methods (authz per method)
lib/store.js      # all persistence: keys, encode/decode, indexes
lib/hooks.js      # action:* handlers
lib/realtime.js   # room naming + broadcasts
lib/notify.js     # notification helpers (best-effort)
lib/cron.js       # scheduled jobs
```

`library.js` stays a wiring file — it exports exactly the method names that
`plugin.json` references and delegates the bodies:

```js
'use strict';
const nbb = require('./lib/nbb');
const nconf = nbb('nconf');
const routeHelpers = nbb('./src/routes/helpers');
const SocketPlugins = nbb('./src/socket.io/plugins');

const controllers = require('./lib/controllers');
const hooks = require('./lib/hooks');
const sockets = require('./lib/sockets');
const cron = require('./lib/cron');

const plugin = module.exports;

plugin.init = async function (params) {
  const { router, middleware } = params;

  // Scheduled jobs run only on the cluster's job-runner process.
  if (nconf.get('runJobs')) {
    cron.start();
  }

  routeHelpers.setupPageRoute(router, '/example', [middleware.ensureLoggedIn], controllers.render);
  routeHelpers.setupAdminPageRoute(router, '/admin/plugins/example', controllers.renderAdmin);

  // Board actions over socket.io (each method authz-checks the caller).
  SocketPlugins.example = sockets;
};

plugin.onPostSave = hooks.onPostSave;
```

## `package.json` essentials

```json
{
  "name": "nodebb-plugin-example",
  "version": "0.1.0",
  "main": "library.js",
  "scripts": { "test": "node --test \"tests/*.test.js\"" },
  "nbbpm": { "compatibility": "^3.0.0 || ^4.0.0" }
}
```

The package name **must** start with `nodebb-plugin-` for NodeBB to discover it.
`nbbpm.compatibility` is the semver range of NodeBB cores you support.

## Lifecycle: what happens when

1. NodeBB starts and reads every active plugin's `plugin.json`.
2. Your `library` module is `require`d **once** — top-level `nbb(...)` calls
   resolve here. This is why server edits need a restart.
3. `static:app.load` fires with `{ router, middleware, controllers }`. Register
   page routes, admin routes, and socket handlers here. Any one-time async init
   (caching another plugin's active state, starting cron) belongs here too.
4. `static:api.routes` fires with a `router` already mounted at
   `/api/v3/plugins`. Register JSON endpoints here.
5. From then on, `action:*` and `filter:*` hooks fire as users do things.

Because step 2 happens once, anything you cache at init (for example
`plugins.isActive('other-plugin')`) stays fixed until the next restart — which is
correct, since activating a plugin requires a restart anyway.

## Cluster awareness

NodeBB can run multiple processes. `nconf.get('runJobs')` is NodeBB's own flag
for the single process that should run scheduled work (`src/start.js`). Guard
cron with it so a job fires exactly once across the cluster:

```js
const nconf = nbb('nconf');
if (nconf.get('runJobs')) {
  cron.start();
}
```

Make the work idempotent anyway, so a restart mid-window can't double-fire — for
example, key a notification's `nid` to a day or month bucket so re-running within
that period is a no-op.

## Optional integration with another plugin

Depend on another plugin **softly**: check once at init, degrade to a no-op when
it is absent.

```js
const plugins = nbb('./src/plugins');
let active = false;

exports.init = async function () {
  try { active = !!(await plugins.isActive('nodebb-plugin-question-and-answer')); }
  catch (e) { active = false; }
};
exports.isActive = () => active;
```

Read the other plugin's data through the same fields it writes — most plugins
store state as topic/post hash fields, and `topics.getTopicData(tid)` returns
custom fields alongside core ones. When you write on its behalf, mirror
everything it does: the fields, the sorted-set memberships, the topic event, and
the hook it publishes, so its own UI stays in sync.

```js
await topics.setTopicFields(tid, { isSolved: 1, solvedPid: pid });
await db.sortedSetRemove('topics:unsolved', tid);
await db.sortedSetAdd('topics:solved', Date.now(), tid);
if (topics.events && typeof topics.events.log === 'function') {
  try { await topics.events.log(tid, { type: 'qanda.solved', uid }); } catch (e) { /* non-fatal */ }
}
if (plugins.hooks && typeof plugins.hooks.fire === 'function') {
  plugins.hooks.fire('action:topic.toggleSolved', { uid, tid, pid, isSolved: true });
}
```

Guard capability checks (`topics.events && typeof … === 'function'`) so you
degrade gracefully on older cores rather than throwing.

## Notifications

```js
const notifications = nbb('./src/notifications');

const notif = await notifications.create({
  type: 'example-thing',
  bodyShort: '[[example:notif-foo]]',   // a language key, not raw text
  path: `/topic/${tid}`,
  nid: `example:${tid}:${uid}`,         // stable id → dedupes
  from: actorUid,
});
if (notif) await notifications.push(notif, targetUids);
```

Practical rules:

- Deduplicate target uids and **exclude the actor** — nobody wants a
  notification about their own click.
- Treat notifications as **best-effort**: wrap in try/catch and swallow, so a
  notification failure never fails the action that triggered it.
- `notifications.push` is **eventually consistent**; see `60-gotchas.md` #9.

## Privileges and auth helpers

- `nbb('./src/privileges').topics.can('topics:read', tid, uid)` → boolean gate
  for reader-facing endpoints.
- `nbb('./src/user').isAdministrator(uid)` for admin checks.
- In sockets, treat `!parseInt(socket.uid, 10)` as not-logged-in and throw
  `[[error:not-logged-in]]`.

Throw language keys (`[[namespace:err-key]]`) rather than English strings — they
are translated for the user and keep the API and socket surfaces consistent.
