# nodebb-plugin-mcp

MCP for a NodeBB forum, served by the forum itself. Each person connects their AI
client (Claude Code, an IDE) with their own forum account and can then search the
forum, pull answers out of existing threads, investigate problem reports, and
work support tickets on a [Shotef](https://github.com/emotochat-droid/nodebb-shotef)
triage board — always with exactly their own forum permissions.

Works on a plain NodeBB forum; the search, Q&A and Shotef plugins each unlock
more (see [Plugins](#plugins)).

## Install

Like any NodeBB plugin:

```bash
cd /path/to/nodebb
npm install github:heknon/nodebb-mcp     # or a local checkout's path; it builds itself on install
./nodebb activate nodebb-plugin-mcp
./nodebb build && ./nodebb restart
```

(It is not on the npm registry yet. Installing from GitHub needs read access to
the repository.)

The forum now serves MCP at `https://forum.example.com/api/mcp`, inside NodeBB's
own API. **ACP → Plugins →
MCP** shows that address, the settings, and every connected app.

## Connect

```bash
claude mcp add --transport http forum https://forum.example.com/api/mcp
```

The first time the client connects, the browser opens the forum: the person
signs in the way they always do (password, SSO, two-factor — whatever the forum
uses) and sees *"Claude Code wants to use the forum as you"*. **Allow** sends
them back to the client, which is now connected as them. Nothing else to
configure: no tokens to copy, no passwords through the MCP client.

Each person's own page, **/mcp/connections**, lists their connected apps with a
**Disconnect** button, and shows the command above.

## Tools

What a tool may change decides when it is available:

| Changes | Available | Who may use it |
| --- | --- | --- |
| nothing | always | anyone the forum lets read the content |
| **ticket** — Shotef team state | always, when Shotef is installed | members of the team handling the ticket, and administrators (Shotef checks) |
| **public** — what forum readers see | only with **Public writes** on (ACP → Plugins → MCP; `NODEBB_ENABLE_WRITES=1` locally) | the connected person, within their NodeBB privileges |

| Tool | Does | Changes | Needs |
| --- | --- | --- | --- |
| `forum_capabilities` | Who you are on the forum, which plugins are live, what is missing | nothing | — |
| `find_answers` | Topics that already answer a question, with the answer from each (labelled accepted or merely upvoted) and its ticket stage | nothing | — |
| `investigate_issue` | Existing answers, still-open reports, triage state, and next steps for a problem report | nothing | — |
| `search_forum` | Full-text search with snippets, flagging hits that have a ticket | nothing | a search plugin and a signed-in user (otherwise a recent-titles scan) |
| `get_topic` | A thread in full, accepted answer and triage stage marked | nothing | — |
| `get_topic_answer` | The answer to one topic | nothing | Q&A for an accepted answer (otherwise the top reply, labelled) |
| `get_post` | One post with its topic | nothing | — |
| `list_categories` | Category tree with ids | nothing | — |
| `list_recent_topics` | Recent, popular, top or unread topics, forum-wide or for one category, with ticket stages | nothing | a signed-in user for `unread` |
| `list_unanswered_questions` | Questions nobody has answered | nothing | Q&A (otherwise topics with no replies) |
| `get_triage_status` | A topic's stage: received, in progress, answered, closed | nothing | Shotef |
| `get_triage_board` | A team's board by column, plus the status keys `set_ticket_status` takes | nothing | Shotef, team member |
| `search_tickets` | Find tickets on every board you can see: by words, lane (active, backlog, intake, closed), status, owner, priority, help wanted, Q&A state, tag, age, reporter silence | nothing | Shotef, team member |
| `get_ticket` | A ticket with its history and internal notes | nothing | Shotef, team member |
| `add_ticket_note` | Leave an internal note only the team sees | ticket | Shotef, team member |
| `set_ticket_status` | Move a ticket, or close it as resolved or no-response | ticket | Shotef, team member |
| `assign_ticket` | Claim, release, or assign a ticket. Claiming a ticket in the intake lane (a category two teams share, taken by neither) takes it for your team | ticket | Shotef, team member (manager to assign someone else) |
| `set_ticket_priority` | Set priority and the help-wanted flag | ticket | Shotef, team member |
| `pass_ticket` | Hand a ticket to another team | ticket | Shotef, team member |
| `create_topic` | Start a topic, optionally as a Q&A question | public | Public writes |
| `reply_to_topic` | Post a reply | public | Public writes |
| `edit_post` | Replace a post's text | public | Public writes |
| `vote_post` | Upvote, downvote, or withdraw a vote | public | Public writes |
| `mark_solved` | Accept a reply as a question's answer | public | Public writes, Q&A, Shotef, team member |

Ticket changes are not entirely invisible: the reporter sees the coarse stage
("in progress", "closed") and Shotef notifies them when it changes. Notes and
the ticket history stay with the team. To keep a server off the board entirely,
give it a token for a user who is on no triage team and is not an administrator
(Shotef treats administrators as members of every team).

**Names.** Teams, categories and assignees can be given by name instead of id,
and spelling need not be exact. "suport", "the billing team", "S&O" or
"generel discusion" all find what was meant. A lookup takes the closest unique
match and its output says what it matched. A change (`pass_ticket`,
`assign_ticket`, `create_topic`) needs the exact name, ignoring case and
punctuation. A near miss there is answered with "did you mean …?" and
nothing changes, because a wrong guess would move someone's ticket. A name that fits several
("general", with both General Discussion and E2E General Discussion) is never
guessed: the options are listed.

**Prompts:** `answer_forum_question` and `investigate_report` chain the read tools;
`work_ticket` takes a ticket from report to closed (with public writes off, it
drafts the reply into a note for a person to post).

## How access works

- **Each connection is the person.** Allowing an app creates a NodeBB API token
  for that person (listed in ACP → Settings → API Access as *"MCP: Claude Code
  (alice)"*). Every tool call goes through the forum's own API with that token,
  so NodeBB checks it like any request of theirs: category privileges, bans,
  Shotef's team rules.
- **Ending access.** The person disconnects the app on /mcp/connections; an
  administrator revokes it in ACP → Plugins → MCP, or deletes its API token; or
  the client revokes its own token. Any of these cuts it off on the next request.
- **Standard OAuth.** The forum is the authorization server: discovery
  (`/.well-known/oauth-authorization-server/api/mcp`), dynamic client registration,
  PKCE, one-time codes, hourly access tokens and rotating refresh tokens, all
  stored hashed in the forum's database. Nothing outside the forum is involved,
  so it works air-gapped.
- **Any number of forum processes.** The MCP endpoint keeps no session between
  requests, and all state is in the database, so a multi-process forum works
  as-is.

Settings (ACP → Plugins → MCP):

| Setting | Default | Effect |
| --- | --- | --- |
| Public writes | off | Lets connected apps post topics and replies, edit posts, vote and accept answers, as the person and within their privileges. Shotef ticket actions do not need it. Takes effect on the next request, in every forum process. |

Before going live:

- **HTTPS.** OAuth requires the forum to be served over `https://` (plain http
  is accepted only on localhost).
- **Forums under a subpath** (`https://example.com/forum`): OAuth discovery
  lives at the origin root, so the reverse proxy must also pass
  `/.well-known/oauth-authorization-server/forum/api/mcp` and
  `/.well-known/oauth-protected-resource/forum/api/mcp` to NodeBB, as they are
  (the plugin answers them at the root; no rewriting).
- **Rate limits.** Client registration, authorization and token requests are
  limited per IP (the MCP SDK's defaults: 20 registrations an hour). Behind a
  proxy, set NodeBB's `trust_proxy` so that is per person, not per proxy.
- **Content-Security-Policy.** If you turned on NodeBB's CSP, its `form-action`
  must allow the clients' callback addresses (e.g. `http://localhost:*` for
  Claude Code), or the browser blocks the way back after **Allow**.

## Running it locally instead (stdio)

Without installing anything on the forum, one person can run the same tools on
their own machine, acting as one forum account (`npm install && npm run build`
in a checkout first):

```json
{
  "mcpServers": {
    "forum": {
      "command": "node",
      "args": ["/path/to/nodebb-mcp/dist/index.js"],
      "env": {
        "NODEBB_URL": "https://forum.example.com",
        "NODEBB_USERNAME": "support-bot",
        "NODEBB_PASSWORD": "…"
      }
    }
  }
}
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODEBB_URL` | required | Forum root, e.g. `https://forum.example.com` (a subpath is fine) |
| `NODEBB_USERNAME`, `NODEBB_PASSWORD` | — | The account to sign in as. Without credentials the server is a guest: public content only, and no search |
| `NODEBB_API_TOKEN` | — | Alternative to a password (ACP → Settings → API Access). Wins if both are set |
| `NODEBB_UID` | — | User to act as. Required with a master token; ignored otherwise |
| `NODEBB_ENABLE_WRITES` | off | `1` / `true` enables the public tools |
| `NODEBB_TIMEOUT_MS` | `15000` | Per-request timeout |
| `NODEBB_MAX_POSTS_PER_TOPIC` | `50` | Posts read per topic |
| `NODEBB_CAPABILITY_TTL_MS` | `300000` | How long plugin detection is cached |
| `NODEBB_SHOTEF_NAMESPACE` | `shotef` | Shotef's route prefix under `/api/v3/plugins/` |
| `NODEBB_SESSION_FILE` | per-user cache file | Where the signed-in session is kept (`~/.cache/nodebb-mcp/`, owner-only); `off` keeps it in memory |
| `NODEBB_SESSION_CHECK_MS` | `30000` | How often an idle session is re-checked before a Shotef or other Write API read |

**Signing in with a password.** The server keeps the session cookie, sends the
CSRF token on writes, and signs in again by itself when the session expires or
is revoked. NodeBB limits sign-ins (by default, 5 failures an hour lock the
account; 20 sign-ins an hour from one IP lock the IP), so new processes reuse the
cached session, a wrong password is tried once and remembered for an hour, and
the password itself is never written anywhere. The session shows on the account's
sessions page as *nodebb-mcp 0.1.0 on Linux*. Two-factor accounts need an API
token instead.

**Check who you are.** NodeBB does not reject an invalid or revoked token; it
quietly treats the caller as a guest. `forum_capabilities` shows the user the
forum actually resolved, and flags credentials it refused or ignored.

## Plugins

None are required. When one is missing, the tools still answer and say in their
output what they could not see.

| Plugin | With it | Without it |
| --- | --- | --- |
| Search: `nodebb-plugin-dbsearch` (on by default in NodeBB v4) | Ranked search over titles and post bodies, for a token's user (guests lack the search privilege by default) | A scan of recent topic titles, flagged as such |
| `nodebb-plugin-question-and-answer` | Accepted answers, the unsolved queue, `mark_solved` | The most-upvoted reply, labelled *not marked accepted*; the queue becomes topics without replies |
| [Shotef](https://github.com/emotochat-droid/nodebb-shotef) | Triage stage, board, tickets, and the ticket tools | Triage is reported as unknown |

The ticket tools need Shotef's HTTP API (`/api/v3/plugins/shotef/tickets/…`, see
its README). On a build without it, `forum_capabilities` reports triage actions
as absent and says why, and the ticket tools refuse before sending anything.
Such builds also ignore API tokens: the board then reads as empty for a token,
but works when the server signs in with `NODEBB_USERNAME` / `NODEBB_PASSWORD`.

An unconfirmed reply is never presented as an accepted answer, and every refusal
from the forum comes back with its reason and what to do about it.

## Development

```bash
npm run check      # build + unit tests (fake forum, no NodeBB needed)
npm run e2e        # build, seed and test against a real NodeBB; provisions one if missing
```

- **Unit tests** (`tests/*.test.js`) run against `tests/fake-forum.js`, an HTTP
  model of NodeBB 4.16 with the three plugins.
- **End-to-end tests** (`tests/e2e/`) run against a real forum seeded by
  `e2e/seed.mjs`, which runs this checkout as `nodebb-plugin-mcp` (symlinked, like
  Shotef). The plugin suites connect through the forum's real OAuth, login and
  Connect page — one of them in headless Chromium, ACP included; the others drive
  the stdio server once per forum identity. They run once with all plugins on
  and once with them off. `e2e/forum.sh` starts, stops, rebuilds and inspects
  that forum.

Layout: `src/plugin/` is the NodeBB side (routes, OAuth provider, database
store), `library.cjs` + `plugin.json` + `templates/` + `public/` are what NodeBB
loads, and everything else in `src/` is the MCP server both modes share.

When the two disagree, the real forum wins and the fake is fixed. `CLAUDE.md`
covers this container; `.claude/skills/nodebb-mcp-dev/` covers NodeBB's API
quirks and how to add a tool.

## Plugin-authoring docs

The server also serves a guide to writing NodeBB plugins (v3/v4) as MCP
resources, distilled from the Shotef plugin:

| URI | Covers |
| --- | --- |
| `nodebb://plugin-dev/overview` | Mental model, plugin anatomy, the five rules |
| `nodebb://plugin-dev/architecture` | The `nbb` loader, layout, lifecycle, clustering, notifications |
| `nodebb://plugin-dev/hooks` | `static:` / `filter:` / `action:` hooks and how they fire |
| `nodebb://plugin-dev/endpoints` | Page routes, `/api/v3/plugins` routes, socket.io |
| `nodebb://plugin-dev/data-layer` | The `db` abstraction, key design, caching |
| `nodebb://plugin-dev/client-acp-templates` | Client scripts, ACP modules, templates, languages, CSS |
| `nodebb://plugin-dev/gotchas` | 17 traps as symptom → cause → fix |
| `nodebb://plugin-dev/testing` | `node:test` units, seeding, HTTP and browser checks |
| `nodebb://plugin-dev/recipes` | Scaffolding, dev environment, snippets |
| `nodebb://plugin-dev/worked-example` | An annotated tour of a real plugin |

They live in `resources/` as plain markdown. To add one, write the file and add
an entry to `resources/index.json`.

## License

MIT
