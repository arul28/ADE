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

# The user's home as the CLI reads it: on Windows that is USERPROFILE, which
# Git Bash's $HOME need not match (the .cmd uses %USERPROFILE% too).
USER_HOME=$HOME
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    if [ -n "${USERPROFILE:-}" ]; then USER_HOME=$(cygpath -u "$USERPROFILE" 2>/dev/null || printf '%s' "$USERPROFILE"); fi
    ;;
esac

case "$CLI_NAME:$CHANNEL" in
  ade-alpha:*|ade:alpha)
    export ADE_PACKAGE_CHANNEL=${ADE_PACKAGE_CHANNEL:-alpha}
    export ADE_HOME=${ADE_HOME:-"$USER_HOME/.ade-alpha"}
    export ADE_DESKTOP_APP_NAME=${ADE_DESKTOP_APP_NAME:-"ADE Alpha"}
    ;;
  ade-beta:*|ade:beta)
    export ADE_PACKAGE_CHANNEL=${ADE_PACKAGE_CHANNEL:-beta}
    export ADE_HOME=${ADE_HOME:-"$USER_HOME/.ade-beta"}
    export ADE_DESKTOP_APP_NAME=${ADE_DESKTOP_APP_NAME:-"ADE Beta"}
    ;;
esac

# Node's compile cache stops the ~19 MB cli.cjs bundle from being re-parsed on every launch.
# Node ignores a cache directory it cannot use, so a bad path only loses the speedup.
# An explicit NODE_COMPILE_CACHE or NODE_DISABLE_COMPILE_CACHE from the caller wins.
if [ -z "${NODE_COMPILE_CACHE:-}" ] && [ -z "${NODE_DISABLE_COMPILE_CACHE:-}" ]; then
  export NODE_COMPILE_CACHE="${ADE_HOME:-$USER_HOME/.ade}/cache/node-compile"
fi

case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    # Git Bash on Windows. This file ships in the Windows package too, as
    # resources/ade-cli/bin/ade, and the PATH installer puts an `ade` next to
    # `ade.cmd` that runs it. `ade.cmd` goes through cmd.exe, which ends an
    # argument at its first line break; here "$@" reaches the CLI whole. The
    # defaults match ade-cli-windows-wrapper.cmd. Paths go to Windows programs
    # in the C:/x form, which they read and Git Bash leaves alone.
    winpath() { cygpath -m "$1" 2>/dev/null || printf '%s' "$1"; }
    RESOURCES_DIR=$(CDPATH= cd -P -- "$SCRIPT_DIR/../.." && pwd)
    BUNDLED_CHANNEL=
    if [ -f "$SCRIPT_DIR/../channel" ]; then
      BUNDLED_CHANNEL=$(tr -d '[:space:]' < "$SCRIPT_DIR/../channel")
    fi
    case "$BUNDLED_CHANNEL" in
      beta) APP_EXE="$RESOURCES_DIR/../ADE Beta.exe" ;;
      alpha) APP_EXE="$RESOURCES_DIR/../ADE Alpha.exe" ;;
      *) APP_EXE="$RESOURCES_DIR/../ADE.exe" ;;
    esac
    # The homes above are spelled the Git Bash way; Windows programs need the
    # drive form.
    if [ -n "${ADE_HOME:-}" ]; then ADE_HOME=$(winpath "$ADE_HOME"); export ADE_HOME; fi
    if [ -n "${NODE_COMPILE_CACHE:-}" ]; then NODE_COMPILE_CACHE=$(winpath "$NODE_COMPILE_CACHE"); export NODE_COMPILE_CACHE; fi
    if [ -z "${ADE_AGENT_SKILLS_DIRS:-}" ] && [ -d "$RESOURCES_DIR/agent-skills" ]; then
      ADE_AGENT_SKILLS_DIRS=$(winpath "$RESOURCES_DIR/agent-skills")
      export ADE_AGENT_SKILLS_DIRS
    fi
    CLI_JS=$(winpath "$CLI_JS")
    NODE_PATH_VALUE="$(winpath "$RESOURCES_DIR/app.asar.unpacked/node_modules");$(winpath "$RESOURCES_DIR/app.asar/node_modules")"
    if [ -n "${NODE_PATH:-}" ]; then
      NODE_PATH_VALUE="$NODE_PATH_VALUE;$NODE_PATH"
    fi
    if [ -n "${ADE_CLI_NODE:-}" ]; then
      # A Windows environment sets this in its own spelling (C:\Program Files\…);
      # cygpath turns either form into one this shell can run. A bare `node`
      # stays a name for PATH to resolve.
      case "$ADE_CLI_NODE" in
        */*|*\\*|*:*) ADE_CLI_NODE=$(winpath "$ADE_CLI_NODE") ;;
      esac
      NODE_PATH="$NODE_PATH_VALUE" exec "$ADE_CLI_NODE" "$CLI_JS" "$@"
    fi
    node_is_22() {
      command -v node >/dev/null 2>&1 || return 1
      [ "$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)" -ge 22 ]
    }
    if [ -f "$APP_EXE" ]; then
      ELECTRON_RUN_AS_NODE=1 NODE_PATH="$NODE_PATH_VALUE" exec "$APP_EXE" "$CLI_JS" "$@"
    fi
    if node_is_22; then
      NODE_PATH="$NODE_PATH_VALUE" exec node "$CLI_JS" "$@"
    fi
    echo "ade: Node.js 22+ or the packaged ADE.exe runtime is required to run this CLI." >&2
    exit 127
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
