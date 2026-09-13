# Client scripts, ACP modules, templates, languages, CSS

Everything that ships to the browser lives in the prebuilt bundle, so every
change in this file's territory needs a **rebuild + restart**.

## Client scripts

Declared in `plugin.json` under `scripts: []` and bundled into
`scripts-client.js`.

```js
'use strict';
/* global $, app, config, ajaxify, socket */

(function () {
  function onPage() {
    // Gate on your mount element being present — this fires on every page.
    var $mount = $('.example-app');
    if (!$mount.length) return;
    render($mount);
  }

  $(window).on('action:ajaxify.end', onPage);   // SPA navigation
  $(document).ready(onPage);                     // initial full load
}());
```

`action:ajaxify.end` is NodeBB's "page changed" event. Because the forum is a
SPA, your script is loaded once and must re-check on every navigation whether it
is on the right page. Gate on the presence of your mount element, or on
`ajaxify.data.template.name`.

### Globals available

`$` (jQuery), `app`, `config` (including `relative_path` and `csrf_token`),
`ajaxify` (with `ajaxify.data` — the payload your page controller rendered),
`socket`.

Modules like `alerts`, `bootbox`, and `api` are **not** globals in v4 — load them
lazily:

```js
var alerts, bootbox;
app.require(['alerts', 'bootbox'], function (a, b) { alerts = a; bootbox = b; });
```

Always build URLs with `config.relative_path + '/path'` — forums mounted at a
subdirectory break otherwise.

### Escaping in client code

jQuery's `$('<div>').text(s).html()` escapes `&`, `<`, and `>` but leaves
**quotes intact**. That is fine for text nodes and unsafe the moment you
interpolate into an attribute (`title="…"`, `alt="…"`, `src="…"`), where a quote
breaks out of the attribute. Use one escaper that covers both contexts:

```js
function esc(s) {
  return $('<div>').text(s == null ? '' : String(s)).html()
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
```

Remember this escape is the **second** one if the server didn't decode — see the
double-escape trap in `60-gotchas.md` #1.

## ACP modules — use `modules`, not `scripts`

Admin panel code goes in `plugin.json`'s `modules` map, which maps a virtual
module path to your file:

```json
"modules": { "../admin/plugins/example.js": "./public/js/admin.js" }
```

```js
'use strict';
/* global $, app, config, define */

// Declare NO dependencies in define() — a non-trivial dependency array can make
// NodeBB's build resolve the module to `undefined`, so its init never runs.
// Load deps via app.require() inside init instead.
define('admin/plugins/example', [], function () {
  var ACP = {};
  var alerts, bootbox;

  ACP.init = function () {
    app.require(['alerts', 'bootbox'], function (a, b) { alerts = a; bootbox = b; });
    // wire up the page
  };

  return ACP;
});
```

The `define` name must match the virtual path (`admin/plugins/example`), and
NodeBB calls the returned object's `init()` when the ACP page loads.

Add the ACP page to the admin menu with a filter hook:

```js
plugin.adminMenu = async function (header) {
  header.plugins.push({ route: '/plugins/example', icon: 'fa-list-check', name: 'Example' });
  return header;
};
```

## Templates

Templates live in `templates/` (pointed at by `plugin.json`'s `"templates"` key)
and use Benjamin syntax. They compile into `build/public/templates/*.js`.

```html
<div class="example-audit">
  <h2><i class="fa fa-clipboard-list"></i> Audit</h2>

  <!-- BEGIN teams -->
  <a class="btn btn-sm <!-- IF teams.selected -->btn-primary<!-- ELSE -->btn-light<!-- ENDIF teams.selected -->"
     href="{config.relative_path}/example/audit?team={teams.id}">{teams.name}</a>
  <!-- END teams -->

  <table class="table table-sm">
    <tbody>
      <!-- BEGIN events -->
      <tr>
        <td><span class="timeago" title="{events.tsISO}"></span></td>
        <td>{events.actor.username}</td>
        <td><code>{events.action}</code></td>
        <td><!-- IF events.tid --><a href="{config.relative_path}/topic/{events.tid}">#{events.tid}</a><!-- ENDIF events.tid --></td>
      </tr>
      <!-- END events -->
    </tbody>
  </table>

  <!-- IF !events.length --><p class="text-muted">No events yet.</p><!-- ENDIF !events.length -->
</div>
```

Syntax notes:

- `{value}` interpolates; inside a `<!-- BEGIN list -->` block, fields are
  addressed as `{list.field}`.
- `<!-- IF cond -->` / `<!-- ELSE -->` / `<!-- ENDIF cond -->` — the `ENDIF` must
  repeat the condition. `<!-- IF !x.length -->` handles the empty case.
- `{config.relative_path}` is available in every template; use it on every link.
- `<span class="timeago" title="{iso}"></span>` gets relative-time formatting for
  free from NodeBB.

A **new or changed `.tpl` requires a full `./nodebb build`** — `build js` does
not compile templates, and a missing compiled view 500s with *"Failed to lookup
view! Did you run ./nodebb build?"*.

## Languages

Strings live in `languages/<lang>/<namespace>.json` and are referenced as
`[[namespace:key]]`, with positional args:

```json
{
  "example": "Example Plugin",
  "err-no-team": "No such team",
  "err-conflict": "This item changed since you loaded it — reload and try again",
  "notif-stale-bulk": "%1 items have been untouched for %2 days"
}
```

```js
throw new Error('[[example:err-no-team]]');
bodyShort: `[[example:notif-stale-bulk, ${count}, ${days}]]`,
```

Language keys work in thrown errors, notification bodies, and templates. New keys
need a **restart** (they're server-side) and are safe to add incrementally.

Use keys rather than literal English everywhere a user can see the string —
errors thrown from sockets and API controllers are translated on the way out.

## CSS and dark-mode theming

CSS files listed in `plugin.json`'s `css: []` are compiled into the base
`client.css` **and** into every Harmony skin bundle (`client-darkly.css`,
`client-cyborg.css`, …). Skins rebuild **asynchronously a moment after NodeBB
starts**, so after a CSS change: rebuild, restart, then wait for the skin bundle
to reappear before screenshotting a skin.

The theming trap worth knowing: Bootswatch **dark skins** (Darkly, Cyborg, Slate,
Superhero, Solar, Vapor) flip `--bs-body-bg` and `--bs-body-color` to dark but
leave `--bs-tertiary-bg`, `--bs-secondary-bg`, and `--bs-border-color` at their
**light** Bootstrap defaults. Paint plugin surfaces from those and you get light
boxes under light text.

Derive your surfaces from the two tokens that *are* correct in both themes:

```css
.example-app {
  --ex-surface:   color-mix(in srgb, var(--bs-body-bg) 92%, var(--bs-body-color));
  --ex-surface-2: color-mix(in srgb, var(--bs-body-bg) 86%, var(--bs-body-color));
  --ex-border:    color-mix(in srgb, var(--bs-body-bg) 72%, var(--bs-body-color));
}
.example-card { background: var(--ex-surface); border: 1px solid var(--ex-border); }
```

Tint accents (badges, pills, banners) from an accent colour blended toward the
body colour by the same method, so they track both themes. `--bs-secondary-color`
*is* theme-aware (it's a tint of the body text colour) and is fine for muted text.

Harmony's own dark toggle (`data-bs-theme="dark"`, no skin) **does** set the
tertiary and secondary tokens correctly — so testing only that toggle hides the
bug. Test an actual Bootswatch skin.

Form controls are the usual casualty: an input left at Bootstrap's default white
background stays white in a dark skin. Set background and colour explicitly from
your derived tokens on every input, textarea, and select your plugin renders.
