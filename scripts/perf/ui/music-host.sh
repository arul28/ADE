#!/bin/bash
# CPU % and memory of the macOS Apple Music player host over a window.
# usage: scripts/perf/ui/music-host.sh <seconds>
# Samples `ade-music-host` and the WebKit processes it started (WebContent,
# Networking, GPU). Those are XPC services whose parent is launchd, so they
# are matched by start time: launched within 3 s after the host, with a
# higher pid. Prints CPU %, RSS and the physical footprint (what Activity
# Monitor calls Memory; RSS double-counts shared framework pages).
set -euo pipefail
secs=${1:?seconds}
host=$(pgrep -f "/ade-music-host --udf" | head -1 || true)
if [ -z "$host" ]; then echo "no ade-music-host running"; exit 1; fi
epoch() { date -j -f "%a %b %d %T %Y" "$(ps -o lstart= -p "$1" | xargs)" +%s; }
hstart=$(epoch "$host")
procs="host=$host"
for p in $(pgrep -f "com.apple.WebKit\.(WebContent|Networking|GPU)"); do
  [ "$p" -gt "$host" ] || continue
  s=$(epoch "$p")
  [ $((s - hstart)) -ge 0 ] && [ $((s - hstart)) -le 3 ] || continue
  c=$(ps -o comm= -p "$p")
  procs="$procs ${c##*.}=$p"
done
# CPU seconds of a pid, or nothing when it has exited (WebKit may end one).
cputime() { ps -o time= -p "$1" 2>/dev/null | python3 -c "import sys
t=sys.stdin.read().strip()
if t:
  s=0
  for x in t.replace('-',':').split(':'): s=s*60+float(x)
  print(s)"; }
before=""
for kv in $procs; do v=$(cputime "${kv#*=}" || true); before="$before ${v:--}"; done
sleep "$secs"
set -- $before
tcpu=0; trss=0; tfoot=0
for kv in $procs; do
  n=${kv%%=*}; p=${kv#*=}; was=$1; shift
  [ "$was" = "-" ] && { echo "$n ($p): exited before the sample, skipped"; continue; }
  now=$(cputime "$p" || true); rss=$(ps -o rss= -p "$p" 2>/dev/null | tr -d ' ' || true)
  if [ -z "$now" ] || [ -z "$rss" ]; then echo "$n ($p): exited during the sample, skipped"; continue; fi
  rss=$(( rss / 1024 ))
  foot=$(footprint -p "$p" 2>/dev/null | python3 -c "import re,sys
m=re.search(r'Footprint: ([0-9.]+) (KB|MB|GB)', sys.stdin.read())
print(0 if not m else round(float(m[1])*{'KB':1/1024,'MB':1,'GB':1024}[m[2]],1))")
  cpu=$(python3 -c "print(f'{($now-$was)/$secs*100:.1f}')")
  echo "$n ($p): ${cpu}% rss=${rss}MB footprint=${foot}MB"
  tcpu=$(python3 -c "print($tcpu+$cpu)"); trss=$((trss + rss)); tfoot=$(python3 -c "print($tfoot+$foot)")
done
echo "total: $(python3 -c "print(f'{$tcpu:.1f}')")% rss=${trss}MB footprint=${tfoot}MB"
