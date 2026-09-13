# Recipes — scaffolding and dev environment

Copy-paste starting points.

## A minimal plugin skeleton

```
nodebb-plugin-example/
├── package.json
├── plugin.json
├── library.js
├── lib/nbb.js
├── public/js/client.js
├── public/css/example.css
├── templates/example.tpl
├── languages/en-GB/example.json
└── tests/example.test.js
```

**`package.json`**

```json
{
  "name": "nodebb-plugin-example",
  "version": "0.1.0",
  "description": "What it does",
  "main": "library.js",
  "scripts": { "test": "node --test \"tests/*.test.js\"" },
  "keywords": ["nodebb", "nodebb-plugin"],
  "license": "MIT",
  "nbbpm": { "compatibility": "^3.0.0 || ^4.0.0" }
}
```

**`plugin.json`**

```json
{
  "id": "nodebb-plugin-example",
  "url": "https://github.com/you/nodebb-plugin-example",
  "library": "./library.js",
  "hooks": [
    { "hook": "static:app.load", "method": "init" },
    { "hook": "static:api.routes", "method": "apiRoutes" },
    { "hook": "filter:admin.header.build", "method": "adminMenu" }
  ],
  "scripts": ["public/js/client.js"],
  "css": ["public/css/example.css"],
  "templates": "templates",
  "languages": "languages",
  "modules": { "../admin/plugins/example.js": "./public/js/admin.js" }
}
```

**`lib/nbb.js`**

```js
'use strict';
/* eslint-disable no-undef */
module.exports = (typeof nodebb !== 'undefined' && nodebb && typeof nodebb.require === 'function')
  ? nodebb.require.bind(nodebb)
  : require.main.require;
```

**`library.js`**

```js
'use strict';
const nbb = require('./lib/nbb');
const routeHelpers = nbb('./src/routes/helpers');
const apiHelpers = nbb('./src/controllers/helpers');
const SocketPlugins = nbb('./src/socket.io/plugins');

const controllers = require('./lib/controllers');
const sockets = require('./lib/sockets');

const plugin = module.exports;

plugin.init = async function ({ router, middleware }) {
  routeHelpers.setupPageRoute(router, '/example', [middleware.ensureLoggedIn], controllers.render);
  routeHelpers.setupAdminPageRoute(router, '/admin/plugins/example', controllers.renderAdmin);
  SocketPlugins.example = sockets;
};

function wrap(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (err) { apiHelpers.formatApiResponse(err.status || 400, res, err); }
  };
}

plugin.apiRoutes = async function ({ router }) {
  router.get('/example/ping', (req, res) => res.json({ ok: 1, uid: req.uid }));
  router.get('/example/model', wrap(controllers.apiModel));
};

plugin.adminMenu = async function (header) {
  header.plugins.push({ route: '/plugins/example', icon: 'fa-list', name: 'Example' });
  return header;
};
```

## Local dev environment from scratch

NodeBB needs **Redis, MongoDB, or PostgreSQL** — Redis is the lightest. NodeBB's
server does **not** run under Bun (its undici compatibility breaks NodeBB's HTTP
layer); use Node to run the server, and Bun only as a fast package installer if
you like.

```bash
# 1. Clone NodeBB next to your plugin
git clone --depth 1 --branch v4.x https://github.com/NodeBB/NodeBB.git .nodebb-dev
cd .nodebb-dev
cp install/package.json package.json
npm install                     # or: bun install

# 2. Link your plugin (this is what makes edits live)
ln -sfn /path/to/nodebb-plugin-example node_modules/nodebb-plugin-example

# 3. Start a file-persisted Redis you control
mkdir -p redis
redis-server --daemonize yes --dir "$PWD/redis" \
  --dbfilename dump.rdb --save "60 1" --appendonly no
redis-cli ping                  # -> PONG

# 4. First-time setup (interactive: admin user, db choice)
./nodebb setup

# 5. Activate + build + run
./nodebb activate nodebb-plugin-example
./nodebb build
./nodebb dev                    # hot-reloading dev mode
```

The forum comes up on <http://localhost:4567>.

## Iteration loop

```bash
# server-only change (library.js, lib/*.js, languages/*.json)
./nodebb restart

# client change (public/js, public/css, templates/*.tpl)
rm -f build/public/scripts-client.js build/public/scripts-client.js.map \
      build/public/scripts-admin.js build/public/scripts-admin.js.map
./nodebb build && ./nodebb restart

# constrained container / EMFILE during build
./nodebb build --series

# wait for the forum to answer
for i in $(seq 1 15); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4567/)" = 200 ] && { echo up; break; }
  sleep 2
done
```

## Health checks

```bash
redis-cli ping && redis-cli dbsize                     # datastore up, has data
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4567/
ls -la <NodeBB>/node_modules/nodebb-plugin-example     # symlink intact?
curl -s http://127.0.0.1:4567/api/v3/plugins/example/ping   # plugin loaded?
```

## Auditable state change (the shape that holds up)

```js
Store.transition = async function (tid, to, opts = {}) {
  const x = await Store.getTopic(tid);
  if (!x) throw new Error('[[example:err-not-tracked]]');

  const team = await Store.getTeam(x.handlingTeam || x.team);
  const col = (team.columns || []).find(c => c.key === to);
  if (!col) throw new Error('[[example:err-unknown-status]]');

  // optimistic concurrency — the client tells us what it thought it saw
  if (opts.expectedFrom && opts.expectedFrom !== x.status) {
    throw new Error('[[example:err-conflict]]');
  }

  const now = Date.now();
  await Store.setTopicFields(tid, { status: to, updatedAt: now });
  await Store.reindex(tid);                        // move between the zsets/sets
  await Store.audit({
    tid, cid: x.cid, actorUid: opts.actorUid || 0,
    action: 'transition', from: x.status, to, note: opts.note, teamId: team.id,
  });

  return await Store.getTopic(tid);                 // callers broadcast from this
};
```

## Best-effort notification helper

```js
Notify.users = async function (uids, { bodyShort, path, fromUid, nidSuffix } = {}) {
  try {
    if (!notifications || typeof notifications.create !== 'function') return;
    const from = parseInt(fromUid, 10) || 0;
    const targets = [...new Set((uids || []).map(u => parseInt(u, 10)).filter(u => u && u !== from))];
    if (!targets.length) return;

    const notif = await notifications.create({
      type: 'example', bodyShort, path, nid: `example:${nidSuffix}`, from,
    });
    if (notif) await notifications.push(notif, targets);
  } catch (e) {
    // intentionally swallowed — notifications are best-effort and must never
    // fail the action that triggered them
  }
};
```

The guard on `notifications.create` also makes this a no-op under a unit-test
stub, so calling code needs no special casing in tests.

## Cluster-safe cron

```js
'use strict';
const nbb = require('./nbb');
const winston = nbb('winston');
const { CronJob } = nbb('cron');            // 6-field: seconds are supported

const Cron = module.exports;

async function guard(name, fn) {
  try { await fn(); } catch (e) { winston.error(`[plugin/example] cron ${name}: ${e && e.stack}`); }
}

Cron.start = function () {
  if (Cron._jobs) return;                   // idempotent: never double-schedule
  Cron._jobs = [];
  Cron._jobs.push(new CronJob('0 * * * * *', () => guard('minute', () => Cron.everyMinute())));
  Cron._jobs.push(new CronJob('0 0 * * * *', () => guard('hourly', () => Cron.hourly())));
  Cron._jobs.forEach(j => j.start());
};

Cron.stop = function () {
  (Cron._jobs || []).forEach(j => j.stop());
  Cron._jobs = null;
};
```

Start it only under `nconf.get('runJobs')`, and make each job idempotent per
period by bucketing the notification `nid`:

```js
const dayBucket = now => new Date(now).toISOString().slice(0, 10);    // YYYY-MM-DD
const monthBucket = now => new Date(now).toISOString().slice(0, 7);   // YYYY-MM

nidSuffix: `stale:${team.id}:${dayBucket(now)}`,   // re-runs within the day no-op
```

Keep the decision logic in pure exported helpers so cron behaviour is unit
testable without waiting for a clock:

```js
Cron.isHandoverOverdue = function (shiftStartedAt, intervalDays, now) {
  if (!shiftStartedAt || !intervalDays) return false;
  return (now - shiftStartedAt) >= intervalDays * 86400000;
};
```
