#!/usr/bin/env bash
set -euo pipefail
binary="$(dirname -- "$(readlink -f -- "$0")")/$(basename -- "$0").bin"
# The persistent AppImage CLI shim enters here after the image is mounted.
if [[ "${ADE_APPIMAGE_CLI:-}" == 1 ]]; then
  resources="$(dirname -- "$binary")/resources"
  if [[ -f "$resources/ade-cli/channel" ]]; then
    channel=$(tr -d '[:space:]' < "$resources/ade-cli/channel")
    if [[ "$channel" == alpha || "$channel" == beta ]]; then
      export ADE_PACKAGE_CHANNEL="${ADE_PACKAGE_CHANNEL:-$channel}"
      export ADE_HOME="${ADE_HOME:-$HOME/.ade-$channel}"
      if [[ "$channel" == alpha ]]; then channel_label=Alpha; else channel_label=Beta; fi
      export ADE_DESKTOP_APP_NAME="${ADE_DESKTOP_APP_NAME:-ADE $channel_label}"
    fi
  fi
  export ELECTRON_RUN_AS_NODE=1
  export NODE_PATH="$resources/app.asar.unpacked/node_modules:$resources/app.asar/node_modules${NODE_PATH:+:$NODE_PATH}"
  export ADE_AGENT_SKILLS_DIRS="${ADE_AGENT_SKILLS_DIRS:-$resources/agent-skills}"
  exec "$binary" "$resources/ade-cli/cli.cjs" "$@"
fi
if [[ "${ELECTRON_RUN_AS_NODE:-}" == 1 ]]; then
  exec "$binary" "$@"
fi
args=()
for arg in "$@"; do
  # electron-builder's AppRun may inject this flag without the user's consent.
  [[ "$arg" == --no-sandbox ]] || args+=("$arg")
done
if [[ "${ADE_ALLOW_NO_SANDBOX:-}" == 1 ]]; then
  echo 'ADE: Chromium sandbox disabled by ADE_ALLOW_NO_SANDBOX=1.' >&2
  exec "$binary" --no-sandbox "${args[@]}"
fi
if ! unshare -Ur true 2>/dev/null; then
  # No AppArmor profile is offered for the AppImage: it can only match a path
  # under /tmp, which any local user could create to get the same exception.
  message='ADE cannot start its security sandbox on this system, which blocks the user namespaces an AppImage needs. Install the ADE .deb, which sets this up correctly. To accept the risk and run without the sandbox, start ADE with ADE_ALLOW_NO_SANDBOX=1.'
  echo "ADE: $message" >&2
  if command -v zenity >/dev/null 2>&1; then zenity --error --text="$message" || true
  elif command -v kdialog >/dev/null 2>&1; then kdialog --error "$message" || true
  elif command -v xmessage >/dev/null 2>&1; then xmessage "$message" || true
  fi
  exit 1
fi
exec "$binary" "${args[@]}"
