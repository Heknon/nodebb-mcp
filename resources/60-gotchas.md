# Gotchas — the hours-eaters

Each one as symptom → cause → fix. Skim this before debugging; most "impossible"
NodeBB plugin bugs are on this list.

## 1. The double-escape (titles render `&#x27;`)

**Symptom:** an apostrophe or ampersand shows as a literal `&#x27;` / `&amp;` in
your UI.

**Cause:** NodeBB stores topic titles **unescaped** in the `topic:<tid>` hash,
but `topics.getTopicsFields` / `getTopicData` return them **HTML-escaped**. If
your client then escapes again on render (jQuery `.text().html()`, a template
`{prop}` in an escaping context), it's encoded twice and the browser shows the
entity literally.

**Fix:** decode **once, server-side**, before sending to the client:

```js
const validator = nbb('validator');
const decode = s => validator.unescape(String(s || ''));
```

The same applies to **category names** (`categories.getCategoriesFields(…,
['name'])`) and to any socket payload carrying a title. Verify with a title like
`Can't sign in & "reset" <x>` — it should render exactly that.

Tags differ: `topics.getTopicsTags(tids)` returns already-cleaned values, and
`updateTopicTags(tid, tags)` replaces the whole set.

## 2. `./nodebb build js` skips templates AND css

**Symptom:** a template edit 500s with *"Failed to lookup view!"*, or CSS changes
don't apply, even though the build succeeded.

**Cause:** `build js` only bundles client and admin JS.

**Fix:** run the **full** `./nodebb build` whenever a `.tpl` or `.css`/`.less`
changed or was newly added. Reserve `build js` for pure client-JS edits.

## 3. Stale `scripts-client.js` bundle

**Symptom:** client-JS edits silently don't take effect even after a build.

**Cause:** the build sometimes leaves the previous bundle in place.

**Fix:** delete the bundles first, every time:

```bash
rm -f build/public/scripts-client.js build/public/scripts-client.js.map \
      build/public/scripts-admin.js build/public/scripts-admin.js.map
./nodebb build && ./nodebb restart
```

Then hard-refresh the browser (Ctrl/Cmd-Shift-R) to bust its cache.

## 4. Server code is cached in memory

**Symptom:** you edited `library.js` / `lib/*.js` (or a language file) and nothing
changed.

**Cause:** NodeBB loads plugin server code once at startup.

**Fix:** `./nodebb restart`. If restart is a no-op because the process already
died, use `./nodebb stop; sleep 2; ./nodebb start`.

## 5. `npm install <anything>` prunes your dev symlink

**Symptom:** your route 404s and the log says *"nodebb-plugin-X is active but not
installed."*

**Cause:** a symlinked dev plugin looks "extraneous" to npm, so **any**
`npm install` inside the NodeBB directory removes it. This bites most often when
you install another plugin to integration-test against.

**Fix:** recreate the symlink and rebuild:

```bash
ln -s /path/to/your-plugin <NodeBB>/node_modules/nodebb-plugin-x
cd <NodeBB> && rm -f build/public/scripts-*.js* && ./nodebb build && ./nodebb restart
```

## 6. Out-of-process writes are invisible until restart

**Symptom:** a standalone script wrote to the database, but the live page still
shows the old value.

**Cause:** the running server holds in-memory caches (topics, categories, users,
post cache). A script writing straight to Redis/Mongo bypasses cache
invalidation.

**Fix:** either restart the server (which drops the caches), or make the change
**through** the running server via its API/socket/UI so the cache is invalidated
correctly. When a mock "didn't take", restart before concluding there's a bug.

## 7. A top-level `nbb('…')` breaks unit tests

**Symptom:** every test throws `TypeError: X is not a function` at module load,
including tests unrelated to your change.

**Cause:** tests stub the `nodebb` global with a `require` that returns `{}` for
un-cased modules. A newly added top-level `nbb('validator')` then yields an
object with no methods.

**Fix:** add a `case` for the new dependency to every test's stub. If a
dependency is used on only one code path, require it lazily inside that function
instead of at module top level.

## 8. Standalone NodeBB-context scripts crash on incomplete config

**Symptom:** requiring `src/topics` or `src/posts` from a one-off script throws
inside `src/posts/uploads.js` (`path.join(undefined)`) or the post LRU cache
(*"cannot set sizeCalculation without setting maxSize"*).

**Cause:** `nconf` isn't fully set up and `meta.config` isn't loaded.

**Fix:** set the missing nconf keys and init meta configs **before** requiring
the heavy modules:

```js
nconf.argv().env({ separator: '__' }).file({ file: NBB + '/config.json' });
nconf.set('base_dir', NBB);
nconf.set('upload_path', require('path').resolve(NBB, 'public/uploads'));
nconf.set('upload_url', '/assets/uploads');
const db = require(NBB + '/src/database');
await db.init();
await require(NBB + '/src/meta').configs.init();   // before topics.post / post cache
```

Full recipe in `70-testing.md`.

## 9. `notifications.push` is async

**Symptom:** a test reads `uid:<uid>:notifications:unread` right after pushing,
finds nothing, and concludes delivery is broken.

**Cause:** `push` is eventually consistent.

**Fix:** wait ~2 seconds before asserting delivery. This is a test-timing trap
only; production behaviour is fine.

## 10. Optional-integration `isActive()` is cached at init

**Symptom:** cross-plugin behaviour (reading another plugin's fields) is silently
off.

**Cause:** you cached `plugins.isActive('other')` at your plugin's init, but the
other plugin was activated **after** NodeBB last started.

**Fix:** the other plugin must be active **before** your plugin initializes —
activate it, then restart NodeBB. Caching at init is correct (toggling a plugin
requires a restart anyway); just remember the ordering when setting up a test
forum.

## 11. ACP module with dependencies resolves to `undefined`

**Symptom:** your ACP page renders but nothing is wired up; `init` never runs.

**Cause:** a non-trivial dependency array in `define('admin/plugins/x', [deps],
…)` can make NodeBB's build resolve the module to `undefined`.

**Fix:** declare `define('admin/plugins/x', [], function () { … })` with an empty
array and load dependencies via `app.require([...])` inside `init`.

## 12. Dark skins leave surface tokens light

**Symptom:** your plugin's panels are light boxes with light text under Darkly or
Cyborg, while looking fine under Harmony's dark toggle.

**Cause:** Bootswatch dark skins flip `--bs-body-bg`/`--bs-body-color` but leave
`--bs-tertiary-bg`, `--bs-secondary-bg`, and `--bs-border-color` at light
defaults. Harmony's own `data-bs-theme="dark"` sets them correctly, so testing
only that hides the bug.

**Fix:** derive surfaces and borders from `--bs-body-bg` + `--bs-body-color` via
`color-mix`, and test against an actual Bootswatch skin. See
`50-client-acp-templates.md`.

## 13. Redis dev data loss

**Symptom:** the whole forum is empty after a restart (`dbsize` 0, `nextTid` 0).

**Cause:** Redis was started **without persistence pointed at the data dir**, so
it came up on a fresh empty database — and a subsequent save then overwrites the
good RDB/AOF.

**Fix:** always start Redis against the data dir:

```bash
redis-server --daemonize yes --dir <data-dir> --appendonly yes --save "60 1"
redis-cli ping && redis-cli dbsize     # expect PONG and hundreds of keys
```

If `dbsize` is 0 but you expected data you're on the wrong dir — shut down
**without saving** (`redis-cli shutdown nosave`) so you don't clobber the good
files, then restart on the correct `--dir`.

## 14. Low file-descriptor ulimit breaks the build

**Symptom:** `./nodebb build` fails with `EMFILE: too many open files`, often in
the languages step.

**Cause:** NodeBB's default parallel build fans out over thousands of files; some
containers cap open files low enough (e.g. 4096) that even root can't raise it.

**Fix:** build with `./nodebb build --series`. If the languages step still
EMFILEs, batch its fan-out in `src/meta/languages.js` (`buildTranslations` →
run `buildNamespaceLanguage` in slices of ~40 rather than one `Promise.all`).

## 15. Deployed branch ≠ your working branch

**Symptom:** a fix that "works" and is "merged" still shows old behaviour on the
live forum.

**Cause:** you merged into a working branch, not the branch the forum actually
deploys from.

**Fix:** ship to the deployed branch; then the deploy checkout still needs
`git pull` **and** `./nodebb build && ./nodebb restart` to run the new code.

## 16. The harmless one: web-push VAPID warning on localhost

`nodebb-plugin-web-push` logs a VAPID/HTTPS error on `http://localhost`. It's in
`noErrorHooks`, so it does **not** block your plugin's routes. Ignore it.
