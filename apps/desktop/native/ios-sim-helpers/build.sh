#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ROOT="$SCRIPT_DIR/build"
PRINT_JSON=0
SMOKE=0

for arg in "$@"; do
  case "$arg" in
    --print-json) PRINT_JSON=1 ;;
    --smoke) SMOKE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

DEVELOPER_DIR="$(/usr/bin/xcode-select -p 2>/dev/null || true)"
if [[ -z "$DEVELOPER_DIR" || ! -d "$DEVELOPER_DIR" ]]; then
  echo "xcode-select does not point at a developer directory" >&2
  exit 2
fi

SIMULATOR_KIT=""
for candidate in \
  "$DEVELOPER_DIR/Platforms/iPhoneSimulator.platform/Developer/Library/PrivateFrameworks/SimulatorKit.framework" \
  "$DEVELOPER_DIR/Library/PrivateFrameworks/SimulatorKit.framework"
do
  if [[ -d "$candidate" ]]; then
    SIMULATOR_KIT="$candidate"
    break
  fi
done
if [[ -z "$SIMULATOR_KIT" ]]; then
  echo "full Xcode is required; SimulatorKit.framework was not found under $DEVELOPER_DIR" >&2
  exit 3
fi

XCODE_VERSION="$(xcodebuild -version 2>/dev/null | awk 'NR == 1 {print $2}')"
if [[ -z "$XCODE_VERSION" ]]; then
  echo "xcodebuild -version did not report an Xcode version" >&2
  exit 4
fi

SWIFTC="$(command -v swiftc || true)"
CLANG="$(command -v clang || true)"
if [[ -z "$SWIFTC" ]]; then
  echo "swiftc was not found on PATH" >&2
  exit 5
fi
if [[ -z "$CLANG" ]]; then
  echo "clang was not found on PATH" >&2
  exit 6
fi

SOURCE_HASH="$(
  {
    shasum -a 256 "$SCRIPT_DIR/sim-capture.swift"
    shasum -a 256 "$SCRIPT_DIR/sim-input.m"
    shasum -a 256 "$SCRIPT_DIR/build.sh"
  } | shasum -a 256 | awk '{print $1}'
)"
KEY="xcode-${XCODE_VERSION//[^A-Za-z0-9._-]/_}-${SOURCE_HASH:0:16}"
OUT_DIR="$BUILD_ROOT/$KEY"
CAPTURE="$OUT_DIR/sim-capture"
INPUT="$OUT_DIR/sim-input"

if [[ ! -x "$CAPTURE" || ! -x "$INPUT" ]]; then
  mkdir -p "$OUT_DIR"
  "$SWIFTC" -O \
    -framework Foundation \
    -framework CoreGraphics \
    -framework CoreImage \
    -framework IOSurface \
    -framework ImageIO \
    -framework UniformTypeIdentifiers \
    "$SCRIPT_DIR/sim-capture.swift" \
    -o "$CAPTURE"
  "$CLANG" -fobjc-arc -O2 \
    -framework Foundation \
    -framework CoreGraphics \
    "$SCRIPT_DIR/sim-input.m" \
    -o "$INPUT"
fi

if [[ "$SMOKE" == "1" ]]; then
  "$CAPTURE" --smoke-test >/dev/null
  "$INPUT" --smoke-test >/dev/null
fi

if [[ "$PRINT_JSON" == "1" ]]; then
  XCODE_VERSION="$XCODE_VERSION" SOURCE_HASH="$SOURCE_HASH" OUT_DIR="$OUT_DIR" \
    CAPTURE="$CAPTURE" INPUT="$INPUT" \
    python3 -c 'import json, os, sys
sys.stdout.write(json.dumps({
  "xcodeVersion": os.environ.get("XCODE_VERSION", ""),
  "sourceHash": os.environ.get("SOURCE_HASH", ""),
  "buildDir": os.environ.get("OUT_DIR", ""),
  "capture": os.environ.get("CAPTURE", ""),
  "input": os.environ.get("INPUT", ""),
}) + "\n")'
else
  echo "$OUT_DIR"
fi
