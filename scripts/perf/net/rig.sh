#!/bin/zsh
# Three-machine rig: one dev desktop ("local", the laptop) paired with two isolated measurement brains
# ("studio", the big desktop, and "win", a third machine) through slow proxies, all on this computer.
# Run the whole up → measure → down inside ONE heavy slot (one rig machine-wide):
#   RIG_DIR=<scratch> RIG_STUDIO_SOURCE=<copy> RIG_WIN_SOURCE=<copy> RIG_LOCAL_SOURCE=<copy> \
#     zsh scripts/perf/net/rig.sh up [--app-worktree <dir>] [--brain-cli <cli.cjs>] [--node-options "…"] [--profile wan30]
#   … measure with scripts/perf/net/rig-scenarios.mjs --machines $RIG_DIR/machines.json …
#   zsh scripts/perf/net/rig.sh down
#   rig.sh reset   re-clone the three projects from their sources (make-real-load-copy --clone)
#   rig.sh status
#
# The three sources are copies made by make-real-load-copy.mts (never a live project). Each brain is a
# measure-brain.mjs brain (own HOME and socket, loopback only, 8787 and tailscale guarded); the desktop is a
# dev app with NO_DEVTOOLS=1 and its own ADE_HOME, paired through its own pairWithMachine with each brain's
# pairing link (rig-pair.mts) via the proxy. Nothing touches the installed ADE, its account or 8787.
# RIG_ORIGINS=shared (default) gives all three copies one git origin (the same repo on every machine, so
# Work merges their chats); RIG_ORIGINS=unique keeps a project on its own machine (cross-machine tab switches).
# RIG_OWNER_LOG (optional, read-only): the installed brain's log, checked for event-loop near-misses per run.
# CDP for the app: 127.0.0.1:${RIG_CDP:-9470}. macOS only (APFS clonefile copies, process groups); always run
# `rig.sh down` after `up`, even when `up` fails part way, so no brain, proxy or app is left behind.
set -e
REPO=${0:A:h:h:h:h}
RIG=${RIG_DIR:?set RIG_DIR to a scratch directory}
CDP=${RIG_CDP:-9470}; PIN=424242
cmd=${1:-status}; shift || true
APP_WT=$REPO; BRAIN_CLI=$REPO/apps/ade-cli/dist/cli.cjs; EXTRA_NODE_OPTIONS=""; PROFILE=wan30
while [ $# -gt 0 ]; do case $1 in
  --app-worktree) APP_WT=$2; shift 2;; --brain-cli) BRAIN_CLI=$2; shift 2;;
  --node-options) EXTRA_NODE_OPTIONS=$2; shift 2;; --profile) PROFILE=$2; shift 2;;
  *) echo "unknown option $1"; exit 2;; esac; done
mkdir -p $RIG
mb() { node $REPO/scripts/perf/net/measure-brain.mjs "$@"; }
clone() { (cd $REPO/apps/ade-cli && nice -n 10 npx tsx ../../scripts/perf/net/make-real-load-copy.mts --clone --source $1 --out $2 | tail -1 | cut -c1-200); }

reset() {
  for m in studio win mac; do rm -rf $RIG/$m-proj; done
  clone ${RIG_STUDIO_SOURCE:?} $RIG/studio-proj
  clone ${RIG_WIN_SOURCE:?} $RIG/win-proj
  clone ${RIG_LOCAL_SOURCE:?} $RIG/mac-proj
}

down() {
  if [ -f $RIG/app.pid ]; then P=$(cat $RIG/app.pid); if ps -p $P >/dev/null 2>&1; then G=$(ps -o pgid= -p $P | tr -d ' '); kill -TERM -$G 2>/dev/null || true; for i in {1..40}; do pgrep -g $G >/dev/null || break; sleep 1; done; pgrep -g $G >/dev/null && kill -KILL -$G 2>/dev/null || true; fi; rm -f $RIG/app.pid; fi
  for m in studio win; do [ -f $RIG/proxy-$m.pid ] && { kill $(cat $RIG/proxy-$m.pid) 2>/dev/null || true; rm -f $RIG/proxy-$m.pid; }; done
  for m in studio win; do mb stop --dir $RIG/$m-brain --n $m >/dev/null 2>&1 || true; done
  echo "rig down"
  installed_brain_check
}

# Read-only: did the installed brain (RIG_OWNER_LOG) log an event-loop near-miss while the rig was up?
installed_brain_check() {
  [ -f $RIG/window-start ] || return 0
  local from=$(cat $RIG/window-start) to=$(date -u +%Y-%m-%dT%H:%M:%S)
  local hits=$(awk -v f="[$from" -v t="[$to" '/event_loop_near_miss/ && $1 >= f && $1 <= t' ${RIG_OWNER_LOG:-/dev/null} 2>/dev/null | grep -o '"observedLagMs":[0-9]*' | cut -d: -f2 | tr '\n' ' ')
  echo "{\"from\":\"$from\",\"to\":\"$to\",\"installedBrainNearMissLagMs\":\"$hits\"}" | tee -a $RIG/installed-brain-check.jsonl
}

up() {
  ${RIG_MEMGATE:-true}
  date -u +%Y-%m-%dT%H:%M:%S > $RIG/window-start
  [ -f $RIG/studio-proj/.ade/real-load-copy.json ] || reset
  : > $RIG/up.json
  # Git origins decide how the desktop treats the copies ("prefer local checkout" matches by origin).
  # RIG_ORIGINS=shared (default): one origin for all three copies, like one repo checked out on every machine,
  # so the Work list merges every machine's chats and a same-repo project switch goes local by design.
  # RIG_ORIGINS=unique: a project that exists only on the other machine stays remote (cross-machine tab switch).
  for m in studio win mac; do
    if [ "${RIG_ORIGINS:-shared}" = unique ]; then o=/var/empty/ade-rig-no-origin-$m; else o=$(node -e "console.log(require(\"path\").join(require(\"os\").tmpdir(),\"ade-real-load-copy-no-origin\"))"); fi
    git -C $RIG/$m-proj remote set-url origin $o
  done
  for m in studio win; do
    mb stop --dir $RIG/$m-brain --n $m >/dev/null 2>&1 || true
    mb start --dir $RIG/$m-brain --n $m --cli $BRAIN_CLI > $RIG/$m-brain.json
    port=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).syncPort)' $RIG/$m-brain.json)
    mb cli --dir $RIG/$m-brain --n $m --cli $BRAIN_CLI --cwd $RIG/$m-proj -- projects add $RIG/$m-proj > /dev/null
    echo "{\"pin\":\"$PIN\",\"updatedAt\":\"2026-01-01T00:00:00.000Z\"}" > $RIG/$m-brain/home/.ade/secrets/sync-pin.json
    node $REPO/scripts/perf/net/slow-proxy.mjs --profile $PROFILE --listen 127.0.0.1:0 --target 127.0.0.1:$port > $RIG/proxy-$m.log 2>&1 &
    echo $! > $RIG/proxy-$m.pid
    for i in {1..20}; do grep -q listening $RIG/proxy-$m.log && break; sleep 0.3; done
    pport=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0];console.log(JSON.parse(l).listening.split(":")[1])' $RIG/proxy-$m.log)
    echo "{\"machine\":\"$m\",\"brainPort\":$port,\"proxyPort\":$pport}" >> $RIG/up.json
  done
  # The local desktop: fresh desktop home every run (the remote machines and the projects persist).
  rm -rf $RIG/mac-home $RIG/mac-userdata; mkdir -p $RIG/mac-home $RIG/mac-userdata
  cd $APP_WT
  export ADE_APP_CONTROL_DEBUG_FLAGS="--use-mock-keychain --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling"
  export ADE_HOME=$RIG/mac-home ADE_DEV_ALLOW_ALT_HOME=1 ADE_DESKTOP_USER_DATA_PATH=$RIG/mac-userdata ADE_ELECTRON_REMOTE_DEBUGGING_PORT=$CDP ADE_APP_CONTROL_CDP_PORT=$CDP
  export NODE_OPTIONS="$EXTRA_NODE_OPTIONS"
  unset ADE_PROJECT_ROOT ADE_LANE_ID ADE_CHAT_SESSION_ID ADE_PARENT_CHAT_SESSION_ID
  # Setup at low priority (it once coincided with an installed-brain freeze): the first
  # launch of a worktree builds main and warms Vite's dep cache. Do it once under nice 10, stop it,
  # then start the measured app at normal priority.
  warm=$APP_WT/node_modules/.rig-warm; [ -d $APP_WT/node_modules ] || warm=$RIG/.warm-$(echo $APP_WT | shasum | cut -c1-8)
  if [ ! -f $warm ]; then
    NO_DEVTOOLS=1 nice -n 10 node scripts/dev-detached.mjs $RIG/app-warm.log npm run dev:desktop -- --socket /tmp/ade-rig-mac.sock --project-root $RIG/mac-proj > $RIG/app.pid
    for i in {1..200}; do curl -s -m 3 http://127.0.0.1:$CDP/json/list | grep -q localhost && break; sleep 3; done
    sleep 20
    P=$(cat $RIG/app.pid); G=$(ps -o pgid= -p $P | tr -d ' '); kill -TERM -$G 2>/dev/null || true; for i in {1..40}; do pgrep -g $G >/dev/null || break; sleep 1; done
    touch $warm
  fi
  NO_DEVTOOLS=1 node scripts/dev-detached.mjs $RIG/app.log npm run dev:desktop -- --socket /tmp/ade-rig-mac.sock --project-root $RIG/mac-proj > $RIG/app.pid
  for i in {1..120}; do curl -s -m 3 http://127.0.0.1:$CDP/json/list | grep -q localhost && break; sleep 3; done
  curl -s -m 3 http://127.0.0.1:$CDP/json/list | grep -q localhost || { echo "app did not come up; see $RIG/app.log"; exit 1; }
  sleep 8
  # Pass the in-memory launch gate and skip first-run setup (P3's recipe).
  c() { CDP_PORT=$CDP node $REPO/scripts/perf/ui/cdp.mjs eval "$1"; }
  c 'window.ade.app.resolveLaunchGate().then(()=>{setTimeout(()=>location.reload(),50); return "gate"})' > /dev/null; sleep 8
  c '([...document.querySelectorAll("button,a")].find(b=>b.innerText.trim()==="Skip setup")?.click(), "skip")' > /dev/null; sleep 2
  for i in 1 2 3 4 5 6 7 8; do c '([...document.querySelectorAll("button")].find(b=>b.innerText.trim().startsWith("Next"))?.click(), "n")' >/dev/null; sleep 0.6; done
  c '([...document.querySelectorAll("button")].find(b=>/close/i.test(b.getAttribute("aria-label")||"")||/^(Done|Got it)$/.test(b.innerText.trim()))?.click(), "x")' > /dev/null
  # Pair through the app's own call with each brain's pairing link (through its proxy), turn on auto-connect, connect.
  for m in studio win; do
    pport=$(node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")){const r=JSON.parse(l); if(r.machine===process.argv[2]) console.log(r.proxyPort)}' $RIG/up.json $m)
    name=$([ $m = studio ] && echo "Rig studio" || echo "Rig win")
    url=$(mb cli --dir $RIG/$m-brain --n $m --cli $BRAIN_CLI --cwd $RIG/$m-proj -- sync status --json 2>/dev/null | (cd $REPO/apps/ade-cli && npx tsx ../../scripts/perf/net/rig-pair.mts --via 127.0.0.1:$pport --name "$name"))
    tid=$(c "window.ade.remoteRuntime.pairWithMachine({input:'$url',pin:'$PIN',deviceName:'Rig local desktop'}).then(r=>r.targetId)")
    c "window.ade.remoteRuntime.setAutoConnect('$tid',true).then(()=>window.ade.remoteRuntime.connect('$tid')).then(()=>'ok')" > /dev/null
    echo "{\"machine\":\"$m\",\"targetId\":\"$tid\"}" >> $RIG/up.json
  done
  for i in {1..60}; do n=$(c 'window.ade.remoteRuntime.getConnectionSnapshot().then(t=>t.connections.filter(c=>c.state==="connected").length)'); [ "$n" = 2 ] && break; sleep 2; done
  # Which chats live on which machine (read-only from each copy's db), plus each proxy, for rig-scenarios.mjs.
  node -e '
    const { execFileSync } = require("child_process"); const fs = require("fs"); const rig = process.argv[1];
    const ids = (proj) => execFileSync("sqlite3", ["-readonly", rig + "/" + proj + "/.ade/ade.db", "select id from terminal_sessions where tool_type like \"%chat%\""], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const m = { mac: { ids: ids("mac-proj") } };
    for (const k of ["studio", "win"]) m[k] = { ids: ids(k + "-proj"), proxyPid: Number(fs.readFileSync(rig + "/proxy-" + k + ".pid", "utf8")), proxyLog: rig + "/proxy-" + k + ".log" };
    fs.writeFileSync(rig + "/machines.json", JSON.stringify(m));
    console.log("machines:", Object.entries(m).map(([k, v]) => k + "=" + v.ids.length).join(" "));
  ' $RIG
  echo "rig up: app $(cat $RIG/app.pid) cdp $CDP; $(tr '\n' ' ' < $RIG/up.json)"
}

case $cmd in
  up) up;; down) down;; reset) reset;; installed-brain-check) installed_brain_check;;
  status) cat $RIG/up.json 2>/dev/null; ls $RIG; for f in $RIG/*-brain.json $RIG/app.pid; do [ -f $f ] && echo "$f: $(head -c 120 $f)"; done;;
  *) echo "usage: rig.sh up|down|reset|status"; exit 2;;
esac
