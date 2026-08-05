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

# Same as download(), but with a visible progress bar on stderr. The runtime
# binary and its native archive are ~150 MB together, and downloading them
# silently is what made the installer look frozen for the first 30 seconds.
# stdout/stderr still point at the terminal under `curl | sh`.
download_with_progress() {
  dl_url="$1"
  dl_out="$2"
  dl_label="$3"
  printf '  %s\n' "$dl_label" >&2
  if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar "$dl_url" -o "$dl_out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress "$dl_url" -O "$dl_out"
  else
    die "missing curl or wget"
  fi
}

file_size_bytes() {
  if [ ! -f "$1" ]; then
    printf '0\n'
    return 0
  fi
  wc -c <"$1" | tr -d ' '
}

print_banner() {
  cat >&2 <<'BANNER'

     _    ____  _____
    / \  |  _ \| ____|
   / _ \ | | | |  _|
  / ___ \| |_| | |___
 /_/   \_\____/|_____|

BANNER
}

# Matches the step lines `ade setup` prints for steps 3-5, so the whole install
# reads as one list even though it spans two processes.
print_step() {
  printf '  %s %-20s %s\n' "$1" "$2" "$3" >&2
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
  # `brain start`, NOT `serve --install-service`. The latter registers the
  # service at whatever ADE_DEFAULT_ROLE happens to be, and on a fresh install
  # that is unset, so the machine brain came up as role `agent`. `ade connect`
  # runs at `cto`, and an `agent` brain can never serve a `cto` caller -- so
  # sign-in failed on every clean install, on macOS exactly as on Windows.
  # `brain start` pins `cto` internally, matching what the desktop app spawns
  # and what it refuses to attach to anything else.
  "$dest_dir/ade" brain start >"$service_log" 2>&1 || status="$?"
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

# The desktop app's SHA-512 verification moved into `ade setup`; SHA256SUMS
# above still covers the standalone runtime assets this script downloads.

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

# --- ade path setup (start) -------------------------------------------------
# Everything between these markers is self-contained: it reads `dest_dir`,
# `ade_home`, `interactive` and `ADE_INSTALL_NO_PATH`, and it is extracted
# verbatim by the installer's PATH tests. Keep it free of install-specific
# state so it stays testable in isolation.

path_marker_begin='# >>> ade >>>'
path_marker_end='# <<< ade <<<'
# Set to 1 only when this run appended the block to a profile file, which is
# what makes the *current* shell stale.
path_profile_updated=0
# Filled in by detect_profile.
path_shell=""
path_profile=""

env_file_path() {
  printf '%s\n' "$ade_home/env"
}

# The literal line written into the profile. Kept `$HOME`-relative so it stays
# readable, and so it survives a home directory mounted at a different path.
# `$HOME` can legitimately be unset here (ADE_HOME set, no home directory: some
# CI images, docker RUN, systemd units), so it is read defensively -- an
# unbound expansion would abort the whole installer under `set -u`.
env_file_ref() {
  env_ref_file="$(env_file_path)"
  env_ref_home="${HOME:-}"
  if [ -n "$env_ref_home" ]; then
    case "$env_ref_file" in
      "$env_ref_home"/*)
        printf '. "$HOME/%s"\n' "${env_ref_file#"$env_ref_home"/}"
        return 0
        ;;
    esac
  fi
  printf '. "%s"\n' "$env_ref_file"
}

# rustup/bun/uv shape: a tiny POSIX-sh file that prepends the install dir to
# PATH, guarded so sourcing it twice (or in an already-configured shell) is a
# no-op rather than a growing PATH.
# Returns non-zero instead of letting `set -e` kill the run: by the time this
# is called the runtime is already installed, so a stale root-owned $ADE_HOME/env
# must cost the user a PATH hint, not the sign-in and agent-CLI steps below.
write_env_file() {
  env_file="$(env_file_path)"
  mkdir -p "$(dirname "$env_file")" 2>/dev/null || return 1
  cat >"$env_file" <<EOF || return 1
#!/bin/sh
# Added by the ADE installer. Safe to source more than once.
case ":\${PATH}:" in
  *":$dest_dir:"*) ;;
  *) export PATH="$dest_dir:\$PATH" ;;
esac
EOF
  chmod 644 "$env_file" 2>/dev/null || true
  return 0
}

# Prefer $SHELL (the login shell, which is what the user's next terminal will
# start), and only fall back to sniffing dotfiles when it is absent or exotic.
detect_profile() {
  path_shell=""
  path_profile=""
  path_home="${HOME:-}"
  if [ -n "${SHELL:-}" ]; then
    path_shell="$(basename "$SHELL")"
  fi
  # No home directory means no profile to sniff for or write to. Leave
  # path_profile empty and let the caller fall back to printing the hint.
  if [ -z "$path_home" ]; then
    return 0
  fi
  case "$path_shell" in
    zsh | bash | fish) ;;
    *)
      if [ -f "$HOME/.zshrc" ] || [ -f "$HOME/.zprofile" ]; then
        path_shell="zsh"
      elif [ -f "$HOME/.bashrc" ] || [ -f "$HOME/.bash_profile" ]; then
        path_shell="bash"
      fi
      ;;
  esac

  case "$path_shell" in
    zsh)
      # Every interactive zsh reads .zshrc, while .zprofile is login-shell only.
      # Writing to .zprofile would leave PATH missing in the non-login shells
      # editors and multiplexers spawn, so always target .zshrc and create it
      # when it is absent.
      path_profile="$HOME/.zshrc"
      ;;
    bash)
      # macOS Terminal starts login shells, which read .bash_profile and never
      # .bashrc; Linux terminals are the other way round.
      if [ "$(uname -s)" = "Darwin" ]; then
        path_profile="$HOME/.bash_profile"
      else
        path_profile="$HOME/.bashrc"
      fi
      ;;
    *)
      # fish and anything unrecognized: we do not know the syntax or the file,
      # so we print instructions instead of guessing at someone's config.
      path_profile=""
      ;;
  esac
}

profile_has_block() {
  [ -f "$1" ] || return 1
  grep -Fq "$path_marker_begin" "$1"
}

append_profile_block() {
  append_target="$1"
  mkdir -p "$(dirname "$append_target")" 2>/dev/null || return 1
  # One printf, so the whole block lands in a single append -- three separate
  # writes let a concurrently running installer interleave into the middle of
  # ours and produce a nested, unreadable pair of blocks. The leading newline
  # also terminates a profile whose last line has no newline of its own.
  printf '\n%s\n%s\n%s\n' \
    "$path_marker_begin" "$(env_file_ref)" "$path_marker_end" \
    >>"$append_target" || return 1
  return 0
}

print_path_hint() {
  if [ "$path_shell" = "fish" ]; then
    printf 'To use `ade` in your own terminal, run:\n  fish_add_path "%s"\n' "$dest_dir"
  else
    printf 'To use `ade` in your own terminal, add this line to your shell profile:\n  %s\n' "$(env_file_ref)"
  fi
}

# Writes the env file always; edits a profile file only with consent, on a tty,
# and only once (re-running the installer is the update path).
setup_path() {
  # Without the env file there is nothing for a profile line to source, so a
  # failed write ends PATH setup here rather than pointing a dotfile at a file
  # that does not exist.
  if ! write_env_file; then
    printf 'ade install: could not write %s; skipping PATH setup.\n' "$(env_file_path)" >&2
    printf 'To use `ade` in your own terminal, add %s to your PATH.\n' "$dest_dir"
    return 0
  fi
  detect_profile

  case ":$PATH:" in
    *":$dest_dir:"*) path_on_path=1 ;;
    *) path_on_path=0 ;;
  esac

  # Already managed by a previous install: the block sources the env file we
  # just rewrote, so there is nothing to do and nothing to ask.
  if [ -n "$path_profile" ] && profile_has_block "$path_profile"; then
    return 0
  fi

  if [ "${ADE_INSTALL_NO_PATH:-}" = "1" ]; then
    [ "$path_on_path" -eq 1 ] || print_path_hint
    return 0
  fi

  # The directory is already on PATH by some other arrangement the user owns.
  # Adding our own block would be redundant noise in their profile.
  if [ "$path_on_path" -eq 1 ]; then
    return 0
  fi

  if [ -z "$path_profile" ] || [ "$path_shell" = "fish" ]; then
    print_path_hint
    return 0
  fi

  # No terminal (CI, automation): never touch dotfiles unasked.
  if [ "$interactive" -ne 1 ]; then
    print_path_hint
    return 0
  fi

  printf '\n'
  if ! ask "Add ade to your PATH by updating $path_profile?" y; then
    print_path_hint
    return 0
  fi

  if append_profile_block "$path_profile"; then
    path_profile_updated=1
    printf 'Updated %s\n' "$path_profile"
  else
    printf 'ade install: could not update %s.\n' "$path_profile" >&2
    print_path_hint
  fi
  return 0
}
# --- ade path setup (end) ---------------------------------------------------

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
# `cpu` used to be re-derived here for the desktop-app upsell's manifest match.
# That moved into `ade setup`, which reads the architecture from its own
# process, so nothing in this script needs it any more.
binary_name="ade-$target"
archive_name="$binary_name.native.tar.gz"
dest_dir="$(choose_install_dir)"
runtime_dir="$ade_home/runtime/$target"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/ade-install.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

mkdir -p "$dest_dir" "$runtime_dir" "$ade_home/bin"

install_started_at="$(date +%s)"
print_banner
printf '  Installing ADE to %s\n\n' "$ade_home" >&2

download_with_progress "$(asset_url "$binary_name")" "$tmp_dir/ade" "ADE runtime"
download_with_progress "$(asset_url "$archive_name")" "$tmp_dir/native.tar.gz" \
  "Native dependencies"
download "$(asset_url "SHA256SUMS")" "$tmp_dir/SHA256SUMS"
verify_asset_checksum "$binary_name" "$tmp_dir/ade"
verify_asset_checksum "$archive_name" "$tmp_dir/native.tar.gz"
downloaded_bytes="$((
  $(file_size_bytes "$tmp_dir/ade") + $(file_size_bytes "$tmp_dir/native.tar.gz")
))"

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

print_step "+" "ADE runtime" "$dest_dir/ade"
print_step "+" "Native dependencies" "$runtime_dir"
# The recovery commands in the closing summary are printed by `ade setup`, which
# resolves its own invocation, so this script no longer needs to work out
# whether `ade` is on PATH yet.

# Under `curl | sh` the script's stdin is the download pipe, so every prompt --
# and every command that prompts -- must be wired to /dev/tty instead. With no
# tty (CI, automation) the interactive steps are skipped and printed as
# follow-up commands.
interactive=0
if [ "${ADE_INSTALL_NO_PROMPT:-}" != "1" ] && tty_is_usable; then
  interactive=1
fi

# PATH first: `ade setup` should run with a sane environment, and the user
# should be asked about their shell profile before they are asked about
# accounts and a 1 GB desktop download.
setup_path

# Everything past this point -- agent CLIs, account, desktop app, end-to-end
# verification and the closing summary -- is `ade setup`. That is the same
# implementation the Windows installer hands off to, written once in TypeScript
# and unit-tested, so the two platforms cannot drift the way they had (this
# script had a desktop download progress bar; the PowerShell one did not).
#
# stdin is wired to /dev/tty because under `curl | sh` this script's own stdin
# is the download pipe: prompts reading it would consume the script or see EOF.
# stdout/stderr stay inherited so the step lines and summary reach the terminal.
# Built with positional parameters rather than a space-joined string: an
# ADE_INSTALL_DIR containing a space would otherwise word-split into two broken
# arguments, and `--runtime-path` is exactly the flag that carries such a path.
set -- setup --continue --runtime-path "$dest_dir/ade" --native-path "$runtime_dir"
if runtime_version="$("$dest_dir/ade" --version 2>/dev/null)"; then
  runtime_version="$(printf '%s' "$runtime_version" | tr -d '\r\n')"
  if [ -n "$runtime_version" ]; then
    set -- "$@" --runtime-version "$runtime_version"
  fi
fi
set -- "$@" --elapsed-ms "$(( ($(date +%s) - install_started_at) * 1000 ))"
set -- "$@" --downloaded-bytes "${downloaded_bytes:-0}"
# No terminal (CI, automation) means no prompts: `ade setup` falls through to
# printing the follow-up commands instead of blocking on an unreadable stdin.
[ "$interactive" -eq 1 ] || set -- "$@" --no-prompt

setup_status=0
if [ "$interactive" -eq 1 ]; then
  "$dest_dir/ade" "$@" </dev/tty || setup_status="$?"
else
  "$dest_dir/ade" "$@" || setup_status="$?"
fi

# Only this script knows whether it edited a shell profile, so the "new
# terminal" note belongs here rather than in the shared summary.
if [ "$path_profile_updated" -eq 1 ]; then
  printf '\n  ade is on your PATH in new terminals. To use it in this one, run:\n    %s\n' \
    "$(env_file_ref)"
fi

exit "$setup_status"
