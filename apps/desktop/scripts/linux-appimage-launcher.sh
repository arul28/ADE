#!/usr/bin/env bash
set -euo pipefail
binary="$(dirname -- "$(readlink -f -- "$0")")/$(basename -- "$0").bin"
args=()
for arg in "$@"; do
  # electron-builder's AppRun may inject this flag without the user's consent.
  [[ "$arg" == --no-sandbox ]] || args+=("$arg")
done
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
  exec "$binary" "$resources/ade-cli/cli.cjs" "${args[@]}"
fi
if [[ "${ELECTRON_RUN_AS_NODE:-}" == 1 ]]; then
  exec "$binary" "${args[@]}"
fi
if [[ "${ADE_ALLOW_NO_SANDBOX:-}" == 1 ]]; then
  echo 'ADE: Chromium sandbox disabled by ADE_ALLOW_NO_SANDBOX=1.' >&2
  exec "$binary" --no-sandbox "${args[@]}"
fi
# An AppArmor profile may grant user namespaces to the packaged executable even
# when the generic unshare program is blocked. Check for our loaded profile.
profile_loaded=0
if [[ -r /sys/kernel/security/apparmor/profiles ]] && grep -q '^ade-appimage ' /sys/kernel/security/apparmor/profiles; then
  profile_loaded=1
elif [[ ! -r /sys/kernel/security/apparmor/profiles && -r /etc/apparmor.d/ade-appimage ]]; then
  # Some systems restrict the loaded-profile list to root. Try Chromium with
  # its sandbox on when an administrator installed the profile; if it is not
  # loaded Chromium still refuses to start rather than silently dropping it.
  profile_loaded=1
fi
if ! unshare -Ur true 2>/dev/null && [[ "$profile_loaded" != 1 ]]; then
  message='ADE cannot start the Chromium sandbox on this system. Install the ADE .deb, which configures AppArmor, or install and load /etc/apparmor.d/ade-appimage containing this one-line profile:
abi <abi/4.0>, profile ade-appimage /tmp/.mount_ADE*/ade-desktop*.bin flags=(unconfined) { userns, }
Load it with sudo apparmor_parser -r /etc/apparmor.d/ade-appimage. To accept the risk and run without the sandbox, set ADE_ALLOW_NO_SANDBOX=1.'
  echo "ADE: $message" >&2
  if command -v zenity >/dev/null 2>&1; then zenity --error --text="$message" || true
  elif command -v kdialog >/dev/null 2>&1; then kdialog --error "$message" || true
  elif command -v xmessage >/dev/null 2>&1; then xmessage "$message" || true
  fi
  exit 1
fi
exec "$binary" "${args[@]}"
