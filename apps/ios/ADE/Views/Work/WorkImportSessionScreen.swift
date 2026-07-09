import Foundation
import SwiftUI

private let workImportSessionProviders = ["all", "claude", "codex", "cursor", "droid", "opencode"]

private struct WorkPendingExternalSessionImport: Identifiable {
  let session: ExternalSessionSummary
  let action: WorkExternalSessionAction

  var id: String {
    "\(session.provider):\(session.id):\(action.id)"
  }
}

struct WorkImportSessionScreen: View {
  @EnvironmentObject var syncService: SyncService

  let lane: LaneSummary
  let lanes: [LaneSummary]
  let onCliImported: @MainActor (TerminalSessionSummary) async -> Void
  let onChatImported: @MainActor (AgentChatSessionSummary) async -> Void

  @State private var sessions: [ExternalSessionSummary] = []
  @State private var providerFilter = "all"
  @State private var scope = "project"
  @State private var loading = false
  @State private var hasLoaded = false
  @State private var errorMessage: String?
  @State private var importingSessionId: String?
  @State private var selectedSession: ExternalSessionSummary?
  @State private var selectedLaneId: String
  @State private var pendingActiveResume: WorkPendingExternalSessionImport?

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
    _selectedLaneId = State(initialValue: lane.id)
  }

  private var selectedLane: LaneSummary {
    lanes.first(where: { $0.id == selectedLaneId }) ?? lane
  }

  private var queryKey: String {
    "\(providerFilter)|\(scope)|\(selectedLaneId)"
  }

  private var pendingActiveResumePresented: Binding<Bool> {
    Binding(
      get: { pendingActiveResume != nil },
      set: { presented in
        if !presented {
          pendingActiveResume = nil
        }
      }
    )
  }

  private var sortedSessions: [ExternalSessionSummary] {
    sessions.sorted { left, right in
      (left.updatedAt ?? left.createdAt ?? 0) > (right.updatedAt ?? right.createdAt ?? 0)
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
    .alert(
      "Session may be open elsewhere",
      isPresented: pendingActiveResumePresented,
      presenting: pendingActiveResume
    ) { pending in
      Button("Continue anyway") {
        Task { await importSession(pending.session, action: pending.action) }
      }
      Button("Cancel", role: .cancel) {}
    } message: { _ in
      Text("Close the other CLI before continuing the original session, or cancel and create a copy instead.")
    }
  }

  @ViewBuilder
  private var detailControls: some View {
    VStack(alignment: .leading, spacing: 12) {
      Button {
        selectedSession = nil
      } label: {
        Label("All sessions", systemImage: "chevron.left")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
      }
      .buttonStyle(.plain)

      HStack {
        Text("Import into")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 12)
        WorkLanePickerDropdown(
          lanes: lanes,
          selectedLaneId: $selectedLaneId,
          showsAutoCreateOption: false
        )
      }
    }
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
        WorkImportSessionRow(
          session: selectedSession,
          actions: workExternalSessionActions(for: selectedSession),
          importing: importingSessionId == selectedSession.importIdentity,
          importDisabled: importingSessionId != nil || loading,
          onSelectAction: { action in
            selectAction(action, for: selectedSession)
          }
        )
        .padding(16)
      }
      .refreshable { await loadSessions() }
    } else if loading && !hasLoaded {
      Spacer()
      ProgressView()
        .controlSize(.regular)
      Spacer()
    } else if sortedSessions.isEmpty {
      Spacer()
      VStack(spacing: 8) {
        Image(systemName: "tray")
          .font(.title3)
          .foregroundStyle(ADEColor.textMuted)
        Text("No sessions found")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("Pull to refresh")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
      Spacer()
    } else {
      List {
        ForEach(sortedSessions, id: \.importIdentity) { session in
          Button {
            selectedSession = session
          } label: {
            WorkImportSessionSummaryRow(session: session)
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

  private func selectAction(_ action: WorkExternalSessionAction, for session: ExternalSessionSummary) {
    if session.possiblyActive,
       action.mode == "resume",
       action.importedSessionRef == nil {
      pendingActiveResume = WorkPendingExternalSessionImport(session: session, action: action)
      return
    }
    Task { await importSession(session, action: action) }
  }

  private func loadSessions() async {
    let requestedQueryKey = queryKey
    let requestedLaneId = selectedLane.id
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
        laneId: requestedLaneId,
        scope: requestedScope,
        limit: 100
      )
      guard requestedQueryKey == queryKey else { return }
      sessions = loadedSessions
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
  private func importSession(_ session: ExternalSessionSummary, action: WorkExternalSessionAction) async {
    guard importingSessionId == nil, !loading else { return }
    importingSessionId = session.importIdentity
    errorMessage = nil
    if let importedSessionRef = action.importedSessionRef {
      await openExistingSession(session, ref: importedSessionRef, action: action)
      importingSessionId = nil
      return
    }
    do {
      let result = try await syncService.importExternalSession(
        provider: session.provider,
        sessionId: session.id,
        laneId: selectedLane.id,
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
        await onCliImported(result.session ?? makeTerminalSessionSummary(
          sessionId: sessionId,
          ptyId: result.ptyId,
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
  private func openExistingSession(
    _ session: ExternalSessionSummary,
    ref: ExternalSessionImportedRef,
    action: WorkExternalSessionAction
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
    imported session: ExternalSessionSummary,
    action: WorkExternalSessionAction
  ) -> TerminalSessionSummary {
    TerminalSessionSummary(
      id: sessionId,
      laneId: selectedLane.id,
      laneName: selectedLane.name,
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
      summary: action.title,
      runtimeState: "running",
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: nil
    )
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

        if let preview = session.previewSnippet {
          Text(preview)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }

        HStack(spacing: 5) {
          Text(providerDisplayName(session.provider))
          if let count = session.messageCount {
            Text("· \(count) \(count == 1 ? "prompt" : "prompts")")
          }
          if let cwd = session.trimmedCwd {
            Text("· \((cwd as NSString).lastPathComponent)")
              .lineLimit(1)
          }
        }
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
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

private struct WorkImportSessionRow: View {
  let session: ExternalSessionSummary
  let actions: [WorkExternalSessionAction]
  let importing: Bool
  let importDisabled: Bool
  let onSelectAction: (WorkExternalSessionAction) -> Void

  @State private var previewExpanded = true

  private var actionColumns: [GridItem] {
    [GridItem(.flexible(), spacing: 8)]
  }

  private var existingActions: [WorkExternalSessionAction] {
    actions.filter { $0.importedSessionRef != nil }
  }

  private var chatActions: [WorkExternalSessionAction] {
    actions.filter { $0.importedSessionRef == nil && $0.target == "chat" }
  }

  private var cliActions: [WorkExternalSessionAction] {
    actions.filter { $0.importedSessionRef == nil && $0.target == "cli" }
  }

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

      previewDisclosure

      if !actions.isEmpty {
        VStack(spacing: 8) {
          actionGrid(existingActions)
          if !existingActions.isEmpty && (!chatActions.isEmpty || !cliActions.isEmpty) {
            Divider()
              .overlay(ADEColor.glassBorder.opacity(0.7))
          }
          actionGrid(chatActions)
          if !chatActions.isEmpty && !cliActions.isEmpty {
            Divider()
              .overlay(ADEColor.glassBorder.opacity(0.7))
          }
          actionGrid(cliActions)
        }
      }
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

      if session.hasRealTitle, let cwd = session.trimmedCwd {
        Text(session.cwdDisplayName)
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(ADEColor.textPrimary.opacity(0.035), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
          .overlay {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
              .stroke(ADEColor.glassBorder.opacity(0.55), lineWidth: 0.6)
          }
          .accessibilityLabel(cwd)
      }
    }
    .font(.caption)
    .foregroundStyle(ADEColor.textSecondary)
    .lineLimit(1)
  }

  @ViewBuilder
  private var previewDisclosure: some View {
    if let preview = session.previewSnippet {
      VStack(alignment: .leading, spacing: 6) {
        Button {
          withAnimation(.easeInOut(duration: 0.18)) {
            previewExpanded.toggle()
          }
        } label: {
          HStack(spacing: 4) {
            Image(systemName: "chevron.right")
              .font(.system(size: 10, weight: .bold))
              .rotationEffect(.degrees(previewExpanded ? 90 : 0))
            Text("Preview")
              .font(.caption.weight(.semibold))
          }
          .foregroundStyle(ADEColor.textMuted)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        if previewExpanded {
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
        }
      }
    }
  }

  @ViewBuilder
  private func actionGrid(_ groupedActions: [WorkExternalSessionAction]) -> some View {
    if !groupedActions.isEmpty {
      LazyVGrid(columns: actionColumns, alignment: .leading, spacing: 8) {
        ForEach(groupedActions) { action in
          WorkImportActionButton(
            action: action,
            importDisabled: importDisabled,
            onSelect: onSelectAction
          )
        }
      }
    }
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

private struct WorkImportActionButton: View {
  let action: WorkExternalSessionAction
  let importDisabled: Bool
  let onSelect: (WorkExternalSessionAction) -> Void

  private var isEnabled: Bool {
    action.enabled && !importDisabled
  }

  var body: some View {
    Button {
      guard action.enabled else { return }
      onSelect(action)
    } label: {
      HStack(alignment: .center, spacing: 7) {
        Image(systemName: action.systemImage)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(iconColor)
          .frame(width: 14, height: 16)

        VStack(alignment: .leading, spacing: 2) {
          Text(action.title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(titleColor)
          Text(action.detail)
            .font(.caption2)
            .foregroundStyle(action.isPrimary && action.enabled ? Color.white.opacity(0.78) : ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        Spacer(minLength: 0)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
      .background(backgroundStyle, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .stroke(borderColor, lineWidth: 0.7)
      }
      .opacity(isEnabled ? 1 : 0.58)
    }
    .buttonStyle(.plain)
    .disabled(!isEnabled)
  }

  private var backgroundStyle: Color {
    if action.isPrimary && action.enabled {
      return ADEColor.accent
    }
    return ADEColor.textPrimary.opacity(action.enabled ? 0.04 : 0.025)
  }

  private var borderColor: Color {
    if action.isPrimary && action.enabled {
      return Color.white.opacity(0.18)
    }
    return action.enabled ? ADEColor.glassBorder : ADEColor.glassBorder.opacity(0.55)
  }

  private var iconColor: Color {
    if action.isPrimary && action.enabled {
      return .white
    }
    return action.enabled ? action.tint : ADEColor.textMuted
  }

  private var titleColor: Color {
    if action.isPrimary && action.enabled {
      return .white
    }
    return action.enabled ? ADEColor.textPrimary : ADEColor.textMuted
  }
}

private extension ExternalSessionSummary {
  var importIdentity: String {
    "\(provider):\(id)"
  }

  var rowHeading: String {
    if let realTitle { return realTitle }
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

  var previewSnippet: String? {
    let trimmedPreview = preview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmedPreview.isEmpty ? nil : trimmedPreview
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
    return ".../" + segments.suffix(3).joined(separator: "/")
  }

  var relativeUpdatedAt: String {
    guard let timestamp = updatedAt ?? createdAt, timestamp > 0 else { return "" }
    let seconds = timestamp > 10_000_000_000 ? timestamp / 1000 : timestamp
    return WorkImportSessionFormatters.relative.localizedString(for: Date(timeIntervalSince1970: seconds), relativeTo: Date())
  }
}

private enum WorkImportSessionFormatters {
  static let relative: RelativeDateTimeFormatter = {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    return formatter
  }()
}

private func providerDisplayName(_ provider: String) -> String {
  switch provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "claude": return "Claude"
  case "codex": return "Codex"
  case "cursor": return "Cursor"
  case "droid": return "Droid"
  case "opencode": return "OpenCode"
  default:
    let trimmed = provider.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "Unknown" : trimmed
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
  case "opencode": return "opencode"
  default: return provider
  }
}
