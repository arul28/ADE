#!/usr/bin/env bash
# The second place a release finds its cached native builds: the workflow
# artifact warm-release-caches.yml uploads beside each cache entry.
#
# The repository's Actions cache is 10 GB in all and drops the least recently
# used entry first. The native builds are a few MB, but a release reads them
# only a few times a day, so the big CI caches pushed them out within hours and
# every release compiled them again. An artifact does not share that space.
#
# This runs only when the cache missed. It looks for the newest successful
# warm-release-caches.yml run on main whose artifact has exactly this name (the
# cache key, from .github/actions/release-cache-keys), downloads it, and puts
# each file at its path. It proves nothing about the files:
# verify-cached-release-builds.sh runs next, unchanged, and deletes any file
# without the warm workflow's attestation. Any failure here leaves the paths
# empty, so the build compiles from source, as on any cache miss.
#
#   scripts/fetch-warm-release-build.sh <artifact-name> <path>...
# <path>s are relative to the current directory (the checkout root), exactly as
# the warm workflow packed them. Always exits 0.
set -uo pipefail

name="${1:?usage: fetch-warm-release-build.sh <artifact-name> <path>...}"
shift
[ "$#" -gt 0 ] || { echo "usage: fetch-warm-release-build.sh <artifact-name> <path>..." >&2; exit 0; }
paths=("$@")

workflow_path=".github/workflows/warm-release-caches.yml"
download_dir=""

# shellcheck disable=SC2329 # run by the EXIT trap
cleanup() { if [ -n "$download_dir" ]; then rm -rf "$download_dir"; fi; }
trap cleanup EXIT

# Every failure ends here: no partial set of files is ever left behind.
give_up() {
  echo "::warning::No usable $name artifact from $workflow_path ($1); building from source."
  rm -f "${paths[@]}"
  exit 0
}

all_present=1
for file in "${paths[@]}"; do
  [ -f "$file" ] || all_present=0
done
if [ "$all_present" = 1 ]; then
  echo "The cache restored every file for $name; no artifact needed."
  exit 0
fi
rm -f "${paths[@]}"

[ -n "${GH_TOKEN:-}" ] || give_up "GH_TOKEN is not set"
[ -n "${GITHUB_REPOSITORY:-}" ] || give_up "GITHUB_REPOSITORY is not set"
# The name goes into a URL and a file name.
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || give_up "the artifact name has unexpected characters"
for file in "${paths[@]}"; do
  case "$file" in
    /* | *..* | *\\*) give_up "the path $file is not a plain relative path" ;;
  esac
done

# Newest first, unexpired, from a run on main. The run is checked below.
if ! candidates="$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=$name&per_page=30" \
    --jq '[.artifacts[] | select(.expired == false and .workflow_run.head_branch == "main")]
          | sort_by(.created_at) | reverse | .[].workflow_run.id' 2>&1)"; then
  give_up "the artifact lookup failed: ${candidates//$'\n'/ }"
fi

run_id=""
checked=0
for candidate in $candidates; do
  [[ "$candidate" =~ ^[0-9]+$ ]] || continue
  checked=$((checked + 1))
  [ "$checked" -le 5 ] || break
  # Only a finished, successful run of the warm workflow itself, on main.
  if run="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$candidate" \
      --jq '"\(.path)|\(.head_branch)|\(.status)|\(.conclusion)"' 2>/dev/null)" \
      && [ "$run" = "$workflow_path|main|completed|success" ]; then
    run_id="$candidate"
    break
  fi
done
[ -n "$run_id" ] || give_up "no successful run on main has one"

# Relative to the checkout, so no Windows drive path reaches gh or tar.
download_dir="$(mktemp -d .warm-release-build.XXXXXX)" || give_up "no temporary directory"
if ! out="$(gh run download "$run_id" --repo "$GITHUB_REPOSITORY" --name "$name" --dir "$download_dir" 2>&1)"; then
  give_up "downloading it from run $run_id failed: ${out//$'\n'/ }"
fi
tarball="$download_dir/$name.tar"
[ -f "$tarball" ] || give_up "run $run_id's artifact holds no $name.tar"

# The archive must hold exactly these paths: nothing else, nothing elsewhere.
# tar reads it from stdin: GNU tar on Windows takes "D:" in a file name for a
# remote host.
listing="$(tar -tf - < "$tarball" 2>/dev/null)" || give_up "run $run_id's archive is unreadable"
expected="$(printf '%s\n' "${paths[@]}" | LC_ALL=C sort)"
actual="$(printf '%s\n' "$listing" | LC_ALL=C sort)"
[ "$expected" = "$actual" ] || give_up "run $run_id's archive does not hold exactly the expected files"

tar -xf - "${paths[@]}" < "$tarball" || give_up "unpacking run $run_id's archive failed"
for file in "${paths[@]}"; do
  if [ ! -f "$file" ] || [ -L "$file" ]; then
    give_up "run $run_id's archive did not unpack $file as a regular file"
  fi
done
echo "Fetched ${#paths[@]} file(s) for $name from run $run_id of $workflow_path; verifying next."
exit 0
