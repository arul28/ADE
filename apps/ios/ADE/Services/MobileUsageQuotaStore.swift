import Combine
import Foundation

@MainActor
final class MobileUsageQuotaStore: ObservableObject {
  static let shared = MobileUsageQuotaStore()

  @Published private(set) var snapshot: MobileUsageQuotaSnapshot?
  @Published private(set) var refreshing = false
  @Published private(set) var errorMessage: String?

  private let cacheKeyPrefix = "ade.mobile.usageQuota.v2"
  private var loadedHostIdentity: String?
  private var loadGeneration = 0

  private init() {}

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
