# Endpoints: page routes, JSON API, and socket.io

A plugin has three ways to expose behaviour. Pick by shape of the interaction,
not by habit.

| Kind | Registered in | Client calls it via | Use for |
| --- | --- | --- | --- |
| Page route | `static:app.load` | browser navigation | app screens, ACP pages |
| API route | `static:api.routes` | `fetch` / `$.ajax` to `/api/v3/plugins/…` | CRUD, data the page loads, anything scriptable |
| Socket method | `static:app.load` | `socket.emit('plugins.<id>.<method>')` | realtime actions, live updates |

## Page routes

The server renders a shell template; the client bundle hydrates it.

```js
const routeHelpers = nbb('./src/routes/helpers');

plugin.init = async function ({ router, middleware }) {
  routeHelpers.setupPageRoute(router, '/example', [middleware.ensureLoggedIn], controllers.render);
  routeHelpers.setupPageRoute(router, '/example/audit', [middleware.ensureLoggedIn], controllers.renderAudit);
  routeHelpers.setupAdminPageRoute(router, '/admin/plugins/example', controllers.renderAdmin);
};
```

`setupPageRoute` handles both the full-page render and the ajaxified JSON
variant NodeBB's SPA fetches — you write the controller once.

`setupAdminPageRoute` applies admin gating for you; it needs no middleware array.

The controller renders a template name relative to your `templates/` dir:

```js
Controllers.render = async function (req, res) {
  const teams = await Store.teamsForUser(req.uid);
  res.render('example', {                 // -> templates/example.tpl
    title: 'Example',
    noTeam: !teams.length,
    teamId: teams.length ? teams[0].id : '',
  });
};
```

A common and effective pattern is a **near-empty shell template** plus a client
script that fetches the real model from your API. It keeps rendering logic in one
place (JS) instead of split between `.tpl` and the browser:

```html
<div class="example-app" data-team="{teamId}">
  <div class="text-muted" style="padding:24px">Loading&hellip;</div>
</div>
```

## API routes (`/api/v3/plugins/…`)

The router handed to `static:api.routes` is already mounted at
`/api/v3/plugins`, so register relative paths.

```js
const apiHelpers = nbb('./src/controllers/helpers');

// Turn a thrown error into a clean JSON API response.
function wrap(fn) {
  return async function (req, res) {
    try { await fn(req, res); }
    catch (err) { apiHelpers.formatApiResponse(err.status || 400, res, err); }
  };
}

plugin.apiRoutes = async function ({ router }) {
  // auth is enforced inside each controller (req.uid / admin check)
  router.get('/example/board', wrap(controllers.apiBoard));
  router.get('/example/thing/:id', wrap(controllers.apiGetThing));
  router.put('/example/thing/:id', wrap(controllers.apiSaveThing));
  router.delete('/example/thing/:id', wrap(controllers.apiDeleteThing));
  router.post('/example/thing/:id/action', wrap(controllers.apiAction));
};
```

Always respond through `formatApiResponse(status, res, payloadOrError)` — it
produces NodeBB's standard `{ status, response }` envelope that the client
helpers expect, and it renders an `Error` carrying a `[[namespace:key]]` message
as a translated error.

```js
Controllers.apiGetTeams = async function (req, res) {
  if (!await user.isAdministrator(req.uid)) {
    return apiHelpers.formatApiResponse(403, res, new Error('[[error:no-privileges]]'));
  }
  apiHelpers.formatApiResponse(200, res, { teams: await Store.getTeams() });
};
```

A trivial `GET /ping` returning `{ ok: 1, uid: req.uid }` is worth adding — it is
the fastest way to confirm the plugin is actually loaded and the router mounted.

### Calling the API from the browser

Write requests need the CSRF token that NodeBB puts in `config`:

```js
function exampleApi(method, path, body) {
  return $.ajax({
    url: config.relative_path + '/api/v3/plugins/example' + path,
    method: method,
    headers: { 'x-csrf-token': config.csrf_token },
    contentType: 'application/json',
    data: body ? JSON.stringify(body) : undefined,
  });
}
```

## Socket.io methods

Register an object of handlers on the `SocketPlugins` registry under your plugin
id. Every key becomes callable as `plugins.<id>.<method>`.

```js
const SocketPlugins = nbb('./src/socket.io/plugins');
SocketPlugins.example = sockets;         // lib/sockets.js
```

```js
// lib/sockets.js — every method takes the actor from the authenticated socket.
function uidOf(socket) {
  if (!socket || !parseInt(socket.uid, 10)) {
    throw new Error('[[error:not-logged-in]]');
  }
  return parseInt(socket.uid, 10);
}

Sockets.transition = async function (socket, data) {
  const uid = uidOf(socket);
  if (!(await Store.isMember(uid, data.teamId))) {
    throw new Error('[[example:err-not-team-member]]');
  }
  return await Store.transition(data.tid, data.to, { actorUid: uid });
};
```

From the client:

```js
socket.emit('plugins.example.transition', { tid: 12, to: 'closed' }, function (err, result) {
  if (err) return alerts.error(err);
  render(result);
});
```

Thrown errors arrive as the callback's `err`, with `[[…]]` keys translated.

### Never trust a client-supplied identity

The actor is `socket.uid` (or `req.uid`), full stop. Equally, validate that
client-supplied ids actually belong together — a `pid` the caller claims is an
answer must really be on that topic:

```js
if (pid) {
  const postTid = parseInt(await posts.getPostField(pid, 'tid'), 10);
  if (postTid !== tid) throw new Error('[[example:err-reply-not-on-topic]]');
}
```

## Live updates with rooms

For "everyone looking at X should refresh", put those sockets in a room and
broadcast a lightweight **ping** rather than a diff. The client already knows how
to rebuild from your model endpoint, and a ping is always consistent.

```js
// lib/realtime.js
const io = nbb('./src/socket.io');

Realtime.room = teamId => `example_board_${teamId}`;

Realtime.emitTeam = function (teamId) {
  if (!teamId || !io || typeof io.in !== 'function') return;   // safe before io is up
  const room = io.in(Realtime.room(teamId));
  if (room) room.emit('example:board:changed', { teamId: String(teamId) });
};

// Point a socket at exactly one room (board load / switch).
Realtime.watch = function (socket, teamId) {
  if (!socket) return;
  const rooms = socket.rooms ? Array.from(socket.rooms) : [];
  rooms.forEach((r) => {
    if (typeof r === 'string' && r.indexOf('example_board_') === 0 && r !== Realtime.room(teamId)) {
      socket.leave(r);
    }
  });
  if (teamId) socket.join(Realtime.room(teamId));
};
```

Pair it with a `watch` socket method that **authorizes before joining** — room
membership is an access grant:

```js
Sockets.watch = async function (socket, data) {
  uidOf(socket);
  const teamId = data && data.teamId ? String(data.teamId) : '';
  if (teamId && !(await Store.isMember(socket.uid, teamId))) {
    throw new Error('[[example:err-not-team-member]]');
  }
  Realtime.watch(socket, teamId);
  return { watching: teamId };
};
```

On the client:

```js
socket.on('example:board:changed', function (payload) {
  if (payload.teamId === currentTeamId) refresh();
});
```

The `io` handle can be undefined very early in startup, so guard every broadcast
(`typeof io.in !== 'function'`) and make it a silent no-op.

## Optimistic concurrency

Two people dragging the same card is normal. Have mutating methods accept the
state the client believed it was acting on, and reject on mismatch:

```js
await Store.transition(data.tid, data.to, {
  actorUid: uid,
  expectedFrom: data.expectedFrom,     // throws [[example:err-conflict]] on drift
});
```

The client shows "this changed since you loaded it — reload and try again"
instead of silently clobbering someone else's move.
