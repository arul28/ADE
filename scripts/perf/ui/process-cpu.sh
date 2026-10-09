#!/bin/bash
# CPU % and RSS of each ADE dev process over a window.
# usage: scripts/perf/ui/process-cpu.sh <seconds> <runtime-socket>
# Samples the dev Electron main (remote debugging port 9222), its GPU and
# renderer helpers, and the dev brain serving <runtime-socket>.
set -euo pipefail
secs=${1:?seconds}; sock=${2:?runtime socket path}
main=$(pgrep -f "Electron --remote-debugging-port=9222" | head -1)
procs="main=$main"
for p in $(pgrep -P "$main"); do
  c=$(ps -o command= -p "$p")
  case "$c" in
    *gpu-process*) procs="$procs gpu=$p" ;;
    *"--type=renderer"*) procs="$procs renderer$p=$p" ;;
  esac
done
brain=$(pgrep -f "cli.cjs serve --socket $sock" | head -1 || true)
[ -n "$brain" ] && procs="$procs brain=$brain"
cputime() { ps -o time= -p "$1" | python3 -c "import sys
s=0
for x in sys.stdin.read().strip().replace('-',':').split(':'): s=s*60+float(x)
print(s)"; }
before=""
for kv in $procs; do before="$before $(cputime "${kv#*=}")"; done
sleep "$secs"
set -- $before
for kv in $procs; do
  n=${kv%%=*}; p=${kv#*=}; was=$1; shift
  now=$(cputime "$p"); rss=$(ps -o rss= -p "$p" | tr -d ' ')
  python3 -c "print(f'$n: {($now-$was)/$secs*100:.1f}% rss={$rss//1024}MB')"
done
