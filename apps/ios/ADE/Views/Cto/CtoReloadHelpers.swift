import Foundation

let ctoLiveReloadMinimumInterval: TimeInterval = 2

func shouldRunCtoLiveReload(
  lastReloadAt: Date?,
  now: Date,
  minimumInterval: TimeInterval = ctoLiveReloadMinimumInterval
) -> Bool {
  guard let lastReloadAt else { return true }
  return now.timeIntervalSince(lastReloadAt) >= minimumInterval
}
