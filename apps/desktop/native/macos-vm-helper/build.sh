#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ROOT="${ADE_MACOS_VM_HELPER_BUILD_ROOT:-"$SCRIPT_DIR/build"}"
PRINT_JSON=0
SMOKE=0

for arg in "$@"; do
  case "$arg" in
    --print-json) PRINT_JSON=1 ;;
    --smoke) SMOKE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "macOS VM helper requires Apple silicon macOS" >&2
  exit 2
fi

SWIFTC="$(command -v swiftc || true)"
if [[ -z "$SWIFTC" ]]; then
  echo "swiftc was not found on PATH" >&2
  exit 3
fi

for required in "$SCRIPT_DIR/macos-vm-helper.swift" "$SCRIPT_DIR/entitlements.plist" "$SCRIPT_DIR/build.sh"; do
  if [[ ! -f "$required" ]]; then
    echo "required file not found: $required" >&2
    exit 4
  fi
done

SOURCE_HASH="$(
  {
    shasum -a 256 "$SCRIPT_DIR/macos-vm-helper.swift"
    shasum -a 256 "$SCRIPT_DIR/entitlements.plist"
    shasum -a 256 "$SCRIPT_DIR/build.sh"
  } | shasum -a 256 | awk '{print $1}'
)"
OS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo unknown)"
KEY="macos-${OS_VERSION//[^A-Za-z0-9._-]/_}-${SOURCE_HASH:0:16}"
OUT_DIR="$BUILD_ROOT/$KEY"
HELPER="$OUT_DIR/macos-vm-helper"

if [[ ! -x "$HELPER" ]]; then
  mkdir -p "$OUT_DIR"
  TMP_HELPER="$HELPER.tmp.$$"
  trap 'rm -f "$TMP_HELPER"' ERR
  "$SWIFTC" -O \
    -parse-as-library \
    -framework AppKit \
    -framework Foundation \
    -framework Virtualization \
    "$SCRIPT_DIR/macos-vm-helper.swift" \
    -o "$TMP_HELPER"
  mv "$TMP_HELPER" "$HELPER"
  trap - ERR
fi

if command -v codesign >/dev/null 2>&1; then
  if ! codesign --force --sign - --entitlements "$SCRIPT_DIR/entitlements.plist" "$HELPER" >/dev/null 2>&1; then
    echo "warning: failed to ad-hoc sign $HELPER with virtualization entitlement" >&2
  fi
fi

if [[ "$SMOKE" == "1" ]]; then
  "$HELPER" doctor >/dev/null
fi

if [[ "$PRINT_JSON" == "1" ]]; then
  OS_VERSION="$OS_VERSION" SOURCE_HASH="$SOURCE_HASH" OUT_DIR="$OUT_DIR" HELPER="$HELPER" \
    python3 -c 'import json, os, sys
sys.stdout.write(json.dumps({
  "osVersion": os.environ.get("OS_VERSION", ""),
  "sourceHash": os.environ.get("SOURCE_HASH", ""),
  "buildDir": os.environ.get("OUT_DIR", ""),
  "helper": os.environ.get("HELPER", ""),
}) + "\n")'
else
  echo "$OUT_DIR"
fi
