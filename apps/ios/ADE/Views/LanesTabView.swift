import SwiftUI

struct LanesTabView: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @EnvironmentObject var syncService: SyncService
  @Namespace private var laneTransitionNamespace
  var isActive = true

  @State var laneSnapshots: [LaneListSnapshot] = []
  @State var errorMessage: String?
  @State var searchText = ""
  @State var scope: LaneListScope = .active
  @State var runtimeFilter: LaneRuntimeFilter = .all
  @State var addLaneSheetPresented = false
  @State var openLaneIds: [String] = []
  @AppStorage("ade.lanes.pinnedIds") private var pinnedLaneIdsStorage: String = ""
  @State var primaryBranches: [GitBranchSummary] = []
  @State var primaryBranchLaneId: String?
  @State var primaryBranchError: String?
  @State var detailSheetTarget: LaneDetailSheetTarget?
  @State var batchManageLaneIds: [String] = []
  @State var batchManagePresented = false
  @State var refreshFeedbackToken = 0
  @State var selectedLaneTransitionId: String?
  @State private var lastLanesLocalProjectionReload = Date.distantPast
  @State private var lastHandledLanesProjectionRevision: Int?

  var pinnedLaneIds: Set<String> {
    get {
      Set(pinnedLaneIdsStorage.split(separator: ",").map(String.init).filter { !$0.isEmpty })
    }
    nonmutating set {
      pinnedLaneIdsStorage = newValue.sorted().joined(separator: ",")
    }
  }

  var laneStatus: SyncDomainStatus {
    syncService.status(for: .lanes)
  }

  var canRunLiveActions: Bool {
    laneAllowsLiveActions(connectionState: syncService.connectionState, laneStatus: laneStatus)
  }

  var transitionNamespace: Namespace.ID? {
    ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? laneTransitionNamespace : nil
  }

  var lanesProjectionReloadKey: Int? {
    isActive ? syncService.localStateRevision : nil
  }

  var primaryBranchReloadKey: String? {
    guard isActive else { return nil }
    return "\(primaryLane?.id ?? "none")-\(canRunLiveActions)"
  }

  var laneNavigationRequestKey: String? {
    guard isActive else { return nil }
    return syncService.requestedLaneNavigation?.id
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 14) {
          addLaneActionButton
          if !syncService.connectionState.isHostUnreachable,
            let hydrationNotice = laneStatus.inlineHydrationFailureNotice(for: .lanes)
          {
            ADENoticeCard(
              title: hydrationNotice.title,
              message: hydrationNotice.message,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .transition(.opacity)
          }
          if let errorMessage,
            laneStatus.phase == .ready,
            !syncService.connectionState.isHostUnreachable
          {
            ADENoticeCard(
              title: "Lane view error",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .transition(.opacity)
          }
          if let primaryBranchError,
            laneStatus.phase == .ready,
            !syncService.connectionState.isHostUnreachable
          {
            ADENoticeCard(
              title: "Primary branch error",
              message: primaryBranchError,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await refreshPrimaryBranches(force: true) } }
            )
            .transition(.opacity)
          }
          if !syncService.connectionState.isHostUnreachable,
            let liveActionNoticePresentation
          {
            ADENoticeCard(
              title: liveActionNoticePresentation.title,
              message: liveActionNoticePresentation.message,
              icon: liveActionNoticePresentation.symbol,
              tint: ADEColor.warning,
              actionTitle: liveActionNoticePresentation.actionTitle,
              action: liveActionNoticePresentation.action.map { action in
                { handleNoticeAction(action) }
              }
            )
            .transition(.opacity)
          }
          if showsLaneLoadingSkeletons {
            ADECardSkeleton(rows: 4)
            ADECardSkeleton(rows: 3)
          }
          if !openLaneSnapshots.isEmpty {
            openLanesTray
              .transition(.move(edge: .top).combined(with: .opacity))
          }
          if !visibleSuggestions.isEmpty || !visibleAutoRebaseAttention.isEmpty {
            attentionSection
              .transition(.move(edge: .top).combined(with: .opacity))
          }
          laneList
        }
        .padding(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
      }
      .scrollBounceBehavior(.basedOnSize)
      .searchable(text: $searchText, prompt: "Filter by lane, branch, is:dirty...")
      .refreshable { await refreshFromPullGesture() }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(.hidden, for: .navigationBar)
      .safeAreaInset(edge: .top, spacing: 0) {
        ADERootTopBar(title: "Lanes") {
          topBarActions
        }
      }
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task(id: primaryBranchReloadKey) {
        guard primaryBranchReloadKey != nil else { return }
        await refreshPrimaryBranches(force: false)
      }
      .task(id: lanesProjectionReloadKey) {
        guard let revision = lanesProjectionReloadKey else { return }
        guard lastHandledLanesProjectionRevision != revision || laneSnapshots.isEmpty else { return }
        let now = Date()
        if !laneSnapshots.isEmpty {
          let elapsed = now.timeIntervalSince(lastLanesLocalProjectionReload)
          if elapsed < 0.35 {
            try? await Task.sleep(for: .milliseconds(max(1, Int((0.35 - elapsed) * 1_000))))
            guard !Task.isCancelled, lanesProjectionReloadKey == revision else { return }
          }
        }
        lastLanesLocalProjectionReload = Date()
        await reload(refreshRemote: false)
        guard !Task.isCancelled, lanesProjectionReloadKey == revision else { return }
        lastHandledLanesProjectionRevision = revision
      }
      .task(id: laneNavigationRequestKey) {
        guard laneNavigationRequestKey != nil else { return }
        await handleRequestedLaneNavigation()
      }
      .onChange(of: syncService.connectionState) { oldValue, newValue in
        guard isActive else { return }
        let wasOnline = oldValue == .connected || oldValue == .syncing
        let nowOnline = newValue == .connected || newValue == .syncing
        if wasOnline && !nowOnline {
          ADEHaptics.warning()
        }
      }
      .sheet(isPresented: $addLaneSheetPresented) {
        AddLaneSheet(
          primaryLane: primaryLane,
          lanes: laneSnapshots.map(\.lane),
          onLaneCreated: { createdLaneId in
            addLaneSheetPresented = false
            if !openLaneIds.contains(createdLaneId) {
              openLaneIds.insert(createdLaneId, at: 0)
            }
            await reload(refreshRemote: true)
          }
        )
      }
      .sheet(item: $detailSheetTarget) { target in
        NavigationStack {
          LaneDetailScreen(
            laneId: target.laneId,
            initialSnapshot: target.snapshot,
            allLaneSnapshots: laneSnapshots,
            initialSection: target.initialSection,
            onRefreshRoot: { await reload(refreshRemote: true) }
          )
        }
      }
      .sheet(isPresented: $batchManagePresented) {
        LaneBatchManageSheet(
          snapshots: laneSnapshots.filter { batchManageLaneIds.contains($0.lane.id) }
        ) {
          await reload(refreshRemote: true)
        }
      }
    }
  }

  // MARK: - Top bar

  @ViewBuilder
  private var topBarActions: some View {
    EmptyView()
  }

  @ViewBuilder
  var addLaneActionButton: some View {
    Button {
      if canRunLiveActions {
        addLaneSheetPresented = true
      } else {
        handleBlockedLiveAction()
      }
    } label: {
      HStack(spacing: 8) {
        Image(systemName: "plus")
          .font(.system(size: 13, weight: .bold))
        Text("Add lane")
          .font(.subheadline.weight(.semibold))
      }
      .foregroundStyle(.white)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 11)
      .background(ADEColor.accent, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: 12))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(.white.opacity(0.18), lineWidth: 0.6)
      )
      .shadow(color: ADEColor.accent.opacity(0.35), radius: 12, x: 0, y: 4)
    }
    .buttonStyle(.plain)
    .opacity(canRunLiveActions ? 1 : 0.55)
    .accessibilityLabel("Add lane")
    .accessibilityHint(canRunLiveActions ? "Opens lane creation options" : "Reconnect to desktop before creating lanes")
  }

  @ViewBuilder
  func primaryBranchPickerMenu<Label: View>(@ViewBuilder label: () -> Label) -> some View {
    if let primaryLane, !primaryBranches.isEmpty {
      Menu {
        ForEach(primaryBranches) { branch in
          Button(branch.name) {
            Task {
              do {
                try await syncService.checkoutPrimaryBranch(
                  laneId: primaryLane.id,
                  branchName: branch.name,
                  mode: "existing",
                  startPoint: nil,
                  baseRef: nil,
                  acknowledgeActiveWork: false
                )
                await reload(refreshRemote: true)
                await refreshPrimaryBranches(force: true)
              } catch {
                ADEHaptics.error()
                primaryBranchError = error.localizedDescription
              }
            }
          }
          .disabled(!canRunLiveActions)
        }
      } label: {
        label()
      }
      .accessibilityLabel("Primary branch")
    }
  }
}
