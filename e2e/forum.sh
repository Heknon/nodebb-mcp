#!/usr/bin/env bash
#
# Manage the real NodeBB forum the e2e suite runs against.
#
#   e2e/forum.sh provision     clone + install NodeBB v4 with dbsearch, Q&A and Shotef (once)
#   e2e/forum.sh up            start Redis (with persistence!) and NodeBB, wait until ready
#   e2e/forum.sh down          stop NodeBB (Redis keeps running)
#   e2e/forum.sh restart       restart NodeBB and wait (needed after server-side plugin edits)
#   e2e/forum.sh status        what is running, what is active
#   e2e/forum.sh plugins off   deactivate dbsearch, Q&A and Shotef + restart (core-only forum)
#   e2e/forum.sh plugins on    reactivate them + restart
#
# Env: NODEBB_DIR (/home/user/NodeBB), NODEBB_URL (http://127.0.0.1:4567),
#      SHOTEF_DIR (../nodebb-shotef next to this repo), ADMIN_PASS (Test1234!)
#
# Operational rules learned the hard way (see CLAUDE.md):
#  - Redis is not a service here; started without its data dir it comes up EMPTY
#    and the forum is gone. We discover the dir and refuse to guess.
#  - `./nodebb start` daemonizes but keeps stdout open: never pipe it (| tail),
#    or the caller hangs forever. Redirect to a file instead.
#  - `npm install` inside NodeBB prunes symlinked plugins; we re-link Shotef.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
NODEBB_DIR="${NODEBB_DIR:-/home/user/NodeBB}"
NODEBB_URL="${NODEBB_URL:-http://127.0.0.1:4567}"
SHOTEF_DIR="${SHOTEF_DIR:-$(cd "$REPO/.." && pwd)/nodebb-shotef}"
ADMIN_PASS="${ADMIN_PASS:-Test1234!}"
LOG="${NODEBB_LOG:-/tmp/nodebb-e2e.log}"
OPTIONAL_PLUGINS=(nodebb-plugin-dbsearch nodebb-plugin-question-and-answer nodebb-plugin-shotef)
QNA_VERSION="${QNA_VERSION:-2.0.5}"

say() { printf '▶ %s\n' "$*" >&2; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }

http_code() { curl -s -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo 000; }

wait_ready() {
	for _ in $(seq 1 60); do
		[ "$(http_code "$NODEBB_URL/api/config")" = 200 ] && return 0
		sleep 2
	done
	die "NodeBB did not come up at $NODEBB_URL (log: $LOG)"
}

redis_up() {
	if redis-cli ping >/dev/null 2>&1; then return 0; fi
	local dir args
	if [ -f "$NODEBB_DIR/redis/dump.rdb" ] || [ -d "$NODEBB_DIR/redis" ]; then
		dir="$NODEBB_DIR/redis"; args=(--dbfilename dump.rdb --save "60 1" --appendonly no)
	elif [ -d "$NODEBB_DIR/dev/redis-data" ]; then
		dir="$NODEBB_DIR/dev/redis-data"; args=(--appendonly yes)
	else
		die "no Redis data dir under $NODEBB_DIR (redis/ or dev/redis-data/). Run: e2e/forum.sh provision"
	fi
	say "starting Redis on $dir"
	redis-server --daemonize yes --dir "$dir" "${args[@]}" >/dev/null
	sleep 1
	redis-cli ping >/dev/null || die "Redis failed to start"
	local keys; keys="$(redis-cli dbsize)"
	[ "$keys" -gt 0 ] || die "Redis came up EMPTY on $dir — wrong data dir? Stop it WITHOUT saving: redis-cli shutdown nosave"
}

link_shotef() {
	[ -d "$SHOTEF_DIR" ] || die "Shotef checkout not found at $SHOTEF_DIR (set SHOTEF_DIR)"
	if [ ! -L "$NODEBB_DIR/node_modules/nodebb-plugin-shotef" ]; then
		say "re-linking nodebb-plugin-shotef -> $SHOTEF_DIR"
		ln -sfn "$SHOTEF_DIR" "$NODEBB_DIR/node_modules/nodebb-plugin-shotef"
	fi
}

nodebb_start() {
	cd "$NODEBB_DIR"
	./nodebb start >>"$LOG" 2>&1 </dev/null
	wait_ready
}

nodebb_stop() {
	cd "$NODEBB_DIR"
	./nodebb stop >>"$LOG" 2>&1 </dev/null || true
	for _ in $(seq 1 15); do
		[ "$(http_code "$NODEBB_URL/")" = 000 ] && return 0
		sleep 1
	done
}

cmd_up() {
	[ -d "$NODEBB_DIR" ] || die "no NodeBB at $NODEBB_DIR. Run: e2e/forum.sh provision"
	redis_up
	link_shotef
	if [ "$(http_code "$NODEBB_URL/api/config")" = 200 ]; then
		say "NodeBB already up at $NODEBB_URL"
		return 0
	fi
	say "starting NodeBB (log: $LOG)"
	nodebb_start
	say "NodeBB up at $NODEBB_URL"
}

cmd_restart() {
	# `./nodebb restart` is a no-op when the process already died: stop + start.
	nodebb_stop
	nodebb_start
	say "NodeBB restarted"
}

cmd_status() {
	printf 'redis : %s (%s keys)\n' "$(redis-cli ping 2>/dev/null || echo down)" "$(redis-cli dbsize 2>/dev/null || echo '?')"
	printf 'forum : HTTP %s at %s\n' "$(http_code "$NODEBB_URL/api/config")" "$NODEBB_URL"
	printf 'shotef: %s\n' "$(readlink "$NODEBB_DIR/node_modules/nodebb-plugin-shotef" 2>/dev/null || echo 'NOT LINKED')"
	(cd "$NODEBB_DIR" && ./nodebb plugins 2>/dev/null | grep -E "$(IFS='|'; echo "${OPTIONAL_PLUGINS[*]}")") || true
}

cmd_plugins() {
	cd "$NODEBB_DIR"
	case "${1:-}" in
		off)
			for plugin in "${OPTIONAL_PLUGINS[@]}"; do
				say "deactivating $plugin"
				./nodebb reset -p "$plugin" >>"$LOG" 2>&1 </dev/null
			done
			;;
		on)
			link_shotef
			for plugin in "${OPTIONAL_PLUGINS[@]}"; do
				say "activating $plugin"
				./nodebb activate "$plugin" >>"$LOG" 2>&1 </dev/null
			done
			;;
		*) die "usage: e2e/forum.sh plugins on|off" ;;
	esac
	# Plugin (de)activation is read at startup — and Shotef caches whether Q&A is
	# active at init — so a restart is required. No rebuild: the API surface is
	# all server-side.
	cmd_restart
}

cmd_provision() {
	if [ ! -d "$NODEBB_DIR/.git" ]; then
		say "cloning NodeBB v4.x into $NODEBB_DIR"
		git clone --depth 1 --branch v4.x https://github.com/NodeBB/NodeBB.git "$NODEBB_DIR"
	fi
	if [ ! -d "$SHOTEF_DIR" ]; then
		say "cloning Shotef into $SHOTEF_DIR"
		git clone https://github.com/emotochat-droid/nodebb-shotef.git "$SHOTEF_DIR"
	fi
	# Shotef's own setup script installs NodeBB's deps, starts a persisted Redis,
	# runs first-time setup, links the plugin and builds. dbsearch is a NodeBB v4
	# default plugin, so setup activates it.
	if [ ! -f "$NODEBB_DIR/config.json" ]; then
		say "running Shotef's dev/setup.sh against $NODEBB_DIR"
		NODEBB_DIR="$NODEBB_DIR" ADMIN_USER=admin ADMIN_PASS="$ADMIN_PASS" bash "$SHOTEF_DIR/dev/setup.sh"
	fi
	cd "$NODEBB_DIR"
	if [ ! -d node_modules/nodebb-plugin-question-and-answer ]; then
		say "installing nodebb-plugin-question-and-answer@$QNA_VERSION"
		if command -v bun >/dev/null 2>&1; then bun add "nodebb-plugin-question-and-answer@$QNA_VERSION"
		else npm install --no-audit --no-fund "nodebb-plugin-question-and-answer@$QNA_VERSION"; fi
	fi
	link_shotef
	for plugin in "${OPTIONAL_PLUGINS[@]}"; do ./nodebb activate "$plugin" >>"$LOG" 2>&1 </dev/null; done
	say "building (series mode — parallel builds can hit EMFILE under a low ulimit)"
	rm -f build/public/scripts-client.js build/public/scripts-client.js.map \
		build/public/scripts-admin.js build/public/scripts-admin.js.map
	./nodebb build --series >>"$LOG" 2>&1 </dev/null
	redis_up
	if [ "$(http_code "$NODEBB_URL/api/config")" = 200 ]; then cmd_restart; else nodebb_start; fi
	say "provisioned: $NODEBB_URL (admin / $ADMIN_PASS)"
}

case "${1:-}" in
	provision) cmd_provision ;;
	up) cmd_up ;;
	down) nodebb_stop; say "NodeBB stopped" ;;
	restart) cmd_restart ;;
	status) cmd_status ;;
	plugins) shift; cmd_plugins "$@" ;;
	*) sed -n '3,12p' "$0"; exit 64 ;;
esac
