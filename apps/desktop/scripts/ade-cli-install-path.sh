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
if [ "$(uname -s 2>/dev/null || echo unknown)" = Linux ] && [ -n "${APPIMAGE:-}" ] && [ -f "$APPIMAGE" ]; then
  # A symlink into an AppImage mount dies when the app exits. Keep a shim to
  # the image itself instead; its launcher resolves the mounted CLI at runtime.
  quoted_image=$(printf '%s' "$APPIMAGE" | sed "s/'/'\\\\''/g")
  shim=$(mktemp "$TARGET_DIR/.ade-cli.XXXXXXXX")
  trap 'rm -f "$shim"' EXIT HUP INT TERM
  printf "#!/bin/sh\nexport ADE_APPIMAGE_CLI=1 ELECTRON_RUN_AS_NODE=1\nexec '%s' \"\$@\"\n" "$quoted_image" > "$shim"
  chmod 755 "$shim"
  mv -f "$shim" "$TARGET_PATH"
  trap - EXIT HUP INT TERM
  installed_source=$APPIMAGE
else
  ln -sf "$ADE_BIN" "$TARGET_PATH"
  installed_source=$ADE_BIN
fi

echo "Installed $CLI_NAME -> $installed_source"
echo "Ensure $TARGET_DIR is on PATH, then run: $CLI_NAME doctor"
