import SwiftUI
import UIKit
import AVKit

/// Work sidebar toolbar matching the desktop `SessionListPane` layout: compact search field,
/// inline "New chat" accent button, and a funnel toggle that reveals the Group-by + Lane filter
/// panel. Replaces the earlier phone-only filter card stack so mobile and desktop share the same
/// information architecture.
struct WorkFiltersSection: View {
  @Binding var searchText: String
  @Binding var selectedLaneId: String
  @Binding var organization: WorkSessionOrganization
  @Binding var filterOpen: Bool
  let lanes: [LaneSummary]
  let runningCount: Int
  let needsInputCount: Int
  let onNewChat: () -> Void
  let newChatEnabled: Bool

  private var selectedLaneName: String {
    if selectedLaneId == "all" { return "All lanes" }
    return lanes.first(where: { $0.id == selectedLaneId })?.name ?? "All lanes"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        HStack(spacing: 8) {
          Image(systemName: "magnifyingglass")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
          TextField("Search", text: $searchText)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.footnote)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 32)
        .background(ADEColor.surfaceBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.5)
        )

        Button(action: onNewChat) {
          HStack(spacing: 5) {
            Image(systemName: "plus")
              .font(.system(size: 10, weight: .bold))
            Text("New Chat")
              .font(.caption.weight(.semibold))
          }
          .foregroundStyle(ADEColor.accent)
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
          .background(ADEColor.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
              .stroke(ADEColor.accent.opacity(0.35), lineWidth: 0.5)
          )
        }
        .buttonStyle(.plain)
        .disabled(!newChatEnabled)
        .opacity(newChatEnabled ? 1.0 : 0.5)
        .accessibilityLabel("Start a new chat")

        Button {
          withAnimation(.snappy(duration: 0.2)) {
            filterOpen.toggle()
          }
        } label: {
          Image(systemName: filterOpen ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(filterOpen ? ADEColor.accent : ADEColor.textSecondary)
            .frame(width: 32, height: 32)
            .background(
              (filterOpen ? ADEColor.accent.opacity(0.1) : ADEColor.surfaceBackground.opacity(0.55)),
              in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .overlay(
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Toggle filter panel")
      }

      if filterOpen {
        VStack(alignment: .leading, spacing: 10) {
          HStack(alignment: .center, spacing: 10) {
            Text("GROUP")
              .font(.caption2.monospaced().weight(.bold))
              .foregroundStyle(ADEColor.textMuted)
              .frame(width: 48, alignment: .leading)
            HStack(spacing: 4) {
              ForEach(WorkSessionOrganization.allCases) { option in
                Button {
                  withAnimation(.snappy) { organization = option }
                } label: {
                  Text(option.title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(organization == option ? ADEColor.textPrimary : ADEColor.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(
                      organization == option ? ADEColor.surfaceBackground.opacity(0.7) : Color.clear,
                      in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Group by \(option.title)")
              }
            }
            .padding(3)
            .background(ADEColor.recessedBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
          }

          HStack(alignment: .center, spacing: 10) {
            Text("LANE")
              .font(.caption2.monospaced().weight(.bold))
              .foregroundStyle(ADEColor.textMuted)
              .frame(width: 48, alignment: .leading)
            Menu {
              Button("All lanes") { selectedLaneId = "all" }
              ForEach(lanes) { lane in
                Button(lane.name) { selectedLaneId = lane.id }
              }
            } label: {
              HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch")
                  .font(.system(size: 10, weight: .semibold))
                  .foregroundStyle(ADEColor.textMuted)
                Text(selectedLaneName)
                  .font(.caption.weight(.medium))
                  .foregroundStyle(ADEColor.textPrimary)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down")
                  .font(.system(size: 9, weight: .semibold))
                  .foregroundStyle(ADEColor.textMuted)
              }
              .padding(.horizontal, 10)
              .padding(.vertical, 8)
              .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
              .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                  .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.5)
              )
            }
            .buttonStyle(.plain)
          }

          if runningCount > 0 || needsInputCount > 0 {
            HStack(spacing: 6) {
              if runningCount > 0 {
                WorkFlatCountChip(icon: "circle.fill", text: "\(runningCount) running", tint: ADEColor.success)
              }
              if needsInputCount > 0 {
                WorkFlatCountChip(icon: "exclamationmark.circle.fill", text: "\(needsInputCount) waiting", tint: ADEColor.warning)
              }
              Spacer(minLength: 0)
            }
          }
        }
        .padding(10)
        .background(ADEColor.recessedBackground.opacity(0.38), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(ADEColor.border.opacity(0.15), lineWidth: 0.5)
        )
        .transition(.move(edge: .top).combined(with: .opacity))
      }
    }
  }
}

/// Matches desktop `StickyGroupHeader`: chevron + semantic icon + label + count badge. Tap to
/// collapse or expand the section body in the parent list.
struct WorkSidebarSectionHeader: View {
  let group: WorkSessionGroup
  let collapsed: Bool
  let onToggle: () -> Void

  var body: some View {
    Button(action: onToggle) {
      HStack(spacing: 8) {
        Image(systemName: collapsed ? "chevron.right" : "chevron.down")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 10, alignment: .center)

        sectionIcon

        Text(group.label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)

        Spacer(minLength: 0)

        Text("\(group.sessions.count)")
          .font(.caption2.monospacedDigit().weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(ADEColor.surfaceBackground.opacity(0.6), in: Capsule())
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 8)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(group.label), \(group.sessions.count) session\(group.sessions.count == 1 ? "" : "s"). Tap to \(collapsed ? "expand" : "collapse").")
  }

  @ViewBuilder
  private var sectionIcon: some View {
    switch group.icon {
    case .statusDot:
      Circle()
        .fill(group.tint)
        .frame(width: 7, height: 7)
    case .laneBranch:
      Image(systemName: "arrow.triangle.branch")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(group.tint)
    case .none:
      Color.clear.frame(width: 0, height: 0)
    }
  }
}

/// Flat-capsule variant of `ADEGlassChip` used when the chip sits inside a `.adeGlassCard` so we avoid
/// glass-on-glass stacking. Visual spec matches `ADEGlassChip` minus the inner `.glassEffect()`.
struct WorkFlatCountChip: View {
  let icon: String
  let text: String
  let tint: Color

  var body: some View {
    HStack(spacing: 3) {
      Image(systemName: icon)
        .font(.system(size: 8, weight: .semibold))
      Text(text)
        .font(.system(.caption2).weight(.medium))
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 6)
    .padding(.vertical, 3)
    .background(tint.opacity(0.1), in: Capsule())
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

/// Single-row renderer for the session list that carries the swipe + context-menu action set.
/// Used inside the sidebar's grouped loop so the Work root screen can drive the section
/// organization directly (byLane / byStatus / byTime) without a nested Section wrapper.
struct WorkSessionListRow: View {
  let session: TerminalSessionSummary
  let lane: LaneSummary?
  let chatSummary: AgentChatSessionSummary?
  let isArchived: Bool
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
    Button {
      selectedSessionId = session.id
      path.append(WorkSessionRoute(sessionId: session.id))
    } label: {
      WorkSessionRow(
        session: session,
        lane: lane,
        chatSummary: chatSummary,
        isArchived: isArchived,
        transitionNamespace: transitionNamespace,
        isSelectedTransitionSource: selectedSessionId == session.id
      )
    }
    .buttonStyle(.plain)
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(isArchived ? "Restore" : "Archive") {
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
      Button(isArchived ? "Restore from archive" : "Archive") {
        onArchive(session)
      }
      if shouldShowEndAction {
        Button(isChatSession(session) ? "End chat" : "Close session", role: .destructive) {
          onEnd(session)
        }
      } else if shouldShowResumeAction {
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
  }

  private var status: String {
    normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
  }

  private var shouldShowEndAction: Bool {
    status == "active" || status == "awaiting-input"
  }

  private var shouldShowResumeAction: Bool {
    status == "idle" || status == "ended"
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
