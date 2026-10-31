import Foundation
import SwiftUI

private let workImportAllProvidersFilter = "all"
/// Lane filter values that are not lane ids.
private let workImportAllLanesFilter = "__all_lanes__"
/// Rows per provider scan. The sync host caps a list at 100; ten providers at
/// full size would be a heavy payload for a phone.
private let workImportBrowseLimitPerProvider = 50
/// How long "Continue anyway" stays armed after the first tap (desktop: 4 s).
private let workImportLiveConfirmNanos: UInt64 = 4_000_000_000
/// Every provider failing at once is a host that is still starting; wait and
/// scan once more before showing the error (desktop: 2.5 s).
private let workImportScanRetryNanos: UInt64 = 2_500_000_000
/// From this width the list and the preview sit side by side (desktop's
/// browser); below it the preview is a step after the list.
private let workImportSplitMinWidth: CGFloat = 640
/// From this width the filter controls fit on the one row above both columns.
private let workImportOneRowControlsMinWidth: CGFloat = 760

// MARK: - Host hooks

private struct WorkImportClaimsFullWidthKey: EnvironmentKey {
  static let defaultValue: ((Bool) -> Void)? = nil
}

extension EnvironmentValues {
  /// Set by a wide Work layout: the import browser calls it with `true` while
  /// it is open so the sessions column steps aside and the browser gets the
  /// whole screen (list | preview), as desktop's dialog does.
  var workImportClaimsFullWidth: ((Bool) -> Void)? {
    get { self[WorkImportClaimsFullWidthKey.self] }
    set { self[WorkImportClaimsFullWidthKey.self] = newValue }
  }
}

/// The machine the browser scans. Every call for its sessions goes there: the
/// list and the import through its namespaced lane ids, the conversation
/// through its marked project.
struct WorkImportSource: Equatable {
  /// Nil: the machine this project tab is bound to.
  var machineKey: String?
  var markedProjectId: String?
  var rootPath: String?

  static let primary = WorkImportSource(machineKey: nil, markedProjectId: nil, rootPath: nil)
}

extension SyncService {
  /// Whether `source` can send a whole external conversation.
  func workImportSupportsDetail(_ source: WorkImportSource) -> Bool {
    guard let key = source.machineKey else { return supportsExternalSessionDetail }
    return machineFleet?.connection(for: key)?.commandDescriptors
      .contains { $0.action == "work.getExternalSessionDetail" } == true
  }

  /// `getExternalSessionDetail` on the machine that has the session.
  func workImportSessionDetail(
    provider: String,
    sessionId: String,
    before: String? = nil,
    source: WorkImportSource
  ) async throws -> ExternalSessionDetail {
    guard source.machineKey != nil, let projectId = source.markedProjectId else {
      return try await getExternalSessionDetail(provider: provider, sessionId: sessionId, before: before)
    }
    var args: [String: Any] = ["provider": provider, "sessionId": sessionId]
    if let before, !before.isEmpty { args["before"] = before }
    return try await sendDecodableCommand(
      action: "work.getExternalSessionDetail",
      args: args,
      targetProjectId: projectId,
      targetProjectRootPath: source.rootPath,
      fallbackToActiveProjectScope: false,
      as: ExternalSessionDetail.self
    )
  }
}

// MARK: - Screen

/// Desktop's import browser on iOS: filters, the session list, the preview
/// and one action bar. Wide (Duo inner display, iPad): list | preview side by
/// side. Compact (any iPhone, the Duo's outer display): the list, then the
/// preview as a step.
struct WorkImportSessionScreen: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @Environment(\.workImportClaimsFullWidth) private var claimsFullWidth

  let lane: LaneSummary
  let lanes: [LaneSummary]
  let onCliImported: @MainActor (TerminalSessionSummary) async -> Void
  let onChatImported: @MainActor (AgentChatSessionSummary) async -> Void

  @State private var sessions: [ExternalSessionSummary] = []
  @State private var providerFilter = workImportAllProvidersFilter
  @State private var scope = "project"
  @State private var laneFilter = workImportAllLanesFilter
  /// Providers whose scan has not answered yet.
  @State private var pendingProviders: Set<String> = []
  /// Providers the host refused by name (an older host): not offered.
  @State private var unsupportedProviders: Set<String> = []
  @State private var scanDone = false
  @State private var loadError: String?
  @State private var failedProviders: [String] = []
  @State private var loadSeq = 0
  @State private var importError: String?
  @State private var importingSessionId: String?
  /// The chosen row (wide: shown in the preview; compact: opened).
  @State private var selectedKey: String?
  /// Compact only: the preview step is open.
  @State private var showsDetail = false
  /// Where each session's import goes, once the user picked a lane.
  @State private var targetChoices: [String: String] = [:]
  /// Mode picked on this screen, per provider. Falls back to the stored
  /// preference, then to the plan's first surface.
  @State private var surfaceChoices: [String: String] = [:]
  /// Action key waiting on a second tap (continuing a session that may be live).
  @State private var confirmingKey: String?

  // The machine being browsed.
  @State private var sourceKey: String?
  @State private var remoteLanes: [LaneSummary] = []
  @State private var remoteLanesLoading = false
  @State private var sourceError: String?

  init(
    lane: LaneSummary,
    lanes: [LaneSummary],
    onCliImported: @escaping @MainActor (TerminalSessionSummary) async -> Void,
    onChatImported: @escaping @MainActor (AgentChatSessionSummary) async -> Void
  ) {
    self.lane = lane
    self.lanes = lanes
    self.onCliImported = onCliImported
    self.onChatImported = onChatImported
  }

  // MARK: - Machine

  private var machineOptions: [WorkNewChatMachineOption] {
    if let fleet = syncService.machineFleet {
      return workNewChatMachineOptions(syncService: syncService, fleet: fleet)
    }
    let name = syncService.focusedMachineDisplayName
    return [WorkNewChatMachineOption(
      machineKey: nil,
      name: name,
      symbol: machineSymbol(machineKey: syncService.focusedMachineKey, name: name),
      isLive: syncService.connectionState == .connected
    )]
  }

  private var selectedMachine: WorkNewChatMachineOption {
    let options = machineOptions
    return options.first { $0.machineKey == sourceKey } ?? options[0]
  }

  private var remoteRepo: WorkRemoteMachineRepo? {
    sourceKey.flatMap { syncService.remoteLaneRepo(machineKey: $0) }
  }

  private var source: WorkImportSource {
    guard let sourceKey, let repo = remoteRepo else { return .primary }
    return WorkImportSource(machineKey: sourceKey, markedProjectId: repo.markedProjectId, rootPath: repo.rootPath)
  }

  private var isRemoteSource: Bool { sourceKey != nil }

  /// The lanes of the machine being browsed.
  private var activeLanes: [LaneSummary] {
    sourceKey == nil ? lanes : remoteLanes
  }

  /// The lane the scan is asked about: the page's lane here, the primary lane
  /// of another machine (its id carries the machine, which routes the scan).
  private var originLaneId: String? {
    sourceKey == nil ? lane.id : workNewChatPrimaryLane(remoteLanes)?.id
  }

  private var scanTaskKey: String {
    "\(scope)|\(sourceKey ?? "-")|\(originLaneId ?? "-")"
  }

  // MARK: - Derived list state

  private var scanProviders: [String] {
    workImportScanProviders(hostKnowsAcpProviders: syncService.workImportSupportsDetail(source))
  }

  private var loading: Bool {
    !pendingProviders.isEmpty || (!scanDone && loadError == nil) || remoteLanesLoading
  }

  private var liveLaneIds: Set<String> {
    Set(activeLanes.map(\.id))
  }

  private func laneName(_ laneId: String) -> String? {
    activeLanes.first(where: { $0.id == laneId })?.name
  }

  private func bucket(_ session: ExternalSessionSummary) -> String {
    session.importLaneBucket(liveLaneIds: liveLaneIds, originLaneId: originLaneId ?? lane.id)
  }

  private var scanLaneKeys: Set<String> {
    Set(sessions.map(bucket))
  }

  private func matchesLane(_ session: ExternalSessionSummary) -> Bool {
    laneFilter == workImportAllLanesFilter || bucket(session) == laneFilter
  }

  private func matchesProvider(_ session: ExternalSessionSummary) -> Bool {
    providerFilter == workImportAllProvidersFilter || workExternalSessionProviderKey(session.provider) == providerFilter
  }

  private var inLane: [ExternalSessionSummary] {
    sessions.filter(matchesLane)
  }

  private var inProvider: [ExternalSessionSummary] {
    sessions.filter(matchesProvider)
  }

  /// Chips count the sessions under the current lane filter.
  private var providerCounts: [String: Int] {
    var counts: [String: Int] = [:]
    for session in inLane {
      counts[workExternalSessionProviderKey(session.provider), default: 0] += 1
    }
    return counts
  }

  /// Lane rows count the sessions under the current provider filter.
  private var laneCounts: [String: Int] {
    var counts: [String: Int] = [:]
    for session in inProvider {
      counts[bucket(session), default: 0] += 1
    }
    return counts
  }

  /// Every agent the machine was asked about gets a chip, so the filter
  /// always names all of them: the ones with sessions first, then the ones
  /// with none here (dimmed, still tappable: their empty state points to
  /// where else to look).
  private var providerChips: [WorkImportProviderCount] {
    let counts = providerCounts
    let offered = scanProviders.filter { !unsupportedProviders.contains($0) }
    let withSessions = offered.filter { (counts[$0] ?? 0) > 0 }
    let without = offered.filter { (counts[$0] ?? 0) == 0 }
    return (withSessions + without).map { WorkImportProviderCount(provider: $0, count: counts[$0] ?? 0) }
  }

  private var visibleSessions: [ExternalSessionSummary] {
    inLane.filter(matchesProvider).sorted { left, right in
      (left.updatedAt ?? left.createdAt ?? 0) > (right.updatedAt ?? right.createdAt ?? 0)
    }
  }

  private var visibleGroups: [WorkImportSessionGroup] {
    var groups: [WorkImportSessionGroup] = []
    for session in visibleSessions {
      let label = workImportDateGroup(session.updatedAt ?? session.createdAt)
      if groups.last?.label == label {
        groups[groups.count - 1].rows.append(session)
      } else {
        groups.append(WorkImportSessionGroup(label: label, rows: [session]))
      }
    }
    return groups
  }

  /// Rows hide their lane label when the filter already names that one lane.
  private var rowsShowLane: Bool {
    laneFilter == workImportAllLanesFilter || laneFilter == workImportOtherFoldersFilter
  }

  private var laneFilterName: String {
    switch laneFilter {
    case workImportOtherFoldersFilter: return "other folders"
    case workImportAllLanesFilter: return scope == "project" ? "this project" : "any folder"
    default: return laneName(laneFilter) ?? "this lane"
    }
  }

  private var failedNotice: String? {
    guard !failedProviders.isEmpty else { return nil }
    let names = scanProviders
      .filter { failedProviders.contains($0) }
      .map(workExternalSessionProviderName)
      .joined(separator: ", ")
    return "\(names) couldn't be scanned."
  }

  private var emptyScanDetail: String {
    let place = scope == "project" ? "in this project" : "in every folder"
    let summary = "Checked \(selectedMachine.name) \(place)."
    return [summary, failedNotice].compactMap { $0 }.joined(separator: " ")
  }

  /// The row the preview shows: the chosen one, else the newest.
  private var activeSession: ExternalSessionSummary? {
    let visible = visibleSessions
    if let selectedKey, let row = visible.first(where: { $0.importIdentity == selectedKey }) { return row }
    return visible.first
  }

  /// The compact step's row: the chosen one while it still exists.
  private var openedSession: ExternalSessionSummary? {
    guard let selectedKey else { return nil }
    return sessions.first(where: { $0.importIdentity == selectedKey })
  }

  // MARK: - Body

  var body: some View {
    GeometryReader { proxy in
      let split = horizontalSizeClass == .regular && proxy.size.width >= workImportSplitMinWidth
      Group {
        if split {
          splitBody(proxy: proxy)
        } else {
          compactBody
        }
      }
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(compactDetailShown ? "Session" : "Import session")
    .navigationBarTitleDisplayMode(.inline)
    // The system back button would land on the Duo's edge bar as a lone
    // circle; back lives in the page header instead (and, on the compact
    // preview step, goes back to the list).
    .navigationBarBackButtonHidden(true)
    .modifier(WorkImportBackItem(
      title: compactDetailShown ? "Sessions" : "Back",
      disabled: importingSessionId != nil,
      action: goBack
    ))
    .toolbar {
      DuoAppTabsToolbar(includesUtilities: false)
    }
    .toolbar(.hidden, for: .tabBar)
    .adeRootTabBarHidden()
    .task(id: scanTaskKey) {
      await loadSessions(resetting: true)
    }
    .onAppear { claimsFullWidth?(true) }
    .onDisappear { claimsFullWidth?(false) }
  }

  private var compactDetailShown: Bool {
    horizontalSizeClass != .regular && showsDetail && openedSession != nil
  }

  private func goBack() {
    if showsDetail && horizontalSizeClass != .regular {
      closeDetail()
    } else {
      dismiss()
    }
  }

  // MARK: - Wide: list | preview

  @ViewBuilder
  private func splitBody(proxy: GeometryProxy) -> some View {
    let fold = DuoFoldReading.fold(in: proxy)
    let foldRect: CGRect? = {
      if case .sideBySide(let rect) = fold { return rect }
      return nil
    }()
    let width = proxy.size.width
    // Book: the list is the left page. Flat: desktop's proportions.
    let listWidth = foldRect.map { max(280, $0.minX) } ?? min(420, max(300, width * 0.4))
    let oneRow = foldRect == nil && width >= workImportOneRowControlsMinWidth
    VStack(spacing: 0) {
      if oneRow {
        controls(oneRow: true)
          .padding(.horizontal, 16)
          .padding(.top, 8)
          .padding(.bottom, 10)
        Divider().overlay(ADEKit.rule)
      }
      HStack(spacing: 0) {
        VStack(spacing: 0) {
          if !oneRow {
            controls(oneRow: false)
              .padding(.horizontal, 16)
              .padding(.top, 8)
              .padding(.bottom, 10)
          }
          listContent(selectable: true)
        }
        .frame(width: listWidth)
        DuoSeam(axis: .vertical, foldRect: foldRect)
        previewColumn
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
  }

  @ViewBuilder
  private var previewColumn: some View {
    if let session = activeSession {
      sessionPreview(session)
        .id(session.importIdentity)
    } else if loading {
      WorkImportCenterState(systemImage: nil, tint: ADEColor.textMuted, title: "Scanning sessions…", detail: nil, actionTitle: nil, action: nil, showsProgress: true)
    } else {
      // Nothing under the filters: the list says why and what to do.
      Color.clear
    }
  }

  // MARK: - Compact: list, then the preview

  @ViewBuilder
  private var compactBody: some View {
    if showsDetail, let session = openedSession {
      sessionPreview(session)
    } else {
      VStack(spacing: 0) {
        controls(oneRow: false)
          .padding(.horizontal, 16)
          .padding(.top, 8)
          .padding(.bottom, 10)
        listContent(selectable: false)
      }
    }
  }

  // MARK: - Controls (machine, lane, scope, agents)

  @ViewBuilder
  private func controls(oneRow: Bool) -> some View {
    if oneRow {
      HStack(spacing: 8) {
        pickers
          .fixedSize()
        providerFilterBar
        scanIndicator
      }
    } else {
      // Two rows: the pickers, then the agents. When the three pickers do not
      // fit on one line, "where to look" leads the agents' row instead.
      ViewThatFits(in: .horizontal) {
        VStack(alignment: .leading, spacing: 10) {
          HStack(spacing: 8) {
            pickers
            Spacer(minLength: 0)
            scanIndicator
          }
          providerFilterBar
        }
        VStack(alignment: .leading, spacing: 10) {
          HStack(spacing: 8) {
            machinePicker
            laneFilterPicker
            Spacer(minLength: 0)
            scanIndicator
          }
          HStack(spacing: 8) {
            scopePicker
              .fixedSize()
            providerFilterBar
          }
        }
      }
    }
  }

  private var pickers: some View {
    HStack(spacing: 8) {
      machinePicker
      laneFilterPicker
      scopePicker
    }
  }

  /// The new-chat page's machine menu (same sections, same pill), as a
  /// label that can shorten in a narrow column.
  private var machinePicker: some View {
    let options = machineOptions
    let selected = selectedMachine
    return Menu {
      Section("Connected") {
        ForEach(options.filter { $0.isPrimary || $0.isLive }) { option in
          Button {
            selectMachine(option)
          } label: {
            Label(option.isPrimary ? "\(option.name) · Primary" : option.name, systemImage: option.symbol)
          }
        }
      }
      let notLive = options.filter { !$0.isPrimary && !$0.isLive }
      if !notLive.isEmpty {
        Section("Not connected · tap to reconnect") {
          ForEach(notLive) { option in
            Button {
              selectMachine(option)
            } label: {
              Label(option.name, systemImage: option.symbol)
            }
          }
        }
      }
    } label: {
      WorkImportPillLabel(symbol: selected.symbol, title: selected.name)
    }
    .disabled(importingSessionId != nil)
    .accessibilityLabel("Import from")
    .accessibilityValue(selected.name)
  }

  private var laneFilterPicker: some View {
    WorkImportLaneFilterMenu(
      lanes: activeLanes,
      scanKeys: scanLaneKeys,
      counts: laneCounts,
      totalCount: inProvider.count,
      selection: $laneFilter
    )
  }

  private var scopePicker: some View {
    Menu {
      Picker("Where to look", selection: $scope) {
        Label("This project", systemImage: "folder").tag("project")
        Label("All folders", systemImage: "externaldrive").tag("all")
      }
    } label: {
      WorkImportPillLabel(
        symbol: scope == "project" ? "folder" : "externaldrive",
        title: scope == "project" ? "This project" : "All folders"
      )
    }
    .accessibilityLabel("Where to look")
    .accessibilityValue(scope == "project" ? "This project" : "All folders")
  }

  @ViewBuilder
  private var scanIndicator: some View {
    if loading && !sessions.isEmpty {
      ProgressView()
        .controlSize(.small)
        .accessibilityLabel("Scanning sessions")
    }
  }

  private var providerFilterBar: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 2) {
        WorkImportProviderSegment(
          provider: workImportAllProvidersFilter,
          count: inLane.count,
          selected: providerFilter == workImportAllProvidersFilter,
          action: { selectProvider(workImportAllProvidersFilter) }
        )
        ForEach(providerChips) { chip in
          WorkImportProviderSegment(
            provider: chip.provider,
            count: chip.count,
            selected: providerFilter == chip.provider,
            action: { selectProvider(chip.provider) }
          )
        }
      }
      .adeKitSegmentTrack()
    }
    // A scroller wants its whole content's width; it takes whatever the row
    // leaves instead, so the row layout above never picks around it.
    .frame(minWidth: 120, idealWidth: 120, maxWidth: .infinity)
  }

  private func selectProvider(_ provider: String) {
    providerFilter = provider
    selectedKey = nil
    confirmingKey = nil
  }

  // MARK: - List

  @ViewBuilder
  private func listContent(selectable: Bool) -> some View {
    if let sourceError, !remoteLanesLoading {
      WorkImportCenterState(
        systemImage: "desktopcomputer.trianglebadge.exclamationmark",
        tint: ADEColor.warning,
        title: "Can't browse \(selectedMachine.name)",
        detail: sourceError,
        actionTitle: "Try again",
        action: { retrySource() }
      )
    } else if let loadError, sessions.isEmpty, !loading {
      WorkImportCenterState(
        systemImage: "exclamationmark.triangle",
        tint: ADEColor.warning,
        title: "Sessions couldn't be loaded",
        detail: loadError,
        actionTitle: "Try again",
        action: { Task { await loadSessions() } }
      )
    } else if visibleSessions.isEmpty && loading {
      WorkImportCenterState(systemImage: nil, tint: ADEColor.textMuted, title: "Scanning \(selectedMachine.name)…", detail: nil, actionTitle: nil, action: nil, showsProgress: true)
    } else if sessions.isEmpty {
      WorkImportCenterState(
        systemImage: "tray",
        tint: ADEColor.textMuted,
        title: "No sessions found",
        detail: emptyScanDetail,
        actionTitle: scope == "project" ? "Look in all folders" : "Scan again",
        action: {
          if scope == "project" { scope = "all" } else { Task { await loadSessions() } }
        }
      )
    } else if visibleSessions.isEmpty {
      emptyFilterState
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(visibleGroups) { group in
            Text(group.label)
              .font(.footnote.weight(.semibold))
              .foregroundStyle(ADEColor.textMuted)
              .accessibilityAddTraits(.isHeader)
              .padding(.horizontal, 16)
              .padding(.top, 14)
              .padding(.bottom, 4)
            ForEach(group.rows, id: \.importIdentity) { session in
              let key = session.importIdentity
              Button {
                open(session, pushes: !selectable)
              } label: {
                WorkImportSessionSummaryRow(
                  session: session,
                  lanes: activeLanes,
                  showsLane: rowsShowLane,
                  selected: selectable && activeSession?.importIdentity == key,
                  showsChevron: !selectable
                )
              }
              .buttonStyle(.plain)
              .padding(.horizontal, 8)
            }
          }
          if let failedNotice {
            Label(failedNotice, systemImage: "exclamationmark.triangle")
              .font(.caption)
              .foregroundStyle(ADEColor.warning)
              .padding(.horizontal, 16)
              .padding(.vertical, 12)
          }
        }
        .padding(.bottom, 16)
      }
      .scrollContentBackground(.hidden)
      .refreshable { await loadSessions() }
    }
  }

  /// Nothing under the filters. Names the filter, and the one way out.
  @ViewBuilder
  private var emptyFilterState: some View {
    let providerName = providerFilter == workImportAllProvidersFilter
      ? nil
      : workExternalSessionProviderName(providerFilter)
    let title = providerName.map { "No \($0) sessions in \(laneFilterName)" } ?? "No sessions in \(laneFilterName)"
    if laneFilter != workImportAllLanesFilter {
      WorkImportCenterState(
        systemImage: "tray", tint: ADEColor.textMuted, title: title, detail: nil,
        actionTitle: "Show all lanes",
        action: { laneFilter = workImportAllLanesFilter }
      )
    } else if scope == "project" {
      WorkImportCenterState(
        systemImage: "tray", tint: ADEColor.textMuted, title: title,
        detail: "\(selectedMachine.name) may have \(providerName ?? "other") sessions in folders outside this project.",
        actionTitle: "Look in all folders",
        action: { scope = "all" }
      )
    } else {
      WorkImportCenterState(
        systemImage: "tray", tint: ADEColor.textMuted, title: title, detail: nil,
        actionTitle: "Show all agents",
        action: { selectProvider(workImportAllProvidersFilter) }
      )
    }
  }

  // MARK: - Preview + action bar

  private func sessionPreview(_ session: ExternalSessionSummary) -> some View {
    let plan = plan(for: session)
    return VStack(spacing: 0) {
      WorkImportSessionHeader(session: session, lanes: activeLanes)
        .padding(.leading, 20)
        .padding(.trailing, 16)
        .padding(.top, 12)
        .padding(.bottom, 10)
      Divider().overlay(ADEKit.rule)
      WorkImportSessionPreview(session: session, source: source)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      actionBar(session, plan: plan)
    }
    // The action bar's buttons end level with the edge bar's last capsule.
    .duoEdgeBarAlignedBottom(contentBottomPadding: 10)
  }

  private func actionBar(_ session: ExternalSessionSummary, plan: WorkImportPlan) -> some View {
    WorkImportActionBar(
      session: session,
      plan: plan,
      lanes: activeLanes,
      targetLaneId: Binding(
        get: { plan.targetLaneId ?? targetLaneId(for: session) },
        set: { newValue in
          targetChoices[session.importIdentity] = newValue
          confirmingKey = nil
        }
      ),
      surface: Binding(
        get: { plan.surface ?? "chat" },
        set: { newValue in
          let provider = workExternalSessionProviderKey(session.provider)
          surfaceChoices[provider] = newValue
          workSetImportSurfacePreference(provider, surface: newValue)
          confirmingKey = nil
        }
      ),
      confirmingKey: confirmingKey,
      importing: importingSessionId == session.importIdentity,
      importDisabled: importingSessionId != nil,
      error: importError,
      onRun: { action in
        run(action, for: session)
      },
      onOpenExisting: { ref in
        Task { await openExisting(session, ref: ref) }
      }
    )
  }

  private func closeDetail() {
    showsDetail = false
    confirmingKey = nil
    importError = nil
  }

  private func open(_ session: ExternalSessionSummary, pushes: Bool) {
    if selectedKey != session.importIdentity {
      confirmingKey = nil
      importError = nil
    }
    selectedKey = session.importIdentity
    if pushes { showsDetail = true }
  }

  /// The lane an import goes to: the user's pick, else the session's home
  /// lane, else the lane the page was opened for.
  private func targetLaneId(for session: ExternalSessionSummary) -> String {
    if let choice = targetChoices[session.importIdentity] { return choice }
    return session.defaultImportTargetLaneId(liveLaneIds: liveLaneIds) ?? originLaneId ?? lane.id
  }

  private func requestedSurface(for session: ExternalSessionSummary) -> String? {
    let provider = workExternalSessionProviderKey(session.provider)
    return surfaceChoices[provider] ?? workImportSurfacePreference(provider)
  }

  private func plan(for session: ExternalSessionSummary) -> WorkImportPlan {
    var plan = workPlanImport(
      session,
      surface: isRemoteSource ? "chat" : requestedSurface(for: session),
      targetLaneId: targetLaneId(for: session),
      originLaneId: originLaneId,
      laneName: laneName
    )
    // Terminals of another machine do not stream to the phone yet (the
    // new-chat page says the same): from there only chat imports are offered.
    if isRemoteSource {
      plan.surfaces = plan.surfaces.filter { $0 == "chat" }
      if plan.surface != "chat" {
        plan.surface = nil
        plan.primary = nil
        plan.secondary = nil
        plan.note = "This session opens only as a CLI, and the phone runs CLI sessions on \(syncService.focusedMachineDisplayName) only."
      }
    }
    return plan
  }

  private func run(_ action: WorkImportPlanAction, for session: ExternalSessionSummary) {
    guard importingSessionId == nil else { return }
    let plan = plan(for: session)
    let laneId = plan.targetLaneId ?? targetLaneId(for: session)
    // Same guard, same words as the host: never send an import it would refuse.
    if let reason = workImportRejectionReason(session, target: action.target, mode: action.mode, laneId: laneId) {
      ADEHaptics.error()
      importError = reason
      return
    }
    let key = workImportConfirmKey(session: session, action: action, laneId: plan.targetLaneId)
    // Continuing a session that may be open elsewhere takes a second tap.
    if action.confirmBeforeRun, confirmingKey != key {
      confirmingKey = key
      ADEHaptics.warning()
      Task { @MainActor in
        try? await Task.sleep(nanoseconds: workImportLiveConfirmNanos)
        if confirmingKey == key { confirmingKey = nil }
      }
      return
    }
    confirmingKey = nil
    Task { await importSession(session, action: action, laneId: laneId) }
  }

  // MARK: - Machine switching

  private func selectMachine(_ option: WorkNewChatMachineOption) {
    guard option.machineKey != sourceKey, importingSessionId == nil else { return }
    sourceKey = option.machineKey
    loadSeq += 1
    sessions = []
    pendingProviders = []
    unsupportedProviders = []
    failedProviders = []
    loadError = nil
    sourceError = nil
    scanDone = false
    selectedKey = nil
    showsDetail = false
    targetChoices = [:]
    laneFilter = workImportAllLanesFilter
    providerFilter = workImportAllProvidersFilter
    confirmingKey = nil
    importError = nil
    remoteLanes = []
    if let key = option.machineKey {
      Task { await loadRemoteLanes(machineKey: key) }
    }
  }

  private func retrySource() {
    guard let key = sourceKey else { return }
    sourceError = nil
    Task { await loadRemoteLanes(machineKey: key) }
  }

  /// Another machine's lanes: connect it if needed, then read its checkout of
  /// this project. The scan starts once its primary lane is known.
  @MainActor
  private func loadRemoteLanes(machineKey: String) async {
    remoteLanesLoading = true
    defer { if sourceKey == machineKey { remoteLanesLoading = false } }
    let live = await syncService.machineFleet?.connect(machineKey: machineKey) ?? false
    guard sourceKey == machineKey else { return }
    guard let repo = syncService.remoteLaneRepo(machineKey: machineKey) else {
      sourceError = "That machine has no checkout of this project."
      return
    }
    guard live else {
      sourceError = "Can’t reach \(repo.machineName) right now."
      return
    }
    do {
      let snapshots = try await syncService.fetchRemoteLaneSnapshots(
        repo: repo,
        timeoutNanoseconds: LaneRemoteMachinesModel.readTimeoutNanoseconds
      )
      guard sourceKey == machineKey else { return }
      remoteLanes = snapshots.map(\.lane).filter { $0.archivedAt == nil }
      if remoteLanes.isEmpty { sourceError = "\(repo.machineName) has no lanes in this project." }
    } catch {
      guard sourceKey == machineKey else { return }
      sourceError = "Can’t read \(repo.machineName)’s lanes: \(error.localizedDescription)"
    }
  }

  // MARK: - Loading

  /// Scans every provider in parallel, like the desktop dialog, so the chips
  /// can show counts. A refresh swaps each provider's rows in place, so the
  /// list never blanks; a scope or machine change starts from an empty list.
  @MainActor
  private func loadSessions(resetting: Bool = false, attempt: Int = 0) async {
    loadSeq += 1
    let seq = loadSeq
    let requestedScope = scope
    if resetting {
      sessions = []
      scanDone = false
    }
    // Another machine's lanes are still loading (or failed): nothing to scan yet.
    guard let scanLaneId = originLaneId else { return }
    let providers = scanProviders
    loadError = nil
    failedProviders = []
    pendingProviders = Set(providers)
    var failures = 0
    var lastError: String?

    await withTaskGroup(of: (String, [ExternalSessionSummary]?, Error?).self) { group in
      for provider in providers {
        group.addTask {
          do {
            // A lane of another machine carries its machine in its id, so
            // this scan goes to that machine.
            let rows = try await syncService.listExternalSessions(
              providers: [provider],
              laneId: scanLaneId,
              scope: requestedScope,
              limit: workImportBrowseLimitPerProvider
            )
            return (provider, rows, nil)
          } catch {
            return (provider, nil, error)
          }
        }
      }
      for await (provider, rows, error) in group {
        guard seq == loadSeq else { continue }
        pendingProviders.remove(provider)
        if let rows {
          let kept = rows.filter(workImportHasPrompts)
          sessions = sessions.filter { workExternalSessionProviderKey($0.provider) != provider } + kept
        } else if let error, !(error is CancellationError) {
          // An older host that does not know this provider refuses it by
          // name; that is "not supported here", not a failed scan.
          if error.localizedDescription.contains("requires a valid provider") {
            unsupportedProviders.insert(provider)
            continue
          }
          failures += 1
          lastError = error.localizedDescription
          failedProviders.append(provider)
        }
      }
    }

    guard seq == loadSeq, !Task.isCancelled else { return }
    if failures == providers.count && attempt == 0 {
      try? await Task.sleep(nanoseconds: workImportScanRetryNanos)
      guard seq == loadSeq, !Task.isCancelled else { return }
      await loadSessions(attempt: 1)
      return
    }
    scanDone = true
    if failures == providers.count {
      loadError = lastError ?? "\(selectedMachine.name) didn't answer. Check that it has this project open, then try again."
    }
  }

  // MARK: - Import

  /// The chat lives on the machine it was imported on: its reads, sends and
  /// stream go there.
  private func adoptChatScope(sessionId: String) {
    guard let repo = remoteRepo else { return }
    syncService.setRemoteMachineChatScope(
      sessionId: sessionId,
      machineKey: repo.machineKey,
      projectId: repo.projectId,
      projectRootPath: repo.rootPath
    )
  }

  @MainActor
  private func importSession(_ session: ExternalSessionSummary, action: WorkImportPlanAction, laneId: String) async {
    guard importingSessionId == nil else { return }
    if isRemoteSource && action.target != "chat" {
      importError = "The phone runs CLI sessions on \(syncService.focusedMachineDisplayName) only."
      return
    }
    importingSessionId = session.importIdentity
    importError = nil
    defer { importingSessionId = nil }
    do {
      let result = try await syncService.importExternalSession(
        provider: session.provider,
        sessionId: session.id,
        laneId: laneId,
        target: action.target,
        mode: action.mode
      )
      if result.kind == "chat", let chatSessionId = result.chatSessionId {
        adoptChatScope(sessionId: chatSessionId)
        let chatSummary: AgentChatSessionSummary
        if let returnedSummary = result.chatSummary {
          chatSummary = returnedSummary
        } else {
          chatSummary = try await syncService.fetchChatSummary(sessionId: chatSessionId)
        }
        syncService.cacheChatSummary(chatSummary)
        ADEHaptics.medium()
        await onChatImported(chatSummary)
      } else if result.kind == "cli", let sessionId = result.sessionId {
        ADEHaptics.medium()
        let resultLaneId = result.laneId ?? laneId
        await onCliImported(result.session ?? makeTerminalSessionSummary(
          sessionId: sessionId,
          ptyId: result.ptyId,
          laneId: resultLaneId,
          imported: session,
          action: action
        ))
      } else {
        throw NSError(
          domain: "ADE",
          code: 31,
          userInfo: [NSLocalizedDescriptionKey: "The machine returned an incomplete import result."]
        )
      }
    } catch {
      ADEHaptics.error()
      importError = error.localizedDescription
      // The host may have imported before failing; refresh so the row shows
      // "In ADE" instead of inviting a duplicate.
      Task { await loadSessions() }
    }
  }

  @MainActor
  private func openExisting(_ session: ExternalSessionSummary, ref: ExternalSessionImportedRef) async {
    guard importingSessionId == nil else { return }
    importingSessionId = session.importIdentity
    importError = nil
    await openExistingSession(session, ref: ref)
    importingSessionId = nil
  }

  @MainActor
  private func openExistingSession(
    _ session: ExternalSessionSummary,
    ref: ExternalSessionImportedRef
  ) async {
    guard let kind = workNormalizedImportedSessionKind(ref.kind) else {
      ADEHaptics.error()
      importError = "The imported session reference is not supported."
      return
    }
    let sessionId = ref.sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !sessionId.isEmpty else {
      ADEHaptics.error()
      importError = "The imported session reference is missing a session ID."
      return
    }

    if kind == "chat" {
      ADEHaptics.medium()
      adoptChatScope(sessionId: sessionId)
      do {
        let summary = try await syncService.fetchChatSummary(sessionId: sessionId)
        syncService.cacheChatSummary(summary)
        await onChatImported(summary)
      } catch {
        ADEHaptics.error()
        importError = "The imported ADE chat is not available yet. \(error.localizedDescription)"
      }
    } else if isRemoteSource {
      ADEHaptics.error()
      importError = "This CLI session runs on \(selectedMachine.name). Open it from there."
    } else {
      ADEHaptics.medium()
      if let terminal = await syncService.ensureSessionRowHydrated(sessionId: sessionId) {
        await onCliImported(terminal)
      } else {
        ADEHaptics.error()
        importError = "The imported CLI session is not available yet. Refresh and try again."
      }
    }
  }

  private func makeTerminalSessionSummary(
    sessionId: String,
    ptyId: String?,
    laneId: String,
    imported session: ExternalSessionSummary,
    action: WorkImportPlanAction
  ) -> TerminalSessionSummary {
    TerminalSessionSummary(
      id: sessionId,
      laneId: laneId,
      laneName: laneName(laneId) ?? lane.name,
      ptyId: ptyId,
      tracked: true,
      pinned: false,
      manuallyNamed: nil,
      goal: session.preview,
      toolType: workImportToolType(provider: session.provider),
      title: session.rowHeading,
      status: "running",
      startedAt: workDateFormatter.string(from: Date()),
      endedAt: nil,
      exitCode: nil,
      transcriptPath: "",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: session.preview,
      summary: action.label,
      runtimeState: "running",
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: nil
    )
  }
}

/// Back in the page header's leading slot. Held landscape on the Duo it stays
/// in the top row beside the title instead of becoming a lone circle on the
/// edge bar.
private struct WorkImportBackItem: ViewModifier {
  let title: String
  let disabled: Bool
  let action: () -> Void

  func body(content: Content) -> some View {
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      content.toolbar {
        ToolbarItem(placement: .topBarLeading) { button }
          .axisBehavior(.horizontalOnly)
      }
    } else {
      content.toolbar {
        ToolbarItem(placement: .topBarLeading) { button }
      }
    }
    #else
    content.toolbar {
      ToolbarItem(placement: .topBarLeading) { button }
    }
    #endif
  }

  private var button: some View {
    Button(title, systemImage: "chevron.left", action: action)
      .disabled(disabled)
      .accessibilityLabel(title == "Sessions" ? "Back to sessions" : "Back")
      .accessibilityIdentifier("Work.Import.Back")
  }
}

private struct WorkImportProviderCount: Identifiable {
  let provider: String
  let count: Int
  var id: String { provider }
}

/// A day of sessions in the list ("Today", "Yesterday", …).
private struct WorkImportSessionGroup: Identifiable {
  let label: String
  var rows: [ExternalSessionSummary]
  var id: String { label }
}

/// A centered empty/error state with one way forward, never a dead end.
private struct WorkImportCenterState: View {
  let systemImage: String?
  let tint: Color
  let title: String
  let detail: String?
  let actionTitle: String?
  let action: (() -> Void)?
  var showsProgress = false

  var body: some View {
    VStack(spacing: 8) {
      if showsProgress {
        ProgressView()
          .controlSize(.regular)
      } else if let systemImage {
        Image(systemName: systemImage)
          .font(.title3)
          .foregroundStyle(tint)
          .accessibilityHidden(true)
      }
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(showsProgress ? ADEColor.textSecondary : ADEColor.textPrimary)
        .multilineTextAlignment(.center)
      if let detail {
        Text(detail)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let actionTitle, let action {
        Button(actionTitle, action: action)
          .buttonStyle(ADEKitButtonStyle())
          .padding(.top, 6)
      }
    }
    .frame(maxWidth: 360)
    .padding(.horizontal, 24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// The calm kit pill every filter control here uses (34pt, like the machine
/// and lane controls on the new-chat page).
struct WorkImportPillLabel: View {
  var symbol: String?
  var laneMark: LaneSummary?
  let title: String

  var body: some View {
    HStack(spacing: 6) {
      if let laneMark {
        WorkLaneLogoMark(
          color: LaneColorPalette.displayColor(forHex: laneMark.color, fallback: ADEColor.textSecondary),
          laneIcon: laneMark.icon,
          emoji: laneMark.emoji,
          size: 12
        )
      } else if let symbol {
        Image(systemName: symbol)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
      }
      Text(title)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Image(systemName: "chevron.up.chevron.down")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, 12)
    .frame(height: 34)
    .adeKitPill()
    .contentShape(Capsule(style: .continuous))
  }
}

/// Lane filter for the session list: All lanes, each lane with sessions (with
/// its count), and Other folders for sessions no live lane owns.
private struct WorkImportLaneFilterMenu: View {
  let lanes: [LaneSummary]
  /// Buckets that hold any session, whatever the provider filter.
  let scanKeys: Set<String>
  /// Per-bucket counts under the provider filter.
  let counts: [String: Int]
  let totalCount: Int
  @Binding var selection: String

  private var lanesWithSessions: [LaneSummary] {
    lanes.filter { scanKeys.contains($0.id) || $0.id == selection }
  }

  private var selectedLane: LaneSummary? {
    lanes.first(where: { $0.id == selection })
  }

  private var title: String {
    if selection == workImportAllLanesFilter { return "All lanes" }
    if selection == workImportOtherFoldersFilter { return "Other folders" }
    return selectedLane?.name ?? "All lanes"
  }

  var body: some View {
    Menu {
      Picker("Lane", selection: $selection) {
        Text("All lanes · \(totalCount)").tag(workImportAllLanesFilter)
        ForEach(lanesWithSessions) { lane in
          Text("\(lane.emoji.map { "\($0) " } ?? "")\(lane.name) · \(counts[lane.id] ?? 0)").tag(lane.id)
        }
        if scanKeys.contains(workImportOtherFoldersFilter) || selection == workImportOtherFoldersFilter {
          Text("Other folders · \(counts[workImportOtherFoldersFilter] ?? 0)").tag(workImportOtherFoldersFilter)
        }
      }
    } label: {
      WorkImportPillLabel(
        symbol: selection == workImportOtherFoldersFilter ? "folder" : "square.stack.3d.up",
        laneMark: selectedLane,
        title: title
      )
    }
    .accessibilityLabel("Lane filter")
    .accessibilityValue(title)
  }
}

/// One option of the agent filter: one kit segmented track, each option a
/// logo, a name and its count (desktop's provider filter). Agents with no
/// sessions here stay listed, dimmed.
private struct WorkImportProviderSegment: View {
  let provider: String
  let count: Int
  let selected: Bool
  let action: () -> Void

  private var name: String {
    provider == workImportAllProvidersFilter ? "All" : workExternalSessionProviderName(provider)
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        if provider != workImportAllProvidersFilter {
          WorkProviderBareLogo(
            provider: provider,
            fallbackSymbol: providerIcon(provider),
            tint: workImportProviderTint(provider),
            size: 14
          )
          .opacity(count == 0 && !selected ? 0.45 : 1)
        }
        Text(name)
          .font(.system(size: 12.5, weight: selected ? .semibold : .medium))
          .foregroundStyle(selected ? ADEColor.textPrimary : (count == 0 ? ADEColor.textMuted : ADEColor.textSecondary))
        Text("\(count)")
          .font(.adeMono(11.5, weight: .medium))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 10)
      .frame(minHeight: 30)
      .background {
        if selected { ADEKitSegmentThumb() }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(name), \(count) \(count == 1 ? "session" : "sessions")")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

private func workImportToolType(provider: String) -> String {
  switch provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "claude": return "claude"
  case "codex": return "codex"
  // "cursor-cli" (not "cursor") so isWorkChatToolType classifies an imported
  // Cursor session as a CLI terminal, matching the desktop import mapping.
  case "cursor": return "cursor-cli"
  case "droid": return "droid"
  case "pi": return "pi"
  case "muse": return "muse"
  case "opencode": return "opencode"
  case "qwen": return "qwen"
  case "kimi": return "kimi"
  case "grok": return "grok"
  case "copilot": return "copilot"
  default: return provider
  }
}
