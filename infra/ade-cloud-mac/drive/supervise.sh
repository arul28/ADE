#!/bin/bash
# Keeps DAEX's brain running on a DAEX Cloud Mac. Started by boot.sh as the
# NoMac service `daex` (a service is not restarted when it exits, so this loop
# is the brain's supervisor), the Mac counterpart of
# infra/ade-cloud/template/ade-entrypoint.sh.
set -u
. "$HOME/drive/.daex/env.sh"
state="$HOME/.daex-boot"
log="$ADE_HOME/logs/brain-entrypoint.log"
say() { echo "$(date -u +%FT%TZ) $*" >> "$log"; }
echo $$ > "$state/supervise.pid"

# The boot's env, kept in this process only: a brain restarted mid-sign-in may
# join again with the launch's code while the launch is still joining.
if [ -f "$state/boot.env" ]; then
  # shellcheck disable=SC1091
  . "$state/boot.env"
  rm -f "$state/boot.env"
fi
. "$HOME/drive/.daex/env.sh"

# The login keychain: NoMac makes a new one each session, with this session's
# password. Unlocked with no timeout, so git, agents and Xcode never wait on a
# prompt. It is gone at stop with everything outside ~/drive.
if [ -n "${NOMAC_MAC_PASSWORD:-}" ]; then
  keychain="$HOME/Library/Keychains/login.keychain-db"
  security unlock-keychain -p "$NOMAC_MAC_PASSWORD" "$keychain" >> "$log" 2>&1 || say "the login keychain did not unlock"
  security set-keychain-settings "$keychain" >> "$log" 2>&1 || true
fi

# Nothing of a stopped session runs now, so a sync-host lock is stale.
rm -f /tmp/ade-sync-host-*.json
mkdir -p "$ADE_HOME/sock" "$ADE_HOME/logs"
# `ade brain update` stops the brain and lets this loop start the new one
# (serviceManager/entrypointSupervisor.ts).
export ADE_BRAIN_SUPERVISOR=entrypoint

# ADE_MIN_VERSION: the channel's release (the `mac_min_version_<channel>`
# setting). A drive with an older DAEX installs it before its brain starts.
if [ -n "${ADE_MIN_VERSION:-}" ] && [ "$(daex_newest "$daex_running_version" "$ADE_MIN_VERSION")" != "$daex_running_version" ]; then
  say "installing DAEX $ADE_MIN_VERSION (this drive has ${daex_running_version:-none})"
  "$daex_bin" brain update --version "$ADE_MIN_VERSION" --no-restart --foreground >> "$log" 2>&1 \
    || say "installing DAEX $ADE_MIN_VERSION failed; starting ${daex_running_version:-the template's DAEX}"
fi
if [ -x "$daex_home_ade" ] && [ ! -e "$ADE_HOME/bin/daex" ] && [ ! -L "$ADE_HOME/bin/daex" ]; then
  ln -s ade "$ADE_HOME/bin/daex" 2>/dev/null || true
fi
[ -n "${ADE_LAUNCH_ID:-}" ] && say "server launch $ADE_LAUNCH_ID"

base_path=$PATH
delay=2
while true; do
  # A move holds the brain while its files are copied; a pause older than two
  # hours is one whose desktop quit mid-move.
  while [ -f "$ADE_HOME/brain.paused" ]; do
    find "$ADE_HOME/brain.paused" -mmin +120 -delete 2>/dev/null
    sleep 5
  done
  start=$(date +%s)
  mkdir -p "$ADE_HOME/logs"
  daex_pick
  say "starting the brain: $daex_bin ($daex_running_version)"
  PATH="${daex_bin%/ade}:$base_path" ADE_RUNTIME_ROOT="$daex_runtime" \
    ADE_RUNTIME_NODE_MODULES="$daex_runtime/node_modules" NODE_PATH="$daex_runtime/node_modules" \
    "$daex_bin" --role cto serve --socket "$ADE_HOME/sock/ade.sock" >> "$log" 2>&1
  if [ $(( $(date +%s) - start )) -gt 60 ]; then
    delay=2
  else
    delay=$(( delay < 60 ? delay * 2 : 60 ))
  fi
  say "brain exited; restarting in ${delay}s"
  sleep "$delay"
done
