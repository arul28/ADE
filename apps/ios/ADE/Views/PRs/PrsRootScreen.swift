import SwiftUI
import UIKit

struct PRsTabView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject private var syncService: SyncService
  @Namespace private var prTransitionNamespace
  var isActive = true

  @State private var path = NavigationPath()
  @State private var prs: [PullRequestListItem] = []
  @State private var lanes: [LaneSummary] = []
  @State private var laneSnapshots: [LaneListSnapshot] = []
  @State private var integrationProposals: [IntegrationProposal] = []
  @State private var queueStates: [QueueLandingState] = []
  @State private var mobileSnapshot: PrMobileSnapshot?
  @State private var githubSnapshot: GitHubPrSnapshot?
  @State private var errorMessage: String?
  @State private var actionMessage: String?
  @State private var busyAction: String?
  @State private var createPresented = false
  @State private var stackPresentation: PrStackPresentation?
  @State private var refreshFeedbackToken = 0
  @State private var lastPrsLocalProjectionReload = Date.distantPast
  @State private var lastHandledPrsProjectionRevision: Int?
  @State private var lastPrsLiveSnapshotAttempt = Date.distantPast
  @State private var selectedPrTransitionId: String?
  @State private var laneContextLaneId: String?
  @State private var rootActionTask: Task<Void, Never>?
  @State private var githubDetailRequest: PrGitHubLaneLinkRequest?
  @State private var laneLinkRequest: PrGitHubLaneLinkRequest?
  @SceneStorage("ade.prs.rootSurface") private var rootSurfaceRawValue = PrRootSurface.github.rawValue
  @SceneStorage("ade.prs.workflowFilter") private var workflowFilterRawValue = PrWorkflowKindFilter.all.rawValue
  @SceneStorage("ade.prs.githubStatusFilter") private var githubStatusFilterRawValue = PrGitHubStatusFilter.open.rawValue
  @SceneStorage("ade.prs.githubScopeFilter") private var githubScopeFilterRawValue = PrGitHubScopeFilter.all.rawValue
  @SceneStorage("ade.prs.githubSort") private var githubSortRawValue = PrGitHubSortOption.updated.rawValue
  @State private var searchText = ""
  @State private var filtersExpanded = false

  private var hasActiveFilters: Bool {
    selectedGitHubScopeFilter.wrappedValue != .all
      || selectedGitHubStatusFilter.wrappedValue != .open
      || selectedGitHubSort.wrappedValue != .updated
  }

  /// Compact one-liner shown when filters are collapsed but non-default,
  /// e.g. "ADE-linked · Merged · sort newest".
  private var activeFilterSummary: String {
    var parts: [String] = []
    let scope = selectedGitHubScopeFilter.wrappedValue
    if scope != .all {
      parts.append(scope == .ade ? "ADE-linked" : "External")
    }
    let status = selectedGitHubStatusFilter.wrappedValue
    if status != .open {
      parts.append(status.rawValue.capitalized)
    }
    let sort = selectedGitHubSort.wrappedValue
    if sort != .updated {
      parts.append("Sort \(sort.title.lowercased())")
    }
    return parts.isEmpty ? "Filters" : parts.joined(separator: " · ")
  }

  private var prsStatus: SyncDomainStatus {
    syncService.status(for: .prs)
  }

  private var isLive: Bool {
    prsStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var isLoadingSkeleton: Bool {
    prsStatus.phase == .hydrating || prsStatus.phase == .syncingInitialData
  }

  private var selectedRootSurface: Binding<PrRootSurface> {
    Binding(
      get: { PrRootSurface(rawValue: rootSurfaceRawValue) ?? .github },
      set: { rootSurfaceRawValue = $0.rawValue }
    )
  }

  private var selectedWorkflowFilter: Binding<PrWorkflowKindFilter> {
    Binding(
      get: { PrWorkflowKindFilter(rawValue: workflowFilterRawValue) ?? .all },
      set: { workflowFilterRawValue = $0.rawValue }
    )
  }

  private var selectedGitHubStatusFilter: Binding<PrGitHubStatusFilter> {
    Binding(
      get: { PrGitHubStatusFilter(rawValue: githubStatusFilterRawValue) ?? .open },
      set: { githubStatusFilterRawValue = $0.rawValue }
    )
  }

  private var selectedGitHubScopeFilter: Binding<PrGitHubScopeFilter> {
    Binding(
      get: { PrGitHubScopeFilter(rawValue: githubScopeFilterRawValue) ?? .all },
      set: { githubScopeFilterRawValue = $0.rawValue }
    )
  }

  private var selectedGitHubSort: Binding<PrGitHubSortOption> {
    Binding(
      get: { PrGitHubSortOption(rawValue: githubSortRawValue) ?? .updated },
      set: { githubSortRawValue = $0.rawValue }
    )
  }

  private var filteredPrs: [PullRequestListItem] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let status = selectedGitHubStatusFilter.wrappedValue
    let scope = selectedGitHubScopeFilter.wrappedValue
    return prs.filter { item in
      matchesCachedPrStatus(item, status: status)
        && matchesCachedPrScope(item, scope: scope)
        && matchesCachedPrSearch(item, query: query)
    }
  }

  private var allGitHubPrs: [GitHubPrListItem] {
    (githubSnapshot?.repoPullRequests ?? []) + (githubSnapshot?.externalPullRequests ?? [])
  }

  private var filteredGitHubPrs: [GitHubPrListItem] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let status = selectedGitHubStatusFilter.wrappedValue
    let scope = selectedGitHubScopeFilter.wrappedValue
    let sort = selectedGitHubSort.wrappedValue
    return allGitHubPrs
      .filter { item in
        matchesGitHubStatus(item, status: status)
          && matchesGitHubScope(item, scope: scope)
          && matchesGitHubSearch(item, query: query)
      }
      .sorted { lhs, rhs in
        switch sort {
        case .updated:
          return (prParsedDate(lhs.updatedAt) ?? .distantPast) > (prParsedDate(rhs.updatedAt) ?? .distantPast)
        case .created:
          return (prParsedDate(lhs.createdAt) ?? .distantPast) > (prParsedDate(rhs.createdAt) ?? .distantPast)
        case .number:
          if lhs.repoOwner == rhs.repoOwner && lhs.repoName == rhs.repoName {
            return lhs.githubPrNumber > rhs.githubPrNumber
          }
          return "\(lhs.repoOwner)/\(lhs.repoName)" < "\(rhs.repoOwner)/\(rhs.repoName)"
        }
      }
  }

  private var githubFilterCounts: PrGitHubFilterCounts {
    let scope = selectedGitHubScopeFilter.wrappedValue
    let status = selectedGitHubStatusFilter.wrappedValue
    let scopedItems = allGitHubPrs.filter { matchesGitHubScope($0, scope: scope) }
    let statusItems = allGitHubPrs.filter { matchesGitHubStatus($0, status: status) }
    return PrGitHubFilterCounts(
      open: scopedItems.filter { matchesGitHubStatus($0, status: .open) }.count,
      merged: scopedItems.filter { matchesGitHubStatus($0, status: .merged) }.count,
      closed: scopedItems.filter { matchesGitHubStatus($0, status: .closed) }.count,
      all: scopedItems.count,
      ade: statusItems.filter { matchesGitHubScope($0, scope: .ade) }.count,
      external: statusItems.filter { matchesGitHubScope($0, scope: .external) }.count
    )
  }

  private var canLinkGitHubPullRequests: Bool {
    isLive && busyAction == nil && syncService.supportsRemoteAction("prs.linkToLane")
  }

  /// Prefer the unified `PrMobileSnapshot.workflowCards` payload when available; fall back to the
  /// legacy per-kind fetches (integrationProposals / queueStates / laneSnapshots-derived rebase)
  /// so offline cached state still renders if the mobile snapshot fetch failed.
  private var workflowCards: [PrWorkflowCard] {
    if let mobileSnapshot {
      return mobileSnapshot.workflowCards
    }
    return legacyWorkflowCards
  }

  private var legacyWorkflowCards: [PrWorkflowCard] {
    var cards: [PrWorkflowCard] = []

    for proposal in integrationProposals {
      cards.append(legacyIntegrationCard(from: proposal))
    }
    for queue in queueStates {
      cards.append(legacyQueueCard(from: queue))
    }
    for item in rebaseWorkflowItems {
      cards.append(legacyRebaseCard(from: item))
    }

    return cards
  }

  private var rebaseWorkflowItems: [PrRebaseWorkflowItem] {
    laneSnapshots.compactMap { snapshot in
      guard let suggestion = snapshot.rebaseSuggestion, suggestion.dismissedAt == nil else { return nil }
      let severity: String
      if snapshot.autoRebaseStatus?.state == "rebaseConflict" {
        severity = "critical"
      } else if suggestion.behindCount >= 10 {
        severity = "warning"
      } else {
        severity = "info"
      }

      let message = snapshot.autoRebaseStatus?.message
        ?? "\(snapshot.lane.name) is \(suggestion.behindCount) commit\(suggestion.behindCount == 1 ? "" : "s") behind its parent lane."

      return PrRebaseWorkflowItem(
        laneId: snapshot.lane.id,
        laneName: snapshot.lane.name,
        branchRef: snapshot.lane.branchRef,
        behindCount: suggestion.behindCount,
        severity: severity,
        statusMessage: message,
        deferredUntil: suggestion.deferredUntil
      )
    }
    .sorted { lhs, rhs in
      if lhs.severity == rhs.severity {
        return lhs.behindCount > rhs.behindCount
      }
      return severityRank(lhs.severity) < severityRank(rhs.severity)
    }
  }

  private var canCreatePr: Bool {
    if let createCaps = mobileSnapshot?.createCapabilities {
      return createCaps.canCreateAny && canRunWorkflowActions
    }
    return canRunWorkflowActions && !lanes.isEmpty
  }

  private var canRunWorkflowActions: Bool {
    isLive && busyAction == nil
  }

  private var prsProjectionReloadKey: Int? {
    isActive ? syncService.localStateRevision : nil
  }

  private var prNavigationRequestKey: String? {
    guard isActive else { return nil }
    return syncService.requestedPrNavigation?.id
  }

  private var syncEyebrow: String {
    if isLoadingSkeleton {
      return "HYDRATING…"
    }
    if !isLive {
      return "CACHED"
    }
    if let syncedAt = githubSnapshot?.syncedAt, !syncedAt.isEmpty {
      return "UP TO DATE · \(prRelativeTime(syncedAt).uppercased())"
    }
    return "UP TO DATE"
  }

  private var linkedPrCount: Int {
    allGitHubPrs.filter { $0.linkedPrId != nil || $0.linkedLaneId != nil || $0.adeKind != nil }.count
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        prsSearchPill

        if let notice = laneContextNotice {
          notice.prListRow()
        }

        if isLoadingSkeleton {
          ForEach(0..<3, id: \.self) { _ in
            ADECardSkeleton(rows: 3)
              .prListRow()
          }
        } else {
          // Suppress hydration and view-error banners when the host is
          // unreachable — the red gear dot is the single source of truth
          // for connection state.
          if !syncService.connectionState.isHostUnreachable,
            let hydrationNotice = prsStatus.inlineHydrationFailureNotice(for: .prs)
          {
            ADENoticeCard(
              title: hydrationNotice.title,
              message: hydrationNotice.message,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .prListRow()
          }
          if let errorMessage,
            prsStatus.phase == .ready,
            !syncService.connectionState.isHostUnreachable
          {
            ADENoticeCard(
              title: "PR view error",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .prListRow()
          }

          if let busyAction {
            HStack(spacing: 10) {
              ProgressView()
                .tint(ADEColor.accent)
              Text(busyAction)
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
              Spacer(minLength: 0)
            }
            .adeGlassCard(cornerRadius: 12, padding: 12)
            .prListRow()
          }

          if let actionMessage {
            ADENoticeCard(
              title: "PR workflow updated",
              message: actionMessage,
              icon: "checkmark.circle.fill",
              tint: ADEColor.success,
              actionTitle: nil,
              action: nil
            )
            .prListRow()
          }

          PrsSurfaceToggle(
            selection: selectedRootSurface,
            repoPrCount: allGitHubPrs.count,
            workflowCount: workflowCards.count
          )
          .padding(.top, 2)
          .prListRow()

          switch selectedRootSurface.wrappedValue {
          case .github:
            githubSurfaceRows
          case .workflows:
            workflowsSurfaceRows
          }
        }
      }
      .listStyle(.plain)
      .listRowSpacing(10)
      .scrollContentBackground(.hidden)
      .background { PrsLiquidBackdrop() }
      .adeNavigationGlass()
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(.hidden, for: .navigationBar)
      .safeAreaInset(edge: .top, spacing: 0) {
        prsInlineTopBar
      }
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task(id: prsProjectionReloadKey) {
        guard let revision = prsProjectionReloadKey else { return }
        guard lastHandledPrsProjectionRevision != revision || prs.isEmpty else { return }
        let now = Date()
        if !prs.isEmpty || githubSnapshot != nil || mobileSnapshot != nil {
          let elapsed = now.timeIntervalSince(lastPrsLocalProjectionReload)
          if elapsed < 0.35 {
            try? await Task.sleep(for: .milliseconds(max(1, Int((0.35 - elapsed) * 1_000))))
            guard !Task.isCancelled, prsProjectionReloadKey == revision else { return }
          }
        }
        lastPrsLocalProjectionReload = Date()
        await reload()
        guard !Task.isCancelled, prsProjectionReloadKey == revision else { return }
        lastHandledPrsProjectionRevision = revision
      }
      .task(id: prNavigationRequestKey) {
        guard prNavigationRequestKey != nil else { return }
        await handleRequestedPrNavigation()
      }
      .refreshable {
        await refreshFromPullGesture()
      }
      .onDisappear {
        rootActionTask?.cancel()
        rootActionTask = nil
      }
      .navigationDestination(for: String.self) { prId in
        PrDetailView(
          prId: prId,
          transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? prTransitionNamespace : nil
        )
          .environmentObject(syncService)
      }
      .sheet(isPresented: $createPresented) {
        createPrWizardSheet
      }
      .sheet(item: $stackPresentation) { presentation in
        PrStackSheet(groupId: presentation.id, groupName: presentation.groupName)
          .environmentObject(syncService)
      }
      .sheet(item: $githubDetailRequest) { request in
        PrGitHubReadDetailSheet(
          item: request.item,
          canLink: canLinkGitHubPullRequests,
          onLink: {
            githubDetailRequest = nil
            DispatchQueue.main.async {
              laneLinkRequest = request
            }
          },
          onOpenGitHub: {
            openGitHub(urlString: request.item.githubUrl)
          }
        )
      }
      .sheet(item: $laneLinkRequest) { request in
        PrLaneLinkSheet(
          item: request.item,
          lanes: lanes,
          canLink: canLinkGitHubPullRequests
        ) { laneId in
          runPrRootAction(
            "Linking pull request",
            operation: {
              try await syncService.linkPullRequestToLane(
                laneId: laneId,
                prUrlOrNumber: request.item.githubUrl.isEmpty ? "\(request.item.githubPrNumber)" : request.item.githubUrl
              )
            },
            onSuccess: {
              laneLinkRequest = nil
            }
          )
        } onOpenGitHub: {
          openGitHub(urlString: request.item.githubUrl)
        }
      }
    }
  }

  /// Count shown in the hero-header chip — matches whichever surface the user
  /// is currently viewing, so we don't flash "GitHub 42" in the title while
  /// the workflows surface is showing 3 cards.
  private var heroCount: Int {
    switch selectedRootSurface.wrappedValue {
    case .github:
      return githubSnapshot == nil ? filteredPrs.count : filteredGitHubPrs.count
    case .workflows:
      return groupedWorkflowCards.count
    }
  }

  /// Inline top bar — eyebrow + 32pt PRs title on the left, refresh +
  /// gradient-plus on the right, all in one row. Pulls the hero up so we
  /// stop wasting an entire scroll-row on whitespace.
  @ViewBuilder
  private var prsInlineTopBar: some View {
    HStack(alignment: .center, spacing: 12) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("PRs")
          .font(.system(size: 28, weight: .bold, design: .rounded))
          .tracking(-0.6)
          .foregroundStyle(PrsGlass.textPrimary)
          .shadow(color: Color.black.opacity(0.45), radius: 6, x: 0, y: 2)
          .lineLimit(1)
          .fixedSize(horizontal: true, vertical: false)
        if heroCount > 0 {
          Text("\(heroCount)")
            .font(.system(size: 11, weight: .bold, design: .monospaced))
            .foregroundStyle(PrsGlass.textMuted)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
              Capsule(style: .continuous)
                .fill(Color.white.opacity(0.06))
            )
            .overlay(
              Capsule(style: .continuous)
                .stroke(Color.white.opacity(0.10), lineWidth: 0.6)
            )
            .fixedSize()
        }
      }
      .layoutPriority(1)
      Spacer(minLength: 0)
      HStack(spacing: 8) {
        // Filter toggle — collapsed by default, expands the filter chip
        // panel inline in the list. Tints purple when any non-default
        // filter is active so users know they're looking at a subset.
        Button {
          withAnimation(.easeInOut(duration: 0.2)) {
            filtersExpanded.toggle()
          }
        } label: {
          let active = hasActiveFilters
          PrsGlassDisc(
            tint: active ? PrsGlass.accentTop : PrsGlass.textSecondary,
            isAlive: active
          ) {
            Image(systemName: filtersExpanded ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
              .font(.system(size: 14, weight: .bold))
              .foregroundStyle(active ? PrsGlass.accentTop : PrsGlass.textSecondary)
          }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(filtersExpanded ? "Hide filters" : "Show filters")

        Button {
          Task { await reload(refreshRemote: true) }
        } label: {
          PrsGlassDisc(tint: PrsGlass.textSecondary, isAlive: false) {
            Image(systemName: "arrow.clockwise")
              .font(.system(size: 13, weight: .bold))
              .foregroundStyle(PrsGlass.textSecondary)
          }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Refresh pull requests")
        .disabled(prsStatus.phase == .hydrating)

        Button {
          createPresented = true
        } label: {
          ZStack {
            Circle()
              .fill(
                LinearGradient(
                  colors: [PrsGlass.accentTop, PrsGlass.accentBottom],
                  startPoint: .topLeading,
                  endPoint: .bottomTrailing
                )
              )
              .frame(width: 34, height: 34)
              .overlay(
                Circle()
                  .strokeBorder(Color.white.opacity(0.45), lineWidth: 0.75)
              )
              .shadow(color: PrsGlass.glowPurple.opacity(0.55), radius: 10, x: 0, y: 3)
            Image(systemName: "plus")
              .font(.system(size: 15, weight: .bold))
              .foregroundStyle(.white)
          }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Create pull request")
        .disabled(!canCreatePr)
        .opacity(canCreatePr ? 1 : 0.4)

        // Global triad (laptop/grid/bell) — kept in PRs tab for parity with
        // every other tab. The user doesn't have to context-switch tabs to
        // reach connection status, project home, or attention.
        ADERootToolbarControls()
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 4)
    .padding(.bottom, 6)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }

  @ViewBuilder
  private var prsHeroHeader: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        PrsEyebrowLabel(text: "Open Pull Requests")
        PrsLivePulse(isLive: isLive, syncedLabel: syncSubtitle)
        Spacer(minLength: 0)
        if linkedPrCount > 0 {
          HStack(spacing: 4) {
            Image(systemName: "link")
              .font(.system(size: 9, weight: .bold))
            Text("\(linkedPrCount)")
              .font(.system(size: 10, weight: .bold, design: .monospaced))
          }
          .foregroundStyle(PrsGlass.textMuted)
        }
      }
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text("PRs")
          .font(.system(size: 32, weight: .bold, design: .rounded))
          .tracking(-0.8)
          .foregroundStyle(PrsGlass.textPrimary)
        if heroCount > 0 {
          Text("\(heroCount)")
            .font(.system(size: 13, weight: .bold, design: .monospaced))
            .foregroundStyle(PrsGlass.textMuted)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(
              Capsule(style: .continuous)
                .fill(Color.white.opacity(0.06))
            )
            .overlay(
              Capsule(style: .continuous)
                .stroke(Color.white.opacity(0.10), lineWidth: 0.6)
            )
        }
        Spacer(minLength: 0)
      }
    }
    .padding(.top, 0)
    .padding(.bottom, 0)
    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }

  @ViewBuilder
  private var prsSearchPill: some View {
    PrsGlassSearchPill(
      text: $searchText,
      placeholder: selectedRootSurface.wrappedValue == .github ? "Search PRs, branches, authors" : "Search workflow cards"
    )
    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)
  }

  @ViewBuilder
  private var compactStatusHeader: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      PrsLivePulse(isLive: isLive, syncedLabel: syncSubtitle)

      Spacer(minLength: 0)

      if linkedPrCount > 0 {
        HStack(spacing: 4) {
          Image(systemName: "link")
            .font(.system(size: 9, weight: .bold))
          Text("\(linkedPrCount) linked")
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
        }
        .foregroundStyle(PrsGlass.textMuted)
        .lineLimit(1)
      }
    }
    .padding(.horizontal, 4)
    .padding(.top, 4)
    .padding(.bottom, 6)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Pull request sync status: \(syncEyebrow)")
    .listRowBackground(Color.clear)
    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
    .listRowSeparator(.hidden)
  }

  private var syncSubtitle: String? {
    if isLoadingSkeleton { return "hydrating" }
    if !isLive { return "cached" }
    if let syncedAt = githubSnapshot?.syncedAt, !syncedAt.isEmpty {
      return "synced \(prRelativeTime(syncedAt))"
    }
    return nil
  }

  private var workflowKindCounts: [String: Int] {
    var counts: [String: Int] = [:]
    for card in workflowCards {
      counts[card.kind, default: 0] += 1
    }
    counts["all"] = workflowCards.count
    return counts
  }

  @ViewBuilder
  private var githubSurfaceRows: some View {
    if filtersExpanded {
      PrGitHubFiltersCard(
        statusFilter: selectedGitHubStatusFilter,
        scopeFilter: selectedGitHubScopeFilter,
        sortOption: selectedGitHubSort,
        counts: githubFilterCounts
      )
      .transition(.opacity.combined(with: .move(edge: .top)))
      .prListRow()
    } else if hasActiveFilters {
      // Compact summary chip when filters are collapsed but active.
      Button {
        withAnimation(.easeInOut(duration: 0.2)) { filtersExpanded = true }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "line.3.horizontal.decrease.circle.fill")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(PrsGlass.accentTop)
          Text(activeFilterSummary)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(PrsGlass.textSecondary)
            .lineLimit(1)
          Spacer(minLength: 0)
          Image(systemName: "chevron.down")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(PrsGlass.textMuted)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
          Capsule(style: .continuous)
            .fill(Color.white.opacity(0.05))
        )
        .overlay(
          Capsule(style: .continuous)
            .stroke(PrsGlass.accentTop.opacity(0.30), lineWidth: 0.75)
        )
      }
      .buttonStyle(.plain)
      .prListRow()
    }

    if prsStatus.phase == .ready && filteredPrs.isEmpty && filteredGitHubPrs.isEmpty {
      ADEEmptyStateView(
        symbol: searchText.isEmpty ? "arrow.triangle.pull" : "magnifyingglass",
        title: searchText.isEmpty ? "No pull requests for these filters" : "No PRs match this search",
        message: searchText.isEmpty
          ? "Try a different status or scope, or refresh GitHub state from the host."
          : "Try a broader query or switch the status and scope filters."
      )
      .prListRow()
    }

    if githubSnapshot == nil, !filteredPrs.isEmpty {
      Section("Cached ADE pull requests") {
        ForEach(filteredPrs) { pr in
          NavigationLink(value: pr.id) {
            PrRowCard(
              pr: pr,
              transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? prTransitionNamespace : nil,
              isSelectedTransitionSource: selectedPrTransitionId == pr.id
            ) { groupId, groupName in
              stackPresentation = PrStackPresentation(id: groupId, groupName: groupName)
            }
          }
          .simultaneousGesture(TapGesture().onEnded {
            selectedPrTransitionId = pr.id
          })
          .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            rowSwipeActions(for: pr)
          }
          .prListRow()
        }
      }
    }

    if githubSnapshot != nil {
      let repoItems = filteredGitHubPrs.filter { $0.scope != "external" }
      let externalItems = filteredGitHubPrs.filter { $0.scope == "external" }
      let repoSectionTitle: String = {
        if let repo = githubSnapshot?.repo {
          return "\(repo.owner)/\(repo.name)"
        }
        return "Repository PRs"
      }()
      if !repoItems.isEmpty {
        Section(repoSectionTitle) {
          ForEach(repoItems) { item in
            githubRowNavigation(for: item)
              .prListRow()
          }
        }
      }
      if !externalItems.isEmpty {
        let unmappedCount = externalItems.filter { $0.linkedPrId == nil && $0.scope != "external" }.count
        Section {
          ForEach(externalItems) { item in
            githubRowNavigation(for: item)
              .prListRow()
          }
        } header: {
          HStack(spacing: 6) {
            PrsEyebrowLabel(
              text: unmappedCount > 0
                ? "External · \(unmappedCount) unmapped"
                : "External",
              tint: PrsGlass.externalTop
            )
            Spacer(minLength: 0)
          }
          .padding(.top, 8)
          .padding(.bottom, 4)
          .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
          .listRowBackground(Color.clear)
          .textCase(nil)
        }
      }
    }
  }

  @ViewBuilder
  private func githubRowNavigation(for item: GitHubPrListItem) -> some View {
    if let prId = item.linkedPrId {
      Button {
        path.append(prId)
      } label: {
        PrRowCard(
          item: item,
          transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? prTransitionNamespace : nil,
          isSelectedTransitionSource: selectedPrTransitionId == prId
        )
      }
      .buttonStyle(.plain)
      .simultaneousGesture(TapGesture().onEnded { selectedPrTransitionId = prId })
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        Button("Open in GitHub") { openGitHub(urlString: item.githubUrl) }
          .tint(ADEColor.accent)
      }
    } else if item.scope == "external" {
      Button {
        openGitHub(urlString: item.githubUrl)
      } label: {
        PrRowCard(item: item)
      }
      .buttonStyle(.plain)
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        Button("Open in GitHub") { openGitHub(urlString: item.githubUrl) }
          .tint(ADEColor.accent)
      }
    } else {
      Button {
        githubDetailRequest = PrGitHubLaneLinkRequest(item: item)
      } label: {
        PrRowCard(
          item: item,
          onLink: canLinkGitHubPullRequests
            ? { laneLinkRequest = PrGitHubLaneLinkRequest(item: item) }
            : nil
        )
      }
      .buttonStyle(.plain)
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        Button("Review") {
          githubDetailRequest = PrGitHubLaneLinkRequest(item: item)
        }
        .tint(ADEColor.warning)
        if canLinkGitHubPullRequests {
          Button("Link") {
            laneLinkRequest = PrGitHubLaneLinkRequest(item: item)
          }
          .tint(ADEColor.tintPRs)
        }
        Button("Open in GitHub") { openGitHub(urlString: item.githubUrl) }
          .tint(ADEColor.accent)
      }
    }
  }

  @ViewBuilder
  private var workflowsSurfaceRows: some View {
    PrsWorkflowFilterPills(
      selection: selectedWorkflowFilter,
      counts: workflowKindCounts
    )
    .prListRow()

    if groupedWorkflowCards.isEmpty {
      ADEEmptyStateView(
        symbol: "point.3.filled.connected.trianglepath.dotted",
        title: "No active PR workflows",
        message: "Queue, integration, and rebase work appears here once the host syncs workflow state."
      )
      .prListRow()
    } else {
      ForEach(groupedWorkflowCards, id: \.title) { group in
        Section(group.title) {
          ForEach(group.cards) { card in
            PrMobileWorkflowCardView(
              card: card,
              isLive: canRunWorkflowActions,
              onOpenPr: { prId in path.append(prId) },
              onLand: { prId, method in
                runPrRootAction("Landing active PR") {
                  try await syncService.mergePullRequest(prId: prId, method: method.rawValue)
                }
              },
              onLandQueueNext: { groupId, method in
                runPrRootAction("Landing queue next") {
                  try await syncService.landQueueNext(groupId: groupId, method: method.rawValue)
                }
              },
              onPauseQueue: { queueId in
                runPrRootAction("Pausing queue") {
                  try await syncService.pauseQueueAutomation(queueId: queueId)
                }
              },
              onResumeQueue: { queueId, method in
                runPrRootAction("Resuming queue") {
                  try await syncService.resumeQueueAutomation(queueId: queueId, method: method.rawValue)
                }
              },
              onCancelQueue: { queueId in
                runPrRootAction("Canceling queue") {
                  try await syncService.cancelQueueAutomation(queueId: queueId)
                }
              },
              onReorderQueue: { groupId, prIds in
                runPrRootAction("Reordering queue") {
                  try await syncService.reorderQueue(groupId: groupId, prIds: prIds)
                }
              },
              onCreateIntegrationLane: { proposalId in
                runPrRootAction("Creating integration lane") {
                  _ = try await syncService.createIntegrationLaneForProposal(proposalId: proposalId)
                }
              },
              onDeleteIntegrationProposal: { proposalId in
                runPrRootAction("Deleting integration proposal") {
                  _ = try await syncService.deleteIntegrationProposal(proposalId: proposalId)
                }
              },
              onDismissIntegrationCleanup: { proposalId in
                runPrRootAction("Dismissing integration cleanup") {
                  try await syncService.dismissIntegrationCleanup(proposalId: proposalId)
                }
              },
              onCleanupIntegrationWorkflow: { proposalId, sourceLaneIds in
                runPrRootAction("Cleaning up integration lanes") {
                  try await syncService.cleanupIntegrationWorkflow(
                    proposalId: proposalId,
                    archiveIntegrationLane: true,
                    archiveSourceLaneIds: sourceLaneIds
                  )
                }
              },
              onResolveIntegrationLane: { proposalId, laneId in
                runPrRootAction("Resolving integration lane") {
                  _ = try await syncService.startIntegrationResolution(proposalId: proposalId, laneId: laneId)
                }
              },
              onRecheckIntegrationLane: { proposalId, laneId in
                runPrRootAction("Rechecking integration lane") {
                  _ = try await syncService.recheckIntegrationStep(proposalId: proposalId, laneId: laneId)
                }
              },
              onRebaseLane: { laneId in
                runPrRootAction("Rebasing lane") {
                  try await syncService.startLaneRebase(laneId: laneId)
                }
              },
              onDeferRebase: { laneId in
                runPrRootAction("Deferring rebase") {
                  try await syncService.deferRebaseSuggestion(laneId: laneId)
                }
              },
              onDismissRebase: { laneId in
                runPrRootAction("Dismissing rebase") {
                  try await syncService.dismissRebaseSuggestion(laneId: laneId)
                }
              }
            )
            .prListRow()
          }
        }
      }
    }
  }

  @ViewBuilder
  private func rowSwipeActions(for pr: PullRequestListItem) -> some View {
    let caps = mobileSnapshot?.capabilities[pr.id]

    Button("Open in GitHub") {
      openGitHub(urlString: pr.githubUrl)
    }
    .tint(ADEColor.accent)

    Button("Copy URL") {
      UIPasteboard.general.string = pr.githubUrl
      ADEHaptics.success()
    }
    .tint(ADEColor.textSecondary)

    if caps?.canClose ?? (pr.state == "open") {
      Button("Close", role: .destructive) {
        runPrRootAction("Closing pull request") {
          try await syncService.closePullRequest(prId: pr.id)
        }
      }
    } else if caps?.canReopen ?? (pr.state == "closed") {
      Button("Reopen") {
        runPrRootAction("Reopening pull request") {
          try await syncService.reopenPullRequest(prId: pr.id)
        }
      }
      .tint(ADEColor.success)
    }
  }

  private struct WorkflowCardGroup {
    let title: String
    let cards: [PrWorkflowCard]
  }

  private var groupedWorkflowCards: [WorkflowCardGroup] {
    let cards = workflowCards.filter { card in
      let selected = selectedWorkflowFilter.wrappedValue
      guard selected != .all else { return true }
      return card.kind == selected.rawValue
    }
    guard !cards.isEmpty else { return [] }

    let queue = cards.filter { $0.kind == "queue" }
    let integration = cards.filter { $0.kind == "integration" }
    let rebase = cards.filter { $0.kind == "rebase" }

    var groups: [WorkflowCardGroup] = []
    if !queue.isEmpty {
      groups.append(WorkflowCardGroup(title: "Queue", cards: queue))
    }
    if !integration.isEmpty {
      groups.append(WorkflowCardGroup(title: "Integration", cards: integration))
    }
    if !rebase.isEmpty {
      groups.append(WorkflowCardGroup(title: "Rebase", cards: rebase))
    }
    return groups
  }

  private func matchesGitHubStatus(_ item: GitHubPrListItem, status: PrGitHubStatusFilter) -> Bool {
    switch status {
    case .all:
      return true
    case .open:
      return item.state == "open" || item.isDraft
    case .merged:
      return item.state == "merged"
    case .closed:
      return item.state == "closed"
    }
  }

  private func matchesGitHubScope(_ item: GitHubPrListItem, scope: PrGitHubScopeFilter) -> Bool {
    switch scope {
    case .all:
      return true
    case .ade:
      return item.adeKind != nil || item.linkedPrId != nil || item.linkedLaneId != nil
    case .external:
      return item.adeKind == nil && item.linkedPrId == nil && item.linkedLaneId == nil
    }
  }

  private func matchesCachedPrStatus(_ item: PullRequestListItem, status: PrGitHubStatusFilter) -> Bool {
    switch status {
    case .all:
      return true
    case .open:
      return item.state == "open" || item.state == "draft"
    case .merged:
      return item.state == "merged"
    case .closed:
      return item.state == "closed"
    }
  }

  private func matchesCachedPrScope(_ item: PullRequestListItem, scope: PrGitHubScopeFilter) -> Bool {
    switch scope {
    case .all, .ade:
      return true
    case .external:
      return false
    }
  }

  private func matchesCachedPrSearch(_ item: PullRequestListItem, query: String) -> Bool {
    guard !query.isEmpty else { return true }
    let haystack = [
      item.title,
      item.headBranch,
      item.baseBranch,
      item.laneName,
      item.repoOwner,
      item.repoName,
      item.adeKind,
      item.workflowDisplayState,
      "#\(item.githubPrNumber)",
      "\(item.githubPrNumber)",
    ]
    .compactMap { $0?.lowercased() }
    .joined(separator: " ")
    return haystack.contains(query)
  }

  private func matchesGitHubSearch(_ item: GitHubPrListItem, query: String) -> Bool {
    guard !query.isEmpty else { return true }
    let haystack = [
      item.title,
      item.author,
      item.repoOwner,
      item.repoName,
      item.baseBranch,
      item.headBranch,
      item.linkedLaneName,
      item.adeKind,
      item.workflowDisplayState,
      "#\(item.githubPrNumber)",
      "\(item.githubPrNumber)",
    ]
    .compactMap { $0?.lowercased() }
    .joined(separator: " ")
    return haystack.contains(query) || item.labels.contains { $0.name.lowercased().contains(query) }
  }

  private var laneContextNotice: ADENoticeCard? {
    guard let laneContextLaneId else { return nil }
    let laneName = lanes.first(where: { $0.id == laneContextLaneId })?.name ?? "lane context"
    return ADENoticeCard(
      title: "Opened from \(laneName)",
      message: "Review the linked pull request or keep scanning PRs from the native tab.",
      icon: "arrow.triangle.pull",
      tint: ADEColor.accent,
      actionTitle: "Clear",
      action: { self.laneContextLaneId = nil }
    )
  }

  @MainActor
  private func refreshFromPullGesture() async {
    await reload(refreshRemote: true)
    if errorMessage == nil {
      withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
        refreshFeedbackToken += 1
      }
    }
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      var refreshError: Error?
      if refreshRemote {
        do {
          try await syncService.refreshPullRequestSnapshots()
          try await syncService.refreshLaneSnapshots()
        } catch {
          refreshError = error
        }
      }

      async let prsTask = syncService.fetchPullRequestListItems()
      async let lanesTask = syncService.fetchLanes()

      let loadedPrs = try await prsTask
      let loadedLanes = try await lanesTask
      if prs != loadedPrs {
        prs = loadedPrs
      }
      if lanes != loadedLanes {
        lanes = loadedLanes
      }

      let now = Date()
      let missingLiveSnapshot = mobileSnapshot == nil || githubSnapshot == nil
      let shouldAttemptLiveSnapshots = isLive
        && (refreshRemote || missingLiveSnapshot || now.timeIntervalSince(lastPrsLiveSnapshotAttempt) >= 10)

      var nextMobileSnapshot: PrMobileSnapshot?
      if shouldAttemptLiveSnapshots {
        lastPrsLiveSnapshotAttempt = now
        let mobileSnapshotTask = Task { try? await syncService.fetchPrMobileSnapshot() }
        let githubSnapshotTask = Task { try? await syncService.fetchGitHubPullRequestSnapshot(force: refreshRemote) }
        nextMobileSnapshot = await mobileSnapshotTask.value
        if let nextGithubSnapshot = await githubSnapshotTask.value, githubSnapshot != nextGithubSnapshot {
          githubSnapshot = nextGithubSnapshot
        }
      }

      if !isLive {
        if mobileSnapshot != nil {
          mobileSnapshot = nil
        }
        if githubSnapshot != nil {
          githubSnapshot = nil
        }
      }
      if let nextMobileSnapshot {
        if mobileSnapshot != nextMobileSnapshot {
          mobileSnapshot = nextMobileSnapshot
        }
        if !laneSnapshots.isEmpty {
          laneSnapshots = []
        }
        if !integrationProposals.isEmpty {
          integrationProposals = []
        }
        if !queueStates.isEmpty {
          queueStates = []
        }
      } else if mobileSnapshot == nil {
        async let laneSnapshotsTask = syncService.fetchLaneListSnapshots()
        async let integrationTask = syncService.fetchIntegrationProposals()
        async let queueTask = syncService.fetchQueueStates()

        let loadedLaneSnapshots = try await laneSnapshotsTask
        let loadedIntegrationProposals = try await integrationTask
        let loadedQueueStates = try await queueTask
        if laneSnapshots != loadedLaneSnapshots {
          laneSnapshots = loadedLaneSnapshots
        }
        if integrationProposals != loadedIntegrationProposals {
          integrationProposals = loadedIntegrationProposals
        }
        if queueStates != loadedQueueStates {
          queueStates = loadedQueueStates
        }
      }

      let message = refreshError?.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    } catch {
      let message = error.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    }
  }

  @MainActor
  private func handleRequestedPrNavigation() async {
    guard let request = syncService.requestedPrNavigation else { return }
    rootSurfaceRawValue = PrRootSurface.github.rawValue
    selectedPrTransitionId = request.prId
    laneContextLaneId = request.laneId
    path = NavigationPath()
    path.append(request.prId)
    syncService.requestedPrNavigation = nil
  }

  @MainActor
  @ViewBuilder
  private var createPrWizardSheet: some View {
    CreatePrWizardView(
      lanes: lanes,
      createCapabilities: mobileSnapshot?.createCapabilities,
      onCreateSingle: handleCreateSinglePr,
      onCreateQueue: handleCreateQueuePrs,
      onCreateIntegration: handleCreateIntegrationPr
    )
    .environmentObject(syncService)
  }

  private func handleCreateSinglePr(
    laneId: String,
    title: String,
    body: String,
    draft: Bool,
    baseBranch: String,
    labels: [String],
    reviewers: [String],
    strategy: String?
  ) {
    runPrRootAction(
      "Creating pull request",
      operation: {
        try await syncService.createPullRequest(
          laneId: laneId,
          title: title,
          body: body,
          draft: draft,
          baseBranch: baseBranch,
          labels: labels,
          reviewers: reviewers,
          strategy: strategy
        )
      },
      onSuccess: {
        createPresented = false
      }
    )
  }

  private func handleCreateQueuePrs(_ request: CreateQueuePrsRequest) {
    runPrRootAction(
      "Creating queue PRs",
      operation: {
        _ = try await syncService.createQueuePrs(
          laneIds: request.laneIds,
          targetBranch: request.baseBranch,
          titles: request.titles,
          draft: request.draft,
          autoRebase: request.autoRebase,
          ciGating: request.ciGating,
          queueName: request.queueName,
          allowDirtyWorktree: nil
        )
      },
      onSuccess: {
        createPresented = false
      }
    )
  }

  private func handleCreateIntegrationPr(_ request: CreateIntegrationRequest) {
    runPrRootAction(
      "Creating integration PR",
      operation: {
        let proposal = try await syncService.simulateIntegration(
          sourceLaneIds: request.sourceLaneIds,
          baseBranch: request.baseBranch,
          persist: true,
          mergeIntoLaneId: nil
        )
        // Conflict path: the desktop surfaces a dedicated conflict
        // resolution UI; on iOS v1 we bail out with a friendly error
        // so the host sheet can re-surface. v2 TODO: render the
        // pairwise conflict matrix inline.
        if proposal.status == "conflict" || proposal.overallOutcome == "conflict" {
          throw PrWizardError.integrationConflict
        }
        _ = try await syncService.commitIntegration(
          proposalId: proposal.proposalId,
          integrationLaneName: request.integrationLaneName,
          title: request.title,
          body: request.body,
          draft: request.draft,
          pauseOnConflict: true,
          allowDirtyWorktree: nil,
          preferredIntegrationLaneId: nil
        )
      },
      onSuccess: {
        createPresented = false
      }
    )
  }

  private func runPrRootAction(
    _ label: String,
    operation: @escaping () async throws -> Void,
    onSuccess: @escaping @MainActor () -> Void = {}
  ) {
    rootActionTask?.cancel()
    let task = Task { @MainActor in
      busyAction = label
      errorMessage = nil
      actionMessage = nil
      do {
        try await operation()
        guard !Task.isCancelled else {
          busyAction = nil
          return
        }
        onSuccess()
        guard !Task.isCancelled else {
          busyAction = nil
          return
        }
        await reload(refreshRemote: true)
        guard !Task.isCancelled else {
          busyAction = nil
          return
        }
        actionMessage = "\(label) finished."
      } catch {
        guard !Task.isCancelled else {
          busyAction = nil
          return
        }
        let message = error.localizedDescription
        await reload(refreshRemote: false)
        guard !Task.isCancelled else {
          busyAction = nil
          return
        }
        errorMessage = message
      }
      busyAction = nil
    }
    rootActionTask = task
  }

  private func openGitHub(urlString: String) {
    guard let url = URL(string: urlString) else { return }
    UIApplication.shared.open(url)
  }

  // MARK: - Legacy → unified workflow card adapters
  //
  // These let the root screen keep rendering queue/integration/rebase state when the mobile
  // snapshot fetch isn't available (older desktop build, or cold cache). Once every host the
  // user pairs with supports `prs.getMobileSnapshot` these can be dropped.

  private func legacyQueueCard(from queue: QueueLandingState) -> PrWorkflowCard {
    PrWorkflowCard(
      id: "queue:\(queue.id)",
      kind: "queue",
      queueId: queue.queueId,
      groupId: queue.groupId,
      groupName: queue.groupName,
      targetBranch: queue.targetBranch,
      state: queue.state,
      activePrId: queue.activePrId,
      currentPosition: nil,
      totalEntries: queue.entries.count,
      entries: queue.entries,
      waitReason: queue.waitReason,
      lastError: queue.lastError,
      updatedAt: nil,
      proposalId: nil,
      title: nil,
      baseBranch: nil,
      overallOutcome: nil,
      integrationStatus: nil,
      laneCount: nil,
      conflictLaneCount: nil,
      lanes: nil,
      workflowDisplayState: nil,
      cleanupState: nil,
      linkedPrId: nil,
      integrationLaneId: nil,
      preferredIntegrationLaneId: nil,
      mergeIntoHeadSha: nil,
      integrationLaneOrigin: nil,
      createdAt: nil,
      laneId: nil,
      laneName: nil,
      behindBy: nil,
      conflictPredicted: nil,
      prId: nil,
      prNumber: nil,
      dismissedAt: nil,
      deferredUntil: nil
    )
  }

  private func legacyIntegrationCard(from proposal: IntegrationProposal) -> PrWorkflowCard {
    PrWorkflowCard(
      id: "integration:\(proposal.id)",
      kind: "integration",
      queueId: nil,
      groupId: nil,
      groupName: nil,
      targetBranch: nil,
      state: nil,
      activePrId: nil,
      currentPosition: nil,
      totalEntries: nil,
      entries: nil,
      waitReason: nil,
      lastError: nil,
      updatedAt: nil,
      proposalId: proposal.id,
      title: proposal.title ?? proposal.integrationLaneName,
      baseBranch: proposal.baseBranch,
      overallOutcome: proposal.overallOutcome,
      integrationStatus: proposal.status,
      laneCount: proposal.laneSummaries.count,
      conflictLaneCount: proposal.laneSummaries.filter { $0.outcome == "conflict" }.count,
      lanes: proposal.laneSummaries.map {
        PrIntegrationWorkflowLane(laneId: $0.laneId, laneName: $0.laneName, outcome: $0.outcome)
      },
      workflowDisplayState: proposal.workflowDisplayState,
      cleanupState: proposal.cleanupState,
      linkedPrId: proposal.linkedPrId,
      integrationLaneId: proposal.integrationLaneId,
      preferredIntegrationLaneId: proposal.preferredIntegrationLaneId,
      mergeIntoHeadSha: proposal.mergeIntoHeadSha,
      integrationLaneOrigin: proposal.integrationLaneOrigin,
      createdAt: nil,
      laneId: nil,
      laneName: nil,
      behindBy: nil,
      conflictPredicted: nil,
      prId: nil,
      prNumber: nil,
      dismissedAt: nil,
      deferredUntil: nil
    )
  }

  private func legacyRebaseCard(from item: PrRebaseWorkflowItem) -> PrWorkflowCard {
    PrWorkflowCard(
      id: "rebase:\(item.laneId)",
      kind: "rebase",
      queueId: nil,
      groupId: nil,
      groupName: nil,
      targetBranch: nil,
      state: nil,
      activePrId: nil,
      currentPosition: nil,
      totalEntries: nil,
      entries: nil,
      waitReason: nil,
      lastError: nil,
      updatedAt: nil,
      proposalId: nil,
      title: nil,
      baseBranch: nil,
      overallOutcome: nil,
      integrationStatus: nil,
      laneCount: nil,
      conflictLaneCount: nil,
      lanes: nil,
      workflowDisplayState: nil,
      cleanupState: nil,
      linkedPrId: nil,
      integrationLaneId: nil,
      preferredIntegrationLaneId: nil,
      mergeIntoHeadSha: nil,
      integrationLaneOrigin: nil,
      createdAt: nil,
      laneId: item.laneId,
      laneName: item.laneName,
      behindBy: item.behindCount,
      conflictPredicted: item.severity == "critical",
      prId: nil,
      prNumber: nil,
      dismissedAt: nil,
      deferredUntil: item.deferredUntil
    )
  }
}

private struct PrGitHubReadDetailSheet: View {
  @Environment(\.dismiss) private var dismiss
  let item: GitHubPrListItem
  let canLink: Bool
  let onLink: () -> Void
  let onOpenGitHub: () -> Void

  private var stateLabel: String {
    item.isDraft ? "draft" : item.state
  }

  private var headBranch: String {
    item.headBranch?.isEmpty == false ? item.headBranch! : "unknown branch"
  }

  private var baseBranch: String {
    item.baseBranch?.isEmpty == false ? item.baseBranch! : "unknown base"
  }

  var body: some View {
    PrLiquidSheetShell(
      title: "PR details",
      trailingLabel: "Done",
      onTrailing: { dismiss() }
    ) {
      VStack(alignment: .leading, spacing: 14) {
        // Hero: number + state + EXTERNAL chip + title.
        VStack(alignment: .leading, spacing: 12) {
          HStack(spacing: 8) {
            Text("#\(item.githubPrNumber)")
              .font(.system(size: 22, weight: .bold, design: .monospaced))
              .foregroundStyle(PrGlassPalette.success)
              .shadow(color: PrGlassPalette.success.opacity(0.45), radius: 8)

            PrTagChip(label: stateLabel, color: prStateTint(stateLabel))

            PrExternalInfoChip()

            Spacer(minLength: 0)
          }

          Text(item.title)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(PrsGlass.textPrimary)
            .tracking(-0.2)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        VStack(spacing: 8) {
          PrGlassMonoRow(
            eyebrow: "Repo",
            value: "\(item.repoOwner)/\(item.repoName)",
            icon: "chevron.left.slash.chevron.right"
          )
          PrGlassMonoRow(
            eyebrow: "Branches",
            value: "\(headBranch) → \(baseBranch)",
            icon: "arrow.triangle.branch"
          )
          PrGlassMonoRow(
            eyebrow: "Author",
            value: (item.author?.isEmpty == false) ? "@\(item.author!)" : "unknown",
            icon: "person.fill"
          )
          PrGlassMonoRow(
            eyebrow: "Updated",
            value: prRelativeTime(item.updatedAt),
            icon: "clock"
          )
        }

        // Unmapped / linked-lane CTA card.
        HStack(alignment: .top, spacing: 12) {
          ZStack {
            Circle()
              .fill(PrGlassPalette.purple.opacity(0.22))
            Image(systemName: "link.badge.plus")
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(PrGlassPalette.purpleBright)
          }
          .frame(width: 34, height: 34)

          VStack(alignment: .leading, spacing: 4) {
            Text("Not linked to an ADE lane")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(PrsGlass.textPrimary)
            Text("Review the branch and author, then link this PR into a lane to track it inside ADE.")
              .font(.system(size: 11))
              .foregroundStyle(PrsGlass.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }

          Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .prGlassCard(cornerRadius: 14, tint: PrGlassPalette.purple.opacity(0.55), shadow: false)

        VStack(spacing: 10) {
          Button {
            onLink()
          } label: {
            Label("Link to lane", systemImage: "link")
          }
          .buttonStyle(PrGlassPrimaryButtonStyle())
          .disabled(!canLink)

          Button {
            onOpenGitHub()
          } label: {
            Label("Open on GitHub", systemImage: "arrow.up.right.square")
          }
          .buttonStyle(PrGlassOutlineButtonStyle())
        }
        .padding(.top, 4)
      }
      .padding(16)
    }
  }
}

private struct PrLaneLinkSheet: View {
  @Environment(\.dismiss) private var dismiss
  let item: GitHubPrListItem
  let lanes: [LaneSummary]
  let canLink: Bool
  let onLink: (String) -> Void
  let onOpenGitHub: () -> Void
  @State private var selectedLaneId = ""

  private var availableLanes: [LaneSummary] {
    lanes
      .filter { $0.archivedAt == nil && $0.laneType != "primary" }
      .sorted { lhs, rhs in lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending }
  }

  var body: some View {
    PrLiquidSheetShell(
      title: "Link to lane",
      trailingLabel: "Cancel",
      onTrailing: { dismiss() }
    ) {
      VStack(alignment: .leading, spacing: 14) {
        // PR summary card.
        VStack(alignment: .leading, spacing: 6) {
          Text(item.title)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(PrsGlass.textPrimary)
            .fixedSize(horizontal: false, vertical: true)

          Text("#\(item.githubPrNumber) · \(item.repoOwner)/\(item.repoName)")
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(PrsGlass.textSecondary)

          if let head = item.headBranch, let base = item.baseBranch {
            Text("\(head) → \(base)")
              .font(.system(size: 11, design: .monospaced))
              .foregroundStyle(PrsGlass.textSecondary)
          }

          HStack(spacing: 6) {
            if let author = item.author, !author.isEmpty {
              Text("@\(author)")
            }
            Text("· updated \(prRelativeTime(item.updatedAt))")
          }
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(PrsGlass.textMuted)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .prGlassCard(cornerRadius: 14, shadow: false)

        if !canLink {
          HStack(alignment: .center, spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(PrGlassPalette.warning)
            Text("Reconnect to a host that supports PR lane linking.")
              .font(.system(size: 11))
              .foregroundStyle(PrGlassPalette.warning)
              .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .prGlassCard(cornerRadius: 12, tint: PrGlassPalette.warning.opacity(0.45), shadow: false)
        }

        VStack(alignment: .leading, spacing: 8) {
          PrsEyebrowLabel(text: "Lane")
            .padding(.horizontal, 2)

          Text(laneSelectionMessage)
            .font(.system(size: 11))
            .foregroundStyle(laneSelectionTint)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 2)
            .padding(.bottom, 2)

          if availableLanes.isEmpty {
            HStack(spacing: 10) {
              Image(systemName: "tray")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PrsGlass.textMuted)
              Text("No eligible lanes are available to link.")
                .font(.system(size: 12))
                .foregroundStyle(PrsGlass.textSecondary)
              Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .prGlassCard(cornerRadius: 12, shadow: false)
          } else {
            VStack(spacing: 6) {
              ForEach(availableLanes) { lane in
                PrGlassLaneRow(
                  name: lane.name,
                  branch: lane.branchRef,
                  isSelected: selectedLaneId == lane.id
                ) {
                  selectedLaneId = lane.id
                }
              }
            }
          }
        }

        VStack(spacing: 10) {
          Button {
            onLink(selectedLaneId)
          } label: {
            Label("Link to lane", systemImage: "link")
          }
          .buttonStyle(PrGlassPrimaryButtonStyle())
          .disabled(!canLink || selectedLaneId.isEmpty)

          Button {
            onOpenGitHub()
          } label: {
            Label("Open on GitHub", systemImage: "arrow.up.right.square")
          }
          .buttonStyle(PrGlassOutlineButtonStyle())
        }
        .padding(.top, 4)
      }
      .padding(16)
    }
    .onAppear {
      if selectedLaneId.isEmpty {
        selectedLaneId = item.linkedLaneId ?? exactBranchMatchedLane?.id ?? ""
      }
    }
  }

  private var exactBranchMatchedLane: LaneSummary? {
    matchedLaneForExactBranch(item.headBranch, lanes: availableLanes)
  }

  private var laneSelectionMessage: String {
    if let exactBranchMatchedLane, selectedLaneId == exactBranchMatchedLane.id {
      return "Preselected because the PR branch matches \(exactBranchMatchedLane.branchRef)."
    }
    if selectedLaneId.isEmpty {
      return "No lane was preselected because the PR branch does not exactly match an ADE lane."
    }
    return "Confirm this lane before linking; ADE will attach this GitHub PR to the selected lane."
  }

  private var laneSelectionTint: Color {
    selectedLaneId.isEmpty ? PrGlassPalette.warning : PrsGlass.textSecondary
  }
}

// MARK: - File-private liquid-glass primitives (sheets)

/// Standard liquid-glass sheet shell: deep-ink backdrop, 36×5 grab handle,
/// inline title bar with a single trailing label (Done/Cancel).
private struct PrLiquidSheetShell<Content: View>: View {
  let title: String
  let trailingLabel: String
  let onTrailing: () -> Void
  @ViewBuilder let content: () -> Content

  var body: some View {
    ZStack {
      prLiquidGlassBackdrop().ignoresSafeArea()

      VStack(spacing: 0) {
        Capsule(style: .continuous)
          .fill(Color.white.opacity(0.25))
          .frame(width: 36, height: 5)
          .padding(.top, 8)
          .padding(.bottom, 8)

        HStack {
          Text(title)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(PrsGlass.textPrimary)
          Spacer(minLength: 0)
          Button(action: onTrailing) {
            Text(trailingLabel)
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(PrGlassPalette.purpleBright)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
          Rectangle()
            .fill(Color.white.opacity(0.06))
            .frame(height: 0.5)
        }

        ScrollView {
          content()
        }
      }
    }
    .presentationDetents([.large])
    .presentationDragIndicator(.hidden)
  }
}

/// Small "EXTERNAL" info chip used on the GitHub PR detail sheet.
private struct PrExternalInfoChip: View {
  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: "arrow.up.right.square.fill")
        .font(.system(size: 9, weight: .bold))
      Text("EXTERNAL")
        .font(.system(size: 9, weight: .bold))
        .tracking(1.0)
    }
    .foregroundStyle(PrGlassPalette.blue)
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(
      Capsule(style: .continuous)
        .fill(PrGlassPalette.blue.opacity(0.18))
    )
    .overlay(
      Capsule(style: .continuous)
        .strokeBorder(PrGlassPalette.blue.opacity(0.35), lineWidth: 0.75)
    )
  }
}

/// Glass row: eyebrow label + monospaced value, with a small glyph disc.
private struct PrGlassMonoRow: View {
  let eyebrow: String
  let value: String
  let icon: String

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      ZStack {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Color.white.opacity(0.06))
          .frame(width: 30, height: 30)
        Image(systemName: icon)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(PrsGlass.textSecondary)
      }

      VStack(alignment: .leading, spacing: 2) {
        Text(eyebrow.uppercased())
          .font(.system(size: 9, weight: .bold))
          .tracking(1.0)
          .foregroundStyle(PrsGlass.textMuted)
        Text(value)
          .font(.system(size: 12, design: .monospaced))
          .foregroundStyle(PrsGlass.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
      }

      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 12, shadow: false)
  }
}

/// Lane row for the Lane-Link sheet: lane-icon disc + name + mono branch +
/// selection checkmark.
private struct PrGlassLaneRow: View {
  let name: String
  let branch: String
  let isSelected: Bool
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(alignment: .center, spacing: 12) {
        ZStack {
          if isSelected {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
              .fill(PrGlassPalette.accentGradient)
          } else {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
              .fill(Color.white.opacity(0.06))
          }
          Image(systemName: "arrow.triangle.branch")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(isSelected ? Color.white : PrsGlass.textSecondary)
        }
        .frame(width: 32, height: 32)

        VStack(alignment: .leading, spacing: 2) {
          Text(name)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(PrsGlass.textPrimary)
            .lineLimit(1)
          Text(branch)
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(PrsGlass.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }

        Spacer(minLength: 0)

        if isSelected {
          Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(PrGlassPalette.purpleBright)
        } else {
          Circle()
            .strokeBorder(Color.white.opacity(0.18), lineWidth: 1)
            .frame(width: 17, height: 17)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .prGlassCard(
        cornerRadius: 12,
        tint: isSelected ? PrGlassPalette.purple.opacity(0.55) : nil,
        strokeOpacity: isSelected ? 0.22 : 0.10,
        shadow: false
      )
    }
    .buttonStyle(.plain)
  }
}

/// Gradient primary CTA (purple, with glow + inner highlight).
private struct PrGlassPrimaryButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(Color.white)
      .frame(maxWidth: .infinity)
      .frame(height: 44)
      .background(
        ZStack {
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(PrGlassPalette.accentGradient)
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(
              LinearGradient(
                colors: [Color.white.opacity(0.45), Color.white.opacity(0.05)],
                startPoint: .top,
                endPoint: .bottom
              ),
              lineWidth: 1
            )
        }
      )
      .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1.0) : 0.45)
      .shadow(
        color: PrGlassPalette.purpleDeep.opacity(isEnabled ? 0.45 : 0.0),
        radius: 16,
        x: 0,
        y: 6
      )
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

/// Glass-outline secondary CTA.
private struct PrGlassOutlineButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(PrsGlass.textPrimary)
      .frame(maxWidth: .infinity)
      .frame(height: 44)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(.ultraThinMaterial)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
      )
      .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1.0) : 0.45)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

// MARK: - Wizard-surfaced errors

fileprivate enum PrWizardError: LocalizedError {
  case integrationConflict

  var errorDescription: String? {
    switch self {
    case .integrationConflict:
      return "Integration has conflicts — simulate in full first"
    }
  }
}
