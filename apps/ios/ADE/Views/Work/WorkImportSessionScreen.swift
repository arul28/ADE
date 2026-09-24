import Foundation
import SwiftUI

private let workImportSessionProviders = [
  "all", "claude", "codex", "cursor", "droid", "opencode", "pi", "qwen", "kimi", "grok", "copilot",
]

/// Lane filter values that are not lane ids.
private let workImportAllLanesFilter = "__all_lanes__"
private let workImportOtherFoldersFilter = "__other_folders__"

struct WorkImportSessionScreen: View {
  @EnvironmentObject var syncService: SyncService

  let lane: LaneSummary
  let lanes: [LaneSummary]
  let onCliImported: @MainActor (TerminalSessionSummary) async -> Void
  let onChatImported: @MainActor (AgentChatSessionSummary) async -> Void

  @State private var sessions: [ExternalSessionSummary] = []
  @State private var providerFilter = "all"
  @State private var scope = "project"
  /// Nil until the first load decides between the origin lane and "All lanes".
  @State private var laneFilter: String?
  @State private var loading = false
  @State private var hasLoaded = false
  @State private var errorMessage: String?
  @State private var importingSessionId: String?
  @State private var selectedSession: ExternalSessionSummary?
  /// Where the import goes. Defaults to the session's home lane when it opens.
  @State private var targetLaneId: String
  @State private var surface: String?
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

  /// The list no longer depends on the target lane: every row carries its own
  /// home lane, and the lane filter works on the loaded rows.
  private var queryKey: String {
    "\(providerFilter)|\(scope)"
  }

  private var liveLaneIds: Set<String> {
    Set(lanes.map(\.id))
  }

  private func laneName(_ laneId: String) -> String? {
    lanes.first(where: { $0.id == laneId })?.name
  }

  private var sortedSessions: [ExternalSessionSummary] {
    sessions.sorted { left, right in
      (left.updatedAt ?? left.createdAt ?? 0) > (right.updatedAt ?? right.createdAt ?? 0)
    }
  }

  private var laneCounts: [String: Int] {
    var counts: [String: Int] = [:]
    for session in sessions {
      counts[session.importLaneBucket(liveLaneIds: liveLaneIds, originLaneId: lane.id), default: 0] += 1
    }
    return counts
  }

  private var visibleSessions: [ExternalSessionSummary] {
    let filter = laneFilter ?? workImportAllLanesFilter
    guard filter != workImportAllLanesFilter else { return sortedSessions }
    return sortedSessions.filter {
      $0.importLaneBucket(liveLaneIds: liveLaneIds, originLaneId: lane.id) == filter
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      Group {
        if selectedSession == nil {
          controls
        } else {
          detailControls
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 12)
      .padding(.bottom, 8)

      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 16)
          .padding(.bottom, 8)
      }

      content
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle("Import session")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .adeRootTabBarHidden()
    .task(id: queryKey) {
      await loadSessions()
    }
  }

  @ViewBuilder
  private var detailControls: some View {
    Button {
      selectedSession = nil
      confirmingKey = nil
    } label: {
      Label("All sessions", systemImage: "chevron.left")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.accent)
    }
    .buttonStyle(.plain)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private var controls: some View {
    VStack(alignment: .leading, spacing: 12) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(workImportSessionProviders, id: \.self) { provider in
            WorkImportProviderChip(
              provider: provider,
              selected: providerFilter == provider,
              action: { providerFilter = provider }
            )
          }
        }
        .padding(.vertical, 1)
      }

      HStack(spacing: 10) {
        WorkImportLaneFilterMenu(
          lanes: lanes,
          counts: laneCounts,
          totalCount: sessions.count,
          selection: Binding(
            get: { laneFilter ?? workImportAllLanesFilter },
            set: { laneFilter = $0 }
          )
        )
        Spacer(minLength: 0)
      }

      Picker("Scope", selection: $scope) {
        Text("This project only").tag("project")
        Text("All folders").tag("all")
      }
      .pickerStyle(.segmented)
    }
  }

  @ViewBuilder
  private var content: some View {
    if let selectedSession {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          WorkImportSessionRow(
            session: selectedSession,
            lanes: lanes,
            importing: importingSessionId == selectedSession.importIdentity
          )
          WorkImportActionBar(
            session: selectedSession,
            plan: plan(for: selectedSession),
            lanes: lanes,
            targetLaneId: Binding(
              get: { targetLaneId },
              set: { newValue in
                targetLaneId = newValue
                confirmingKey = nil
              }
            ),
            surface: Binding(
              get: { plan(for: selectedSession).surface ?? "chat" },
              set: { newValue in
                surface = newValue
                confirmingKey = nil
              }
            ),
            confirmingKey: confirmingKey,
            importDisabled: importingSessionId != nil || loading,
            onRun: { action in
              run(action, for: selectedSession)
            },
            onOpenExisting: { ref in
              Task { await openExisting(selectedSession, ref: ref) }
            }
          )
        }
        .padding(16)
      }
      .refreshable { await loadSessions() }
    } else if loading && !hasLoaded {
      Spacer()
      ProgressView()
        .controlSize(.regular)
      Spacer()
    } else if visibleSessions.isEmpty {
      Spacer()
      VStack(spacing: 8) {
        Image(systemName: "tray")
          .font(.title3)
          .foregroundStyle(ADEColor.textMuted)
        Text(sessions.isEmpty ? "No sessions found" : "No sessions in this lane")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("Pull to refresh")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
      Spacer()
    } else {
      List {
        ForEach(visibleSessions, id: \.importIdentity) { session in
          Button {
            open(session)
          } label: {
            WorkImportSessionSummaryRow(session: session, lanes: lanes)
          }
          .buttonStyle(.plain)
          .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .refreshable {
        await loadSessions()
      }
    }
  }

  /// Opens a row: the target starts on its home lane, the mode on the first
  /// surface the provider offers.
  private func open(_ session: ExternalSessionSummary) {
    targetLaneId = session.defaultImportTargetLaneId(liveLaneIds: liveLaneIds) ?? lane.id
    surface = nil
    confirmingKey = nil
    selectedSession = session
  }

  private func plan(for session: ExternalSessionSummary) -> WorkImportPlan {
    workPlanImport(session, surface: surface, targetLaneId: targetLaneId, laneName: laneName)
  }

  private func run(_ action: WorkImportPlanAction, for session: ExternalSessionSummary) {
    let plan = plan(for: session)
    let key = "\(session.importIdentity):\(action.target):\(action.mode):\(plan.targetLaneId ?? "")"
    // Continuing a session that may be open elsewhere takes a second tap.
    if action.mode == "resume", session.possiblyActive, confirmingKey != key {
      confirmingKey = key
      ADEHaptics.warning()
      return
    }
    confirmingKey = nil
    let laneId = plan.targetLaneId ?? targetLaneId
    Task { await importSession(session, action: action, laneId: laneId) }
  }

  private func loadSessions() async {
    let requestedQueryKey = queryKey
    let requestedProviderFilter = providerFilter
    let requestedScope = scope
    loading = true
    defer {
      if requestedQueryKey == queryKey {
        loading = false
      }
    }
    errorMessage = nil
    do {
      let providers = requestedProviderFilter == "all" ? nil : [requestedProviderFilter]
      let loadedSessions = try await syncService.listExternalSessions(
        providers: providers,
        laneId: lane.id,
        scope: requestedScope,
        limit: 100
      )
      guard requestedQueryKey == queryKey else { return }
      sessions = loadedSessions
      if laneFilter == nil {
        // Open on the lane the screen came from when it has sessions.
        let origin = lane.id
        laneFilter = loadedSessions.contains(where: {
          $0.importLaneBucket(liveLaneIds: liveLaneIds, originLaneId: origin) == origin
        }) ? origin : workImportAllLanesFilter
      }
      if let current = selectedSession {
        selectedSession = sessions.first(where: { $0.importIdentity == current.importIdentity })
      }
      hasLoaded = true
    } catch is CancellationError {
    } catch {
      guard requestedQueryKey == queryKey else { return }
      errorMessage = error.localizedDescription
      hasLoaded = true
    }
  }

  @MainActor
  private func importSession(_ session: ExternalSessionSummary, action: WorkImportPlanAction, laneId: String) async {
    guard importingSessionId == nil, !loading else { return }
    importingSessionId = session.importIdentity
    errorMessage = nil
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
      errorMessage = error.localizedDescription
    }
    importingSessionId = nil
  }

  @MainActor
  private func openExisting(_ session: ExternalSessionSummary, ref: ExternalSessionImportedRef) async {
    guard importingSessionId == nil, !loading else { return }
    importingSessionId = session.importIdentity
    errorMessage = nil
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
      errorMessage = "The imported session reference is not supported."
      return
    }
    let sessionId = ref.sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !sessionId.isEmpty else {
      ADEHaptics.error()
      errorMessage = "The imported session reference is missing a session ID."
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
        errorMessage = "The imported ADE chat is not available yet. \(error.localizedDescription)"
      }
    } else {
      if let terminal = await syncService.ensureSessionRowHydrated(sessionId: sessionId) {
        await onCliImported(terminal)
      } else {
        ADEHaptics.error()
        errorMessage = "The imported CLI session is not available yet. Refresh and try again."
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

/// Lane filter for the session list: All lanes, each lane with sessions (with
/// its count), and Other folders for sessions no live lane owns.
private struct WorkImportLaneFilterMenu: View {
  let lanes: [LaneSummary]
  let counts: [String: Int]
  let totalCount: Int
  @Binding var selection: String

  private var lanesWithSessions: [LaneSummary] {
    lanes.filter { (counts[$0.id] ?? 0) > 0 || $0.id == selection }
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
        if (counts[workImportOtherFoldersFilter] ?? 0) > 0 || selection == workImportOtherFoldersFilter {
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
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 9, weight: .bold))
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

/// The action bar: mode switch, lane control, note, and one main button with
/// an optional Copy — all from `workPlanImport`.
private struct WorkImportActionBar: View {
  let session: ExternalSessionSummary
  let plan: WorkImportPlan
  let lanes: [LaneSummary]
  @Binding var targetLaneId: String
  @Binding var surface: String
  let confirmingKey: String?
  let importDisabled: Bool
  let onRun: (WorkImportPlanAction) -> Void
  let onOpenExisting: (ExternalSessionImportedRef) -> Void

  private var importedRef: ExternalSessionImportedRef? {
    workImportedSessionRef(for: session)
  }

  /// An imported row opens its ADE session instead of continuing it again;
  /// only the copy stays on offer.
  private var actions: (primary: WorkImportPlanAction?, secondary: WorkImportPlanAction?) {
    guard importedRef != nil else { return (plan.primary, plan.secondary) }
    let copies = [plan.primary, plan.secondary].compactMap { $0 }.filter { $0.mode == "fork" }
    return (copies.first, nil)
  }

  private var note: String? {
    guard let primary = actions.primary else { return nil }
    if primary == plan.primary { return plan.note }
    return nil
  }

  private func confirmKey(_ action: WorkImportPlanAction) -> String {
    "\(session.importIdentity):\(action.target):\(action.mode):\(plan.targetLaneId ?? "")"
  }

  private var lockedLane: LaneSummary? {
    guard let laneId = plan.targetLaneId else { return nil }
    return lanes.first(where: { $0.id == laneId })
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let importedRef {
        Button {
          onOpenExisting(importedRef)
        } label: {
          Label("Open in ADE", systemImage: "arrow.right.circle.fill")
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
        }
        .buttonStyle(.borderedProminent)
        .tint(ADEColor.accent)
        .disabled(importDisabled)
      }

      if plan.surfaces.count > 1 {
        Picker("Mode", selection: $surface) {
          ForEach(plan.surfaces, id: \.self) { value in
            Text(workImportSurfaceLabel(value)).tag(value)
          }
        }
        .pickerStyle(.segmented)
        .accessibilityLabel("Import as")
      } else if let only = plan.surface {
        Text(workImportSurfaceLabel(only))
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
      }

      if plan.surface != nil {
        HStack(alignment: .center, spacing: 8) {
          Text("in")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
          if plan.laneLocked {
            lockedChip
          } else {
            WorkLanePickerDropdown(
              lanes: lanes,
              selectedLaneId: $targetLaneId,
              showsAutoCreateOption: false
            )
          }
          Spacer(minLength: 0)
        }
        if plan.laneLocked, let lockReason = plan.lockReason {
          Text(lockReason)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
      }

      if let primary = actions.primary, confirmingKey == confirmKey(primary) {
        Label("It may be open elsewhere. Tap again to continue anyway.", systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(ADEColor.warning)
      } else if let note {
        Text(note)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }

      if actions.primary != nil || actions.secondary != nil {
        HStack(spacing: 10) {
          Spacer(minLength: 0)
          if let secondary = actions.secondary {
            Button(secondary.label) {
              onRun(secondary)
            }
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.bordered)
            .tint(ADEColor.textPrimary)
            .disabled(importDisabled)
          }
          if let primary = actions.primary {
            let confirming = confirmingKey == confirmKey(primary)
            Button {
              onRun(primary)
            } label: {
              Text(confirming ? "Continue anyway" : primary.label)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(confirming ? ADEColor.warning : ADEColor.accent)
            .disabled(importDisabled)
          }
        }
      } else if importedRef == nil {
        Text("This session can't be imported from here.")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(16)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.6)
    }
  }

  private var lockedChip: some View {
    let name = lockedLane?.name ?? session.home?.laneName ?? "its lane"
    let color = LaneColorPalette.displayColor(
      forHex: lockedLane?.color ?? session.home?.color,
      fallback: ADEColor.textSecondary
    )
    return HStack(spacing: 6) {
      Image(systemName: "lock.fill")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
      WorkLaneLogoMark(color: color, laneIcon: lockedLane?.icon, size: 12)
      Text(name)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(Color.white.opacity(0.04), in: Capsule(style: .continuous))
    .overlay(Capsule(style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 0.6))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Lane \(name), locked")
    .accessibilityHint(plan.lockReason ?? "")
  }
}

private struct WorkImportProviderChip: View {
  let provider: String
  let selected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if provider != "all" {
          providerLogo
        }
        Text(provider == "all" ? "All" : providerDisplayName(provider))
          .font(.caption.weight(.semibold))
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

private struct WorkImportSessionSummaryRow: View {
  let session: ExternalSessionSummary
  let lanes: [LaneSummary]

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      WorkProviderBareLogo(
        provider: session.provider,
        fallbackSymbol: providerIcon(session.provider),
        tint: ADEColor.providerChatAccent(for: session.provider),
        size: 20
      )
      .padding(.top, 2)

      VStack(alignment: .leading, spacing: 5) {
        Text(session.rowHeading)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)

        HStack(spacing: 5) {
          WorkImportLaneLabel(session: session, lanes: lanes)
          if !session.relativeUpdatedAt.isEmpty {
            Text("· \(session.relativeUpdatedAt)")
          }
          if let count = session.messageCount {
            Text("· \(count) \(count == 1 ? "prompt" : "prompts")")
          }
          if let size = session.sizeDisplay {
            Text("· \(size)")
          }
        }
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)

        if let started = session.startedAnchorSnippet,
           let latest = session.latestAnchorMessage {
          WorkImportSessionAnchorBlock(started: started, latest: latest.text)
        } else if let started = session.startedAnchorSnippet {
          WorkImportSessionAnchorBlock(started: started, latest: nil)
        } else if let latest = session.latestAnchorMessage {
          WorkImportSessionAnchorBlock(started: nil, latest: latest.text)
        } else if !session.hasConversationAnchorData,
                  let preview = session.previewSnippet,
                  !session.previewDuplicatesHeading {
          Text(preview)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
      }

      Spacer(minLength: 4)
      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .padding(.top, 4)
    }
    .padding(14)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.6)
    }
  }
}

private struct WorkImportSessionAnchorBlock: View {
  let started: String?
  let latest: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      if let started {
        anchor(label: "started", text: started, lineLimit: 1)
      }
      if let latest {
        anchor(label: "latest", text: latest, lineLimit: 2)
      }
    }
    .padding(.leading, 9)
    .overlay(alignment: .leading) {
      Rectangle()
        .fill(ADEColor.glassBorder)
        .frame(width: 1)
    }
    .padding(.top, 2)
  }

  private func anchor(label: String, text: String, lineLimit: Int) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(label)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(text)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(lineLimit)
    }
  }
}

private struct WorkImportSessionRow: View {
  let session: ExternalSessionSummary
  let lanes: [LaneSummary]
  let importing: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 7) {
          Text(session.rowHeading)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
          statusBadges
          metaLine
        }

        Spacer(minLength: 0)

        if importing {
          ProgressView()
            .controlSize(.small)
            .padding(.top, 2)
        }
      }

      WorkImportSessionPreview(session: session)
    }
    .padding(16)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.6)
    }
    .contentShape(Rectangle())
  }

  @ViewBuilder
  private var metaLine: some View {
    HStack(spacing: 5) {
      WorkProviderBareLogo(
        provider: session.provider,
        fallbackSymbol: providerIcon(session.provider),
        tint: ADEColor.providerChatAccent(for: session.provider),
        size: 16
      )

      Text(providerDisplayName(session.provider))

      Text("·")
        .foregroundStyle(ADEColor.textMuted.opacity(0.7))
      WorkImportLaneLabel(session: session, lanes: lanes)

      if !session.relativeUpdatedAt.isEmpty {
        Text("·")
          .foregroundStyle(ADEColor.textMuted.opacity(0.7))
        Text(session.relativeUpdatedAt)
      }

      if let messageCount = session.messageCount {
        Text("·")
          .foregroundStyle(ADEColor.textMuted.opacity(0.7))
        Text("\(messageCount) \(messageCount == 1 ? "prompt" : "prompts")")
      }

      if let size = session.sizeDisplay {
        Text("·")
          .foregroundStyle(ADEColor.textMuted.opacity(0.7))
        Text(size)
      }
    }
    .font(.caption)
    .foregroundStyle(ADEColor.textSecondary)
    .lineLimit(1)
  }

  @ViewBuilder
  private var statusBadges: some View {
    if session.alreadyImported || session.possiblyActive {
      HStack(spacing: 6) {
        if session.alreadyImported {
          WorkImportBadge(text: "Imported", tint: ADEColor.success)
        }
        if session.possiblyActive {
          WorkImportBadge(text: "May be open elsewhere", tint: ADEColor.warning)
        }
      }
    }
  }
}

/// The session's conversation, disclosed under the detail header.
///
/// On a host with `work.getExternalSessionDetail` it is the conversation as
/// ADE chat events, rendered by the same builders and row views as a Work chat
/// (messages, tool calls, commands, file changes, reasoning), in a bounded
/// scroller that opens at the newest message with "Load earlier" at the top.
/// On an older host, while the first page loads, or when the call fails, it is
/// the list's sampled messages, as before.
private struct WorkImportSessionPreview: View {
  @EnvironmentObject var syncService: SyncService

  let session: ExternalSessionSummary

  @State private var expanded = true
  @State private var events: [AgentChatEventEnvelope] = []
  @State private var entries: [WorkTimelineEntry] = []
  /// The host's text tail, for a host that answered without events.
  @State private var hostMessages: [ExternalSessionMessage] = []
  @State private var hasOlder = false
  @State private var olderCursor: String?
  @State private var loading = false
  @State private var loadingOlder = false
  @State private var olderError: String?
  @State private var expandedCardIds: Set<String> = []

  private static let bottomAnchorId = "work-import-preview-bottom"
  private static let transcriptHeight: CGFloat = 380

  private var fallbackMessages: [ExternalSessionMessage] {
    let host = hostMessages.compactMap { message -> ExternalSessionMessage? in
      let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { return nil }
      return ExternalSessionMessage(role: message.role, text: text, at: message.at)
    }
    return host.isEmpty ? session.conversationMessages : host
  }

  private var disclosureTitle: String {
    if !entries.isEmpty { return "Conversation" }
    let count = fallbackMessages.count
    guard count > 0 else { return "Preview" }
    return "Last \(count) \(count == 1 ? "message" : "messages")"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) {
          expanded.toggle()
        }
      } label: {
        HStack(spacing: 4) {
          Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .bold))
            .rotationEffect(.degrees(expanded ? 90 : 0))
          Text(disclosureTitle)
            .font(.caption.weight(.semibold))
          if loading {
            ProgressView()
              .controlSize(.mini)
              .padding(.leading, 2)
          }
        }
        .foregroundStyle(ADEColor.textMuted)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)

      if expanded {
        if !entries.isEmpty {
          transcriptPreview
        } else {
          WorkImportSampledMessagesPreview(session: session, messages: fallbackMessages)
        }
      }
    }
    .task(id: session.importIdentity) {
      await loadNewest()
    }
  }

  private var transcriptPreview: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 10) {
          if hasOlder {
            loadEarlierControl(proxy: proxy)
          }
          ForEach(entries) { entry in
            entryView(entry)
              .id(entry.id)
          }
          Color.clear
            .frame(height: 1)
            .id(Self.bottomAnchorId)
        }
        .padding(10)
      }
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .id(session.importIdentity)
      .frame(height: Self.transcriptHeight)
      .background(ADEColor.textPrimary.opacity(0.025), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(ADEColor.glassBorder.opacity(0.55), lineWidth: 0.6)
      }
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
      .environment(\.workChatProvider, session.provider)
      .onAppear {
        proxy.scrollTo(Self.bottomAnchorId, anchor: .bottom)
      }
    }
  }

  @ViewBuilder
  private func loadEarlierControl(proxy: ScrollViewProxy) -> some View {
    VStack(spacing: 4) {
      Button {
        let anchorId = entries.first?.id
        Task {
          await loadOlder()
          // Keep the row the reader was looking at in place instead of jumping
          // to the top of the page that just arrived.
          if let anchorId, entries.contains(where: { $0.id == anchorId }) {
            proxy.scrollTo(anchorId, anchor: .top)
          }
        }
      } label: {
        HStack(spacing: 6) {
          if loadingOlder {
            ProgressView()
              .controlSize(.mini)
          }
          Text(loadingOlder ? "Loading earlier…" : "Load earlier")
            .font(.caption.weight(.semibold))
        }
        .foregroundStyle(ADEColor.accent)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(ADEColor.accent.opacity(0.1), in: Capsule())
      }
      .buttonStyle(.plain)
      .disabled(loadingOlder)

      if let olderError {
        Text(olderError)
          .font(.caption2)
          .foregroundStyle(ADEColor.danger)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.bottom, 4)
  }

  @ViewBuilder
  private func entryView(_ entry: WorkTimelineEntry) -> some View {
    switch entry.payload {
    case .message(let message):
      WorkChatMessageBubble(
        message: message,
        maxUserBubbleWidth: 260,
        onOpenFullOutput: {}
      )
      .equatable()
    case .toolCard(let card):
      WorkToolCardView(
        toolCard: card,
        isExpanded: expandedCardIds.contains(card.id),
        onToggle: { toggleCard(card.id) },
        onOpenFile: { _ in },
        onOpenPr: { _ in }
      )
      .equatable()
    case .commandCard(let card):
      WorkCommandCardView(
        card: card,
        isExpanded: expandedCardIds.contains(card.id),
        onToggle: { toggleCard(card.id) }
      )
      .equatable()
    case .fileChangeCard(let card):
      WorkFileChangeCardView(
        card: card,
        isExpanded: expandedCardIds.contains(card.id),
        onToggle: { toggleCard(card.id) }
      )
      .equatable()
    case .toolGroup(let group):
      WorkToolCallsPanelView(
        group: group,
        isExpanded: expandedCardIds.contains(group.id),
        onToggle: { toggleCard(group.id) },
        expandedMemberIds: expandedCardIds,
        onToggleMember: { memberId in toggleCard(memberId) }
      )
    case .changedFiles(let group):
      WorkChangedFilesPanelView(
        group: group,
        isExpanded: expandedCardIds.contains(group.id),
        onToggle: { toggleCard(group.id) },
        expandedFileIds: expandedCardIds,
        onToggleFile: { fileId in toggleCard(fileId) },
        onUndo: nil
      )
    case .subagent(let row):
      WorkSubagentTimelineRowView(row: row)
    case .eventCard(let card):
      if card.kind == "reasoning" {
        WorkReasoningCard(
          card: card,
          isLive: false,
          isExpanded: expandedCardIds.contains(card.id),
          onToggle: { toggleCard(card.id) }
        )
      } else if card.kind == "plan" {
        WorkProposedPlanCard(
          card: card,
          isExpanded: expandedCardIds.contains(card.id),
          onToggle: { toggleCard(card.id) }
        )
      } else {
        EmptyView()
      }
    default:
      // Live-session rows (pending inputs, turn footers, usage, artifacts,
      // ADE cards) have nothing to say about a session that is not running.
      EmptyView()
    }
  }

  private func toggleCard(_ id: String) {
    if expandedCardIds.contains(id) {
      expandedCardIds.remove(id)
    } else {
      expandedCardIds.insert(id)
    }
  }

  /// The newest page. The detail view is reused across sessions, so every
  /// load starts from a clean slate.
  private func loadNewest() async {
    events = []
    entries = []
    hostMessages = []
    hasOlder = false
    olderCursor = nil
    olderError = nil
    loadingOlder = false
    expandedCardIds = []
    guard syncService.supportsExternalSessionDetail else { return }
    loading = true
    defer { loading = false }
    do {
      let detail = try await syncService.getExternalSessionDetail(
        provider: session.provider,
        sessionId: session.id
      )
      guard !Task.isCancelled else { return }
      events = detail.events
      hostMessages = detail.messages
      olderCursor = detail.olderCursor
      hasOlder = detail.hasOlder && detail.olderCursor != nil
      rebuildEntries()
    } catch {
      // The sampled messages stay on screen: a failed detail call costs the
      // full conversation, never the preview.
    }
  }

  private func loadOlder() async {
    guard let cursor = olderCursor, !loadingOlder else { return }
    loadingOlder = true
    olderError = nil
    defer { loadingOlder = false }
    do {
      let detail = try await syncService.getExternalSessionDetail(
        provider: session.provider,
        sessionId: session.id,
        before: cursor
      )
      guard !Task.isCancelled else { return }
      let known = Set(events.map(\.id))
      events = detail.events.filter { !known.contains($0.id) } + events
      olderCursor = detail.olderCursor
      hasOlder = detail.hasOlder && detail.olderCursor != nil
      rebuildEntries()
    } catch {
      olderError = "Couldn't load earlier messages."
    }
  }

  /// Same pipeline as a Work chat transcript: envelopes to `WorkChatEnvelope`,
  /// then the timeline snapshot (tool-call folding included), then the
  /// mobile presentation filter.
  private func rebuildEntries() {
    let transcript = makeWorkChatTranscript(from: events)
    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    entries = workPresentedTimelineEntries(snapshot.timeline, provider: session.provider)
  }
}

/// The list's sampled messages: the whole preview on an older host, and the
/// fallback while (or if) the full conversation cannot be loaded.
private struct WorkImportSampledMessagesPreview: View {
  let session: ExternalSessionSummary
  let messages: [ExternalSessionMessage]

  var body: some View {
    if !messages.isEmpty {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(messages.enumerated()), id: \.offset) { index, message in
            WorkImportConversationMessageRow(message: message)
            if index < messages.count - 1 {
              Divider()
                .overlay(ADEColor.glassBorder.opacity(0.45))
            }
          }
        }
      }
      .frame(
        height: min(
          260,
          max(92, CGFloat(messages.count) * 72)
        )
      )
      .background(ADEColor.textPrimary.opacity(0.025), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(ADEColor.glassBorder.opacity(0.55), lineWidth: 0.6)
      }
    } else if let preview = session.previewSnippet,
              !session.previewDuplicatesHeading {
      Text(preview)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ADEColor.textPrimary.opacity(0.025), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(ADEColor.glassBorder.opacity(0.55), lineWidth: 0.6)
        }
    } else {
      Text("No conversational preview was recoverable for this session.")
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

private struct WorkImportConversationMessageRow: View {
  let message: ExternalSessionMessage

  private var isUser: Bool {
    message.role == "user"
  }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Text(isUser ? "YOU" : "ADE")
        .font(.system(size: 9, weight: .bold))
        .foregroundStyle(isUser ? ADEColor.purpleAccent : ADEColor.success)
        .frame(width: 30, alignment: .leading)
        .padding(.top, 2)

      Text(message.text)
        .font(.caption)
        .foregroundStyle(isUser ? ADEColor.textPrimary : ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(isUser ? ADEColor.purpleAccent.opacity(0.025) : Color.clear)
  }
}

private struct WorkImportBadge: View {
  let text: String
  let tint: Color

  var body: some View {
    Text(text)
      .font(.caption2.weight(.semibold))
      .foregroundStyle(tint)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(tint.opacity(0.12), in: Capsule())
  }
}

/// Lane dot + name for a row. Never a worktree folder: a removed lane says so,
/// and a folder outside every lane shows its last path segment.
private struct WorkImportLaneLabel: View {
  let session: ExternalSessionSummary
  let lanes: [LaneSummary]

  private var liveLane: LaneSummary? {
    guard session.home?.kind == "lane", let laneId = session.home?.laneId else { return nil }
    return lanes.first(where: { $0.id == laneId })
  }

  var body: some View {
    HStack(spacing: 4) {
      if session.home?.kind == "lane" {
        Circle()
          .fill(LaneColorPalette.displayColor(
            forHex: liveLane?.color ?? session.home?.color,
            fallback: ADEColor.textSecondary
          ))
          .frame(width: 6, height: 6)
      } else if session.home != nil {
        Image(systemName: "folder")
          .font(.system(size: 9, weight: .semibold))
      }
      Text(liveLane?.name ?? session.laneDisplayName)
        .lineLimit(1)
        .truncationMode(.middle)
    }
  }
}

extension ExternalSessionSummary {
  var importIdentity: String {
    "\(provider):\(id)"
  }

  /// The row's lane label: the home lane's name, "Removed lane", or the last
  /// folder of a path outside every lane. Older hosts send no `home`.
  var laneDisplayName: String {
    switch home?.kind {
    case "lane":
      let name = home?.laneName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      return name.isEmpty ? "Lane" : name
    case "removed-lane":
      return "Removed lane"
    case "outside":
      return cwdLastPathSegment ?? "Other folder"
    default:
      return cwdLastPathSegment ?? cwdDisplayName
    }
  }

  /// Which lane-filter bucket the row belongs to: a live lane id, or "Other
  /// folders". Rows from hosts without `home` fall back to the folder match.
  func importLaneBucket(liveLaneIds: Set<String>, originLaneId: String) -> String {
    if let home {
      if home.kind == "lane", let laneId = home.laneId, liveLaneIds.contains(laneId) {
        return laneId
      }
      return workImportOtherFoldersFilter
    }
    return cwdMatchesRequestedLane == true ? originLaneId : workImportOtherFoldersFilter
  }

  /// The home lane when it is a live lane on this device, else nil.
  func defaultImportTargetLaneId(liveLaneIds: Set<String>) -> String? {
    guard home?.kind == "lane", let laneId = home?.laneId, liveLaneIds.contains(laneId) else { return nil }
    return laneId
  }

  var sizeDisplay: String? {
    guard let sizeBytes, sizeBytes.isFinite, sizeBytes >= 0, sizeBytes < 9e18 else { return nil }
    return ByteCountFormatter.string(fromByteCount: Int64(sizeBytes), countStyle: .file)
  }

  var rowHeading: String {
    if let realTitle { return realTitle }
    if let openingPromptHeading { return openingPromptHeading }
    let whereText = cwdLastPathSegment ?? cwdDisplayName
    guard !relativeUpdatedAt.isEmpty else { return whereText }
    return "\(whereText) · \(relativeUpdatedAt)"
  }

  var hasRealTitle: Bool {
    realTitle != nil
  }

  var realTitle: String? {
    let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmedTitle.isEmpty ? nil : trimmedTitle
  }

  /// The opening ask, used as a heading when the provider persisted no title.
  var openingPromptHeading: String? {
    workImportHeadingText(previewSnippet)
  }

  var startedAnchorSnippet: String? {
    guard let openingPromptHeading,
          workImportHeadingText(openingPromptHeading) != workImportHeadingText(rowHeading) else {
      return nil
    }
    return openingPromptHeading
  }

  var latestAnchorMessage: ExternalSessionMessage? {
    guard let latest = conversationMessages.last else { return nil }
    // Normalize both sides before comparing, and check the started anchor too:
    // a titled single-message thread clears the heading check yet still repeats
    // the opening prompt, which reads as a rendering bug.
    let normalizedLatest = workImportHeadingText(latest.text)
    guard normalizedLatest != workImportHeadingText(rowHeading) else { return nil }
    if let started = startedAnchorSnippet, normalizedLatest == workImportHeadingText(started) {
      return nil
    }
    return latest
  }

  var hasConversationAnchorData: Bool {
    openingPromptHeading != nil || !conversationMessages.isEmpty
  }

  var conversationMessages: [ExternalSessionMessage] {
    (messages ?? []).compactMap { message in
      let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { return nil }
      return ExternalSessionMessage(role: message.role, text: text, at: message.at)
    }
  }

  var previewSnippet: String? {
    let trimmedPreview = preview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmedPreview.isEmpty ? nil : trimmedPreview
  }

  var previewDuplicatesHeading: Bool {
    guard let previewSnippet else { return false }
    return workImportHeadingText(previewSnippet) == workImportHeadingText(rowHeading)
  }

  var trimmedCwd: String? {
    let trimmed = cwd?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? nil : trimmed
  }

  var cwdLastPathSegment: String? {
    guard let trimmedCwd else { return nil }
    let last = (trimmedCwd as NSString).lastPathComponent
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return last.isEmpty || last == "/" ? nil : last
  }

  var cwdDisplayName: String {
    guard let cwd = trimmedCwd else { return "its original folder" }
    let home = NSHomeDirectory()
    var display = cwd
    if cwd == home { display = "~" }
    if cwd.hasPrefix(home + "/") {
      display = "~" + cwd.dropFirst(home.count)
    }
    let segments = display.split(separator: "/").map(String.init)
    guard segments.count > 3 else { return display }
    return "…/" + segments.suffix(3).joined(separator: "/")
  }

  var relativeUpdatedAt: String {
    guard let timestamp = updatedAt ?? createdAt, timestamp > 0 else { return "" }
    let seconds = timestamp > 10_000_000_000 ? timestamp / 1000 : timestamp
    return WorkImportSessionFormatters.relative.localizedString(for: Date(timeIntervalSince1970: seconds), relativeTo: Date())
  }
}

private func workImportHeadingText(_ value: String?) -> String? {
  let collapsed = value?
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !collapsed.isEmpty else { return nil }
  guard collapsed.count > 72 else { return collapsed }
  return String(collapsed.prefix(71)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
}

private enum WorkImportSessionFormatters {
  static let relative: RelativeDateTimeFormatter = {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    return formatter
  }()
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
