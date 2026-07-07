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
  if "$dest_dir/ade" serve --install-service >"$service_log" 2>&1; then
    return 0
  fi

  status="$?"
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

rm -rf "$runtime_dir/node_modules"
tar -xzf "$tmp_dir/native.tar.gz" -C "$runtime_dir"
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
  *":$dest_dir:"*) ;;
  *) printf 'Add %s to PATH to run ade from new shells.\n' "$dest_dir" ;;
esac
