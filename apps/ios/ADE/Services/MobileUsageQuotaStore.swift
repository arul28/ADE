import Combine
import Foundation

@MainActor
final class MobileUsageQuotaStore: ObservableObject {
  static let shared = MobileUsageQuotaStore()

  @Published private(set) var snapshot: MobileUsageQuotaSnapshot?
  @Published private(set) var refreshing = false
  @Published private(set) var errorMessage: String?

  /// Range-keyed activity stats for the Settings Usage page. Kept next to the
  /// quota snapshot because the page renders both bands from one screen and one
  /// refresh gesture; keeping two stores would mean two spinners and two
  /// host-change resets that could disagree.
  @Published private(set) var stats: MobileAdeUsageStats?
  /// The range `stats` describes. Nil until the first successful load.
  @Published private(set) var statsRange: String?
  @Published private(set) var statsLoading = false
  @Published private(set) var statsErrorMessage: String?

  private let cacheKeyPrefix = "ade.mobile.usageQuota.v2"
  private var loadedHostIdentity: String?
  private var loadGeneration = 0
  /// In-memory only: `MobileAdeUsageStats` is decode-only (it has a custom
  /// lossy `init(from:)`), so there is no encodable form to persist. Switching
  /// range back is instant; a cold launch refetches.
  private var statsCache: [String: MobileAdeUsageStats] = [:]
  private var statsHostIdentity: String?
  private var statsGeneration = 0

  private init() {}

  /// Loads the ADE activity stats for `range` ("today" | "7d" | "30d" | "year" |
  /// "all"). Serves the in-memory cache immediately when present so range
  /// switching never blanks the page, then refreshes in place.
  func loadStats(range: String, using syncService: SyncService, force: Bool = false) async {
    let hostIdentity = currentHostIdentity(syncService)
    if statsHostIdentity != hostIdentity {
      statsHostIdentity = hostIdentity
      statsCache.removeAll()
      stats = nil
      statsRange = nil
      statsErrorMessage = nil
    }
    guard hostIdentity != nil else {
      statsGeneration += 1
      statsLoading = false
      return
    }
    guard syncService.supportsRemoteAction("usage.getAdeStats") else {
      statsGeneration += 1
      stats = nil
      statsRange = nil
      statsLoading = false
      statsErrorMessage = "Update ADE on this machine to view usage activity."
      return
    }

    statsGeneration += 1
    let generation = statsGeneration
    if let cached = statsCache[range] {
      stats = cached
      statsRange = range
      statsErrorMessage = nil
      if !force { statsLoading = false }
    }
    statsLoading = statsCache[range] == nil || force
    defer { if generation == statsGeneration { statsLoading = false } }

    do {
      // `force` is the user's Refresh, not a cache hint: it must reach the host
      // so an account-wide read is not silently suppressed by the fan-out's
      // rate floor.
      let next = try await syncService.fetchAdeUsageStats(preset: range, force: force)
      guard generation == statsGeneration,
            currentHostIdentity(syncService) == hostIdentity else { return }
      statsCache[range] = next
      stats = next
      statsRange = range
      statsErrorMessage = nil
    } catch {
      guard generation == statsGeneration,
            currentHostIdentity(syncService) == hostIdentity else { return }
      // A cached range stays on screen: a failed refresh should not erase the
      // numbers the user is reading.
      if statsCache[range] == nil {
        stats = nil
        statsRange = nil
      }
      statsErrorMessage = error.localizedDescription
    }
  }

  func load(using syncService: SyncService, refresh: Bool = false) async {
    guard let hostIdentity = currentHostIdentity(syncService) else {
      loadGeneration += 1
      bind(to: nil)
      refreshing = false
      return
    }
    let hostChanged = loadedHostIdentity != hostIdentity
    if hostChanged {
      bind(to: hostIdentity)
    }
    let action = refresh ? "usage.refreshQuota" : "usage.getQuotaSnapshot"
    guard syncService.supportsRemoteAction(action) else {
      loadGeneration += 1
      snapshot = nil
      errorMessage = "Update ADE on this machine to view live usage limits."
      refreshing = false
      return
    }
    if !refresh && refreshing && !hostChanged { return }
    loadGeneration += 1
    let generation = loadGeneration
    if refresh { refreshing = true }
    defer {
      if generation == loadGeneration { refreshing = false }
    }
    do {
      let next = try await syncService.fetchUsageQuotaSnapshot(refresh: refresh)
      guard generation == loadGeneration,
            currentHostIdentity(syncService) == hostIdentity else { return }
      snapshot = next
      errorMessage = nil
      if let data = try? JSONEncoder().encode(next) {
        UserDefaults.standard.set(data, forKey: cacheKey(for: hostIdentity))
      }
    } catch {
      guard generation == loadGeneration,
            currentHostIdentity(syncService) == hostIdentity else { return }
      errorMessage = error.localizedDescription
    }
  }

  private func bind(to hostIdentity: String?) {
    loadedHostIdentity = hostIdentity
    errorMessage = nil
    guard let hostIdentity,
          let data = UserDefaults.standard.data(forKey: cacheKey(for: hostIdentity)),
          let decoded = try? JSONDecoder().decode(MobileUsageQuotaSnapshot.self, from: data) else {
      snapshot = nil
      return
    }
    snapshot = decoded
  }

  private func currentHostIdentity(_ syncService: SyncService) -> String? {
    for value in [
      syncService.activeHostProfile?.hostIdentity,
      syncService.activeHostProfile?.lastHostDeviceId,
    ] {
      let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      if !trimmed.isEmpty { return trimmed }
    }
    return nil
  }

  private func cacheKey(for hostIdentity: String) -> String {
    "\(cacheKeyPrefix).\(hostIdentity)"
  }
}
