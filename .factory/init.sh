#!/bin/bash
set -euo pipefail

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "ERROR: xcodebuild not found. Xcode must be installed." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found. Node.js/npm must be installed for desktop parity work." >&2
  exit 1
fi

if ! xcrun simctl list devices available | grep -q "iPhone 17 Pro"; then
  echo "ERROR: iPhone 17 Pro simulator not available. Install the iOS 26.3 simulator runtime." >&2
  exit 1
fi

mkdir -p /tmp/ade-build /tmp/ade-ios-dryrun

echo "Environment ready for ADE iOS parity mission."
echo "Simulator target: iPhone 17 Pro / iOS 26.3.1"
