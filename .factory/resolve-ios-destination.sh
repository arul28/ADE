#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${IOS_SIMULATOR_UDID:-}" ]]; then
  printf 'platform=iOS Simulator,id=%s\n' "$IOS_SIMULATOR_UDID"
  exit 0
fi

simctl_output="$(
  xcrun simctl list devices available -j 2>/dev/null
)" || {
  echo "Unable to query CoreSimulator. Set IOS_DESTINATION or IOS_SIMULATOR_UDID to run xcodebuild in this environment." >&2
  exit 1
}

if [[ -z "$simctl_output" ]]; then
  echo "No simulator inventory was returned. Set IOS_DESTINATION or IOS_SIMULATOR_UDID to run xcodebuild in this environment." >&2
  exit 1
fi

printf '%s' "$simctl_output" | ruby -rjson -e '
  payload = JSON.parse(STDIN.read)
  devices = payload.fetch("devices", {}).values.flatten
  device = devices.find do |candidate|
    candidate["isAvailable"] && candidate["name"].to_s.start_with?("iPhone")
  end
  abort("No available iOS simulator found. Set IOS_DESTINATION or IOS_SIMULATOR_UDID to choose one explicitly.") unless device
  puts "platform=iOS Simulator,id=#{device.fetch("udid")}"
'
