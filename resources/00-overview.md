# NodeBB plugin development — overview

Transferable knowledge for building NodeBB plugins, verified against **NodeBB
v4.x on Node 22** (most of it applies to v3 too). Start here; each companion
resource goes deep on one area.

| Resource | Covers |
| --- | --- |
| `10-architecture.md` | The `nbb` loader, plugin layout, `plugin.json`, lifecycle |
| `20-hooks-reference.md` | Hook families, firing semantics, the hooks that matter |
| `30-endpoints.md` | Page routes, `/api/v3/plugins/*` routes, socket.io methods, auth |
| `40-data-layer.md` | The backend-agnostic `db` abstraction, key design, encoding, caching |
| `50-client-acp-templates.md` | Client scripts, ACP modules, `.tpl` templates, languages, CSS/theming |
| `60-gotchas.md` | The traps that cost hours, each as symptom → cause → fix |
| `70-testing.md` | `node:test` units, seeding mock data, HTTP/curl, Playwright |
| `80-recipes.md` | Copy-paste scaffolding and dev-environment setup |
| `90-worked-example.md` | An annotated tour of a real, non-trivial plugin |

## The mental model (internalize this)

NodeBB loads a plugin's **server code into memory at startup** and serves
**client assets (JS/CSS/templates) from a prebuilt bundle**. Two consequences
drive almost every "why isn't my change showing up":

1. **Server change** (`library.js`, `lib/*.js`, `languages/*.json`) → **restart**.
2. **Client change** (`public/js/*`, `public/css/*`, `templates/*.tpl`) → **rebuild + restart**.

A plugin is a normal npm package with a `plugin.json` manifest. Nothing in it
runs unless a hook in that manifest points at a method your library exports.

## Anatomy (minimum viable plugin)

```
my-plugin/
  package.json      # name "nodebb-plugin-*", "main", nbbpm.compatibility
  plugin.json       # id, library, hooks[], scripts[], css[], templates, languages, modules{}
  library.js        # exports the hook methods named in plugin.json
  public/js/*.js    # client scripts (AMD modules)
  public/css/*.css  # or .less
  templates/*.tpl   # Benjamin templates (optional)
  languages/en-GB/*.json
```

`plugin.json` wires names to methods:

```json
{
  "id": "nodebb-plugin-example",
  "library": "./library.js",
  "hooks": [
    { "hook": "static:app.load", "method": "init" },
    { "hook": "static:api.routes", "method": "apiRoutes" },
    { "hook": "filter:admin.header.build", "method": "adminMenu" },
    { "hook": "action:post.save", "method": "onPostSave" }
  ],
  "scripts": ["public/js/client.js"],
  "css": ["public/css/example.css"],
  "templates": "templates",
  "languages": "languages",
  "modules": { "../admin/plugins/example.js": "./public/js/admin.js" }
}
```

`static:app.load` — fired once at startup with `{ router, middleware,
controllers }` — is where page routes and socket handlers get registered.

## The five rules that prevent most pain

1. **Import core modules through one helper**, never a bare `require`:

   ```js
   // lib/nbb.js
   /* eslint-disable no-undef */
   module.exports = (typeof nodebb !== 'undefined' && nodebb && typeof nodebb.require === 'function')
     ? nodebb.require.bind(nodebb)   // NodeBB v4 global
     : require.main.require;          // older / fallback
   ```

   `nbb('./src/user')`, `nbb('./src/database')`, and bare packages shipped with
   NodeBB like `nbb('validator')` all resolve from the NodeBB install root.

2. **Persist through the `db` abstraction** so the plugin runs on Redis / Mongo /
   Postgres unchanged. JSON-encode arrays and objects; store booleans as `0/1`.
   `db.getObject` on your own key is **not** cached; `topics` / `categories` /
   `users` reads **are**.

3. **Decode NodeBB-escaped strings once, server-side.** Titles and category names
   come back **HTML-escaped** from `getTopicsFields` / `getTopicData` even though
   they are stored *unescaped*. If the client escapes again on render you get a
   double-encode (`&#x27;` shown literally). Fix with `validator.unescape(...)`
   on the server.

4. **Rebuild the right thing.** Delete the stale bundle before `./nodebb build`;
   `./nodebb build js` skips **templates and CSS**.

5. **Authorize on the server, from the session — never trust the client.** Socket
   handlers take the actor from `socket.uid`; API controllers from `req.uid`.

## Build / restart cheat sheet

```bash
# server-only change (lib/*.js, library.js, languages):
./nodebb restart

# client change (js/css/tpl) — rm the stale bundle first, FULL build:
rm -f build/public/scripts-client.js build/public/scripts-client.js.map \
      build/public/scripts-admin.js build/public/scripts-admin.js.map
./nodebb build && ./nodebb restart
```

If `./nodebb restart` is a no-op because the process already died, use an
explicit `./nodebb stop; sleep 2; ./nodebb start`.

## Triage when something "isn't working"

1. Is the forum up? `curl -s -o /dev/null -w '%{http_code}' <url>/`
2. Is the plugin actually loaded? A route 404 plus a log line *"…is active but
   not installed"* means the symlink/package is gone (see `60-gotchas.md` #5).
3. Server-code change? **restart.** Client/template/CSS change? **rm bundle +
   full build + restart.**
4. Wrote data from a standalone script? The running server caches topics and the
   like — **restart** so it drops stale caches, or make the change through the
   running server.
5. `TypeError` at module load in a unit test → you added a top-level `nbb('…')`
   the test stub doesn't cover (see `70-testing.md`).
