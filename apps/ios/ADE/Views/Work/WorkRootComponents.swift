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
  @Binding var selectedStatus: WorkSessionStatusFilter
  @Binding var organization: WorkSessionOrganization
  @Binding var filterOpen: Bool
  let lanes: [LaneSummary]
  let liveCount: Int
  let needsInputCount: Int
  let isLive: Bool
  let onClear: () -> Void
  let onNewChat: () -> Void

  private var selectedLaneName: String {
    if selectedLaneId == "all" { return "All lanes" }
    return lanes.first(where: { $0.id == selectedLaneId })?.name ?? "All lanes"
  }

  private var hasActiveFilters: Bool {
    selectedStatus != .all
      || selectedLaneId != "all"
      || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        HStack(spacing: 8) {
          Image(systemName: "magnifyingglass")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
          TextField("Search sessions, lanes, output", text: $searchText)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.footnote)
          if !searchText.isEmpty {
            Button {
              searchText = ""
            } label: {
              Image(systemName: "xmark.circle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(ADEColor.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Clear search")
          }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 32)
        .frame(maxWidth: .infinity)
        .background(ADEColor.surfaceBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .glassEffect(in: .rect(cornerRadius: 10))
        .overlay(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(ADEColor.glassBorder, lineWidth: 0.5)
        )

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
              (filterOpen ? ADEColor.accent.opacity(0.12) : ADEColor.surfaceBackground.opacity(0.55)),
              in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .glassEffect(in: .rect(cornerRadius: 10))
            .overlay(
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(filterOpen ? ADEColor.accent.opacity(0.32) : ADEColor.glassBorder, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Toggle filter panel")
      }

      Button(action: onNewChat) {
        HStack(spacing: 8) {
          Image(systemName: "plus")
            .font(.system(size: 13, weight: .bold))
          Text("Start new chat")
            .font(.subheadline.weight(.semibold))
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 11)
        .background(ADEColor.accent, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .glassEffect(in: .rect(cornerRadius: 12))
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(.white.opacity(0.18), lineWidth: 0.6)
        )
        .shadow(color: ADEColor.accent.opacity(0.35), radius: 12, x: 0, y: 4)
      }
      .buttonStyle(.plain)
      .disabled(!isLive)
      .opacity(isLive ? 1 : 0.55)
      .accessibilityLabel("Start new chat")

      HStack(spacing: 6) {
        WorkFlatCountChip(icon: "bolt.fill", text: "\(liveCount) live", tint: ADEColor.success)
        if needsInputCount > 0 {
          WorkFlatCountChip(icon: "exclamationmark.circle.fill", text: "\(needsInputCount) waiting", tint: ADEColor.warning)
        }
        Spacer(minLength: 0)
        if hasActiveFilters {
          Button("Clear") {
            withAnimation(.snappy(duration: 0.18)) {
              onClear()
            }
          }
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
          .buttonStyle(.plain)
          .accessibilityLabel("Clear Work filters")
        }
      }

      if filterOpen {
        VStack(alignment: .leading, spacing: 10) {
          Text("Status")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
            .textCase(.uppercase)
            .tracking(0.5)

          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
              ForEach(WorkSessionStatusFilter.allCases) { status in
                WorkFilterChip(
                  title: status.title,
                  selected: selectedStatus == status,
                  tint: statusFilterTint(status)
                ) {
                  withAnimation(.snappy(duration: 0.18)) {
                    selectedStatus = status
                  }
                }
              }
            }
            .padding(.vertical, 1)
          }

          HStack(spacing: 8) {
            Menu {
              ForEach(WorkSessionOrganization.allCases) { option in
                Button(option.title) {
                  organization = option
                }
              }
            } label: {
              WorkFilterMenuLabel(
                icon: "rectangle.stack",
                title: "Group",
                value: organization.title
              )
            }
            .buttonStyle(.plain)

            Menu {
              Button("All lanes") { selectedLaneId = "all" }
              ForEach(lanes) { lane in
                Button(lane.name) { selectedLaneId = lane.id }
              }
            } label: {
              WorkFilterMenuLabel(
                icon: "arrow.triangle.branch",
                title: "Lane",
                value: selectedLaneName
              )
            }
            .buttonStyle(.plain)
          }
        }
        .padding(12)
        .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .glassEffect(in: .rect(cornerRadius: 14))
        .overlay(
          RoundedRectangle(cornerRadius: 14, style: .continuous)
            .stroke(ADEColor.glassBorder, lineWidth: 0.5)
        )
        .transition(.move(edge: .top).combined(with: .opacity))
      }
    }
  }

  private func statusFilterTint(_ status: WorkSessionStatusFilter) -> Color {
    switch status {
    case .needsInput: return ADEColor.warning
    case .running: return ADEColor.success
    case .ended: return ADEColor.textMuted
    case .archived: return ADEColor.warning
    case .all: return ADEColor.accent
    }
  }
}

struct WorkFilterChip: View {
  let title: String
  let selected: Bool
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(selected ? tint : ADEColor.textSecondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
          selected ? tint.opacity(0.14) : ADEColor.surfaceBackground.opacity(0.5),
          in: Capsule(style: .continuous)
        )
        .glassEffect()
        .overlay(
          Capsule(style: .continuous)
            .stroke(selected ? tint.opacity(0.32) : ADEColor.glassBorder, lineWidth: 0.6)
        )
    }
    .buttonStyle(.plain)
  }
}

struct WorkFilterMenuLabel: View {
  let icon: String
  let title: String
  let value: String

  var body: some View {
    HStack(spacing: 7) {
      Image(systemName: icon)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
      VStack(alignment: .leading, spacing: 1) {
        Text(title)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
        Text(value)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: 0)
      Image(systemName: "chevron.up.chevron.down")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity)
    .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .glassEffect(in: .rect(cornerRadius: 10))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    )
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
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(ADEColor.surfaceBackground.opacity(0.65), in: Capsule())
          .glassEffect()
      }
      .padding(.horizontal, 4)
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

/// Compact live-chat count pill for the Work toolbar. Mirrors the desktop's `ade-liquid-glass-pill`
/// count badge next to the tab title \u2014 a tiny `\u25cf N` capsule that flips to warning tint when any
/// chat is awaiting input. Tap target delegates to the caller so the list can scroll to the live row.
struct WorkLiveCountPill: View {
  let liveCount: Int
  let attentionCount: Int
  let onTap: () -> Void

  var tint: Color {
    attentionCount > 0 ? ADEColor.warning : ADEColor.success
  }

  var label: String {
    attentionCount > 0 ? "\(attentionCount) waiting" : "\(liveCount) live"
  }

  var body: some View {
    Button(action: onTap) {
      HStack(spacing: 5) {
        Circle()
          .fill(tint)
          .frame(width: 6, height: 6)
          .shadow(color: tint.opacity(0.6), radius: 4, x: 0, y: 0)
        Text(label)
          .font(.caption2.monospacedDigit().weight(.semibold))
          .foregroundStyle(tint)
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 5)
      .background(tint.opacity(0.14), in: Capsule())
      .glassEffect()
      .overlay(
        Capsule().stroke(tint.opacity(0.28), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(liveCount) Work session\(liveCount == 1 ? "" : "s") live, \(attentionCount) waiting for input. Tap to jump.")
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
  let isSelecting: Bool
  let isChecked: Bool
  let onLongPressSelect: (TerminalSessionSummary) -> Void
  let onToggleSelect: (TerminalSessionSummary) -> Void
  let onOpen: (TerminalSessionSummary) -> Void
  let onArchive: (TerminalSessionSummary) -> Void
  let onPin: (TerminalSessionSummary) -> Void
  let onRename: (TerminalSessionSummary) -> Void
  let onEnd: (TerminalSessionSummary) -> Void
  let onDelete: (TerminalSessionSummary) -> Void
  let onResume: (TerminalSessionSummary) -> Void
  let onCopyId: (TerminalSessionSummary) -> Void
  let onGoToLane: (TerminalSessionSummary) -> Void

  var body: some View {
    Button {
      if isSelecting {
        onToggleSelect(session)
      } else {
        onOpen(session)
      }
    } label: {
      HStack(spacing: 8) {
        if isSelecting {
          Image(systemName: isChecked ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 20, weight: .regular))
            .foregroundStyle(isChecked ? ADEColor.accent : ADEColor.textSecondary.opacity(0.6))
            .accessibilityLabel(isChecked ? "Selected" : "Not selected")
        }
        WorkSessionRow(
          session: session,
          lane: lane,
          chatSummary: chatSummary,
          isArchived: isArchived,
          transitionNamespace: transitionNamespace,
          isSelectedTransitionSource: selectedSessionId == session.id
        )
      }
    }
    .buttonStyle(.plain)
    .simultaneousGesture(
      LongPressGesture(minimumDuration: 0.45)
        .onEnded { _ in
          guard !isSelecting else { return }
          onLongPressSelect(session)
        }
    )
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
      Button {
        onLongPressSelect(session)
      } label: {
        Label("Select", systemImage: "checkmark.circle")
      }
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
        Button("Close session", role: .destructive) {
          onEnd(session)
        }
      } else if shouldShowDeleteAction {
        Button("Delete chat", role: .destructive) {
          onDelete(session)
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
    if isChatSession(session) {
      return status == "active" || status == "awaiting-input" || status == "idle"
    }
    return status == "active" || status == "awaiting-input"
  }

  private var shouldShowDeleteAction: Bool {
    isChatSession(session) && status == "ended"
  }

  private var shouldShowResumeAction: Bool {
    guard !isChatSession(session) else { return false }
    return status == "idle" || status == "ended"
  }
}

/// Provider mark: renders the branded asset for known families inside a tinted
/// rounded-card container so each mark reads as a logo, not a raw glyph.
struct WorkProviderLogo: View {
  let provider: String?
  let fallbackSymbol: String
  let tint: Color
  let size: CGFloat

  init(provider: String?, fallbackSymbol: String = "terminal.fill", tint: Color = ADEColor.textSecondary, size: CGFloat = 28) {
    self.provider = provider
    self.fallbackSymbol = fallbackSymbol
    self.tint = tint
    self.size = size
  }

  private var containerTint: Color {
    providerTint(provider) == ADEColor.accent && provider == nil ? tint : providerTint(provider)
  }

  var body: some View {
    if let assetName = providerAssetName(provider) {
      let padded = size * 0.54
      Image(assetName)
        .resizable()
        .aspectRatio(contentMode: .fit)
        .frame(width: padded, height: padded)
        .frame(width: size, height: size)
        .background(
          containerTint.opacity(0.16),
          in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        )
        .overlay(
          RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .stroke(containerTint.opacity(0.22), lineWidth: 0.5)
        )
    } else {
      Image(systemName: fallbackSymbol)
        .font(.system(size: size * 0.58, weight: .semibold))
        .foregroundStyle(tint)
        .frame(width: size, height: size)
        .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .stroke(tint.opacity(0.18), lineWidth: 0.5)
        )
    }
  }
}

/// Borderless provider mark — same asset as WorkProviderLogo but without the
/// surrounding tinted square. Used inside the provider-tinted session card so
/// the logo reads as part of the card itself, not a separate badge.
struct WorkProviderBareLogo: View {
  let provider: String?
  let fallbackSymbol: String
  let tint: Color
  let size: CGFloat

  var body: some View {
    if let assetName = providerAssetName(provider) {
      Image(assetName)
        .resizable()
        .aspectRatio(contentMode: .fit)
        .frame(width: size, height: size)
    } else {
      Image(systemName: fallbackSymbol)
        .font(.system(size: size * 0.7, weight: .semibold))
        .foregroundStyle(tint)
        .frame(width: size, height: size)
    }
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
    HStack(alignment: .center, spacing: 12) {
      WorkProviderBareLogo(
        provider: chatSummary?.provider ?? session.toolType,
        fallbackSymbol: sessionSymbol(session, provider: chatSummary?.provider),
        tint: providerTintColor,
        size: 32
      )
      .adeMatchedGeometry(id: isSelectedTransitionSource ? "work-icon-\(session.id)" : nil, in: transitionNamespace)

      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .center, spacing: 6) {
          Circle()
            .fill(rowTint)
            .frame(width: 6, height: 6)
          Text(chatSummary?.title ?? session.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .truncationMode(.tail)
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "work-title-\(session.id)" : nil, in: transitionNamespace)
          if session.pinned {
            Image(systemName: "pin.fill")
              .font(.caption2)
              .foregroundStyle(ADEColor.accent)
          }
          Spacer(minLength: 6)
          Text(relativeTimestampCompact(workSessionActivityTimestamp(session: session, summary: chatSummary)))
            .font(.caption2.monospacedDigit())
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }

        if let preview = workSessionPreviewText(chatSummary?.summary ?? chatSummary?.lastOutputPreview ?? session.summary ?? session.lastOutputPreview) {
          Text(preview)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.tail)
        }

        HStack(spacing: 6) {
          Text(shortProviderLabel(chatSummary?.provider ?? session.toolType))
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)

          Text("·")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted.opacity(0.5))

          if let laneAccent = LaneColorPalette.color(forHex: lane?.color) {
            Circle()
              .fill(laneAccent)
              .frame(width: 6, height: 6)
          } else {
            Image(systemName: "arrow.triangle.branch")
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
          }
          Text(session.laneName)
            .font(.caption2)
            .foregroundStyle(LaneColorPalette.color(forHex: lane?.color) ?? ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)

          if lane?.status.dirty == true {
            Circle()
              .fill(ADEColor.warning)
              .frame(width: 6, height: 6)
              .accessibilityLabel("Uncommitted changes")
          }

          if let ahead = lane?.status.ahead, ahead > 0 {
            HStack(spacing: 1) {
              Image(systemName: "arrow.up")
                .font(.system(size: 9, weight: .semibold))
              Text("\(ahead)")
                .font(.caption2.monospacedDigit())
            }
            .foregroundStyle(ADEColor.success)
          }

          if let behind = lane?.status.behind, behind > 0 {
            HStack(spacing: 1) {
              Image(systemName: "arrow.down")
                .font(.system(size: 9, weight: .semibold))
              Text("\(behind)")
                .font(.caption2.monospacedDigit())
            }
            .foregroundStyle(ADEColor.warning)
          }

          Spacer(minLength: 0)

          if isArchived {
            Text("ARCHIVED")
              .font(.caption2.monospaced().weight(.semibold))
              .foregroundStyle(ADEColor.warning)
              .adeMatchedGeometry(id: isSelectedTransitionSource ? "work-status-\(session.id)" : nil, in: transitionNamespace)
          }
        }
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(providerTintColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .glassEffect(in: .rect(cornerRadius: 16))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(providerTintColor.opacity(0.25), lineWidth: 0.75)
    )
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "work-container-\(session.id)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  var providerTintColor: Color {
    providerTint(chatSummary?.provider ?? session.toolType)
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
  var animatesPulse: Bool = true
  @State var pulse = false

  var body: some View {
    HStack(spacing: 12) {
      Circle()
        .fill(ADEColor.success)
        .frame(width: 10, height: 10)
        .scaleEffect(animatesPulse && pulse && !reduceMotion ? 1.25 : 1.0)
        .animation(animatesPulse ? ADEMotion.pulse(reduceMotion: reduceMotion) : nil, value: pulse)
        .onAppear {
          guard !reduceMotion, animatesPulse else { return }
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
