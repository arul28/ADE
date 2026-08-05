#!/usr/bin/env sh
set -eu

repo="${ADE_RELEASE_REPO:-arul28/ADE}"
version="${ADE_VERSION:-latest}"
install_dir="${ADE_INSTALL_DIR:-}"
ade_home="${ADE_HOME:-$HOME/.ade}"

die() {
  printf '%s\n' "ade install: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

detect_target() {
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m | tr '[:upper:]' '[:lower:]')"

  case "$os" in
    darwin) platform="darwin" ;;
    linux) platform="linux" ;;
    *) die "unsupported OS: $os" ;;
  esac

  case "$arch" in
    arm64|aarch64) cpu="arm64" ;;
    x86_64|amd64) cpu="x64" ;;
    *) die "unsupported architecture: $arch" ;;
  esac

  printf '%s-%s\n' "$platform" "$cpu"
}

download() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$out"
  else
    die "missing curl or wget"
  fi
}

# Like download(), but a failure is reported to the caller instead of aborting
# the install. Used only for the optional desktop-app upsell, which must never
# turn a successful runtime install into a failed one.
try_download() {
  try_url="$1"
  try_out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$try_url" -o "$try_out" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$try_url" -O "$try_out" 2>/dev/null
  else
    return 1
  fi
}

# The desktop app zip is ~1GB, so show a progress bar rather than appearing to
# hang. stdout/stderr still point at the terminal under `curl | sh`.
try_download_progress() {
  try_url="$1"
  try_out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar "$try_url" -o "$try_out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress "$try_url" -O "$try_out"
  else
    return 1
  fi
}

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print tolower($1) }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print tolower($1) }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$file" | awk '{ print tolower($1) }'
  else
    die "missing sha256sum, shasum, or openssl"
  fi
}

checksum_for_asset() {
  asset="$1"
  awk -v asset="$asset" '
    $1 ~ /^[[:xdigit:]]{64}$/ {
      name = $2
      sub(/^\*/, "", name)
      count = split(name, parts, "/")
      if (parts[count] == asset) {
        print tolower($1)
        found = 1
        exit
      }
    }
    END { if (!found) exit 1 }
  ' "$tmp_dir/SHA256SUMS"
}

verify_asset_checksum() {
  asset="$1"
  file="$2"
  expected="$(checksum_for_asset "$asset")" || die "checksum file is missing $asset"
  actual="$(sha256_file "$file")"
  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for $asset"
  fi
}

try_install_service() {
  service_log="$tmp_dir/install-service.log"
  # Capture $? from the command itself: after a closing `fi` it would report the
  # compound statement's status (always 0) and the warning would lie.
  status=0
  "$dest_dir/ade" serve --install-service >"$service_log" 2>&1 || status="$?"
  if [ "$status" -eq 0 ]; then
    return 0
  fi

  printf 'ade install: warning: runtime service install failed with exit status %s; ADE was installed but the login service was not registered.\n' "$status" >&2
  if [ -s "$service_log" ]; then
    while IFS= read -r line; do
      printf 'ade install: service: %s\n' "$line" >&2
    done < "$service_log"
  fi
  return 0
}

asset_url() {
  name="$1"
  if [ "$version" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download/%s\n' "$repo" "$name"
  else
    printf 'https://github.com/%s/releases/download/%s/%s\n' "$repo" "$version" "$name"
  fi
}

sha512_base64_file() {
  # electron-updater manifests carry base64 SHA-512, not hex SHA-256, so the
  # desktop app is verified against latest-mac.yml rather than SHA256SUMS
  # (which only covers the standalone runtime assets).
  sha_file="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha512 -binary "$sha_file" | openssl base64 -A
  elif command -v shasum >/dev/null 2>&1 && command -v xxd >/dev/null 2>&1 &&
    command -v base64 >/dev/null 2>&1; then
    shasum -a 512 "$sha_file" | awk '{ print $1 }' | xxd -r -p | base64 | tr -d '\n'
  else
    return 1
  fi
}

# Prompts must come from the terminal: under `curl | sh` the script's own stdin
# is the download pipe, so reading it would consume the script or see EOF.
tty_is_usable() {
  # Must actually open /dev/tty, not just test its permission bits: a process
  # with no controlling terminal (CI, a detached installer) still sees a
  # world-readable /dev/tty node, but every open of it fails with ENXIO. A
  # permission test would report a usable terminal and the prompts would hang
  # or read EOF.
  ( exec 3</dev/tty ) >/dev/null 2>&1 || return 1
  ( exec 3>/dev/tty ) >/dev/null 2>&1 || return 1
  return 0
}

# ask <question> <default:y|n>; 0 = yes, 1 = no.
ask() {
  ask_question="$1"
  ask_default="$2"
  if [ "$ask_default" = "y" ]; then
    ask_hint="[Y/n]"
  else
    ask_hint="[y/N]"
  fi
  printf '%s %s ' "$ask_question" "$ask_hint" >/dev/tty
  ask_reply=""
  IFS= read -r ask_reply </dev/tty || ask_reply=""
  case "$ask_reply" in
    [Yy] | [Yy][Ee][Ss]) return 0 ;;
    [Nn] | [Nn][Oo]) return 1 ;;
    *) [ "$ask_default" = "y" ] ;;
  esac
}

choose_install_dir() {
  if [ -n "$install_dir" ]; then
    printf '%s\n' "$install_dir"
    return
  fi

  printf '%s\n' "$ade_home/bin"
}

need uname
need tar
need chmod
need awk
target="$(detect_target)"
# detect_target runs in a command-substitution subshell, so the `cpu`/`platform`
# it assigns are lost here. Re-derive `cpu` in this shell: `desktop_manifest_entry`
# reads it, and under `set -u` an unset `cpu` would abort the whole install at the
# desktop-app upsell.
cpu="${target#*-}"
binary_name="ade-$target"
archive_name="$binary_name.native.tar.gz"
dest_dir="$(choose_install_dir)"
runtime_dir="$ade_home/runtime/$target"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/ade-install.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

mkdir -p "$dest_dir" "$runtime_dir" "$ade_home/bin"

download "$(asset_url "$binary_name")" "$tmp_dir/ade"
download "$(asset_url "$archive_name")" "$tmp_dir/native.tar.gz"
download "$(asset_url "SHA256SUMS")" "$tmp_dir/SHA256SUMS"
verify_asset_checksum "$binary_name" "$tmp_dir/ade"
verify_asset_checksum "$archive_name" "$tmp_dir/native.tar.gz"

chmod 755 "$tmp_dir/ade"
cp "$tmp_dir/ade" "$dest_dir/ade"
chmod 755 "$dest_dir/ade"

staged_runtime_dir="$tmp_dir/runtime"
staged_node_modules="$staged_runtime_dir/node_modules"
backup_runtime_dir="$tmp_dir/runtime.previous"

rm -rf "$staged_runtime_dir" "$backup_runtime_dir"
mkdir -p "$staged_runtime_dir"
tar -xzf "$tmp_dir/native.tar.gz" -C "$staged_runtime_dir"
[ -d "$staged_node_modules" ] || die "native dependency archive is missing node_modules"

if [ -e "$runtime_dir" ]; then
  mv "$runtime_dir" "$backup_runtime_dir"
fi

if mv "$staged_runtime_dir" "$runtime_dir"; then
  rm -rf "$backup_runtime_dir"
else
  if [ -e "$backup_runtime_dir" ]; then
    rm -rf "$runtime_dir"
    mv "$backup_runtime_dir" "$runtime_dir"
  fi
  die "failed to install ADE native runtime dependencies"
fi

export ADE_RUNTIME_ROOT="$runtime_dir"
export ADE_RUNTIME_NODE_MODULES="$runtime_dir/node_modules"
export NODE_PATH="$runtime_dir/node_modules${NODE_PATH:+:$NODE_PATH}"

"$dest_dir/ade" --version >/dev/null || die "installed ade binary failed to run"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  try_install_service
elif [ "$(uname -s)" = "Darwin" ]; then
  try_install_service
fi

printf 'ADE runtime installed: %s\n' "$dest_dir/ade"
case ":$PATH:" in
  *":$dest_dir:"*)
    ade_cmd="ade"
    ;;
  *)
    ade_cmd="$dest_dir/ade"
    printf 'Add %s to PATH to run ade from new shells.\n' "$dest_dir"
    ;;
esac

# Under `curl | sh` the script's stdin is the download pipe, so every prompt --
# and every command that prompts -- must be wired to /dev/tty instead. With no
# tty (CI, automation) the interactive steps are skipped and printed as
# follow-up commands.
interactive=0
if [ "${ADE_INSTALL_NO_PROMPT:-}" != "1" ] && tty_is_usable; then
  interactive=1
fi

# The agent CLIs (Codex, Claude Code, OpenCode) are pinned but not bundled --
# the installer fetches them into the shared machine cache so the first agent
# run is not a surprise multi-hundred-megabyte download. Non-fatal by design:
# the brain retries this in the background on every `ade serve`, so a flaky
# network here costs nothing but the wait.
ensure_agent_tools() {
  printf '\nFetching pinned agent CLIs (Codex, Claude Code, OpenCode)...\n'
  if "$dest_dir/ade" tools ensure --text; then
    return 0
  fi
  printf 'ade install: could not fetch the agent CLIs now; ADE will fetch them on first run.\n' >&2
  return 0
}

offer_sign_in() {
  if [ "$interactive" -ne 1 ]; then
    printf '\nNext: run `%s connect` to link this machine to your ADE account.\n' "$ade_cmd"
    return 0
  fi

  printf '\n'
  if ! ask 'Sign in to link this machine to your ADE account?' y; then
    printf 'Skipped. Run `%s connect` later to link this machine.\n' "$ade_cmd"
    return 0
  fi

  # `ade connect` inherits the terminal, so its own prompts and the browser /
  # device-code flow work normally.
  if "$dest_dir/ade" connect </dev/tty; then
    return 0
  fi
  printf 'ade install: sign-in did not finish. Run `%s connect` to try again.\n' "$ade_cmd" >&2
  return 0
}

# macOS desktop app upsell. The published SHA256SUMS covers only the standalone
# runtime assets, so the app zip is verified against the base64 SHA-512 in
# latest-mac.yml -- the same digest electron-updater checks.
desktop_manifest_entry() {
  awk -v arch="$cpu" '
    $1 == "-" && $2 == "url:" { url = $3; next }
    $1 == "sha512:" {
      if (url != "" && url ~ ("-" arch "\\.zip$")) { print url; print $2; found = 1; exit }
      url = ""
      next
    }
    END { if (!found) exit 1 }
  ' "$1"
}

offer_desktop_app() {
  [ "$(uname -s)" = "Darwin" ] || return 0

  desktop_manifest="$tmp_dir/latest-mac.yml"
  try_download "$(asset_url "latest-mac.yml")" "$desktop_manifest" || return 0
  desktop_entry="$(desktop_manifest_entry "$desktop_manifest")" || return 0
  desktop_zip="$(printf '%s\n' "$desktop_entry" | sed -n 1p)"
  desktop_sha="$(printf '%s\n' "$desktop_entry" | sed -n 2p)"
  [ -n "$desktop_zip" ] && [ -n "$desktop_sha" ] || return 0

  if [ "$interactive" -ne 1 ]; then
    printf 'Desktop app for macOS: %s\n' "$(asset_url "$desktop_zip")"
    return 0
  fi

  apps_dir="/Applications"
  [ -w "$apps_dir" ] || apps_dir="$HOME/Applications"
  installed_app="$apps_dir/ADE.app"

  printf '\n'
  if [ -e "$installed_app" ]; then
    if ! ask "Replace the existing ADE desktop app at $installed_app?" n; then
      return 0
    fi
  elif ! ask 'Install the ADE desktop app for macOS? (about 1 GB download)' y; then
    # The site is a single-page app whose only routes are /, /open, /pair,
    # /privacy and /terms (apps/web/src/app/SiteRoutes.tsx); every other path
    # renders NotFoundPage. The homepage carries the install modal, so link
    # there rather than at a /download path that does not exist.
    printf 'Skipped. Download it later from https://ade-app.dev\n'
    return 0
  fi

  printf 'Downloading %s\n' "$desktop_zip"
  if ! try_download_progress "$(asset_url "$desktop_zip")" "$tmp_dir/$desktop_zip"; then
    printf 'ade install: could not download the desktop app; the ADE runtime is still installed.\n' >&2
    return 0
  fi
  desktop_actual="$(sha512_base64_file "$tmp_dir/$desktop_zip")" || {
    printf 'ade install: cannot verify the desktop app on this system; skipping it.\n' >&2
    return 0
  }
  if [ "$desktop_actual" != "$desktop_sha" ]; then
    printf 'ade install: checksum mismatch for %s; skipping the desktop app.\n' "$desktop_zip" >&2
    return 0
  fi

  desktop_stage="$tmp_dir/desktop"
  rm -rf "$desktop_stage"
  mkdir -p "$desktop_stage"
  if ! ditto -x -k "$tmp_dir/$desktop_zip" "$desktop_stage" 2>/dev/null; then
    printf 'ade install: could not expand the desktop app archive; skipping it.\n' >&2
    return 0
  fi
  [ -d "$desktop_stage/ADE.app" ] || {
    printf 'ade install: desktop app archive did not contain ADE.app; skipping it.\n' >&2
    return 0
  }

  # Move the existing app aside rather than deleting it first, so a failed
  # promotion leaves the user's working app in place.
  mkdir -p "$apps_dir"
  desktop_backup="$tmp_dir/ADE.app.previous"
  rm -rf "$desktop_backup"
  if [ -e "$installed_app" ] && ! mv "$installed_app" "$desktop_backup"; then
    printf 'ade install: could not replace %s; skipping the desktop app.\n' "$installed_app" >&2
    return 0
  fi
  if ! mv "$desktop_stage/ADE.app" "$installed_app"; then
    if [ -e "$desktop_backup" ]; then
      mv "$desktop_backup" "$installed_app" || true
    fi
    printf 'ade install: could not install the desktop app into %s.\n' "$apps_dir" >&2
    return 0
  fi
  rm -rf "$desktop_backup"
  printf 'ADE desktop app installed: %s\n' "$installed_app"
  open "$installed_app" 2>/dev/null || true
  return 0
}

ensure_agent_tools
offer_sign_in
offer_desktop_app

printf '\nDone. Try: %s connect --status --text\n' "$ade_cmd"
