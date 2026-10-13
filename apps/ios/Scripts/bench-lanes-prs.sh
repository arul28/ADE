#!/bin/zsh
# Lanes/PRs field benchmark on the lane's simulator (see docs/perf/macos-baseline.md,
# "iOS Lanes and PRs"). Needs ADE running on the lane's device, paired, with the
# project open, and diagnostics on:
#   xcrun simctl spawn <udid> defaults write com.ade.ios adeScrollDiagnostics -bool YES
# Usage: bench-lanes-prs.sh <udid> <lane name> <pr number> [marks file]
# Prints a per-step summary of host commands, main-thread stalls, scroll hitches,
# body evaluations and ready times from the app's scroll-diagnostics.jsonl.
set -u
UDID=$1; LANE=$2; PR=$3; OUT=${4:-$(mktemp -t ade-bench-marks)}
A="${ADE_CLI_PATH:-ade}"
: > "$OUT"
mark() { python3 -c 'import time;print(time.time())' | sed "s/^/$1 /" >> "$OUT"; }
tap_text() { "$A" apple tap-element --text "$1" --index ${2:-0} --text >/dev/null 2>&1 || echo "WARN tap $1" >&2; }
tap_label() { "$A" apple tap-element --label "$1" --index 0 --text >/dev/null 2>&1 || echo "WARN tap $1" >&2; }
swipe_up() { for _ in $(seq $1); do "$A" apple swipe --from-x 200 --from-y 640 --to-x 200 --to-y 220 --text >/dev/null 2>&1; done; }
swipe_dn() { for _ in $(seq $1); do "$A" apple swipe --from-x 200 --from-y 220 --to-x 200 --to-y 640 --text >/dev/null 2>&1; done; }
back() { "$A" apple tap --x 30 --y 84 --text >/dev/null 2>&1; }
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
DATA=$(xcrun simctl get_app_container "$UDID" com.ade.ios data)
python3 "$(dirname "$0")/bench-lanes-prs-summary.py" "$DATA/Documents/scroll-diagnostics.jsonl" "$OUT"
