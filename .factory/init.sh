#!/bin/bash
set -e

# No dependencies to install - iOS app uses only system frameworks (no SPM/CocoaPods/Carthage)
# Verify xcodebuild is available
if ! command -v xcodebuild &> /dev/null; then
    echo "ERROR: xcodebuild not found. Xcode must be installed."
    exit 1
fi

echo "Environment ready. iOS app at apps/ios/"
