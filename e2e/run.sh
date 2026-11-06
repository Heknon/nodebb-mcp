#!/usr/bin/env bash
#
# The whole end-to-end run, from nothing to a verdict:
#
#   npm run e2e                 # full stack, then core-only
#   npm run e2e -- --full-only  # skip the plugins-off pass (faster, no restarts)
#   npm run e2e -- --fresh      # rebuild the fixture from scratch first
#
# 1. provision NodeBB + plugins if there is no forum yet (e2e/forum.sh provision)
# 2. start Redis + NodeBB                              (e2e/forum.sh up)
# 3. build the MCP server                              (npm run build)
# 4. seed the fixture through the live Write API       (e2e/seed.mjs)
# 5. full-stack suites: dbsearch + Q&A + Shotef        (tests/e2e/{read,write,session,oauth,oauth-browser})
# 6. deactivate the three plugins, run the core suite, reactivate (always)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
export NODEBB_DIR="${NODEBB_DIR:-/home/user/NodeBB}"
export NODEBB_URL="${NODEBB_URL:-http://127.0.0.1:4567}"

FULL_ONLY=0
SEED_ARGS=()
for arg in "$@"; do
	case "$arg" in
		--full-only) FULL_ONLY=1 ;;
		--fresh) SEED_ARGS+=(--fresh) ;;
		*) echo "unknown option: $arg" >&2; exit 64 ;;
	esac
done

cd "$REPO"
[ -d "$NODEBB_DIR" ] || "$HERE/forum.sh" provision
"$HERE/forum.sh" up
npm run build --silent
node "$HERE/seed.mjs" "${SEED_ARGS[@]}"

status=0
echo "── full stack: dbsearch + Q&A + Shotef ─────────────────────────────"
node --test tests/e2e/read.e2e.test.js tests/e2e/write.e2e.test.js tests/e2e/session.e2e.test.js tests/e2e/oauth.e2e.test.js tests/e2e/oauth-browser.e2e.test.js || status=$?

if [ "$FULL_ONLY" = 0 ]; then
	echo "── core only: the same forum with all three plugins deactivated ───"
	trap '"$HERE/forum.sh" plugins on' EXIT
	"$HERE/forum.sh" plugins off
	node --test tests/e2e/core.e2e.test.js || status=$?
fi

exit "$status"
