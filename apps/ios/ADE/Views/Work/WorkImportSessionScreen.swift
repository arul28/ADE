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

struct WorkImportSessionScreen: View {
  @EnvironmentObject var syncService: SyncService

  let lane: LaneSummary
  let lanes: [LaneSummary]
  let onCliImported: @MainActor (TerminalSessionSummary) async -> Void
  let onChatImported: @MainActor (AgentChatSessionSummary) async -> Void

  @State private var sessions: [ExternalSessionSummary] = []
  @State private var providerFilter = workImportAllProvidersFilter
  @State private var scope = "project"
  /// Nil until the user picks: the filter then follows the origin lane while
  /// it has (or may still get) sessions, else "All lanes".
  @State private var laneFilterChoice: String?
  /// Providers whose scan has not answered yet.
  @State private var pendingProviders: Set<String> = []
  @State private var scanDone = false
  @State private var loadError: String?
  @State private var failedProviders: [String] = []
  @State private var loadSeq = 0
  @State private var importError: String?
  @State private var importingSessionId: String?
  @State private var selectedSession: ExternalSessionSummary?
  /// Where the import goes. Defaults to the session's home lane when it opens.
  @State private var targetLaneId: String
  /// Mode picked on this screen, per provider. Falls back to the stored
  /// preference, then to the plan's first surface.
  @State private var surfaceChoices: [String: String] = [:]
  /// Action key waiting on a second tap (continuing a session that may be live).
  @State private var confirmingKey: String?

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
    _targetLaneId = State(initialValue: lane.id)
  }

  // MARK: - Derived list state

  private var scanProviders: [String] {
    workImportScanProviders(hostKnowsAcpProviders: syncService.supportsExternalSessionDetail)
  }

  private var loading: Bool {
    !pendingProviders.isEmpty || (!scanDone && loadError == nil)
  }

  private var liveLaneIds: Set<String> {
    Set(lanes.map(\.id))
  }

  private func laneName(_ laneId: String) -> String? {
    lanes.first(where: { $0.id == laneId })?.name
  }

  private func bucket(_ session: ExternalSessionSummary) -> String {
    session.importLaneBucket(liveLaneIds: liveLaneIds, originLaneId: lane.id)
  }

  private var scanLaneKeys: Set<String> {
    Set(sessions.map(bucket))
  }

  /// The origin lane while the scan can still find its sessions, else All lanes.
  private var laneFilter: String {
    if let laneFilterChoice { return laneFilterChoice }
    return scanLaneKeys.contains(lane.id) || loading ? lane.id : workImportAllLanesFilter
  }

  /// A provider filter with no sessions left falls back to All.
  private var effectiveProviderFilter: String {
    guard providerFilter != workImportAllProvidersFilter else { return providerFilter }
    return sessions.contains(where: { workExternalSessionProviderKey($0.provider) == providerFilter })
      ? providerFilter
      : workImportAllProvidersFilter
  }

  private func matchesLane(_ session: ExternalSessionSummary) -> Bool {
    laneFilter == workImportAllLanesFilter || bucket(session) == laneFilter
  }

  private func matchesProvider(_ session: ExternalSessionSummary) -> Bool {
    let filter = effectiveProviderFilter
    return filter == workImportAllProvidersFilter || workExternalSessionProviderKey(session.provider) == filter
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

  /// Only providers with a session under the lane filter get a chip; the
  /// chosen one keeps its chip so the filter can be cleared.
  private var providerChips: [WorkImportProviderCount] {
    let counts = providerCounts
    let filter = effectiveProviderFilter
    return scanProviders
      .filter { (counts[$0] ?? 0) > 0 || $0 == filter }
      .map { WorkImportProviderCount(provider: $0, count: counts[$0] ?? 0) }
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
    case workImportAllLanesFilter: return "any lane"
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

  // MARK: - Body

  var body: some View {
    Group {
      if let selectedSession {
        detail(selectedSession)
      } else {
        browser
      }
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(selectedSession == nil ? "Import session" : "Session")
    .navigationBarTitleDisplayMode(.inline)
    // The detail is a step inside this screen, so the system back button
    // (which would leave the whole screen) gives way to "Sessions".
    .navigationBarBackButtonHidden(selectedSession != nil)
    .toolbar {
      if selectedSession != nil {
        ToolbarItem(placement: .topBarLeading) {
          Button {
            closeDetail()
          } label: {
            Label("Sessions", systemImage: "chevron.left")
              .labelStyle(.titleAndIcon)
          }
          .disabled(importingSessionId != nil)
          .accessibilityLabel("Back to sessions")
        }
      }
    }
    .toolbar(.hidden, for: .tabBar)
    .adeRootTabBarHidden()
    .task(id: scope) {
      await loadSessions(resetting: true)
    }
  }

  // MARK: - Browser

  private var browser: some View {
    VStack(spacing: 0) {
      controls
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)

      if let failedNotice, !sessions.isEmpty {
        Label(failedNotice, systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 16)
          .padding(.bottom, 6)
      }

      browserContent
    }
  }

  @ViewBuilder
  private var controls: some View {
    VStack(alignment: .leading, spacing: 12) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          WorkImportProviderChip(
            provider: workImportAllProvidersFilter,
            count: inLane.count,
            selected: effectiveProviderFilter == workImportAllProvidersFilter,
            action: { providerFilter = workImportAllProvidersFilter }
          )
          ForEach(providerChips) { chip in
            WorkImportProviderChip(
              provider: chip.provider,
              count: chip.count,
              selected: effectiveProviderFilter == chip.provider,
              action: { providerFilter = chip.provider }
            )
          }
        }
        .padding(.vertical, 1)
      }

      HStack(spacing: 10) {
        WorkImportLaneFilterMenu(
          lanes: lanes,
          scanKeys: scanLaneKeys,
          counts: laneCounts,
          totalCount: inProvider.count,
          selection: Binding(
            get: { laneFilter },
            set: { laneFilterChoice = $0 }
          )
        )
        Spacer(minLength: 0)
        if loading && !sessions.isEmpty {
          ProgressView()
            .controlSize(.small)
            .accessibilityLabel("Scanning sessions")
        }
      }

      Picker("Where to look", selection: $scope) {
        Text("This project").tag("project")
        Text("All folders").tag("all")
      }
      .pickerStyle(.segmented)
      .accessibilityLabel("Where to look")
    }
  }

  @ViewBuilder
  private var browserContent: some View {
    if let loadError, sessions.isEmpty, !loading {
      WorkImportCenterState(
        systemImage: "exclamationmark.triangle",
        tint: ADEColor.warning,
        title: "Sessions couldn't be loaded",
        detail: loadError,
        actionTitle: "Try again",
        action: { Task { await loadSessions() } }
      )
    } else if visibleSessions.isEmpty && loading {
      VStack(spacing: 10) {
        Spacer()
        ProgressView()
          .controlSize(.regular)
        Text("Scanning sessions…")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
        Spacer()
      }
      .frame(maxWidth: .infinity)
    } else if sessions.isEmpty {
      WorkImportCenterState(
        systemImage: "tray",
        tint: ADEColor.textMuted,
        title: "No sessions found",
        detail: "Checked \(scanProviders.map(workExternalSessionProviderName).joined(separator: ", ")) \(scope == "project" ? "in this project" : "in every folder").",
        actionTitle: "Scan again",
        action: { Task { await loadSessions() } }
      )
    } else if visibleSessions.isEmpty {
      if laneFilter != workImportAllLanesFilter {
        WorkImportCenterState(
          systemImage: "tray",
          tint: ADEColor.textMuted,
          title: "No sessions in \(laneFilterName)",
          detail: nil,
          actionTitle: "Show all lanes",
          action: { laneFilterChoice = workImportAllLanesFilter }
        )
      } else {
        WorkImportCenterState(
          systemImage: "tray",
          tint: ADEColor.textMuted,
          title: "No matching sessions",
          detail: nil,
          actionTitle: "Show all providers",
          action: { providerFilter = workImportAllProvidersFilter }
        )
      }
    } else {
      List {
        ForEach(visibleGroups) { group in
          Text(group.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
            .accessibilityAddTraits(.isHeader)
            .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 0, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
          ForEach(group.rows, id: \.importIdentity) { session in
            Button {
              open(session)
            } label: {
              WorkImportSessionSummaryRow(session: session, lanes: lanes, showsLane: rowsShowLane)
            }
            .buttonStyle(.plain)
            .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .refreshable {
        await loadSessions()
      }
    }
  }

  // MARK: - Detail

  private func detail(_ session: ExternalSessionSummary) -> some View {
    let plan = plan(for: session)
    return ScrollView {
      WorkImportSessionRow(session: session, lanes: lanes)
        .padding(16)
    }
    .refreshable { await loadSessions() }
    // Pinned like the desktop action bar: the one action is always on screen,
    // however long the preview is.
    .safeAreaInset(edge: .bottom, spacing: 0) {
      WorkImportActionBar(
        session: session,
        plan: plan,
        lanes: lanes,
        targetLaneId: Binding(
          get: { targetLaneId },
          set: { newValue in
            targetLaneId = newValue
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
      .padding(.horizontal, 12)
      .padding(.top, 8)
      .padding(.bottom, 8)
    }
  }

  private func closeDetail() {
    selectedSession = nil
    confirmingKey = nil
    importError = nil
  }

  /// Opens a row: the target starts on its home lane, the mode on the last
  /// one used for this provider (else the first the plan offers).
  private func open(_ session: ExternalSessionSummary) {
    targetLaneId = session.defaultImportTargetLaneId(liveLaneIds: liveLaneIds) ?? lane.id
    confirmingKey = nil
    importError = nil
    selectedSession = session
  }

  private func requestedSurface(for session: ExternalSessionSummary) -> String? {
    let provider = workExternalSessionProviderKey(session.provider)
    return surfaceChoices[provider] ?? workImportSurfacePreference(provider)
  }

  private func plan(for session: ExternalSessionSummary) -> WorkImportPlan {
    workPlanImport(
      session,
      surface: requestedSurface(for: session),
      targetLaneId: targetLaneId,
      // The list was scanned for this screen's lane.
      originLaneId: lane.id,
      laneName: laneName
    )
  }

  private func run(_ action: WorkImportPlanAction, for session: ExternalSessionSummary) {
    guard importingSessionId == nil else { return }
    let plan = plan(for: session)
    let laneId = plan.targetLaneId ?? targetLaneId
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

  // MARK: - Loading

  /// Scans every provider in parallel, like the desktop dialog, so the chips
  /// can show counts. A refresh swaps each provider's rows in place, so the
  /// list never blanks; a scope change starts from an empty list.
  @MainActor
  private func loadSessions(resetting: Bool = false, attempt: Int = 0) async {
    loadSeq += 1
    let seq = loadSeq
    let requestedScope = scope
    let originLaneId = lane.id
    if resetting {
      sessions = []
      scanDone = false
    }
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
            let rows = try await syncService.listExternalSessions(
              providers: [provider],
              laneId: originLaneId,
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
          if error.localizedDescription.contains("requires a valid provider") { continue }
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
      loadError = lastError ?? "The machine didn't answer. Check that it has this project open, then try again."
    }
    // Keep an open detail on the fresh copy of its row.
    if let current = selectedSession,
       let fresh = sessions.first(where: { $0.importIdentity == current.importIdentity }) {
      selectedSession = fresh
    }
  }

  // MARK: - Import

  @MainActor
  private func importSession(_ session: ExternalSessionSummary, action: WorkImportPlanAction, laneId: String) async {
    guard importingSessionId == nil else { return }
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

    ADEHaptics.medium()
    if kind == "chat" {
      do {
        let summary = try await syncService.fetchChatSummary(sessionId: sessionId)
        syncService.cacheChatSummary(summary)
        await onChatImported(summary)
      } catch {
        ADEHaptics.error()
        importError = "The imported ADE chat is not available yet. \(error.localizedDescription)"
      }
    } else {
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
  let systemImage: String
  let tint: Color
  let title: String
  let detail: String?
  let actionTitle: String?
  let action: (() -> Void)?

  var body: some View {
    ScrollView {
      VStack(spacing: 8) {
        Image(systemName: systemImage)
          .font(.title3)
          .foregroundStyle(tint)
          .accessibilityHidden(true)
        Text(title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .multilineTextAlignment(.center)
        if let detail {
          Text(detail)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let actionTitle, let action {
          Button(actionTitle, action: action)
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.bordered)
            .tint(ADEColor.accent)
            .padding(.top, 4)
        }
      }
      .frame(maxWidth: .infinity)
      .padding(.horizontal, 32)
      .padding(.vertical, 48)
    }
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
          Text("\(lane.name) · \(counts[lane.id] ?? 0)").tag(lane.id)
        }
        if scanKeys.contains(workImportOtherFoldersFilter) || selection == workImportOtherFoldersFilter {
          Text("Other folders · \(counts[workImportOtherFoldersFilter] ?? 0)").tag(workImportOtherFoldersFilter)
        }
      }
    } label: {
      HStack(spacing: 6) {
        if let selectedLane {
          WorkLaneLogoMark(
            color: LaneColorPalette.displayColor(forHex: selectedLane.color, fallback: ADEColor.textSecondary),
            laneIcon: selectedLane.icon,
            size: 12
          )
        } else {
          Image(systemName: selection == workImportOtherFoldersFilter ? "folder" : "square.stack.3d.up")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Image(systemName: "chevron.up.chevron.down")
          .font(.caption2.weight(.bold))
          .foregroundStyle(ADEColor.textMuted.opacity(0.7))
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(ADEColor.surfaceBackground.opacity(0.7), in: Capsule(style: .continuous))
      .overlay(Capsule(style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 0.6))
    }
    .accessibilityLabel("Lane filter")
    .accessibilityValue(title)
  }
}

private struct WorkImportProviderChip: View {
  let provider: String
  let count: Int
  let selected: Bool
  let action: () -> Void

  private var name: String {
    provider == workImportAllProvidersFilter ? "All" : providerDisplayName(provider)
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if provider != workImportAllProvidersFilter {
          providerLogo
        }
        Text(name)
          .font(.caption.weight(.semibold))
        Text("\(count)")
          .font(.caption2.weight(.semibold).monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
      }
      .foregroundStyle(selected ? ADEColor.textPrimary : ADEColor.textSecondary)
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(selected ? ADEColor.surfaceBackground.opacity(0.88) : ADEColor.recessedBackground.opacity(0.5), in: Capsule())
      .overlay {
        Capsule()
          .stroke(selected ? ADEColor.glassBorder : Color.clear, lineWidth: 0.6)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(name), \(count) \(count == 1 ? "session" : "sessions")")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  @ViewBuilder
  private var providerLogo: some View {
    WorkProviderBareLogo(
      provider: provider,
      fallbackSymbol: providerIcon(provider),
      tint: ADEColor.providerChatAccent(for: provider),
      size: 18
    )
  }
}

private func providerDisplayName(_ provider: String) -> String {
  workExternalSessionProviderName(provider)
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
  case "opencode": return "opencode"
  case "qwen": return "qwen"
  case "kimi": return "kimi"
  case "grok": return "grok"
  case "copilot": return "copilot"
  default: return provider
  }
}
