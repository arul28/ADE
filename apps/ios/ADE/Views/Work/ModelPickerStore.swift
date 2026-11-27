import SwiftUI

/// Owns the favorites/recents lists for the picker UI. Optimistic local
/// updates fire immediately so taps feel instant; the sync runs in the
/// background and reconciles when the server responds. Failures roll back to
/// the last known-good list rather than letting the UI diverge silently.
///
/// Favorites live on the ADE account (`AccountModelFavoritesClient`), so the
/// desktop on every computer, the web client and this phone share one list.
/// Signed out, or an account server from before the route: the connected
/// machine's list, as before. Recents stay on the connected machine.
@MainActor
final class ModelPickerStore: ObservableObject {
  @Published private(set) var favorites: [String] = []
  @Published private(set) var recents: [String] = []
  @Published private(set) var isLoading: Bool = false

  private var hasLoaded = false
  private let accountFavorites = AccountModelFavoritesClient()
  /// Bumped by each star: only the newest change's answer is shown.
  private var favoritesGeneration = 0
  /// Stars are sent one at a time, in the order tapped, so a quick star and
  /// unstar can't reach the account in the wrong order.
  private var lastFavoriteChange: Task<Void, Never>?

  func load(syncService: SyncService) {
    guard !hasLoaded else { return }
    hasLoaded = true
    isLoading = true
    Task { @MainActor [weak self] in
      await self?.refresh(syncService: syncService)
    }
  }

  func refresh(syncService: SyncService) async {
    let directoryRevision = WorkModelMentionDirectory.shared.recentsRevisionSnapshot
    let generation = favoritesGeneration
    async let favTask = readFavorites(syncService: syncService)
    async let recTask = try? await syncService.getModelRecents()
    let fav = await favTask
    let rec = await recTask
    // A star tapped while the read ran wins over the read.
    if let fav, generation == favoritesGeneration { favorites = fav }
    if let rec {
      recents = rec
      // The `@` menu ranks by the same recents; only the host's answer is
      // mirrored, so a stale local list never overwrites a newer `@` pick.
      WorkModelMentionDirectory.shared.record(recents: rec, ifRevision: directoryRevision)
    }
    isLoading = false
  }

  func toggleFavorite(_ modelId: String, syncService: SyncService) {
    let previous = favorites
    let removing = favorites.contains(modelId)
    // Appended, as the desktop and the account server order stars.
    favorites = removing ? favorites.filter { $0 != modelId } : favorites.filter { $0 != modelId } + [modelId]
    favoritesGeneration &+= 1
    let generation = favoritesGeneration
    let prior = lastFavoriteChange
    lastFavoriteChange = Task { @MainActor [weak self] in
      await prior?.value
      guard let self else { return }
      let settled = await self.changeFavorite(modelId, removing: removing, syncService: syncService)
      guard generation == self.favoritesGeneration else { return }
      self.favorites = settled ?? previous
    }
  }

  /// The account's favorites; the machine's when the account can't answer
  /// for them (signed out, older server). Nil: keep the list shown.
  private func readFavorites(syncService: SyncService) async -> [String]? {
    do {
      return try await accountFavorites.fetch()
    } catch AccountModelFavoritesClient.FavoritesError.signedOut, AccountModelFavoritesClient.FavoritesError.unsupported {
      return try? await syncService.getModelFavorites()
    } catch AccountModelFavoritesClient.FavoritesError.stale {
      return nil
    } catch {
      CrashReporting.breadcrumb("model-picker", message: "favorites read failed", data: ["error": String(describing: error)])
      return nil
    }
  }

  /// The list after one star, or nil when it failed (roll back).
  private func changeFavorite(_ modelId: String, removing: Bool, syncService: SyncService) async -> [String]? {
    do {
      return try await accountFavorites.change(add: removing ? [] : [modelId], remove: removing ? [modelId] : [])
    } catch AccountModelFavoritesClient.FavoritesError.signedOut, AccountModelFavoritesClient.FavoritesError.unsupported {
      return try? await syncService.toggleModelFavorite(modelId).favorites
    } catch AccountModelFavoritesClient.FavoritesError.refused {
      // The account can't take it (the list is full): show its list.
      CrashReporting.breadcrumb("model-picker", message: "favorite refused by the account")
      return try? await accountFavorites.fetch()
    } catch AccountModelFavoritesClient.FavoritesError.stale {
      // Another account now: its list comes with the next read.
      return favorites
    } catch {
      CrashReporting.breadcrumb("model-picker", message: "favorite change failed", data: ["error": String(describing: error)])
      return nil
    }
  }

  func pushRecent(_ modelId: String, syncService: SyncService) {
    let trimmed = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    let previous = recents
    // Optimistic update: dedupe + cap at server's MAX_RECENTS (10) so the UI
    // doesn't briefly flash an over-long list before the server response
    // settles.
    var next = recents.filter { $0 != trimmed }
    next.insert(trimmed, at: 0)
    if next.count > 10 { next = Array(next.prefix(10)) }
    recents = next
    Task { @MainActor [weak self] in
      do {
        let updated = try await syncService.pushModelRecent(trimmed)
        self?.recents = updated
        WorkModelMentionDirectory.shared.record(recents: updated)
      } catch {
        self?.recents = previous
      }
    }
  }
}
