import SwiftUI
import UIKit

private let prIsoFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

private let prIsoFallbackFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  return formatter
}()

struct PrActionAvailability: Equatable {
  let showsMerge: Bool
  let mergeEnabled: Bool
  let showsClose: Bool
  let showsReopen: Bool
  let showsRequestReviewers: Bool

  init(prState: String) {
    switch prState {
    case "open":
      showsMerge = true
      mergeEnabled = true
      showsClose = true
      showsReopen = false
      showsRequestReviewers = true
    case "draft":
      showsMerge = true
      mergeEnabled = false
      showsClose = false
      showsReopen = false
      showsRequestReviewers = true
    case "closed":
      showsMerge = false
      mergeEnabled = false
      showsClose = false
      showsReopen = true
      showsRequestReviewers = false
    default:
      showsMerge = false
      mergeEnabled = false
      showsClose = false
      showsReopen = false
      showsRequestReviewers = false
    }
  }
}

enum PrListStateFilter: String, CaseIterable, Identifiable {
  case all
  case open
  case draft
  case closed
  case merged

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .open: return "Open"
    case .draft: return "Draft"
    case .closed: return "Closed"
    case .merged: return "Merged"
    }
  }
}

func filterPullRequestListItems(
  _ items: [PullRequestListItem],
  query: String,
  state: PrListStateFilter
) -> [PullRequestListItem] {
  let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

  return items.filter { item in
    let matchesState: Bool = {
      switch state {
      case .all:
        return true
      case .open:
        return item.state == "open"
      case .draft:
        return item.state == "draft"
      case .closed:
        return item.state == "closed"
      case .merged:
        return item.state == "merged"
      }
    }()

    guard matchesState else { return false }
    guard !normalizedQuery.isEmpty else { return true }

    let haystack = [
      item.title,
      item.headBranch,
      item.baseBranch,
      item.laneName ?? "",
      item.adeKind ?? "",
      "#\(item.githubPrNumber)",
    ].joined(separator: " ").lowercased()

    return haystack.contains(normalizedQuery)
  }
}

enum PrDiffDisplayLineKind: Equatable {
  case hunk
  case context
  case added
  case removed
  case note
}

struct PrDiffDisplayLine: Identifiable, Equatable {
  var id: String {
    "\(kind)-\(oldLineNumber ?? -1)-\(newLineNumber ?? -1)-\(prefix)-\(text)"
  }

  let kind: PrDiffDisplayLineKind
  let prefix: String
  let text: String
  let oldLineNumber: Int?
  let newLineNumber: Int?
}

func parsePullRequestPatch(_ patch: String) -> [PrDiffDisplayLine] {
  guard !patch.isEmpty else { return [] }

  let headerRegex = try? NSRegularExpression(pattern: #"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#)
  var oldLineNumber = 0
  var newLineNumber = 0

  return patch.components(separatedBy: "\n").map { line in
    if line.hasPrefix("@@") {
      if let headerRegex,
         let match = headerRegex.firstMatch(in: line, range: NSRange(location: 0, length: line.utf16.count)),
         match.numberOfRanges == 3,
         let oldRange = Range(match.range(at: 1), in: line),
         let newRange = Range(match.range(at: 2), in: line) {
        oldLineNumber = Int(line[oldRange]) ?? 0
        newLineNumber = Int(line[newRange]) ?? 0
      }
      return PrDiffDisplayLine(kind: .hunk, prefix: "@@", text: line, oldLineNumber: nil, newLineNumber: nil)
    }

    if line.hasPrefix("+") && !line.hasPrefix("+++") {
      let display = PrDiffDisplayLine(kind: .added, prefix: "+", text: String(line.dropFirst()), oldLineNumber: nil, newLineNumber: newLineNumber)
      newLineNumber += 1
      return display
    }

    if line.hasPrefix("-") && !line.hasPrefix("---") {
      let display = PrDiffDisplayLine(kind: .removed, prefix: "-", text: String(line.dropFirst()), oldLineNumber: oldLineNumber, newLineNumber: nil)
      oldLineNumber += 1
      return display
    }

    if line.hasPrefix(" ") {
      let display = PrDiffDisplayLine(kind: .context, prefix: " ", text: String(line.dropFirst()), oldLineNumber: oldLineNumber, newLineNumber: newLineNumber)
      oldLineNumber += 1
      newLineNumber += 1
      return display
    }

    return PrDiffDisplayLine(kind: .note, prefix: "", text: line, oldLineNumber: nil, newLineNumber: nil)
  }
}

enum PrTimelineEventKind: Equatable {
  case stateChange
  case review
  case comment
}

struct PrTimelineEvent: Identifiable, Equatable {
  let id: String
  let kind: PrTimelineEventKind
  let title: String
  let author: String?
  let body: String?
  let timestamp: String
  let metadata: String?
}

func buildPullRequestTimeline(pr: PullRequestListItem, snapshot: PullRequestSnapshot) -> [PrTimelineEvent] {
  var events: [PrTimelineEvent] = [
    PrTimelineEvent(
      id: "state-opened-\(pr.id)",
      kind: .stateChange,
      title: pr.state == "draft" ? "Draft opened" : "Opened",
      author: snapshot.detail?.author.login,
      body: nil,
      timestamp: pr.createdAt,
      metadata: "\(pr.headBranch) → \(pr.baseBranch)"
    )
  ]

  for review in snapshot.reviews {
    events.append(
      PrTimelineEvent(
        id: "review-\(review.id)",
        kind: .review,
        title: titleCase(review.state.replacingOccurrences(of: "_", with: " ")),
        author: review.reviewer,
        body: review.body,
        timestamp: review.submittedAt ?? pr.updatedAt,
        metadata: nil
      )
    )
  }

  for comment in snapshot.comments {
    let locationText: String?
    if let path = comment.path, let line = comment.line {
      locationText = "\(path):\(line)"
    } else {
      locationText = comment.path
    }

    events.append(
      PrTimelineEvent(
        id: "comment-\(comment.id)",
        kind: .comment,
        title: comment.source == "review" ? "Review comment" : "Comment",
        author: comment.author,
        body: comment.body,
        timestamp: comment.updatedAt ?? comment.createdAt ?? pr.updatedAt,
        metadata: locationText
      )
    )
  }

  let finalState = snapshot.status?.state ?? pr.state
  if finalState == "merged" || finalState == "closed" {
    events.append(
      PrTimelineEvent(
        id: "state-\(finalState)-\(pr.id)",
        kind: .stateChange,
        title: finalState == "merged" ? "Merged" : "Closed",
        author: nil,
        body: nil,
        timestamp: pr.updatedAt,
        metadata: nil
      )
    )
  }

  return events.sorted {
    (prParsedDate($0.timestamp) ?? .distantPast) > (prParsedDate($1.timestamp) ?? .distantPast)
  }
}

private enum PrMergeMethodOption: String, CaseIterable, Identifiable {
  case squash
  case merge
  case rebase

  var id: String { rawValue }

  var title: String {
    switch self {
    case .squash: return "Squash and merge"
    case .merge: return "Create a merge commit"
    case .rebase: return "Rebase and merge"
    }
  }

  var shortTitle: String {
    switch self {
    case .squash: return "Squash"
    case .merge: return "Merge"
    case .rebase: return "Rebase"
    }
  }

  var description: String {
    switch self {
    case .squash: return "Combine all commits into one clean commit."
    case .merge: return "Preserve the branch history with a merge commit."
    case .rebase: return "Replay commits onto the base branch for linear history."
    }
  }
}

private enum PrDetailTab: String, CaseIterable, Identifiable {
  case overview
  case files
  case checks
  case activity

  var id: String { rawValue }

  var title: String {
    switch self {
    case .overview: return "Overview"
    case .files: return "Files"
    case .checks: return "Checks"
    case .activity: return "Activity"
    }
  }
}

private struct PrStackPresentation: Identifiable {
  let id: String
  let groupName: String?
}

private struct PrRebaseWorkflowItem: Identifiable {
  let laneId: String
  let laneName: String
  let branchRef: String
  let behindCount: Int
  let severity: String
  let statusMessage: String
  let deferredUntil: String?

  var id: String { laneId }
}

private enum PrCleanupChoice {
  case archive
  case deleteBranch
}

struct PRsTabView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject private var syncService: SyncService
  @Namespace private var prTransitionNamespace

  @State private var path = NavigationPath()
  @State private var prs: [PullRequestListItem] = []
  @State private var lanes: [LaneSummary] = []
  @State private var laneSnapshots: [LaneListSnapshot] = []
  @State private var integrationProposals: [IntegrationProposal] = []
  @State private var queueStates: [QueueLandingState] = []
  @State private var errorMessage: String?
  @State private var createPresented = false
  @State private var stackPresentation: PrStackPresentation?
  @State private var refreshFeedbackToken = 0
  @State private var lastPrsLocalProjectionReload = Date.distantPast
  @State private var selectedPrTransitionId: String?
  @State private var laneContextLaneId: String?
  @SceneStorage("ade.prs.stateFilter") private var stateFilterRawValue = PrListStateFilter.all.rawValue
  @State private var searchText = ""

  private var prsStatus: SyncDomainStatus {
    syncService.status(for: .prs)
  }

  private var isLive: Bool {
    prsStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !prs.isEmpty
  }

  private var isLoadingSkeleton: Bool {
    prsStatus.phase == .hydrating || prsStatus.phase == .syncingInitialData
  }

  private var selectedStateFilter: Binding<PrListStateFilter> {
    Binding(
      get: { PrListStateFilter(rawValue: stateFilterRawValue) ?? .all },
      set: { stateFilterRawValue = $0.rawValue }
    )
  }

  private var filteredPrs: [PullRequestListItem] {
    filterPullRequestListItems(prs, query: searchText, state: selectedStateFilter.wrappedValue)
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

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let notice = laneContextNotice {
          notice.prListRow()
        }

        if isLoadingSkeleton {
          ForEach(0..<3, id: \.self) { _ in
            ADECardSkeleton(rows: 3)
              .prListRow()
          }
        } else {
          PrFiltersCard(
            stateFilter: selectedStateFilter,
            visibleCount: filteredPrs.count,
            totalCount: prs.count,
            isLive: isLive,
            onRefresh: { Task { await reload(refreshRemote: true) } }
          )
          .prListRow()

          if let errorMessage, prsStatus.phase == .ready {
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

          if prsStatus.phase == .ready && filteredPrs.isEmpty {
            ADEEmptyStateView(
              symbol: searchText.isEmpty ? "arrow.triangle.pull" : "magnifyingglass",
              title: searchText.isEmpty ? "No pull requests on this host" : "No PRs match this search",
              message: searchText.isEmpty
                ? "Open PRs and workflow lanes will appear here once the host syncs GitHub state to iPhone."
                : "Try a broader title query or switch the state filter."
            )
            .prListRow()
          }

          if !filteredPrs.isEmpty {
            Section("Pull requests") {
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
                  Button("Open") {
                    openGitHub(urlString: pr.githubUrl)
                  }
                  .tint(ADEColor.accent)

                  if pr.state == "open" {
                    Button("Close", role: .destructive) {
                      Task {
                        try? await syncService.closePullRequest(prId: pr.id)
                        await reload(refreshRemote: true)
                      }
                    }
                  } else if pr.state == "closed" {
                    Button("Reopen") {
                      Task {
                        try? await syncService.reopenPullRequest(prId: pr.id)
                        await reload(refreshRemote: true)
                      }
                    }
                    .tint(ADEColor.success)
                  }
                }
                .prListRow()
              }
            }
          }

          if !integrationProposals.isEmpty {
            Section("Integration") {
              ForEach(integrationProposals) { proposal in
                IntegrationWorkflowCard(proposal: proposal) { prId in
                  path.append(prId)
                }
                .prListRow()
              }
            }
          }

          if !queueStates.isEmpty {
            Section("Queue") {
              ForEach(queueStates) { queueState in
                QueueWorkflowCard(
                  queueState: queueState,
                  isLive: isLive,
                  onOpenPr: { prId in path.append(prId) },
                  onLand: { prId, method in
                    Task {
                      try? await syncService.mergePullRequest(prId: prId, method: method.rawValue)
                      await reload(refreshRemote: true)
                    }
                  },
                  onRebaseLane: { laneId in
                    Task {
                      try? await syncService.startLaneRebase(laneId: laneId)
                      await reload(refreshRemote: true)
                    }
                  }
                )
                .prListRow()
              }
            }
          }

          if !rebaseWorkflowItems.isEmpty {
            Section("Rebase") {
              ForEach(rebaseWorkflowItems) { item in
                RebaseWorkflowCard(
                  item: item,
                  onRebase: {
                    Task {
                      try? await syncService.startLaneRebase(laneId: item.laneId)
                      await reload(refreshRemote: true)
                    }
                  },
                  onDefer: {
                    Task {
                      try? await syncService.deferRebaseSuggestion(laneId: item.laneId)
                      await reload(refreshRemote: true)
                    }
                  },
                  onDismiss: {
                    Task {
                      try? await syncService.dismissRebaseSuggestion(laneId: item.laneId)
                      await reload(refreshRemote: true)
                    }
                  }
                )
                .prListRow()
              }
            }
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("PRs")
      .navigationBarTitleDisplayMode(.inline)
      .searchable(text: $searchText, prompt: "Search PR titles")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          ADEConnectionPill()
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button {
            Task { await reload(refreshRemote: true) }
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .accessibilityLabel("Refresh pull requests")
          .disabled(prsStatus.phase == .hydrating)

          Button {
            createPresented = true
          } label: {
            Image(systemName: "plus")
          }
          .accessibilityLabel("Create pull request")
          .disabled(!isLive || lanes.isEmpty)
        }
      }

      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task {
        await reload()
      }
      .task(id: syncService.localStateRevision) {
        let now = Date()
        guard now.timeIntervalSince(lastPrsLocalProjectionReload) >= 0.35 else { return }
        lastPrsLocalProjectionReload = now
        await reload()
      }
      .refreshable {
        await refreshFromPullGesture()
      }
      .onChange(of: syncService.requestedPrNavigation?.id) { _, requestId in
        guard requestId != nil, let prId = syncService.requestedPrNavigation?.prId else { return }
        stateFilterRawValue = PrListStateFilter.all.rawValue
        selectedPrTransitionId = prId
        laneContextLaneId = syncService.requestedPrNavigation?.laneId
        path = NavigationPath()
        path.append(prId)
        syncService.requestedPrNavigation = nil
      }
      .navigationDestination(for: String.self) { prId in
        PrDetailView(
          prId: prId,
          transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? prTransitionNamespace : nil
        )
          .environmentObject(syncService)
      }
      .sheet(isPresented: $createPresented) {
        CreatePrWizardView(lanes: lanes) { laneId, title, body, draft, baseBranch, labels, reviewers in
          Task {
            try? await syncService.createPullRequest(
              laneId: laneId,
              title: title,
              body: body,
              draft: draft,
              baseBranch: baseBranch,
              labels: labels,
              reviewers: reviewers
            )
            try? await syncService.refreshPullRequestSnapshots()
            createPresented = false
            await reload()
          }
        }
        .environmentObject(syncService)
      }
      .sheet(item: $stackPresentation) { presentation in
        PrStackSheet(groupId: presentation.id, groupName: presentation.groupName)
          .environmentObject(syncService)
      }
    }
  }

  private var laneContextNotice: ADENoticeCard? {
    guard let laneContextLaneId else { return nil }
    let laneName = laneSnapshots.first(where: { $0.lane.id == laneContextLaneId })?.lane.name ?? "lane context"
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
      if refreshRemote {
        try? await syncService.refreshPullRequestSnapshots()
        try? await syncService.refreshLaneSnapshots()
      }

      async let prsTask = syncService.fetchPullRequestListItems()
      async let lanesTask = syncService.fetchLanes()
      async let laneSnapshotsTask = syncService.fetchLaneListSnapshots()
      async let integrationTask = syncService.fetchIntegrationProposals()
      async let queueTask = syncService.fetchQueueStates()

      prs = try await prsTask
      lanes = try await lanesTask
      laneSnapshots = try await laneSnapshotsTask
      integrationProposals = try await integrationTask
      queueStates = try await queueTask
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func openGitHub(urlString: String) {
    guard let url = URL(string: urlString) else { return }
    UIApplication.shared.open(url)
  }

  private var statusNotice: ADENoticeCard? {
    switch prsStatus.phase {
    case .disconnected:
      return ADENoticeCard(
        title: prs.isEmpty ? "Host disconnected" : "Showing cached PRs",
        message: prs.isEmpty
          ? (syncService.activeHostProfile == nil
              ? "Pair with a host to hydrate pull requests, stacks, and workflow state."
              : "Reconnect to hydrate pull requests, stacks, and workflow state.")
          : (needsRepairing
              ? "Cached PR state is still visible, but the previous host trust was cleared. Pair again before trusting review or workflow status."
              : "Cached PR state is visible. Reconnect before trusting live merge, review, or queue readiness."),
        icon: "arrow.triangle.pull",
        tint: ADEColor.warning,
        actionTitle: syncService.activeHostProfile == nil ? (needsRepairing ? "Pair again" : "Pair with host") : "Reconnect",
        action: {
          if syncService.activeHostProfile == nil {
            syncService.settingsPresented = true
          } else {
            Task {
              await syncService.reconnectIfPossible(userInitiated: true)
              await reload(refreshRemote: true)
            }
          }
        }
      )
    case .hydrating:
      return ADENoticeCard(
        title: "Hydrating pull requests",
        message: "Refreshing PR summaries, stack relationships, and cached detail so iPhone does not show partial state.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.accent,
        actionTitle: nil,
        action: nil
      )
    case .syncingInitialData:
      return ADENoticeCard(
        title: "Syncing initial data",
        message: "Waiting for the host to finish syncing project data before PR hydration starts.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    case .failed:
      return ADENoticeCard(
        title: "PR hydration failed",
        message: prsStatus.lastError ?? "The host PR state did not hydrate cleanly.",
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
    case .ready:
      return nil
    }
  }
}

private struct PrFiltersCard: View {
  @Binding var stateFilter: PrListStateFilter
  let visibleCount: Int
  let totalCount: Int
  let isLive: Bool
  let onRefresh: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text("PR list")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("\(visibleCount) of \(totalCount) pull requests visible")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 12)

        if !isLive {
          ADEStatusPill(text: "CACHED", tint: ADEColor.warning)
        }

        Button(action: onRefresh) {
          Image(systemName: "arrow.clockwise")
            .font(.body.weight(.semibold))
        }
        .buttonStyle(.glass)
        .tint(ADEColor.accent)
      }

      HStack(spacing: 12) {
        Label("State", systemImage: "line.3.horizontal.decrease.circle")
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.textSecondary)
        Picker("State", selection: $stateFilter) {
          ForEach(PrListStateFilter.allCases) { filter in
            Text(filter.title).tag(filter)
          }
        }
        .pickerStyle(.menu)
        Spacer(minLength: 0)
      }
      .adeInsetField(cornerRadius: 14, padding: 12)
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct PrRowCard: View {
  let pr: PullRequestListItem
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool
  let onShowStack: (String, String?) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 6) {
          Text(pr.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "pr-title-\(pr.id)" : nil, in: transitionNamespace)

          HStack(spacing: 8) {
            Text("#\(pr.githubPrNumber)")
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
            if let laneName = pr.laneName, !laneName.isEmpty {
              Text(laneName)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }
          }
        }

        Spacer(minLength: 8)

        VStack(alignment: .trailing, spacing: 6) {
          ADEStatusPill(text: pr.state.uppercased(), tint: prStateTint(pr.state))
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "pr-status-\(pr.id)" : nil, in: transitionNamespace)
          if let adeKindLabel = prAdeKindLabel(pr.adeKind) {
            ADEStatusPill(text: adeKindLabel, tint: ADEColor.accent)
          }
        }
      }

      Text("\(pr.headBranch) → \(pr.baseBranch)")
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)

      HStack(spacing: 10) {
        PrSignalChip(icon: "circle.fill", text: prChecksLabel(pr.checksStatus), tint: prChecksTint(pr.checksStatus))
        PrSignalChip(icon: reviewSymbol(pr.reviewStatus), text: prReviewLabel(pr.reviewStatus), tint: prReviewTint(pr.reviewStatus))

        if let groupId = pr.linkedGroupId, pr.linkedGroupCount > 1 {
          Button {
            onShowStack(groupId, pr.linkedGroupName)
          } label: {
            Label("\(pr.linkedGroupCount)", systemImage: "list.number")
              .font(.caption.weight(.semibold))
          }
          .buttonStyle(.glass)
          .tint(ADEColor.textSecondary)
        }

        Spacer(minLength: 0)

        Text("+\(pr.additions) -\(pr.deletions)")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .adeListCard()
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "pr-container-\(pr.id)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("PR #\(pr.githubPrNumber): \(pr.title), state \(pr.state), checks \(pr.checksStatus), review \(pr.reviewStatus)")
  }
}

private struct PrSignalChip: View {
  let icon: String
  let text: String
  let tint: Color

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: icon)
        .font(.caption2.weight(.bold))
      Text(text)
        .font(.caption2.weight(.semibold))
    }
    .foregroundStyle(tint)
  }
}

private struct PrDetailView: View {
  @EnvironmentObject private var syncService: SyncService
  let prId: String
  let transitionNamespace: Namespace.ID?

  @State private var pr: PullRequestListItem?
  @State private var snapshot: PullRequestSnapshot?
  @State private var groupMembers: [PrGroupMemberSummary] = []
  @State private var selectedTab: PrDetailTab = .overview
  @State private var mergeMethod: PrMergeMethodOption = .squash
  @State private var reviewerInput = ""
  @State private var commentInput = ""
  @State private var errorMessage: String?
  @State private var cleanupChoice: PrCleanupChoice = .archive
  @State private var cleanupConfirmationPresented = false

  private var prsStatus: SyncDomainStatus {
    syncService.status(for: .prs)
  }

  private var isLive: Bool {
    prsStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var currentPr: PullRequestListItem {
    pr ?? PullRequestListItem(
      id: prId,
      laneId: "",
      laneName: nil,
      projectId: "",
      repoOwner: "",
      repoName: "",
      githubPrNumber: 0,
      githubUrl: "",
      title: "Pull request",
      state: snapshot?.status?.state ?? "open",
      baseBranch: "",
      headBranch: "",
      checksStatus: snapshot?.status?.checksStatus ?? "none",
      reviewStatus: snapshot?.status?.reviewStatus ?? "none",
      additions: 0,
      deletions: 0,
      lastSyncedAt: nil,
      createdAt: "",
      updatedAt: "",
      adeKind: nil,
      linkedGroupId: nil,
      linkedGroupType: nil,
      linkedGroupName: nil,
      linkedGroupPosition: nil,
      linkedGroupCount: 0,
      workflowDisplayState: nil,
      cleanupState: nil
    )
  }

  private var actionAvailability: PrActionAvailability {
    PrActionAvailability(prState: snapshot?.status?.state ?? currentPr.state)
  }

  private var canRerunChecks: Bool {
    syncService.supportsRemoteAction("prs.rerunChecks")
  }

  private var canAddComment: Bool {
    syncService.supportsRemoteAction("prs.addComment")
  }

  var body: some View {
    List {
      if let errorMessage {
        ADENoticeCard(
          title: "PR detail failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: { Task { await reload(refreshRemote: true) } }
        )
        .prListRow()
      }

      PrHeaderCard(pr: currentPr, transitionNamespace: transitionNamespace)
        .prListRow()

      Picker("Detail tab", selection: $selectedTab) {
        ForEach(PrDetailTab.allCases) { tab in
          Text(tab.title).tag(tab)
        }
      }
      .pickerStyle(.segmented)
      .prListRow()

      switch selectedTab {
      case .overview:
        PrOverviewTab(
          pr: currentPr,
          snapshot: snapshot,
          actionAvailability: actionAvailability,
          mergeMethod: $mergeMethod,
          reviewerInput: $reviewerInput,
          isLive: isLive,
          groupMembers: groupMembers,
          onMerge: mergeCurrentPr,
          onClose: closeCurrentPr,
          onReopen: reopenCurrentPr,
          onRequestReviewers: requestReviewers,
          onOpenGitHub: { openGitHub(urlString: currentPr.githubUrl) },
          onArchiveLane: {
            cleanupChoice = .archive
            cleanupConfirmationPresented = true
          },
          onDeleteBranch: {
            cleanupChoice = .deleteBranch
            cleanupConfirmationPresented = true
          }
        )
        .prListRow()
      case .files:
        PrFilesTab(snapshot: snapshot)
          .prListRow()
      case .checks:
        PrChecksTab(
          checks: snapshot?.checks ?? [],
          canRerunChecks: canRerunChecks,
          isLive: isLive,
          onRerun: rerunChecks
        )
        .prListRow()
      case .activity:
        PrActivityTab(
          timeline: buildPullRequestTimeline(pr: currentPr, snapshot: snapshot ?? PullRequestSnapshot(detail: nil, status: nil, checks: [], reviews: [], comments: [], files: [])),
          commentInput: $commentInput,
          canAddComment: canAddComment,
          isLive: isLive,
          onSubmitComment: submitComment
        )
        .prListRow()
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(currentPr.title)
    .navigationBarTitleDisplayMode(.inline)
    .adeNavigationZoomTransition(id: transitionNamespace == nil ? nil : "pr-container-\(prId)", in: transitionNamespace)
    .task {
      await reload()
    }
    .task(id: syncService.localStateRevision) {
      await reload()
    }
    .alert(cleanupChoice == .archive ? "Archive lane?" : "Delete lane and branch?", isPresented: $cleanupConfirmationPresented) {
      Button(cleanupChoice == .archive ? "Archive" : "Delete", role: cleanupChoice == .archive ? nil : .destructive) {
        Task { await performCleanup() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(cleanupChoice == .archive
        ? "This keeps the lane for history but removes it from the active stack."
        : "This removes the lane from ADE and asks the host to delete the branch as part of cleanup.")
    }
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try? await syncService.refreshPullRequestSnapshots(prId: prId)
      }
      let listItems = try await syncService.fetchPullRequestListItems()
      pr = listItems.first(where: { $0.id == prId })
      snapshot = try await syncService.fetchPullRequestSnapshot(prId: prId)
      if let groupId = pr?.linkedGroupId {
        groupMembers = try await syncService.fetchPullRequestGroupMembers(groupId: groupId)
      } else {
        groupMembers = []
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func mergeCurrentPr() {
    Task {
      try? await syncService.mergePullRequest(prId: prId, method: mergeMethod.rawValue)
      await reload(refreshRemote: true)
    }
  }

  private func closeCurrentPr() {
    Task {
      try? await syncService.closePullRequest(prId: prId)
      await reload(refreshRemote: true)
    }
  }

  private func reopenCurrentPr() {
    Task {
      try? await syncService.reopenPullRequest(prId: prId)
      await reload(refreshRemote: true)
    }
  }

  private func requestReviewers() {
    let reviewers = reviewerInput
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }

    guard !reviewers.isEmpty else { return }

    Task {
      try? await syncService.requestReviewers(prId: prId, reviewers: reviewers)
      reviewerInput = ""
      await reload(refreshRemote: true)
    }
  }

  private func rerunChecks() {
    Task {
      try? await syncService.rerunPullRequestChecks(prId: prId)
      await reload(refreshRemote: true)
    }
  }

  private func submitComment() {
    let trimmed = commentInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    Task {
      try? await syncService.addPullRequestComment(prId: prId, body: trimmed)
      commentInput = ""
      await reload(refreshRemote: true)
    }
  }

  private func performCleanup() async {
    guard let laneId = pr?.laneId, !laneId.isEmpty else { return }
    switch cleanupChoice {
    case .archive:
      try? await syncService.archiveLane(laneId)
    case .deleteBranch:
      try? await syncService.deleteLane(laneId, deleteBranch: true, deleteRemoteBranch: true)
    }
    await reload(refreshRemote: true)
  }

  private func openGitHub(urlString: String) {
    guard let url = URL(string: urlString) else { return }
    UIApplication.shared.open(url)
  }
}

private struct PrHeaderCard: View {
  let pr: PullRequestListItem
  let transitionNamespace: Namespace.ID?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 6) {
          Text(pr.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "pr-title-\(pr.id)", in: transitionNamespace)
          Text("#\(pr.githubPrNumber) · \(pr.headBranch) → \(pr.baseBranch)")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        ADEStatusPill(text: pr.state.uppercased(), tint: prStateTint(pr.state))
          .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "pr-status-\(pr.id)", in: transitionNamespace)
      }

      HStack(spacing: 8) {
        if let laneName = pr.laneName, !laneName.isEmpty {
          ADEStatusPill(text: laneName.uppercased(), tint: ADEColor.textSecondary)
        }
        if let label = prAdeKindLabel(pr.adeKind) {
          ADEStatusPill(text: label, tint: ADEColor.accent)
        }
        Spacer(minLength: 0)
        Text("Updated \(prRelativeTime(pr.updatedAt))")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .adeListCard()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("PR #\(pr.githubPrNumber), \(pr.title), state \(pr.state)")
  }
}

private struct PrOverviewTab: View {
  let pr: PullRequestListItem
  let snapshot: PullRequestSnapshot?
  let actionAvailability: PrActionAvailability
  @Binding var mergeMethod: PrMergeMethodOption
  @Binding var reviewerInput: String
  let isLive: Bool
  let groupMembers: [PrGroupMemberSummary]
  let onMerge: () -> Void
  let onClose: () -> Void
  let onReopen: () -> Void
  let onRequestReviewers: () -> Void
  let onOpenGitHub: () -> Void
  let onArchiveLane: () -> Void
  let onDeleteBranch: () -> Void

  private var mergeable: Bool {
    (snapshot?.status?.isMergeable ?? true) && !(snapshot?.status?.mergeConflicts ?? false)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrDetailSectionCard("Description") {
        if let body = snapshot?.detail?.body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          PrMarkdownRenderer(markdown: body)
        } else {
          Text("No description was synced for this PR yet.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      PrDetailSectionCard("Overview") {
        VStack(alignment: .leading, spacing: 10) {
          HStack(spacing: 8) {
            ADEStatusPill(text: prChecksLabel(snapshot?.status?.checksStatus ?? pr.checksStatus), tint: prChecksTint(snapshot?.status?.checksStatus ?? pr.checksStatus))
            ADEStatusPill(text: prReviewLabel(snapshot?.status?.reviewStatus ?? pr.reviewStatus), tint: prReviewTint(snapshot?.status?.reviewStatus ?? pr.reviewStatus))
            if let cleanupState = pr.cleanupState, !cleanupState.isEmpty {
              ADEStatusPill(text: cleanupState.uppercased(), tint: ADEColor.warning)
            }
          }

          Text("Author: \(snapshot?.detail?.author.login ?? "Unknown")")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)

          if let detail = snapshot?.detail {
            if !detail.requestedReviewers.isEmpty {
              PrChipWrap(users: detail.requestedReviewers.map(\.login), tint: ADEColor.warning)
            }
            if !detail.labels.isEmpty {
              PrChipWrap(users: detail.labels.map(\.name), tint: ADEColor.accent)
            }
            if !detail.linkedIssues.isEmpty {
              Text(detail.linkedIssues.map { "#\($0.number) \($0.title)" }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }

          if !groupMembers.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              Text("Stack")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              ForEach(groupMembers) { member in
                Text("\(member.position + 1). #\(member.githubPrNumber) · \(member.title)")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
            }
          }
        }
      }

      PrDetailSectionCard("Merge readiness") {
        VStack(alignment: .leading, spacing: 10) {
          Label(
            mergeable ? "Ready to merge" : "Needs attention before merge",
            systemImage: mergeable ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
          )
          .foregroundStyle(mergeable ? ADEColor.success : ADEColor.warning)

          if let status = snapshot?.status {
            if status.mergeConflicts {
              Text("The host reported merge conflicts for this branch.")
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
            }
            if status.behindBaseBy > 0 {
              Text("This branch is \(status.behindBaseBy) commit\(status.behindBaseBy == 1 ? "" : "s") behind the base branch.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
        }
      }

      PrDetailSectionCard("Actions") {
        VStack(alignment: .leading, spacing: 12) {
          Picker("Merge strategy", selection: $mergeMethod) {
            ForEach(PrMergeMethodOption.allCases) { option in
              Text(option.shortTitle).tag(option)
            }
          }
          .pickerStyle(.menu)
          .adeInsetField()

          Text(mergeMethod.description)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)

          if actionAvailability.showsMerge {
            Button(mergeMethod.title) {
              onMerge()
            }
            .buttonStyle(.glassProminent)
            .tint(ADEColor.accent)
            .disabled(!isLive || !actionAvailability.mergeEnabled || !mergeable)
          }

          if actionAvailability.showsClose {
            Button("Close PR", role: .destructive) {
              onClose()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)
          }

          if actionAvailability.showsReopen {
            Button("Reopen PR") {
              onReopen()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)
          }

          if actionAvailability.showsRequestReviewers {
            TextField("Request reviewers (comma-separated)", text: $reviewerInput)
              .adeInsetField()
            Button("Request reviewers") {
              onRequestReviewers()
            }
            .buttonStyle(.glass)
            .disabled(!isLive || reviewerInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }

          Button("Open in GitHub") {
            onOpenGitHub()
          }
          .buttonStyle(.glass)
          .tint(ADEColor.textSecondary)
        }
      }

      if pr.state == "merged" {
        PrLaneCleanupBanner(laneName: pr.laneName, onArchive: onArchiveLane, onDeleteBranch: onDeleteBranch)
      }
    }
  }
}

private struct PrFilesTab: View {
  let snapshot: PullRequestSnapshot?

  var body: some View {
    Group {
      if let files = snapshot?.files, !files.isEmpty {
        VStack(spacing: 12) {
          ForEach(files) { file in
            PrFileDiffCard(file: file)
          }
        }
      } else {
        ADEEmptyStateView(
          symbol: "doc.text.magnifyingglass",
          title: "No changed files",
          message: "The host has not synced any file diff data for this PR yet."
        )
      }
    }
  }
}

private struct PrChecksTab: View {
  let checks: [PrCheck]
  let canRerunChecks: Bool
  let isLive: Bool
  let onRerun: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrDetailSectionCard("Checks") {
        VStack(alignment: .leading, spacing: 10) {
          Button("Re-run failed checks") {
            onRerun()
          }
          .buttonStyle(.glass)
          .disabled(!canRerunChecks || !isLive || checks.isEmpty)

          if !canRerunChecks {
            Text("This host has not exposed PR check reruns to the mobile sync channel yet.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
      }

      if checks.isEmpty {
        ADEEmptyStateView(
          symbol: "checklist",
          title: "No CI checks",
          message: "No check runs were synced for this PR yet."
        )
      } else {
        VStack(spacing: 12) {
          ForEach(checks) { check in
            PrCheckRow(check: check)
          }
        }
      }
    }
  }
}

private struct PrActivityTab: View {
  let timeline: [PrTimelineEvent]
  @Binding var commentInput: String
  let canAddComment: Bool
  let isLive: Bool
  let onSubmitComment: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if timeline.isEmpty {
        ADEEmptyStateView(
          symbol: "bubble.left.and.bubble.right",
          title: "No activity yet",
          message: "Comments, reviews, and state changes will appear here once the host syncs them."
        )
      } else {
        PrDetailSectionCard("Timeline") {
          VStack(spacing: 12) {
            ForEach(timeline) { event in
              PrTimelineRow(event: event)
            }
          }
        }
      }

      PrDetailSectionCard("Add comment") {
        VStack(alignment: .leading, spacing: 10) {
          TextEditor(text: $commentInput)
            .frame(minHeight: 120)
            .adeInsetField(cornerRadius: 14, padding: 10)

          Button("Post comment") {
            onSubmitComment()
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.accent)
          .disabled(!canAddComment || !isLive || commentInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

          if !canAddComment {
            Text("Posting comments requires a host that exposes PR comment actions to mobile.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
      }
    }
  }
}

private struct PrDetailSectionCard<Content: View>: View {
  let title: String
  let content: Content

  init(_ title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      content
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct PrChipWrap: View {
  let users: [String]
  let tint: Color

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(users, id: \.self) { user in
          ADEStatusPill(text: user.uppercased(), tint: tint)
        }
      }
    }
  }
}

private struct PrFileDiffCard: View {
  let file: PrFile
  @State private var expanded = true

  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      VStack(alignment: .leading, spacing: 10) {
        if let previousFilename = file.previousFilename, !previousFilename.isEmpty {
          Text("Renamed from \(previousFilename)")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }

        if let patch = file.patch, !patch.isEmpty {
          PrUnifiedDiffView(file: file, patch: patch)
        } else {
          Text("No patch was synced for this file.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      .padding(.top, 8)
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 10) {
          ADEStatusPill(text: fileStatusLabel(file.status), tint: fileStatusTint(file.status))
          VStack(alignment: .leading, spacing: 4) {
            Text(file.filename)
              .font(.system(.body, design: .monospaced))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(2)
            Text("+\(file.additions) -\(file.deletions)")
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
          }
          Spacer(minLength: 0)
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct PrUnifiedDiffView: View {
  let file: PrFile
  let patch: String

  private var language: FilesLanguage {
    FilesLanguage.detect(languageId: nil, filePath: file.filename)
  }

  private var lines: [PrDiffDisplayLine] {
    parsePullRequestPatch(patch)
  }

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      VStack(alignment: .leading, spacing: 2) {
        ForEach(lines) { line in
          HStack(alignment: .top, spacing: 8) {
            Text(line.oldLineNumber.map(String.init) ?? "")
              .frame(width: 34, alignment: .trailing)
              .foregroundStyle(ADEColor.textMuted)
            Text(line.newLineNumber.map(String.init) ?? "")
              .frame(width: 34, alignment: .trailing)
              .foregroundStyle(ADEColor.textMuted)

            if line.kind == .hunk || line.kind == .note {
              Text(line.text)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(line.kind == .hunk ? ADEColor.accent : ADEColor.textSecondary)
            } else {
              HStack(spacing: 0) {
                Text(verbatim: line.prefix)
                  .font(.system(.caption, design: .monospaced).weight(.semibold))
                  .foregroundStyle(diffPrefixTint(line.kind))
                Text(SyntaxHighlighter.highlightedAttributedString(line.text.isEmpty ? " " : line.text, as: language))
                  .font(.system(.caption, design: .monospaced))
              }
            }
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 8)
          .padding(.vertical, 4)
          .background(diffBackground(line.kind), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
      }
    }
    .adeInsetField(cornerRadius: 14, padding: 10)
  }

  private func diffBackground(_ kind: PrDiffDisplayLineKind) -> Color {
    switch kind {
    case .added:
      return ADEColor.success.opacity(0.12)
    case .removed:
      return ADEColor.danger.opacity(0.12)
    case .hunk:
      return ADEColor.accent.opacity(0.08)
    case .context, .note:
      return Color.clear
    }
  }

  private func diffPrefixTint(_ kind: PrDiffDisplayLineKind) -> Color {
    switch kind {
    case .added:
      return ADEColor.success
    case .removed:
      return ADEColor.danger
    case .hunk:
      return ADEColor.accent
    case .context, .note:
      return ADEColor.textSecondary
    }
  }
}

private struct PrCheckRow: View {
  let check: PrCheck

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: checkSymbol(check))
          .foregroundStyle(prChecksTint(check.status == "completed" ? (check.conclusion == "success" ? "passing" : check.conclusion == "failure" ? "failing" : "none") : "pending"))
          .padding(.top, 2)

        VStack(alignment: .leading, spacing: 4) {
          Text(check.name)
            .foregroundStyle(ADEColor.textPrimary)
          Text(prCheckStatusLabel(check))
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)

          if let duration = prDurationText(startedAt: check.startedAt, completedAt: check.completedAt) {
            Text(duration)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
          }

          if let detailsUrl = check.detailsUrl, !detailsUrl.isEmpty {
            Text(detailsUrl)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct PrTimelineRow: View {
  let event: PrTimelineEvent

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: timelineSymbol(event.kind))
        .foregroundStyle(timelineTint(event.kind))
        .padding(.top, 2)

      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text(event.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Spacer(minLength: 8)
          Text(prRelativeTime(event.timestamp))
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }

        if let author = event.author, !author.isEmpty {
          Text(author)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }

        if let body = event.body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          PrMarkdownRenderer(markdown: body)
        }

        if let metadata = event.metadata, !metadata.isEmpty {
          Text(metadata)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
      }
    }
    .adeInsetField(cornerRadius: 14, padding: 12)
  }
}

private struct PrLaneCleanupBanner: View {
  let laneName: String?
  let onArchive: () -> Void
  let onDeleteBranch: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "trash.circle.fill")
          .foregroundStyle(ADEColor.warning)
        VStack(alignment: .leading, spacing: 4) {
          Text("Lane cleanup")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("\(laneName ?? "This lane") merged successfully. Clean it up now to archive it or delete its branch.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      HStack(spacing: 10) {
        Button("Archive lane") {
          onArchive()
        }
        .buttonStyle(.glass)

        Button("Delete branch") {
          onDeleteBranch()
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.warning)
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct IntegrationWorkflowCard: View {
  let proposal: IntegrationProposal
  let onOpenPr: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(proposal.title?.isEmpty == false ? proposal.title! : (proposal.integrationLaneName?.isEmpty == false ? proposal.integrationLaneName! : "Integration workflow"))
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("Base branch: \(proposal.baseBranch)")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        ADEStatusPill(text: proposal.overallOutcome.uppercased(), tint: proposal.overallOutcome == "clean" ? ADEColor.success : ADEColor.warning)
      }

      HStack(spacing: 8) {
        ADEStatusPill(text: proposal.status.uppercased(), tint: ADEColor.accent)
        if let workflowDisplayState = proposal.workflowDisplayState {
          ADEStatusPill(text: workflowDisplayState.uppercased(), tint: ADEColor.textSecondary)
        }
        if let cleanupState = proposal.cleanupState {
          ADEStatusPill(text: cleanupState.uppercased(), tint: ADEColor.warning)
        }
      }

      Text("\(proposal.steps.count) steps · \(proposal.laneSummaries.count) lanes")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)

      if !proposal.steps.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(proposal.steps.prefix(3)) { step in
            Text("\(step.position + 1). \(step.laneName) · \(step.outcome)")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
      }

      if let linkedPrId = proposal.linkedPrId {
        Button("Open linked PR") {
          onOpenPr(linkedPrId)
        }
        .buttonStyle(.glass)
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct QueueWorkflowCard: View {
  let queueState: QueueLandingState
  let isLive: Bool
  let onOpenPr: (String) -> Void
  let onLand: (String, PrMergeMethodOption) -> Void
  let onRebaseLane: (String) -> Void
  @State private var mergeMethod: PrMergeMethodOption = .squash

  private var activeEntry: QueueLandingEntry? {
    if let activePrId = queueState.activePrId,
       let entry = queueState.entries.first(where: { $0.prId == activePrId }) {
      return entry
    }
    return queueState.entries.first(where: { $0.state != "landed" && $0.state != "skipped" })
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(queueState.groupName ?? "Queue workflow")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("Target branch: \(queueState.targetBranch ?? "unknown")")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        ADEStatusPill(text: queueState.state.uppercased(), tint: queueState.state == "completed" ? ADEColor.success : ADEColor.warning)
      }

      if let waitReason = queueState.waitReason, !waitReason.isEmpty {
        Text("Waiting on: \(waitReason)")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }

      if let lastError = queueState.lastError, !lastError.isEmpty {
        Text(lastError)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
      }

      if let activeEntry {
        Picker("Merge strategy", selection: $mergeMethod) {
          ForEach(PrMergeMethodOption.allCases) { option in
            Text(option.shortTitle).tag(option)
          }
        }
        .pickerStyle(.menu)
        .adeInsetField()

        Button("Land active PR") {
          onLand(activeEntry.prId, mergeMethod)
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(!isLive)
      }

      VStack(alignment: .leading, spacing: 8) {
        ForEach(queueState.entries.sorted(by: { $0.position < $1.position })) { entry in
          HStack(alignment: .top, spacing: 10) {
            ADEStatusPill(text: "#\(entry.position + 1)", tint: ADEColor.textSecondary)
            VStack(alignment: .leading, spacing: 4) {
              Text(entry.laneName)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              Text(entry.state.replacingOccurrences(of: "_", with: " "))
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
            Spacer(minLength: 8)
            if let prNumber = entry.prNumber {
              Button("#\(prNumber)") {
                onOpenPr(entry.prId)
              }
              .buttonStyle(.glass)
            }
            Button("Rebase") {
              onRebaseLane(entry.laneId)
            }
            .buttonStyle(.glass)
            .disabled(!isLive)
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct RebaseWorkflowCard: View {
  let item: PrRebaseWorkflowItem
  let onRebase: () -> Void
  let onDefer: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(item.laneName)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text(item.branchRef)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        ADEStatusPill(text: item.severity.uppercased(), tint: item.severity == "critical" ? ADEColor.danger : item.severity == "warning" ? ADEColor.warning : ADEColor.textSecondary)
      }

      Text(item.statusMessage)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)

      if let deferredUntil = item.deferredUntil {
        Text("Deferred until \(prAbsoluteTime(deferredUntil))")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }

      HStack(spacing: 10) {
        Button("Rebase") {
          onRebase()
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)

        Button("Defer") {
          onDefer()
        }
        .buttonStyle(.glass)

        Button("Dismiss") {
          onDismiss()
        }
        .buttonStyle(.glass)
        .tint(ADEColor.textSecondary)
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct PrStackSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let groupId: String
  let groupName: String?
  @State private var members: [PrGroupMemberSummary] = []

  var body: some View {
    NavigationStack {
      List {
        if members.isEmpty {
          ADEEmptyStateView(
            symbol: "list.number",
            title: "No stack members",
            message: "The host did not sync any PR chain members for this workflow yet."
          )
          .prListRow()
        } else {
          ForEach(members) { member in
            VStack(alignment: .leading, spacing: 8) {
              HStack(alignment: .top) {
                ADEStatusPill(text: "#\(member.position + 1)", tint: ADEColor.accent)
                Spacer(minLength: 8)
                ADEStatusPill(text: member.state.uppercased(), tint: prStateTint(member.state))
              }
              Text(member.title)
                .font(.headline)
                .foregroundStyle(ADEColor.textPrimary)
              Text("#\(member.githubPrNumber) · \(member.headBranch) → \(member.baseBranch)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ADEColor.textSecondary)
              Text(member.laneName)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
            .adeGlassCard(cornerRadius: 18)
            .prListRow()
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle(groupName ?? "PR stack")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") {
            dismiss()
          }
        }
      }
      .task {
        members = (try? await syncService.fetchPullRequestGroupMembers(groupId: groupId)) ?? []
      }
    }
  }
}

private struct CreatePrWizardView: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let lanes: [LaneSummary]
  let onCreate: (String, String, String, Bool, String, [String], [String]) -> Void

  @State private var step = 1
  @State private var selectedLaneId = ""
  @State private var baseBranch = "main"
  @State private var title = ""
  @State private var bodyText = ""
  @State private var draft = false
  @State private var reviewers = ""
  @State private var labels = ""
  @State private var isGenerating = false
  @State private var errorMessage: String?

  private var selectedLane: LaneSummary? {
    lanes.first(where: { $0.id == selectedLaneId }) ?? lanes.first
  }

  private var canAdvance: Bool {
    switch step {
    case 1:
      return selectedLane != nil && !baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    case 2:
      return !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    default:
      return true
    }
  }

  var body: some View {
    NavigationStack {
      List {
        PrStepIndicator(step: step)
          .prListRow()

        if let errorMessage {
          ADENoticeCard(
            title: "Create PR draft failed",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: nil,
            action: nil
          )
          .prListRow()
        }

        Group {
          switch step {
          case 1:
            createStepOne
          case 2:
            createStepTwo
          default:
            createStepThree
          }
        }
        .prListRow()
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Create PR")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            dismiss()
          }
        }

        ToolbarItem(placement: .topBarLeading) {
          if step > 1 {
            Button("Back") {
              withAnimation(.smooth) { step -= 1 }
            }
          }
        }

        ToolbarItem(placement: .confirmationAction) {
          if step < 3 {
            Button("Next") {
              withAnimation(.smooth) { step += 1 }
            }
            .disabled(!canAdvance)
          } else {
            Button("Create") {
              guard let selectedLane else { return }
              onCreate(
                selectedLane.id,
                title.trimmingCharacters(in: .whitespacesAndNewlines),
                bodyText,
                draft,
                baseBranch.trimmingCharacters(in: .whitespacesAndNewlines),
                labels.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty },
                reviewers.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
              )
            }
            .disabled(!canAdvance)
          }
        }
      }
      .onAppear {
        selectedLaneId = selectedLaneId.isEmpty ? (lanes.first?.id ?? "") : selectedLaneId
        if let selectedLane, baseBranch == "main" {
          baseBranch = selectedLane.baseRef
        }
      }
    }
  }

  private var createStepOne: some View {
    VStack(alignment: .leading, spacing: 12) {
      PrDetailSectionCard("Step 1 · lane and branch") {
        VStack(alignment: .leading, spacing: 12) {
          Picker("Lane", selection: $selectedLaneId) {
            ForEach(lanes) { lane in
              Text("\(lane.name) · \(lane.branchRef)").tag(lane.id)
            }
          }
          .pickerStyle(.menu)
          .adeInsetField()

          if let selectedLane {
            Text("Source branch: \(selectedLane.branchRef)")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }

          TextField("Target branch", text: $baseBranch)
            .adeInsetField()

          Toggle("Create as draft", isOn: $draft)
            .adeInsetField()
        }
      }
    }
  }

  private var createStepTwo: some View {
    VStack(alignment: .leading, spacing: 12) {
      PrDetailSectionCard("Step 2 · title and body") {
        VStack(alignment: .leading, spacing: 12) {
          TextField("Title", text: $title)
            .adeInsetField()

          TextEditor(text: $bodyText)
            .frame(minHeight: 180)
            .adeInsetField(cornerRadius: 14, padding: 10)

          Button(isGenerating ? "Generating…" : "Generate with AI") {
            Task { await generateDraft() }
          }
          .buttonStyle(.glass)
          .disabled(isGenerating || selectedLane == nil)
        }
      }
    }
  }

  private var createStepThree: some View {
    VStack(alignment: .leading, spacing: 12) {
      PrDetailSectionCard("Step 3 · reviewers and labels") {
        VStack(alignment: .leading, spacing: 12) {
          TextField("Reviewers (comma-separated)", text: $reviewers)
            .adeInsetField()
          TextField("Labels (comma-separated)", text: $labels)
            .adeInsetField()

          VStack(alignment: .leading, spacing: 6) {
            Text("Summary")
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text(title.isEmpty ? "Add a title before creating the PR." : title)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
            Text("Targeting \(baseBranch)")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
      }
    }
  }

  @MainActor
  private func generateDraft() async {
    guard let selectedLane else { return }
    isGenerating = true
    defer { isGenerating = false }

    do {
      let suggestion: PullRequestDraftSuggestion
      if syncService.supportsRemoteAction("prs.draftDescription") {
        suggestion = try await syncService.draftPullRequestDescription(laneId: selectedLane.id)
      } else {
        let detail = try? await syncService.refreshLaneDetail(laneId: selectedLane.id)
        suggestion = prHeuristicDraft(lane: selectedLane, detail: detail)
      }

      title = suggestion.title
      if bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        bodyText = suggestion.body
      } else {
        bodyText = suggestion.body
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

private struct PrStepIndicator: View {
  let step: Int

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Step \(step) of 3")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)

      HStack(spacing: 8) {
        ForEach(1...3, id: \.self) { index in
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(index <= step ? ADEColor.accent : ADEColor.border.opacity(0.35))
            .frame(height: 8)
        }
      }

      HStack(spacing: 8) {
        Text("Branch")
        Text("Details")
        Text("Review")
      }
      .font(.caption)
      .foregroundStyle(ADEColor.textSecondary)
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct PrMarkdownRenderer: View {
  let markdown: String

  private var attributed: AttributedString? {
    try? AttributedString(
      markdown: markdown,
      options: AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .full,
        failurePolicy: .returnPartiallyParsedIfPossible
      )
    )
  }

  var body: some View {
    Group {
      if let attributed {
        Text(attributed)
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      } else {
        Text(markdown)
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
}

private extension View {
  func prListRow() -> some View {
    listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
  }
}

private func prStateTint(_ state: String) -> Color {
  switch state {
  case "open":
    return ADEColor.success
  case "draft":
    return ADEColor.warning
  case "closed":
    return ADEColor.danger
  case "merged":
    return ADEColor.accent
  default:
    return ADEColor.textSecondary
  }
}

private func prChecksTint(_ status: String) -> Color {
  switch status {
  case "passing", "success":
    return ADEColor.success
  case "failing", "failure":
    return ADEColor.danger
  case "pending", "queued", "in_progress":
    return ADEColor.warning
  default:
    return ADEColor.textSecondary
  }
}

private func prReviewTint(_ status: String) -> Color {
  switch status {
  case "approved":
    return ADEColor.success
  case "changes_requested":
    return ADEColor.danger
  case "requested", "commented", "pending":
    return ADEColor.warning
  default:
    return ADEColor.textSecondary
  }
}

private func prChecksLabel(_ status: String) -> String {
  switch status {
  case "passing": return "Passing"
  case "failing": return "Failing"
  case "pending": return "Pending"
  default: return titleCase(status)
  }
}

private func prReviewLabel(_ status: String) -> String {
  switch status {
  case "changes_requested": return "Changes requested"
  case "requested": return "Review requested"
  case "approved": return "Approved"
  case "none": return "No review"
  default: return titleCase(status)
  }
}

private func prAdeKindLabel(_ adeKind: String?) -> String? {
  guard let adeKind, !adeKind.isEmpty else { return nil }
  switch adeKind {
  case "single": return "ADE"
  case "queue": return "ADE QUEUE"
  case "integration": return "ADE INT"
  default: return "ADE"
  }
}

private func reviewSymbol(_ status: String) -> String {
  switch status {
  case "approved":
    return "checkmark.circle.fill"
  case "changes_requested":
    return "xmark.circle.fill"
  case "requested":
    return "person.badge.clock.fill"
  default:
    return "person.crop.circle.badge.questionmark"
  }
}

private func checkSymbol(_ check: PrCheck) -> String {
  if check.status == "completed" {
    if check.conclusion == "success" { return "checkmark.circle.fill" }
    if check.conclusion == "failure" { return "xmark.circle.fill" }
    return "minus.circle.fill"
  }
  return "circle.dashed"
}

private func prCheckStatusLabel(_ check: PrCheck) -> String {
  if check.status == "completed" {
    return check.conclusion.map(titleCase) ?? "Completed"
  }
  return titleCase(check.status.replacingOccurrences(of: "_", with: " "))
}

private func timelineSymbol(_ kind: PrTimelineEventKind) -> String {
  switch kind {
  case .stateChange: return "arrow.triangle.merge"
  case .review: return "checkmark.seal.fill"
  case .comment: return "text.bubble.fill"
  }
}

private func timelineTint(_ kind: PrTimelineEventKind) -> Color {
  switch kind {
  case .stateChange: return ADEColor.success
  case .review: return ADEColor.accent
  case .comment: return ADEColor.warning
  }
}

private func fileStatusLabel(_ status: String) -> String {
  switch status {
  case "added": return "A"
  case "removed": return "D"
  case "modified": return "M"
  case "renamed": return "R"
  case "copied": return "C"
  default: return status.prefix(1).uppercased()
  }
}

private func fileStatusTint(_ status: String) -> Color {
  switch status {
  case "added": return ADEColor.success
  case "removed": return ADEColor.danger
  case "modified": return ADEColor.warning
  case "renamed", "copied": return ADEColor.accent
  default: return ADEColor.textSecondary
  }
}

private func severityRank(_ severity: String) -> Int {
  switch severity {
  case "critical": return 0
  case "warning": return 1
  default: return 2
  }
}

private func titleCase(_ raw: String) -> String {
  raw
    .replacingOccurrences(of: "_", with: " ")
    .split(separator: " ")
    .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
    .joined(separator: " ")
}

private func prParsedDate(_ iso: String?) -> Date? {
  guard let iso, !iso.isEmpty else { return nil }
  return prIsoFormatter.date(from: iso) ?? prIsoFallbackFormatter.date(from: iso)
}

private func prRelativeTime(_ iso: String?) -> String {
  guard let date = prParsedDate(iso) else { return "unknown" }
  return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
}

private func prAbsoluteTime(_ iso: String?) -> String {
  guard let date = prParsedDate(iso) else { return "unknown" }
  let formatter = DateFormatter()
  formatter.dateStyle = .medium
  formatter.timeStyle = .short
  return formatter.string(from: date)
}

private func prDurationText(startedAt: String?, completedAt: String?) -> String? {
  guard let started = prParsedDate(startedAt), let completed = prParsedDate(completedAt) else { return nil }
  let seconds = max(completed.timeIntervalSince(started), 0)
  if seconds < 60 {
    return "\(Int(seconds.rounded())) sec"
  }
  return String(format: "%.1f min", seconds / 60.0)
}

private func prHeuristicDraft(lane: LaneSummary, detail: LaneDetailPayload?) -> PullRequestDraftSuggestion {
  let commitSubjects = detail?.recentCommits.map(\.subject).filter { !$0.isEmpty } ?? []
  let title = commitSubjects.first ?? lane.name
  let changedFiles = (detail?.diffChanges?.unstaged.count ?? 0) + (detail?.diffChanges?.staged.count ?? 0)
  let bullets = commitSubjects.prefix(3).map { "- \($0)" }
  let body = ([
    "## Summary",
    "",
    bullets.isEmpty ? "- Update \(lane.name) from lane `\(lane.branchRef)`" : bullets.joined(separator: "\n"),
    "",
    "## Notes",
    "",
    "- Source branch: `\(lane.branchRef)`",
    "- Target branch: `\(lane.baseRef)`",
    changedFiles > 0 ? "- Local diff count seen on iPhone: \(changedFiles) files" : nil,
  ].compactMap { $0 }).joined(separator: "\n")
  return PullRequestDraftSuggestion(title: title, body: body)
}
