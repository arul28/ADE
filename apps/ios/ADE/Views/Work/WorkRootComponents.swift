import SwiftUI
import UIKit
import AVKit

struct WorkFiltersSection: View {
  @Binding var searchText: String
  @Binding var selectedLaneId: String
  @Binding var selectedStatus: WorkSessionStatusFilter
  let lanes: [LaneSummary]
  let runningCount: Int
  let needsInputCount: Int

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "magnifyingglass")
          .foregroundStyle(ADEColor.textSecondary)
        TextField("Search sessions", text: $searchText)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      }
      .adeInsetField(cornerRadius: 14, padding: 12)

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(WorkSessionStatusFilter.allCases) { status in
            Button {
              selectedStatus = status
            } label: {
              HStack(spacing: 6) {
                Text(status.title)
                if status == .running && runningCount > 0 {
                  Text("\(runningCount)")
                    .font(.caption2.weight(.semibold))
                } else if status == .needsInput && needsInputCount > 0 {
                  Text("\(needsInputCount)")
                    .font(.caption2.weight(.semibold))
                }
              }
              .font(.caption.weight(.semibold))
              .foregroundStyle(selectedStatus == status ? ADEColor.accent : ADEColor.textSecondary)
              .padding(.horizontal, 12)
              .padding(.vertical, 8)
              .background(
                Capsule(style: .continuous)
                  .fill(selectedStatus == status ? ADEColor.accent.opacity(0.12) : ADEColor.surfaceBackground.opacity(0.6))
              )
            }
            .buttonStyle(.plain)
          }
        }
      }

      Picker("Lane", selection: $selectedLaneId) {
        Text("All lanes").tag("all")
        ForEach(lanes) { lane in
          Text(lane.name).tag(lane.id)
        }
      }
      .pickerStyle(.menu)
      .adeInsetField(cornerRadius: 14, padding: 10)

      HStack(spacing: 8) {
        LaneMicroChip(icon: "waveform.path.ecg", text: "\(runningCount) live", tint: ADEColor.success)
        if needsInputCount > 0 {
          LaneMicroChip(icon: "exclamationmark.bubble.fill", text: "\(needsInputCount) waiting", tint: ADEColor.warning)
        }
        Spacer(minLength: 0)
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }
}

struct WorkRunningBanner: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion

  let liveSessions: [TerminalSessionSummary]
  let attentionCount: Int

  @State var isPulsing = false

  var body: some View {
    HStack(spacing: 10) {
      Circle()
        .fill(attentionCount > 0 ? ADEColor.warning : ADEColor.success)
        .frame(width: 10, height: 10)
        .scaleEffect(isPulsing && !reduceMotion ? 1.2 : 1.0)
        .animation(ADEMotion.pulse(reduceMotion: reduceMotion), value: isPulsing)
        .onAppear {
          guard !reduceMotion else { return }
          isPulsing = true
        }
      VStack(alignment: .leading, spacing: 2) {
        Text(bannerTitle)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(bannerMessage)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
      Spacer()
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }

  var bannerTitle: String {
    workRunningBannerTitle(
      liveChatCount: liveCounts.chat,
      liveTerminalCount: liveCounts.terminal,
      attentionCount: attentionCount
    )
  }

  var bannerMessage: String {
    workRunningBannerMessage(liveTerminalCount: liveCounts.terminal, attentionCount: attentionCount)
  }

  var liveCounts: (chat: Int, terminal: Int) {
    workRunningBannerLiveCounts(liveSessions)
  }
}

struct WorkSessionSection: View {
  let title: String
  let sessions: [TerminalSessionSummary]
  let laneById: [String: LaneSummary]
  let chatSummaries: [String: AgentChatSessionSummary]
  let archivedSessionIds: Set<String>
  let transitionNamespace: Namespace.ID?
  @Binding var selectedSessionId: String?
  @Binding var path: NavigationPath
  let onArchive: (TerminalSessionSummary) -> Void
  let onPin: (TerminalSessionSummary) -> Void
  let onRename: (TerminalSessionSummary) -> Void
  let onEnd: (TerminalSessionSummary) -> Void
  let onResume: (TerminalSessionSummary) -> Void
  let onCopyId: (TerminalSessionSummary) -> Void
  let onGoToLane: (TerminalSessionSummary) -> Void

  var body: some View {
    Section(title) {
      ForEach(sessions) { session in
        Button {
          selectedSessionId = session.id
          path.append(WorkSessionRoute(sessionId: session.id))
        } label: {
          WorkSessionRow(
            session: session,
            lane: laneById[session.laneId],
            chatSummary: chatSummaries[session.id],
            isArchived: archivedSessionIds.contains(session.id),
            transitionNamespace: transitionNamespace,
            isSelectedTransitionSource: selectedSessionId == session.id
          )
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          Button(archivedSessionIds.contains(session.id) ? "Restore" : "Archive") {
            onArchive(session)
          }
          .tint(ADEColor.warning)

          Button(session.pinned ? "Unpin" : "Pin") {
            onPin(session)
          }
          .tint(ADEColor.accent)
        }
        .contextMenu {
          Button("Rename") {
            onRename(session)
          }
          Button(session.pinned ? "Unpin" : "Pin") {
            onPin(session)
          }
          Button(archivedSessionIds.contains(session.id) ? "Restore from archive" : "Archive") {
            onArchive(session)
          }
          if shouldShowEndAction(for: session) {
            Button(isChatSession(session) ? "End chat" : "Close session", role: .destructive) {
              onEnd(session)
            }
          } else if shouldShowResumeAction(for: session) {
            Button("Resume") {
              onResume(session)
            }
          }
          Button("Copy session ID") {
            onCopyId(session)
          }
          Button("Go to lane") {
            onGoToLane(session)
          }
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      }
    }
  }

  func sessionStatus(for session: TerminalSessionSummary) -> String {
    normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
  }

  func shouldShowEndAction(for session: TerminalSessionSummary) -> Bool {
    let status = sessionStatus(for: session)
    return status == "active" || status == "awaiting-input"
  }

  func shouldShowResumeAction(for session: TerminalSessionSummary) -> Bool {
    let status = sessionStatus(for: session)
    return status == "idle" || status == "ended"
  }
}

struct WorkSessionRow: View {
  let session: TerminalSessionSummary
  let lane: LaneSummary?
  let chatSummary: AgentChatSessionSummary?
  let isArchived: Bool
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: sessionSymbol(session, provider: chatSummary?.provider))
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(rowTint)
        .frame(width: 28, height: 28)
        .background(rowTint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .adeMatchedGeometry(id: isSelectedTransitionSource ? "work-icon-\(session.id)" : nil, in: transitionNamespace)

      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 8) {
          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
              Text(chatSummary?.title ?? session.title)
                .font(.headline)
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
                .adeMatchedGeometry(id: isSelectedTransitionSource ? "work-title-\(session.id)" : nil, in: transitionNamespace)
              if session.pinned {
                Image(systemName: "pin.fill")
                  .font(.caption2)
                  .foregroundStyle(ADEColor.accent)
              }
            }

            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 8) {
                WorkTag(text: session.laneName, icon: "arrow.triangle.branch", tint: ADEColor.textSecondary)
                if lane?.status.dirty == true {
                  WorkTag(text: "Dirty", icon: "circle.fill", tint: ADEColor.warning)
                }
                if let devices = lane?.devicesOpen, !devices.isEmpty {
                  WorkTag(
                    text: devices.count == 1 ? "1 device" : "\(devices.count) devices",
                    icon: devicePresenceSymbol(for: devices),
                    tint: ADEColor.accent
                  )
                }
                if let chatSummary {
                  WorkTag(text: providerLabel(chatSummary.provider), icon: providerIcon(chatSummary.provider), tint: rowTint)
                  WorkTag(text: chatSummary.model, icon: "cpu", tint: ADEColor.textSecondary)
                } else if session.toolType != nil {
                  WorkTag(text: workSessionRuntimeLabel(session: session), icon: isChatSession(session) ? "bubble.left.and.bubble.right.fill" : "terminal.fill", tint: ADEColor.textSecondary)
                }
              }
            }
          }

          Spacer(minLength: 8)

          VStack(alignment: .trailing, spacing: 6) {
            ADEStatusPill(
              text: isArchived ? "ARCHIVED" : sessionStatusLabel(session, summary: chatSummary),
              tint: isArchived ? ADEColor.warning : rowTint
            )
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "work-status-\(session.id)" : nil, in: transitionNamespace)
            Text(relativeTimestamp(workSessionActivityTimestamp(session: session, summary: chatSummary)))
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
            Text(formattedSessionDuration(startedAt: session.startedAt, endedAt: session.endedAt))
              .font(.caption2.monospacedDigit())
              .foregroundStyle(ADEColor.textMuted)
          }
        }

        if let preview = chatSummary?.summary ?? chatSummary?.lastOutputPreview ?? session.summary ?? session.lastOutputPreview,
           !preview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          Text(preview)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
      }
    }
    .adeListCard()
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "work-container-\(session.id)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  var rowTint: Color {
    if isArchived { return ADEColor.warning }
    return workChatStatusTint(normalizedWorkChatSessionStatus(session: session, summary: chatSummary))
  }

  var accessibilityLabel: String {
    var parts = [chatSummary?.title ?? session.title, session.laneName, sessionStatusLabel(session, summary: chatSummary)]
    if session.pinned {
      parts.append("pinned")
    }
    if isArchived {
      parts.append("archived")
    }
    return parts.joined(separator: ", ")
  }
}

struct WorkActivityRow: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion

  let activity: WorkAgentActivity
  @State var pulse = false

  var body: some View {
    HStack(spacing: 12) {
      Circle()
        .fill(ADEColor.success)
        .frame(width: 10, height: 10)
        .scaleEffect(pulse && !reduceMotion ? 1.25 : 1.0)
        .animation(ADEMotion.pulse(reduceMotion: reduceMotion), value: pulse)
        .onAppear {
          guard !reduceMotion else { return }
          pulse = true
        }
      VStack(alignment: .leading, spacing: 4) {
        Text(activity.agentName)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("\(activity.laneName) · \(activity.toolName ?? "Waiting")")
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
        if let detail = activity.detail, !detail.isEmpty {
          Text(detail)
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      Spacer()
      Text(formattedSessionDuration(startedAt: activity.startedAt, endedAt: nil))
        .font(.caption2.monospacedDigit())
        .foregroundStyle(ADEColor.textMuted)
    }
    .adeListCard()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(activity.agentName), \(activity.laneName), \(activity.toolName ?? "Waiting")")
  }
}

struct WorkTag: View {
  let text: String
  let icon: String
  let tint: Color

  var body: some View {
    Label(text, systemImage: icon)
      .font(.caption2.weight(.medium))
      .foregroundStyle(tint)
      .lineLimit(1)
      .fixedSize(horizontal: true, vertical: false)
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(tint.opacity(0.10), in: Capsule(style: .continuous))
  }
}
