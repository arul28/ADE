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
CLI_JS=${ADE_CLI_JS:-"$SCRIPT_DIR/../cli.cjs"}

if [ -n "${ADE_CLI_NODE:-}" ]; then
  exec "$ADE_CLI_NODE" "$CLI_JS" "$@"
fi

CONTENTS_DIR=$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd || true)
APP_EXE="$CONTENTS_DIR/MacOS/ADE"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

if [ ! -x "$APP_EXE" ] && [ -d "$CONTENTS_DIR/MacOS" ]; then
  for CANDIDATE in "$CONTENTS_DIR"/MacOS/*; do
    if [ -x "$CANDIDATE" ] && [ ! -d "$CANDIDATE" ]; then
      APP_EXE=$CANDIDATE
      break
    fi
  done
fi

if [ -x "$APP_EXE" ]; then
  NODE_PATH_VALUE="$RESOURCES_DIR/app.asar.unpacked/node_modules:$RESOURCES_DIR/app.asar/node_modules"
  if [ -n "${NODE_PATH:-}" ]; then
    NODE_PATH_VALUE="$NODE_PATH_VALUE:$NODE_PATH"
  fi
  ELECTRON_RUN_AS_NODE=1 NODE_PATH="$NODE_PATH_VALUE" exec "$APP_EXE" "$CLI_JS" "$@"
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
  if [ "$NODE_MAJOR" -ge 22 ]; then
    exec node "$CLI_JS" "$@"
  fi
fi

echo "ade: Node.js 22+ or the packaged ADE.app runtime is required to run this CLI." >&2
exit 127
