import SwiftUI

/// The global Linear pane: a full-screen sheet hosting a `NavigationStack`
/// (issue list → detail → launch). Presented from the Work top-bar Linear
/// button and by `ade://linear-issue/<IDENT>` deep links. Active-project scoped.
struct LinearPaneSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @StateObject private var store: LinearPaneStore
  @State private var path: [LinearRoute] = []
  @State private var started = false
  /// Brief "Connected to <org>" confirmation shown on the empty state before the
  /// store reload flips the pane into the issue list.
  @State private var justConnectedOrg: String?

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
        case .connection:
          LinearConnectionScreen(store: store)
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

  /// Machine name for connect copy — the connected host's display name when
  /// known, else a neutral "your computer".
  private var machineName: String { syncService.machineDisplayName }

  private var connectPrompt: some View {
    ScrollView {
      VStack(spacing: 20) {
        VStack(spacing: 12) {
          LinearMark(size: 40)
            .foregroundStyle(LinearBrand.primaryBright)
          VStack(spacing: 6) {
            Text("Connect Linear")
              .font(.title3.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text("Sign in to browse and launch Linear issues from \(machineName). The token stays on your machine.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
              .multilineTextAlignment(.center)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .frame(maxWidth: .infinity)

        LinearConnectActions(store: store) { status in
          ADEHaptics.success()
          justConnectedOrg = status.organizationName
        }
        .adeGlassCard(cornerRadius: 20, padding: 20)

        if let justConnectedOrg {
          Label("Connected to \(justConnectedOrg)", systemImage: "checkmark.circle.fill")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.success)
            .transition(.opacity)
        }
      }
      .padding(24)
      .frame(maxWidth: .infinity)
    }
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground)
    .navigationTitle("Linear")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button { close() } label: {
          Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))
        }
        .accessibilityLabel("Close Linear")
      }
      ToolbarItem(placement: .topBarTrailing) {
        NavigationLink(value: LinearRoute.connection) {
          Image(systemName: "gearshape")
        }
        .accessibilityLabel("Linear connection settings")
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
