# DAEX on a DAEX Cloud Mac: where its files live. Sourced by boot.sh, by
# supervise.sh, and by every command the account server runs on the Mac
# (`MAC_EXEC_PRELUDE` in apps/account-directory/src/cloud/macProvider.ts).
#
# Only ~/drive outlives a stop (NoMac deletes the rest, the keychain
# included), so everything DAEX keeps is on it:
#   ~/drive/.daex/        these scripts, the template's DAEX (ade/) and its baked agents (tools/)
#   ~/drive/.ade/         the brain's home (ADE_HOME, as ~/.ade): identity, databases, sign-ins, `ade brain update`'s DAEX
#   ~/drive/.daex/home/   the dotfiles agents keep in $HOME (linked back by boot.sh)
#   ~/drive/src/<repo>    the lane's repositories (NoMac's advice, so builds stay incremental)
#   ~/drive/.cache/       package and build caches (NoMac puts them there already)

daex_root="$HOME/drive/.daex"
daex_drive_home="$HOME/drive/.ade"
# Named as ~/.ade, the link boot.sh makes to the drive's home: DAEX runs
# machine sync (its check-ins with the account and its machine connection)
# only in the machine's default home, never in any other path.
export ADE_HOME="$HOME/.ade"
case "$(uname -m)" in
  arm64|aarch64) daex_target=darwin-arm64 ;;
  *) daex_target=darwin-x64 ;;
esac

# The DAEX to run: the template's, or the newer one `ade brain update` put in
# ADE_HOME (with its own runtime beside it). A prerelease's "-" becomes "~" so
# `sort -V` orders 1.2.3~beta.1 before 1.2.3.
daex_image_ade="$daex_root/ade/bin/ade"
daex_image_runtime="$daex_root/ade/runtime/$daex_target"
daex_home_ade="$ADE_HOME/bin/ade"
daex_home_runtime="$ADE_HOME/runtime/$daex_target"
daex_version() {
  ADE_RUNTIME_ROOT="$2" "$1" --version 2>/dev/null | sed -n -E 's/^(ade|daex) //p' | head -n 1
}
daex_newest() {
  printf '%s\n%s\n' "$1" "$2" | sed 's/-/~/' | sort -V | tail -n 1 | sed 's/~/-/'
}
# Sets daex_bin, daex_runtime and daex_running_version.
daex_pick() {
  daex_bin=$daex_image_ade daex_runtime=$daex_image_runtime
  daex_running_version=$(daex_version "$daex_image_ade" "$daex_image_runtime")
  [ -x "$daex_home_ade" ] && [ -d "$daex_home_runtime/node_modules" ] || return 0
  home_version=$(daex_version "$daex_home_ade" "$daex_home_runtime")
  [ -n "$home_version" ] || return 0
  if [ "$(daex_newest "$daex_running_version" "$home_version")" = "$home_version" ]; then
    daex_bin=$daex_home_ade daex_runtime=$daex_home_runtime daex_running_version=$home_version
  fi
  return 0
}
daex_pick
export ADE_RUNTIME_ROOT="$daex_runtime"
export ADE_RUNTIME_NODE_MODULES="$daex_runtime/node_modules"
export NODE_PATH="$daex_runtime/node_modules"
case ":$PATH:" in
  *":${daex_bin%/ade}:"*) ;;
  *) export PATH="${daex_bin%/ade}:$PATH" ;;
esac

# The agents the template's DAEX pins, baked on the drive; the brain uses a
# baked copy only while its version is the pin. Later downloads go to
# ADE_HOME/tools, also on the drive. Only agents this computer ran are fetched
# at start.
export ADE_TOOLS_BAKED_ROOTS="$daex_root/tools"
export ADE_TOOLS_PREFETCH=used
# A DAEX Cloud Mac is a disposable sandbox (Claude Code's full-auto check).
export IS_SANDBOX=1
# The drive's loop (supervise.sh) supervises the brain: `ade brain update` and
# any restart, from the brain or from a command the account server runs, go
# through it and never install launchd's service (serviceManager/entrypointSupervisor.ts).
export ADE_BRAIN_SUPERVISOR=entrypoint
