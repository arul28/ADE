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
CLI_NAME=$(basename -- "$SOURCE")
CHANNEL=${ADE_PACKAGE_CHANNEL:-}
if [ -z "$CHANNEL" ] && [ -f "$SCRIPT_DIR/../channel" ]; then
  CHANNEL=$(tr -d '[:space:]' < "$SCRIPT_DIR/../channel")
fi

case "$CLI_NAME:$CHANNEL" in
  ade-alpha:*|ade:alpha)
    export ADE_PACKAGE_CHANNEL=${ADE_PACKAGE_CHANNEL:-alpha}
    export ADE_HOME=${ADE_HOME:-"$HOME/.ade-alpha"}
    export ADE_DESKTOP_APP_NAME=${ADE_DESKTOP_APP_NAME:-"ADE Alpha"}
    export ADE_DISABLE_RUNTIME_SERVICE_INSTALL=${ADE_DISABLE_RUNTIME_SERVICE_INSTALL:-1}
    ;;
  ade-beta:*|ade:beta)
    export ADE_PACKAGE_CHANNEL=${ADE_PACKAGE_CHANNEL:-beta}
    export ADE_HOME=${ADE_HOME:-"$HOME/.ade-beta"}
    export ADE_DESKTOP_APP_NAME=${ADE_DESKTOP_APP_NAME:-"ADE Beta"}
    export ADE_DISABLE_RUNTIME_SERVICE_INSTALL=${ADE_DISABLE_RUNTIME_SERVICE_INSTALL:-1}
    ;;
esac

if [ -n "${ADE_CLI_NODE:-}" ]; then
  exec "$ADE_CLI_NODE" "$CLI_JS" "$@"
fi

CONTENTS_DIR=$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd || true)
APP_EXE="$CONTENTS_DIR/MacOS/ADE"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

if [ -z "${ADE_AGENT_SKILLS_DIRS:-}" ] && [ -d "$RESOURCES_DIR/agent-skills" ]; then
  export ADE_AGENT_SKILLS_DIRS="$RESOURCES_DIR/agent-skills"
fi

if [ ! -x "$APP_EXE" ] && [ -d "$CONTENTS_DIR/MacOS" ]; then
  for CANDIDATE in "$CONTENTS_DIR"/MacOS/*; do
    if [ -x "$CANDIDATE" ] && [ ! -d "$CANDIDATE" ]; then
      APP_EXE=$CANDIDATE
      break
    fi
  done
fi

if [ -x "$APP_EXE" ]; then
  ARCH_NAME=$(uname -m)
  case "$ARCH_NAME" in
    arm64) ARCH_ASAR="app-arm64.asar" ;;
    *) ARCH_ASAR="app-x64.asar" ;;
  esac
  NODE_PATH_VALUE="$RESOURCES_DIR/$ARCH_ASAR.unpacked/node_modules:$RESOURCES_DIR/app.asar.unpacked/node_modules:$RESOURCES_DIR/$ARCH_ASAR/node_modules:$RESOURCES_DIR/app.asar/node_modules"
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
