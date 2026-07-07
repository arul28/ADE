import SwiftUI

/// The global Linear pane: a full-screen sheet hosting a `NavigationStack`
/// (issue list → detail → launch). Presented from the Work top-bar Linear
/// button and by `ade://linear-issue/<IDENT>` deep links. Active-project scoped.
struct LinearPaneSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @StateObject private var store: LinearPaneStore
  @State private var path: [LinearRoute] = []
  @State private var started = false

  init(syncService: SyncService) {
    _store = StateObject(wrappedValue: LinearPaneStore(sync: syncService))
  }

  private var isDisconnected: Bool {
    store.quickView?.connection.connected == false
  }

  var body: some View {
    NavigationStack(path: $path) {
      Group {
        if isDisconnected {
          connectPrompt
        } else {
          LinearIssueListScreen(store: store, onClose: close)
        }
      }
      .navigationDestination(for: LinearRoute.self) { route in
        switch route {
        case let .issue(issue):
          LinearIssueDetailScreen(issue: issue, hasLane: store.attachedIssueIds.contains(issue.id))
        case let .launch(issue, laneOnly):
          LinearLaunchScreen(issue: issue, laneOnly: laneOnly)
        }
      }
    }
    .tint(LinearBrand.primaryBright)
    .task {
      guard !started else { return }
      started = true
      await store.start()
      await consumePendingDeepLink()
    }
    .onChange(of: syncService.requestedLinearIssueNavigation?.id) { _, id in
      guard id != nil else { return }
      Task { await consumePendingDeepLink() }
    }
  }

  private var connectPrompt: some View {
    ADEEmptyStateView(
      symbol: "link.badge.plus",
      title: "Linear isn\u{2019}t connected",
      message: "Connect Linear from ADE on your machine (Settings \u{203A} Integrations) to browse and launch issues here."
    ) {
      Button("Close", action: close)
        .buttonStyle(.glassProminent)
        .tint(LinearBrand.primary)
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .navigationTitle("Linear")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button { close() } label: {
          Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))
        }
        .accessibilityLabel("Close Linear")
      }
    }
  }

  private func close() {
    syncService.linearPanePresented = false
  }

  /// Resolves and pushes the issue named by a pending `linear-issue` deep link.
  private func consumePendingDeepLink() async {
    guard let request = syncService.requestedLinearIssueNavigation else { return }
    syncService.requestedLinearIssueNavigation = nil
    guard let issue = await store.fetchIssue(identifier: request.identifier) else {
      // Fall back to a filtered list so the user still sees the identifier's
      // results rather than a dead-end, widening beyond "assigned to me".
      store.showFallbackSearch(identifier: request.identifier)
      return
    }
    if path.last != .issue(issue) {
      path.append(.issue(issue))
    }
  }
}
