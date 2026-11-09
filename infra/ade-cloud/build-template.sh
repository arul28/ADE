#!/bin/sh
# Build ADE's cloud machine template with the provider's cloud build and publish
# it to the workspace the key belongs to.
#
#   AGENT37_API_KEY=sk_live_... infra/ade-cloud/build-template.sh [name] [ade-version]
#
# name         template name; default "ade" (what ADE creates boxes from).
#              Use something like "ade-a1-test" for a trial build.
# ade-version  the ADE release baked in; default "latest".
#
# Building an existing name publishes a new revision, its build number. The
# last line printed is `name@N`. Boxes already made from the template keep
# their image until they are updated.
set -eu

name="${1:-ade}"
ade_version="${2:-latest}"
# install.sh takes the release tag ("v1.2.128"); accept "1.2.128" too.
case "$ade_version" in latest|v*) ;; *) ade_version="v$ade_version" ;; esac
here="$(cd "$(dirname "$0")" && pwd)"

if [ -z "${AGENT37_API_KEY:-}" ]; then
  echo "build-template: set AGENT37_API_KEY to the workspace's sk_live_ key." >&2
  exit 1
fi
command -v npx >/dev/null 2>&1 || { echo "build-template: needs Node's npx." >&2; exit 1; }

# The build context is the template folder only: Dockerfile + entrypoint.
# Copy it so a stray file next to them never ships in the image.
work="$(mktemp -d "${TMPDIR:-/tmp}/ade-cloud-template.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM
context="$work/context"
mkdir "$context"
cp "$here/template/Dockerfile" "$here/template/ade-entrypoint.sh" "$context/"
if [ "$ade_version" != "latest" ]; then
  # A pinned release goes in as the Dockerfile's default, so the cloud build
  # needs no build-arg support.
  sed "s/^ARG ADE_VERSION=latest$/ARG ADE_VERSION=$ade_version/" "$here/template/Dockerfile" > "$context/Dockerfile"
fi

echo "Building ADE Cloud template \"$name\" (ADE $ade_version)…" >&2
# The provider's own build log goes straight through; only the build number is
# read from it. Its CLI version is pinned because this runs with the key in CI.
{ npx --yes agent37@0.4.1 templates build "$context" --name "$name" 2>&1; echo $? > "$work/status"; } \
  | tee "$work/build.log"
status="$(cat "$work/status")"
[ "$status" = 0 ] || exit "$status"
revision="$(sed -n 's/^Revision: *\([0-9][0-9]*\)$/\1/p' "$work/build.log" | tail -n 1)"
if [ -z "$revision" ]; then
  echo "build-template: the build finished but printed no build number." >&2
  exit 1
fi
echo "$name@$revision"
