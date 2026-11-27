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

# `daex` is the command's name now and `ade` stays as an alias: the same
# command goes in under both names, side by side (`ade` and `daex`,
# `ade-alpha` and `daex-alpha`). A target not named ade or ade-<channel> gets
# no second name.
TARGET_NAME=$(basename -- "$TARGET_PATH")
case "$TARGET_NAME" in
  ade) ALIAS_PATH="$TARGET_DIR/daex" ;;
  ade-*) ALIAS_PATH="$TARGET_DIR/daex${TARGET_NAME#ade}" ;;
  *) ALIAS_PATH="" ;;
esac

if [ "$(uname -s 2>/dev/null || echo unknown)" = Linux ] && [ -n "${APPIMAGE:-}" ] && [ -f "$APPIMAGE" ]; then
  # A symlink into an AppImage mount dies when the app exits. Keep a shim to
  # the image itself instead; its launcher resolves the mounted CLI at runtime.
  quoted_image=$(printf '%s' "$APPIMAGE" | sed "s/'/'\\\\''/g")
  write_appimage_shim() {
    shim=$(mktemp "$TARGET_DIR/.ade-cli.XXXXXXXX")
    trap 'rm -f "$shim"' EXIT HUP INT TERM
    printf "#!/bin/sh\nexport ADE_APPIMAGE_CLI=1 ELECTRON_RUN_AS_NODE=1\nexec '%s' \"\$@\"\n" "$quoted_image" > "$shim"
    chmod 755 "$shim"
    mv -f "$shim" "$1"
    trap - EXIT HUP INT TERM
  }
  write_appimage_shim "$TARGET_PATH"
  if [ -n "$ALIAS_PATH" ]; then write_appimage_shim "$ALIAS_PATH"; fi
  installed_source=$APPIMAGE
else
  ln -sf "$ADE_BIN" "$TARGET_PATH"
  # Both names link to the same wrapper, so the wrapper sees one name and one
  # channel whichever was typed.
  if [ -n "$ALIAS_PATH" ]; then ln -sf "$ADE_BIN" "$ALIAS_PATH"; fi
  installed_source=$ADE_BIN
fi

echo "Installed $CLI_NAME -> $installed_source"
DOCTOR_NAME=$CLI_NAME
if [ -n "$ALIAS_PATH" ]; then
  DOCTOR_NAME=$(basename -- "$ALIAS_PATH")
  echo "Installed $DOCTOR_NAME -> $installed_source"
fi
echo "Ensure $TARGET_DIR is on PATH, then run: $DOCTOR_NAME doctor"
