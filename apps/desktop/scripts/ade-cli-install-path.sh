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

CLI_NAME=${ADE_CLI_INSTALL_NAME:-}
if [ -z "$CLI_NAME" ] && [ -f "$SCRIPT_DIR/channel" ]; then
  CHANNEL=$(tr -d '[:space:]' < "$SCRIPT_DIR/channel")
  case "$CHANNEL" in
    alpha) CLI_NAME=ade-alpha ;;
    beta) CLI_NAME=ade-beta ;;
  esac
fi
CLI_NAME=${CLI_NAME:-ade}

ADE_BIN=${ADE_BIN:-"$SCRIPT_DIR/bin/$CLI_NAME"}
TARGET_PATH=${1:-"$HOME/.local/bin/$CLI_NAME"}
TARGET_DIR=$(dirname -- "$TARGET_PATH")

if [ ! -x "$ADE_BIN" ]; then
  echo "ade install: missing bundled CLI wrapper at $ADE_BIN" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
ln -sf "$ADE_BIN" "$TARGET_PATH"

echo "Installed $CLI_NAME -> $ADE_BIN"
echo "Ensure $TARGET_DIR is on PATH, then run: $CLI_NAME doctor"
