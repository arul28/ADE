#!/usr/bin/env bash
# One phone-sync run per heavy lock, so a long matrix never holds the machine-wide lock for an hour.
# usage: scripts/perf/net/run-phone-matrix.sh <out.jsonl> <runs> <profiles> -- <phone-sync.bench.mts options>
# Example:
#   scripts/perf/net/run-phone-matrix.sh /tmp/phone.jsonl 3 3g,lte,lan -- all --target 127.0.0.1:8788 \
#     --state /path/phone-state.json --project <id> --chat <id>
# Then: cd apps/ade-cli && npx tsx ../../scripts/perf/net/phone-sync.bench.mts summarize /tmp/phone.jsonl
set -euo pipefail
out=$1; runs=$2; profiles=$3; shift 3
[[ ${1:-} == "--" ]] && shift
here=$(cd "$(dirname "$0")" && pwd)
lock=${ADE_PERF_HEAVY_LOCK:-/tmp/t3triage/perf/heavy.lock}
IFS=, read -r -a list <<< "$profiles"
for ((run = 1; run <= runs; run++)); do
  for profile in "${list[@]}"; do
    echo "== run $run profile $profile ($(date +%H:%M:%S), load $(sysctl -n vm.loadavg 2>/dev/null || cat /proc/loadavg 2>/dev/null))"
    (cd "$here/../../../apps/ade-cli" && lockf "$lock" npx tsx ../../scripts/perf/net/phone-sync.bench.mts "$@" --profiles "$profile" --runs 1 --json "$out") \
      | grep -v '^{"scenario' || true
  done
done
