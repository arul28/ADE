#!/bin/sh
set -eu

SOURCE=$0
while [ -L "$SOURCE" ]; do
  SOURCE_DIR=$(CDPATH= cd -P -- "$(dirname -- "$SOURCE")" && pwd)
  TARGET=$(readlink "$SOURCE")
  case "$TARGET" in
    /*) SOURCE=$TARGET ;;
    *) SOURCE=$SOURCE_DIR/$TARGET ;;
  esac
done

SCRIPT_DIR=$(CDPATH= cd -P -- "$(dirname -- "$SOURCE")" && pwd)
ADE_BIN=${ADE_BIN:-"$SCRIPT_DIR/bin/ade"}
TARGET_PATH=${1:-"$HOME/.local/bin/ade"}
TARGET_DIR=$(dirname -- "$TARGET_PATH")

if [ ! -x "$ADE_BIN" ]; then
  echo "ade install: missing bundled CLI wrapper at $ADE_BIN" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
ln -sf "$ADE_BIN" "$TARGET_PATH"

echo "Installed ade -> $ADE_BIN"
echo "Ensure $TARGET_DIR is on PATH, then run: ade doctor"
