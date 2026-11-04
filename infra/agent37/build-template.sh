#!/bin/sh
# Build ADE's Agent37 machine template with Agent37's cloud build and publish
# it to the workspace the key belongs to.
#
#   AGENT37_API_KEY=sk_live_... infra/agent37/build-template.sh [name] [ade-version]
#
# name         template name; default "ade" (what ADE creates boxes from).
#              Use something like "ade-a1-test" for a trial build.
# ade-version  the ADE release baked in; default "latest".
#
# Building an existing name publishes a new revision. Boxes already made from
# the template keep their image until they are updated.
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
context="$(mktemp -d "${TMPDIR:-/tmp}/ade-agent37-template.XXXXXX")"
trap 'rm -rf "$context"' EXIT INT TERM
cp "$here/template/Dockerfile" "$here/template/ade-entrypoint.sh" "$context/"
if [ "$ade_version" != "latest" ]; then
  # A pinned release goes in as the Dockerfile's default, so the cloud build
  # needs no build-arg support.
  sed "s/^ARG ADE_VERSION=latest$/ARG ADE_VERSION=$ade_version/" "$here/template/Dockerfile" > "$context/Dockerfile"
fi

echo "Building Agent37 template \"$name\" (ADE $ade_version)…" >&2
npx --yes agent37 templates build "$context" --name "$name"
