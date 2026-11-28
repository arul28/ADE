#!/bin/bash
# The boot job: what the account server runs once on each new session of a
# DAEX Cloud Mac (`bootMac`, apps/account-directory/src/cloud/macProvider.ts),
# with the brain's env (ADE_HOST_INSTANCE_ID, ADE_CLOUD_INSTANCE_ID, and for a
# first boot ADE_LAUNCH_ID and its ADE_LAUNCH_JOIN code; ADE_MIN_VERSION and
# ADE_ACCOUNT_DIRECTORY_URL when set).
#
# A NoMac command ends together with everything it started, so the brain runs
# as a NoMac service (`nomac-service`), supervised by supervise.sh, and this job
# returns within seconds. Its exit code is the boot's result: non-zero makes
# the server boot again on the next tick (three failures stop the Mac).
set -u
. "$HOME/drive/.daex/env.sh"

# Outside ~/drive on purpose: NoMac deletes it at stop, so a launch's one-time
# join code never reaches a drive save.
state="$HOME/.daex-boot"
umask 077
mkdir -p "$state" "$ADE_HOME/logs" "$daex_root/home"
log="$ADE_HOME/logs/mac-boot.log"
say() { echo "$(date -u +%FT%TZ) $*" >> "$log"; }

# The dotfiles agents keep in $HOME live on the drive. A fresh Mac may already
# have one (the image made it): the first boot moves it onto the drive, later
# boots keep the drive's.
keep_home() {
  name="$1" target="$2"
  link="$HOME/$name"
  [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ] && return 0
  mkdir -p "$(dirname "$link")" "$(dirname "$target")"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    if [ -e "$target" ]; then
      rm -rf "$link"
    else
      mv "$link" "$target"
    fi
  fi
  ln -sfn "$target" "$link"
}
# DAEX itself: code that reads ~/.ade directly sees ADE_HOME.
keep_home .ade "$ADE_HOME"
for name in .claude .codex .cursor .factory .gemini .kimi .kimi-code .qwen .grok .copilot .pi .devin .muse \
  .agent-browser .ssh .config/gh .config/opencode .config/github-copilot .local/share/opencode .local/state/opencode; do
  keep_home "$name" "$daex_root/home/$name"
  # A link to nothing can't be written through: the folder exists on the drive.
  mkdir -p "$daex_root/home/$name"
done
for name in .claude.json .gitconfig .git-credentials; do
  keep_home "$name" "$daex_root/home/$name"
  [ -e "$daex_root/home/$name" ] || : > "$daex_root/home/$name"
done
chmod 700 "$daex_root/home/.ssh"

# The env the server gave this boot, for the supervisor alone (it reads the
# file once and deletes it). CLERK_* comes only from a test Worker, with its
# account server (`testWorkerAccountEnv` in macProvider.ts).
export -p | grep -E '^declare -x (ADE|CLERK)_[A-Z0-9_]*=' > "$state/boot.env"

# A boot that runs again in the same session (its first answer was lost)
# leaves a running supervisor alone.
if [ -f "$state/supervise.pid" ] && kill -0 "$(cat "$state/supervise.pid")" 2>/dev/null; then
  say "boot again: the supervisor already runs"
  rm -f "$state/boot.env"
  exit 0
fi
nomac-service stop daex >/dev/null 2>&1 || true
say "boot: DAEX ${daex_running_version:-none} for ${ADE_CLOUD_INSTANCE_ID:-?}${ADE_LAUNCH_ID:+, launch $ADE_LAUNCH_ID}"
if ! nomac-service start daex --cwd "$HOME" -- /bin/bash "$daex_root/supervise.sh" >> "$log" 2>&1; then
  say "boot: nomac-service could not start the supervisor"
  exit 1
fi
# Wait for the supervisor to take its env, so a failure here is this boot's.
for _ in $(seq 1 50); do
  [ -f "$state/boot.env" ] || { say "boot: supervisor started"; exit 0; }
  sleep 0.2
done
say "boot: the supervisor did not start within 10 s"
exit 1
