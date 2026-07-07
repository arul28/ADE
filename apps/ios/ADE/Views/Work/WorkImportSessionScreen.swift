import Foundation
import SwiftUI

private let workImportSessionProviders = ["all", "claude", "codex", "cursor", "droid", "opencode"]

private struct WorkExternalSessionAction: Identifiable {
  let id: String
  let title: String
  let subtitle: String?
  let systemImage: String
  let tint: Color
  let target: String
  let mode: String
  var isPrimary = false
  var enabled = true
}

struct WorkImportSessionScreen: View {
  @EnvironmentObject var syncService: SyncService

  let lane: LaneSummary
  let onCliImported: @MainActor (TerminalSessionSummary) async -> Void
  let onChatImported: @MainActor (String) async -> Void

  @State private var sessions: [ExternalSessionSummary] = []
  @State private var providerFilter = "all"
  @State private var scope = "project"
  @State private var loading = false
  @State private var hasLoaded = false
  @State private var errorMessage: String?
  @State private var importingSessionId: String?

  private var queryKey: String {
    "\(providerFilter)|\(scope)|\(lane.id)"
  }

  private var sortedSessions: [ExternalSessionSummary] {
    sessions.sorted { left, right in
      (left.updatedAt ?? left.createdAt ?? 0) > (right.updatedAt ?? right.createdAt ?? 0)
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      controls
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
    .navigationTitle("Import a CLI session")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .adeRootTabBarHidden()
    .task(id: queryKey) {
      await loadSessions()
    }
  }

  @ViewBuilder
  private var controls: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 5) {
        Text("Import a CLI session")
          .font(.title3.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("Continue a Claude, Codex, Cursor, Droid, or OpenCode session you started in a terminal into \(lane.name).")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }

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

      Text("Open continues the original · Fork starts a copy. ADE chat opens the history in a chat; CLI session opens the terminal.")
        .font(.caption2)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder
  private var content: some View {
    if loading && !hasLoaded {
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
        Section {
          ForEach(sortedSessions, id: \.importIdentity) { session in
            WorkImportSessionRow(
              session: session,
              actions: actions(for: session),
              importing: importingSessionId == session.importIdentity,
              importDisabled: importingSessionId != nil,
              onSelectAction: { action in
                Task { await importSession(session, action: action) }
              }
            )
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
          }
        } header: {
          HStack(spacing: 5) {
            Text("CLI sessions")
            Text("·")
            Text("started in a terminal")
              .fontWeight(.regular)
              .textCase(nil)
          }
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
        } footer: {
          Text("Pull to refresh the session list.")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .padding(.top, 4)
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .refreshable {
        await loadSessions()
      }
    }
  }

  private func loadSessions() async {
    loading = true
    errorMessage = nil
    do {
      let providers = providerFilter == "all" ? nil : [providerFilter]
      sessions = try await syncService.listExternalSessions(
        providers: providers,
        laneId: lane.id,
        scope: scope,
        limit: 100
      )
      hasLoaded = true
    } catch is CancellationError {
    } catch {
      errorMessage = error.localizedDescription
      hasLoaded = true
    }
    loading = false
  }

  private func actions(for session: ExternalSessionSummary) -> [WorkExternalSessionAction] {
    var result: [WorkExternalSessionAction] = []
    let caps = session.capabilities
    let cwdMatchesLane = session.cwdMatchesRequestedLane == true

    if caps.importToChat {
      result.append(WorkExternalSessionAction(
        id: "open-as-chat",
        title: "Open as ADE chat",
        subtitle: nil,
        systemImage: "bubble.left.and.bubble.right.fill",
        tint: ADEColor.accent,
        target: "chat",
        mode: "resume",
        isPrimary: true
      ))
      result.append(WorkExternalSessionAction(
        id: "fork-as-chat",
        title: "Fork as ADE chat",
        subtitle: nil,
        systemImage: "arrow.triangle.branch",
        tint: ADEColor.textPrimary,
        target: "chat",
        mode: "fork"
      ))
    }

    if cwdMatchesLane {
      if caps.resumeInPlace {
        result.append(WorkExternalSessionAction(
          id: "resume-here",
          title: "Open as CLI session",
          subtitle: nil,
          systemImage: "terminal.fill",
          tint: ADEColor.textPrimary,
          target: "cli",
          mode: "resume"
        ))
      }
      if caps.fork {
        result.append(WorkExternalSessionAction(
          id: "fork-into-lane",
          title: "Fork as CLI session",
          subtitle: nil,
          systemImage: "arrow.triangle.branch",
          tint: ADEColor.textPrimary,
          target: "cli",
          mode: "fork"
        ))
      }
    } else if caps.resumeInDifferentCwd {
      result.append(WorkExternalSessionAction(
        id: "resume-here",
        title: "Open as CLI session",
        subtitle: nil,
        systemImage: "terminal.fill",
        tint: ADEColor.textPrimary,
        target: "cli",
        mode: "resume"
      ))
      if caps.forkIntoDifferentCwd {
        result.append(WorkExternalSessionAction(
          id: "fork-into-lane",
          title: "Fork as CLI session",
          subtitle: nil,
          systemImage: "arrow.triangle.branch",
          tint: ADEColor.textPrimary,
          target: "cli",
          mode: "fork"
        ))
      }
    } else {
      if caps.forkIntoDifferentCwd {
        result.append(WorkExternalSessionAction(
          id: "fork-into-lane",
          title: "Fork as CLI session",
          subtitle: nil,
          systemImage: "arrow.triangle.branch",
          tint: ADEColor.textPrimary,
          target: "cli",
          mode: "fork"
        ))
      }
      if caps.resumeInPlace {
        result.append(WorkExternalSessionAction(
          id: "resume-in-place",
          title: "Open as CLI session",
          subtitle: "Runs in its original folder",
          systemImage: "terminal.fill",
          tint: ADEColor.textPrimary,
          target: "cli",
          mode: "resume"
        ))
      }
      if !caps.forkIntoDifferentCwd && !caps.resumeInPlace {
        result.append(WorkExternalSessionAction(
          id: "resume-here",
          title: "Open as CLI session",
          subtitle: "This session lives in another folder and \(providerDisplayName(session.provider)) can't resume across folders.",
          systemImage: "terminal.fill",
          tint: ADEColor.textMuted,
          target: "cli",
          mode: "resume",
          enabled: false
        ))
      }
    }

    return result
  }

  @MainActor
  private func importSession(_ session: ExternalSessionSummary, action: WorkExternalSessionAction) async {
    guard importingSessionId == nil else { return }
    importingSessionId = session.importIdentity
    errorMessage = nil
    do {
      let result = try await syncService.importExternalSession(
        provider: session.provider,
        sessionId: session.id,
        laneId: lane.id,
        target: action.target,
        mode: action.mode
      )
      if result.kind == "chat", let chatSessionId = result.chatSessionId {
        ADEHaptics.medium()
        await onChatImported(chatSessionId)
      } else if result.kind == "cli", let sessionId = result.sessionId {
        ADEHaptics.medium()
        await onCliImported(makeTerminalSessionSummary(
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

  private func makeTerminalSessionSummary(
    sessionId: String,
    ptyId: String?,
    imported session: ExternalSessionSummary,
    action: WorkExternalSessionAction
  ) -> TerminalSessionSummary {
    TerminalSessionSummary(
      id: sessionId,
      laneId: lane.id,
      laneName: lane.name,
      ptyId: ptyId,
      tracked: true,
      pinned: false,
      manuallyNamed: nil,
      goal: session.preview,
      toolType: workImportToolType(provider: session.provider),
      title: session.displayTitle,
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

private struct WorkImportSessionRow: View {
  let session: ExternalSessionSummary
  let actions: [WorkExternalSessionAction]
  let importing: Bool
  let importDisabled: Bool
  let onSelectAction: (WorkExternalSessionAction) -> Void

  private var actionColumns: [GridItem] {
    [
      GridItem(.flexible(), spacing: 8),
      GridItem(.flexible(), spacing: 8)
    ]
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 11) {
      HStack(alignment: .top, spacing: 10) {
        providerMark

        VStack(alignment: .leading, spacing: 6) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(session.displayTitle)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(2)
            Spacer(minLength: 6)
            if !session.relativeUpdatedAt.isEmpty {
              Text(session.relativeUpdatedAt)
                .font(.caption2)
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            }
          }

          HStack(spacing: 5) {
            Text(providerDisplayName(session.provider))
            if let messageCount = session.messageCount {
              Text("·")
              Text("\(messageCount) \(messageCount == 1 ? "msg" : "msgs")")
            }
            if let cwd = session.cwd, !cwd.isEmpty {
              Text("·")
              Text(session.cwdDisplayName)
                .lineLimit(1)
                .truncationMode(.middle)
            }
          }
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)

          if let preview = session.preview, !preview.isEmpty {
            Text(preview)
              .font(.caption)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(2)
          }

          statusBadges
        }

        if importing {
          ProgressView()
            .controlSize(.small)
            .padding(.top, 2)
        }
      }

      if session.possiblyActive {
        Text("Recently active — may still be running in a terminal; fork to avoid conflicts.")
          .font(.caption2)
          .foregroundStyle(ADEColor.warning)
          .fixedSize(horizontal: false, vertical: true)
      }

      if !actions.isEmpty {
        LazyVGrid(columns: actionColumns, alignment: .leading, spacing: 8) {
          ForEach(actions) { action in
            WorkImportActionButton(
              action: action,
              importDisabled: importDisabled,
              onSelect: onSelectAction
            )
          }
        }
      }
    }
    .padding(13)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.6)
    }
    .contentShape(Rectangle())
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

  @ViewBuilder
  private var providerMark: some View {
    WorkProviderBareLogo(
      provider: session.provider,
      fallbackSymbol: providerIcon(session.provider),
      tint: ADEColor.providerChatAccent(for: session.provider),
      size: 26
    )
    .padding(.top, 2)
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
      HStack(alignment: .top, spacing: 7) {
        Image(systemName: action.systemImage)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(iconColor)
          .frame(width: 14, height: 18)

        VStack(alignment: .leading, spacing: 2) {
          Text(action.title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(titleColor)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)

          if let subtitle = action.subtitle, !subtitle.isEmpty {
            Text(subtitle)
              .font(.caption2)
              .foregroundStyle(subtitleColor)
              .lineLimit(3)
              .fixedSize(horizontal: false, vertical: true)
          }
        }

        Spacer(minLength: 0)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
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

  private var subtitleColor: Color {
    if action.isPrimary && action.enabled {
      return .white.opacity(0.82)
    }
    return action.enabled ? ADEColor.textSecondary : ADEColor.textMuted
  }
}

private extension ExternalSessionSummary {
  var importIdentity: String {
    "\(provider):\(id)"
  }

  var displayTitle: String {
    let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !trimmedTitle.isEmpty { return trimmedTitle }
    let trimmedPreview = preview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !trimmedPreview.isEmpty { return trimmedPreview }
    return "\(providerDisplayName(provider)) \(String(id.prefix(8)))"
  }

  var cwdDisplayName: String {
    guard let cwd, !cwd.isEmpty else { return "Original folder unavailable" }
    let home = NSHomeDirectory()
    if cwd == home { return "~" }
    if cwd.hasPrefix(home + "/") {
      return "~" + cwd.dropFirst(home.count)
    }
    return cwd
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
  case "cursor": return "cursor"
  case "droid": return "droid"
  case "opencode": return "opencode"
  default: return provider
  }
}
