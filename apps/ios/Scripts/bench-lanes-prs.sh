#!/bin/zsh
# Lanes/PRs field benchmark on the lane's simulator (see docs/perf/macos-baseline.md,
# "iOS app: Lanes and PRs"). Needs ADE running on the lane's device, paired, with
# the project open, and diagnostics on:
#   xcrun simctl spawn <udid> defaults write com.ade.ios adeScrollDiagnostics -bool YES
# Usage: bench-lanes-prs.sh <udid> <lane name> <pr number> [marks file]
# Prints a per-step summary of host commands, main-thread stalls, scroll hitches,
# body evaluations and ready times from the app's scroll-diagnostics.jsonl.
#
# Swipes and the back tap are points on a 402x874 pt screen (iPhone 17 Pro).
# Override them for another device size.
set -u
if [ $# -lt 3 ]; then
  echo "usage: $0 <udid> <lane name> <pr number> [marks file]" >&2
  exit 2
fi
UDID=$1; LANE=$2; PR=$3; OUT=${4:-$(mktemp -t ade-bench-marks)}
A="${ADE_CLI_PATH:-ade}"
SWIPE_X=${BENCH_SWIPE_X:-200}; SWIPE_TOP=${BENCH_SWIPE_TOP:-220}; SWIPE_BOTTOM=${BENCH_SWIPE_BOTTOM:-640}
BACK_X=${BENCH_BACK_X:-30}; BACK_Y=${BENCH_BACK_Y:-84}
: > "$OUT"
mark() { echo "$1 $(date +%s.%N)" >> "$OUT"; }
warn() { echo "WARN: could not tap $1" >&2; }
tap_text() { "$A" apple tap-element --text "$1" --index ${2:-0} --text >/dev/null 2>&1 || warn "$1"; }
tap_label() { "$A" apple tap-element --label "$1" --index 0 --text >/dev/null 2>&1 || warn "$1"; }
swipe() { "$A" apple swipe --from-x $SWIPE_X --from-y $1 --to-x $SWIPE_X --to-y $2 --text >/dev/null 2>&1; }
swipe_up() { for _ in $(seq $1); do swipe $SWIPE_BOTTOM $SWIPE_TOP; done; }
swipe_dn() { for _ in $(seq $1); do swipe $SWIPE_TOP $SWIPE_BOTTOM; done; }
back() { "$A" apple tap --x $BACK_X --y $BACK_Y --text >/dev/null 2>&1; }
tap_label Work; sleep 2
mark lanesTab; tap_label Lanes; sleep 3
mark lanesScroll; swipe_up 2; swipe_dn 2; sleep 1
mark laneOpenA; tap_text "$LANE"; sleep 4
mark laneScrollA; swipe_up 2; swipe_dn 2; sleep 1
mark laneBackA; back; sleep 2
mark laneOpenB; tap_text "Primary"; sleep 4
mark laneBackB; back; sleep 2
mark prsTab; tap_label PRs; sleep 3
mark prsScroll; swipe_up 3; swipe_dn 3; sleep 1
mark prsMerged; tap_text "Merged"; sleep 4
mark prsMergedScroll; swipe_up 3; swipe_dn 3; sleep 1
mark prsOpenTab; tap_text "Open"; sleep 2
mark prOpen; tap_text "Pull request $PR"; sleep 5
mark prScroll; swipe_up 3; swipe_dn 3; sleep 1
mark prChecks; tap_text "Checks"; sleep 2
mark prFiles; tap_text "Files" 1; sleep 2
mark prBack; back; sleep 2
mark end
DATA=$(xcrun simctl get_app_container "$UDID" com.ade.ios data 2>/dev/null)
if [ -z "$DATA" ] || [ ! -f "$DATA/Documents/scroll-diagnostics.jsonl" ]; then
  echo "No diagnostics log. Is ADE installed on $UDID with adeScrollDiagnostics on?" >&2
  exit 1
fi
python3 "$(dirname "$0")/bench-lanes-prs-summary.py" "$DATA/Documents/scroll-diagnostics.jsonl" "$OUT"
