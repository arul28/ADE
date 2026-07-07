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
  var enabled = true
}

private struct WorkExternalSessionSelection: Identifiable {
  let session: ExternalSessionSummary
  var id: String { session.importIdentity }
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
  @State private var selectedSession: WorkExternalSessionSelection?
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
    .navigationTitle("Import session")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .adeRootTabBarHidden()
    .task(id: queryKey) {
      await loadSessions()
    }
    .sheet(item: $selectedSession) { selection in
      WorkImportSessionActionSheet(
        session: selection.session,
        laneName: lane.name,
        actions: actions(for: selection.session),
        onSelect: { action in
          Task { await importSession(selection.session, action: action) }
        }
      )
      .presentationDetents([.medium])
      .presentationDragIndicator(.visible)
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
            Button {
              selectedSession = WorkExternalSessionSelection(session: session)
            } label: {
              WorkImportSessionRow(
                session: session,
                importing: importingSessionId == session.importIdentity
              )
            }
            .buttonStyle(.plain)
            .disabled(importingSessionId != nil)
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
          }
        } footer: {
          Text("Resume can take over a live CLI. Fork keeps the original session untouched.")
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
        id: "chat-resume",
        title: "Open as ADE chat",
        subtitle: "Import transcript",
        systemImage: "bubble.left.and.bubble.right.fill",
        tint: ADEColor.accent,
        target: "chat",
        mode: "resume"
      ))
      result.append(WorkExternalSessionAction(
        id: "chat-fork",
        title: "Fork as ADE chat",
        subtitle: "Copy transcript",
        systemImage: "arrow.triangle.branch",
        tint: ADEColor.accent,
        target: "chat",
        mode: "fork"
      ))
    }

    if cwdMatchesLane {
      if caps.resumeInPlace {
        result.append(WorkExternalSessionAction(
          id: "cli-resume-here",
          title: "Resume here",
          subtitle: lane.name,
          systemImage: "terminal.fill",
          tint: ADEColor.textPrimary,
          target: "cli",
          mode: "resume"
        ))
      }
      if caps.fork {
        result.append(WorkExternalSessionAction(
          id: "cli-fork",
          title: "Fork into this lane",
          subtitle: lane.name,
          systemImage: "arrow.triangle.branch",
          tint: ADEColor.info,
          target: "cli",
          mode: "fork"
        ))
      }
    } else if caps.resumeInDifferentCwd {
      result.append(WorkExternalSessionAction(
        id: "cli-resume-here",
        title: "Resume here",
        subtitle: lane.name,
        systemImage: "terminal.fill",
        tint: ADEColor.textPrimary,
        target: "cli",
        mode: "resume"
      ))
      if caps.forkIntoDifferentCwd {
        result.append(WorkExternalSessionAction(
          id: "cli-fork",
          title: "Fork into this lane",
          subtitle: lane.name,
          systemImage: "arrow.triangle.branch",
          tint: ADEColor.info,
          target: "cli",
          mode: "fork"
        ))
      }
    } else {
      if caps.forkIntoDifferentCwd {
        result.append(WorkExternalSessionAction(
          id: "cli-fork",
          title: "Fork into this lane",
          subtitle: lane.name,
          systemImage: "arrow.triangle.branch",
          tint: ADEColor.info,
          target: "cli",
          mode: "fork"
        ))
      }
      if caps.resumeInPlace {
        result.append(WorkExternalSessionAction(
          id: "cli-resume-original",
          title: "Resume in original folder",
          subtitle: session.cwdDisplayName,
          systemImage: "folder.fill",
          tint: ADEColor.textPrimary,
          target: "cli",
          mode: "resume"
        ))
      }
      if !caps.forkIntoDifferentCwd && !caps.resumeInPlace {
        result.append(WorkExternalSessionAction(
          id: "cli-resume-here",
          title: "Resume here",
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
        Circle()
          .fill(provider == "all" ? ADEColor.textMuted : ADEColor.providerChatAccent(for: provider))
          .frame(width: 7, height: 7)
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
}

private struct WorkImportSessionRow: View {
  let session: ExternalSessionSummary
  let importing: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(alignment: .top, spacing: 10) {
        Circle()
          .fill(ADEColor.providerChatAccent(for: session.provider))
          .frame(width: 10, height: 10)
          .padding(.top, 5)

        VStack(alignment: .leading, spacing: 5) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(session.displayTitle)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(2)
            Spacer(minLength: 6)
            Text(session.relativeUpdatedAt)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }

          HStack(spacing: 6) {
            WorkImportBadge(text: providerDisplayName(session.provider), tint: ADEColor.providerChatAccent(for: session.provider))
            if let messageCount = session.messageCount {
              WorkImportBadge(text: "\(messageCount) \(messageCount == 1 ? "message" : "messages")", tint: ADEColor.textSecondary)
            }
            if session.alreadyImported {
              WorkImportBadge(text: "Imported", tint: ADEColor.success)
            }
            if session.possiblyActive {
              WorkImportBadge(text: "May be open elsewhere", tint: ADEColor.warning)
            }
          }
          .lineLimit(1)

          if let cwd = session.cwd, !cwd.isEmpty {
            Text(session.cwdDisplayName)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
              .truncationMode(.middle)
          }

          if let preview = session.preview, !preview.isEmpty {
            Text(preview)
              .font(.caption)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(2)
          }
        }

        if importing {
          ProgressView()
            .controlSize(.small)
            .padding(.top, 2)
        } else {
          Image(systemName: "chevron.right")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
            .padding(.top, 3)
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

private struct WorkImportSessionActionSheet: View {
  @Environment(\.dismiss) private var dismiss

  let session: ExternalSessionSummary
  let laneName: String
  let actions: [WorkExternalSessionAction]
  let onSelect: (WorkExternalSessionAction) -> Void

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 8) {
            Circle()
              .fill(ADEColor.providerChatAccent(for: session.provider))
              .frame(width: 9, height: 9)
            Text(providerDisplayName(session.provider))
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textSecondary)
          }
          Text(session.displayTitle)
            .font(.title3.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
          Text(session.cwdDisplayName)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }

        VStack(spacing: 10) {
          ForEach(actions) { action in
            Button {
              guard action.enabled else { return }
              dismiss()
              onSelect(action)
            } label: {
              HStack(spacing: 12) {
                Image(systemName: action.systemImage)
                  .font(.system(size: 15, weight: .semibold))
                  .foregroundStyle(action.tint)
                  .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                  Text(action.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                  if let subtitle = action.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                      .font(.caption)
                      .foregroundStyle(ADEColor.textSecondary)
                      .lineLimit(1)
                      .truncationMode(.middle)
                  }
                }
                Spacer()
              }
              .padding(13)
              .background(action.tint.opacity(action.target == "chat" ? 0.14 : 0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
              .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                  .stroke(action.tint.opacity(0.18), lineWidth: 0.6)
              }
            }
            .buttonStyle(.plain)
            .disabled(!action.enabled)
          }
        }

        Spacer(minLength: 0)
      }
      .padding(20)
      .adeScreenBackground()
      .navigationTitle("Import")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close") { dismiss() }
        }
      }
    }
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
