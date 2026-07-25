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
  let onAddLane: () -> Void

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
        .background(ADEColor.composerBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
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
              (filterOpen ? ADEColor.accent.opacity(0.12) : ADEColor.composerBackground),
              in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .overlay(
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(filterOpen ? ADEColor.accent.opacity(0.32) : ADEColor.glassBorder, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Toggle filter panel")
      }

      HStack(spacing: 8) {
        Button(action: onNewChat) {
          HStack(spacing: 8) {
            Image(systemName: "plus")
              .font(.system(size: 13, weight: .bold))
            Text("Start new chat")
              .font(.subheadline.weight(.semibold))
          }
          .foregroundStyle(.white)
          .frame(maxWidth: .infinity, minHeight: 44)
          .background(ADEColor.accent, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(.white.opacity(0.18), lineWidth: 0.6)
          )
          .shadow(color: ADEColor.accent.opacity(0.18), radius: 6, x: 0, y: 2)
        }
        .buttonStyle(.plain)
        .disabled(!isLive)
        .opacity(isLive ? 1 : 0.55)
        .accessibilityLabel("Start new chat")

        Button(action: onAddLane) {
          HStack(spacing: 7) {
            Image(systemName: "plus.square.on.square")
              .font(.system(size: 13, weight: .semibold))
            Text("Add lane")
              .font(.subheadline.weight(.semibold))
              .lineLimit(1)
          }
          .foregroundStyle(isLive ? ADEColor.accent : ADEColor.textMuted)
          .frame(minWidth: 116, minHeight: 44)
          .padding(.horizontal, 12)
          .background(ADEColor.composerBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(isLive ? ADEColor.accent.opacity(0.3) : ADEColor.glassBorder, lineWidth: 0.6)
          )
        }
        .buttonStyle(.plain)
        .disabled(!isLive)
        .opacity(isLive ? 1 : 0.55)
        .accessibilityLabel("Add lane")
        .accessibilityHint(isLive ? "Opens lane creation options" : "Reconnect to machine before creating lanes")
      }

      if needsInputCount > 0 || hasActiveFilters {
        HStack(spacing: 6) {
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

          VStack(alignment: .leading, spacing: 8) {
            Text("Group")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(ADEColor.textMuted)
              .textCase(.uppercase)
              .tracking(0.5)
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 6) {
              ForEach(WorkSessionOrganization.allCases) { option in
                WorkFilterChip(
                  title: option.title,
                  selected: organization == option,
                  tint: ADEColor.accent
                ) {
                  withAnimation(.snappy(duration: 0.18)) {
                    organization = option
                  }
                }
              }
            }
            }

            Text("Lane")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(ADEColor.textMuted)
              .textCase(.uppercase)
              .tracking(0.5)
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 6) {
                WorkFilterChip(
                  title: "All lanes",
                  selected: selectedLaneId == "all",
                  tint: ADEColor.accent
                ) {
                  selectedLaneId = "all"
                }
              ForEach(lanes) { lane in
                WorkFilterChip(
                  title: lane.name,
                  selected: selectedLaneId == lane.id,
                  tint: ADEColor.accent
                ) {
                  selectedLaneId = lane.id
                }
              }
              }
            }
          }
        }
        .padding(12)
        .background(ADEColor.composerBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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
    .background(ADEColor.surfaceBackground.opacity(0.78), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
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
  /// Primary open PR for this lane section (by-lane grouping only). Rendered
  /// once on the header, left of the session count, replacing the former
  /// per-row indicator. Nil for status/time sections.
  var pullRequest: LanePrTag? = nil
  /// Navigates to the header PR in the PRs tab. Defaults to a no-op so preview
  /// harnesses don't have to wire it.
  var onOpenPullRequest: (LanePrTag) -> Void = { _ in }

  var body: some View {
    HStack(spacing: 8) {
      Button(action: onToggle) {
        HStack(spacing: 8) {
          Image(systemName: collapsed ? "chevron.right" : "chevron.down")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 10, alignment: .center)

          sectionIcon

          Text(group.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(group.laneColor != nil ? group.tint : ADEColor.textPrimary)
            .lineLimit(1)

          Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(group.label), \(group.sessions.count) session\(group.sessions.count == 1 ? "" : "s"). Tap to \(collapsed ? "expand" : "collapse").")

      if let pullRequest {
        Button {
          onOpenPullRequest(pullRequest)
        } label: {
          WorkLanePrIndicator(tag: pullRequest)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens in the PRs tab")
      }

      Text("\(group.sessions.count)")
        .font(.caption2.monospacedDigit().weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(ADEColor.surfaceBackground.opacity(0.65), in: Capsule())
    }
    .padding(.horizontal, 4)
    .padding(.vertical, 8)
  }

  @ViewBuilder
  private var sectionIcon: some View {
    switch group.icon {
    case .statusDot:
      Circle()
        .fill(group.tint)
        .frame(width: 7, height: 7)
    case .laneBranch:
      WorkLaneLogoMark(color: group.tint, laneIcon: group.laneIcon, size: 11)
        .frame(width: 12, height: 12)
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
  var pullRequest: LanePrTag? = nil
  let chatSummary: AgentChatSessionSummary?
  let isArchived: Bool
  let transitionNamespace: Namespace.ID?
  var compact: Bool = false
  var isLaneDeleting = false
  @Binding var selectedSessionId: String?
  let isSelecting: Bool
  let isChecked: Bool
  let onLongPressSelect: (TerminalSessionSummary) -> Void
  let onToggleSelect: (TerminalSessionSummary) -> Void
  let onOpen: (TerminalSessionSummary) -> Void
  let onPin: (TerminalSessionSummary) -> Void
  let onRename: (TerminalSessionSummary) -> Void
  let onStopRuntime: (TerminalSessionSummary) -> Void
  let onDelete: (TerminalSessionSummary) -> Void
  let onCopyId: (TerminalSessionSummary) -> Void
  let onCopyDeepLink: (TerminalSessionSummary) -> Void
  let onGoToLane: (TerminalSessionSummary) -> Void
  /// Opens the row's linked PR (mapped or GitHub-by-branch) in the PRs tab.
  /// Defaults to a no-op so preview harnesses don't have to wire it.
  var onOpenPullRequest: (TerminalSessionSummary, LanePrTag) -> Void = { _, _ in }

  /// Observed so the muted glyph and menu label re-render the moment a mute
  /// flips anywhere (this menu, the open chat's header menu, settings).
  @ObservedObject private var pushNotificationService = PushNotificationService.shared

  /// Mute only applies to chat sessions.
  private var isMuted: Bool {
    isChatSession(session)
      && pushNotificationService.prefs.mutedSessionIds.contains(session.id)
  }

  var body: some View {
    let rowStatus = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
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
          pullRequest: pullRequest,
          chatSummary: chatSummary,
          status: rowStatus,
          isArchived: isArchived,
          isMuted: isMuted,
          transitionNamespace: transitionNamespace,
          isSelectedTransitionSource: selectedSessionId == session.id,
          compact: compact
        )
        .equatable()
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
      if isStoppableRuntimeStatus(session, status: rowStatus) {
        Button("Stop runtime", role: .destructive) {
          onStopRuntime(session)
        }
        .tint(ADEColor.danger)
      } else if shouldShowDeleteAction {
        Button("Delete", role: .destructive) {
          onDelete(session)
        }
        .tint(ADEColor.danger)
      }
    }
    .contextMenu {
      Button {
        onLongPressSelect(session)
      } label: {
        Label("Select", systemImage: "checkmark.circle")
      }
      Button {
        onRename(session)
      } label: {
        Label("Rename", systemImage: "pencil")
      }
      if isStoppableRuntimeStatus(session, status: rowStatus) {
        Button(role: .destructive) {
          onStopRuntime(session)
        } label: {
          Label("Stop runtime", systemImage: "stop.fill")
        }
      }
      if shouldShowDeleteAction {
        Button(role: .destructive) {
          onDelete(session)
        } label: {
          Label("Delete chat", systemImage: "trash")
        }
      }
      Divider()
      Button {
        onGoToLane(session)
      } label: {
        Label("Go to lane", systemImage: "arrow.triangle.branch")
      }
      if let pullRequest {
        Button {
          onOpenPullRequest(session, pullRequest)
        } label: {
          Label("Open in PRs tab", systemImage: "arrow.triangle.pull")
        }
      }
      Button {
        onCopyId(session)
      } label: {
        Label("Copy session ID", systemImage: "doc.on.doc")
      }
      Button {
        onCopyDeepLink(session)
      } label: {
        Label("Copy session link", systemImage: "link")
      }
      Button {
        onPin(session)
      } label: {
        Label(session.pinned ? "Unpin from front" : "Pin to front",
              systemImage: session.pinned ? "pin.slash" : "pin")
      }
      if isChatSession(session) {
        Button {
          PushNotificationService.shared.setMuted(!isMuted, sessionId: session.id)
        } label: {
          Label(isMuted ? "Unmute notifications" : "Mute notifications",
                systemImage: isMuted ? "bell" : "bell.slash")
        }
      }
    }
    .overlay {
      if isLaneDeleting {
        HStack(spacing: 6) {
          ProgressView().controlSize(.small)
          Text("Updating lane…")
            .font(.caption.weight(.semibold))
        }
        .foregroundStyle(ADEColor.textSecondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(ADEColor.pageBackground.opacity(0.94), in: Capsule())
      }
    }
    .disabled(isLaneDeleting)
    .accessibilityHint(isLaneDeleting ? "This lane is being deleted" : "")
  }

  private var shouldShowDeleteAction: Bool {
    isChatSession(session)
  }
}

struct WorkChildShellSection<Content: View>: View {
  let group: WorkSessionChildGroup
  let collapsed: Bool
  let onToggle: () -> Void
  let content: () -> Content

  init(
    group: WorkSessionChildGroup,
    collapsed: Bool,
    onToggle: @escaping () -> Void,
    @ViewBuilder content: @escaping () -> Content
  ) {
    self.group = group
    self.collapsed = collapsed
    self.onToggle = onToggle
    self.content = content
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button(action: onToggle) {
        HStack(spacing: 5) {
          Image(systemName: collapsed ? "chevron.right" : "chevron.down")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 9, alignment: .center)
          Image(systemName: "terminal")
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(ADEColor.textMuted)
          Text(group.label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
            .textCase(.uppercase)
            .tracking(0.4)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(group.label). Tap to \(collapsed ? "expand" : "collapse").")

      if !collapsed {
        VStack(spacing: 3) {
          content()
        }
      }
    }
    .padding(.leading, 14)
    .overlay(alignment: .leading) {
      Rectangle()
        .fill(ADEColor.glassBorder.opacity(0.75))
        .frame(width: 1)
        .padding(.leading, 3)
    }
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

/// Minimal PR status indicator shown to the right of the lane name in the Work
/// session list, where space is tight: a state-colored dot, the PR number, and
/// a short state label ("Open" / "Draft" / "Closed" / "Merged"). Mirrors the
/// Lanes tab `LanePrTagChip`, trimmed to fit the dense metadata row.
struct WorkLanePrIndicator: View {
  let tag: LanePrTag

  var body: some View {
    let tint = lanePullRequestTint(tag.state)
    HStack(spacing: 3) {
      Circle()
        .fill(tint)
        .frame(width: 6, height: 6)
      Text("#\(tag.githubPrNumber)")
        .font(.caption2.monospacedDigit().weight(.semibold))
      Text(lanePrStateLabel(tag.state))
        .font(.caption2.weight(.medium))
    }
    .foregroundStyle(tint)
    .lineLimit(1)
    .fixedSize()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Pull request #\(tag.githubPrNumber), \(lanePrStateLabel(tag.state))")
  }
}

/// The compact second line shared by every native Work session row.
///
/// Keep this precedence identical to the desktop card:
/// explicit ask → agent note → sanitized last output → summary → goal.
/// Output intentionally wins over the older AI summary so a failed/missing
/// status-note write still leaves the user with the freshest truthful line.
func workSessionRowPreviewSource(
  session: TerminalSessionSummary,
  chatSummary: AgentChatSessionSummary?,
  isSettled: Bool
) -> String? {
  let primaryText = chatSummary?.title ?? session.title

  func inlineText(_ raw: String?, terminalOutput: Bool = false) -> String? {
    guard let raw else { return nil }
    let rendered = terminalOutput ? sanitizeTerminalOutputForDisplay(raw) : raw
    guard let normalized = workSessionPreviewText(rendered) else { return nil }
    let inline = workSummarizeInlineText(normalized, maxChars: 120)
    return inline.isEmpty ? nil : inline
  }

  if session.attentionRequestedAt?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
     let message = inlineText(session.attentionMessage) {
    return message
  }
  if let note = inlineText(session.statusNote) {
    return isSettled ? "Done: \(note)" : note
  }
  for rawOutput in [chatSummary?.lastOutputPreview, session.lastOutputPreview] {
    if let output = inlineText(rawOutput, terminalOutput: true), output != primaryText {
      return output
    }
  }
  for rawSummary in [chatSummary?.summary, session.summary] {
    if let summary = inlineText(rawSummary), summary != primaryText {
      return summary
    }
  }
  for rawGoal in [chatSummary?.goal, session.goal] {
    if let goal = inlineText(rawGoal), goal != primaryText {
      return goal
    }
  }
  return nil
}

private struct WorkSessionRowRenderSignature: Equatable {
  let sessionId: String
  let title: String
  let provider: String?
  let symbolProvider: String?
  let laneName: String
  let laneColor: String?
  let laneDirty: Bool
  let laneAhead: Int
  let laneBehind: Int
  let activityTimestamp: String
  let previewSource: String?
  let pinned: Bool
  let pullRequestNumber: Int?
  let pullRequestState: String?
  let status: String
  let canonicalPhase: CanonicalSessionPhase
  let settledAt: String?
  let statusNote: String?
  let attentionRequestedAt: String?
  let attentionMessage: String?
  let lastTurnFailedAt: String?
  // Deterministic inputs to the attention capsule, so a badge transition
  // (needs_you / failed) re-renders even when the display status is unchanged.
  let runtimeState: String
  let pendingInputItemId: String?
  let exitCode: Int?
  let isArchived: Bool
  let isMuted: Bool
  let isSelectedTransitionSource: Bool
  let compact: Bool

  init(
    session: TerminalSessionSummary,
    lane: LaneSummary?,
    pullRequest: LanePrTag?,
    chatSummary: AgentChatSessionSummary?,
    status: String,
    isArchived: Bool,
    isMuted: Bool,
    isSelectedTransitionSource: Bool,
    compact: Bool
  ) {
    self.sessionId = session.id
    self.title = chatSummary?.title ?? session.title
    self.provider = chatSummary?.provider ?? session.toolType
    self.symbolProvider = chatSummary?.provider
    self.laneName = session.laneName
    self.laneColor = lane?.color
    self.laneDirty = lane?.status.dirty == true
    self.laneAhead = lane?.status.ahead ?? 0
    self.laneBehind = lane?.status.behind ?? 0
    self.activityTimestamp = workSessionActivityTimestamp(session: session, summary: chatSummary)
    let canonical = workCanonicalSessionState(session: session, summary: chatSummary)
    self.previewSource = workSessionRowPreviewSource(
      session: session,
      chatSummary: chatSummary,
      isSettled: canonical.phase == .settled
    )
    self.pinned = session.pinned
    self.pullRequestNumber = pullRequest?.githubPrNumber
    self.pullRequestState = pullRequest.map { lanePrStateLabel($0.state) }
    self.status = status
    self.canonicalPhase = canonical.phase
    self.settledAt = session.settledAt
    self.statusNote = session.statusNote
    self.attentionRequestedAt = session.attentionRequestedAt
    self.attentionMessage = session.attentionMessage
    self.lastTurnFailedAt = session.lastTurnFailedAt
    self.runtimeState = session.runtimeState
    self.pendingInputItemId = session.pendingInputItemId
    self.exitCode = session.exitCode
    self.isArchived = isArchived
    self.isMuted = isMuted
    self.isSelectedTransitionSource = isSelectedTransitionSource
    self.compact = compact
  }
}

struct WorkSessionRow: View, Equatable {
  let session: TerminalSessionSummary
  let lane: LaneSummary?
  var pullRequest: LanePrTag? = nil
  let chatSummary: AgentChatSessionSummary?
  let status: String
  let isArchived: Bool
  var isMuted: Bool = false
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool
  var compact: Bool = false
  private let renderSignature: WorkSessionRowRenderSignature

  init(
    session: TerminalSessionSummary,
    lane: LaneSummary?,
    pullRequest: LanePrTag? = nil,
    chatSummary: AgentChatSessionSummary?,
    status: String,
    isArchived: Bool,
    isMuted: Bool = false,
    transitionNamespace: Namespace.ID?,
    isSelectedTransitionSource: Bool,
    compact: Bool = false
  ) {
    self.session = session
    self.lane = lane
    self.pullRequest = pullRequest
    self.chatSummary = chatSummary
    self.status = status
    self.isArchived = isArchived
    self.isMuted = isMuted
    self.transitionNamespace = transitionNamespace
    self.isSelectedTransitionSource = isSelectedTransitionSource
    self.compact = compact
    self.renderSignature = WorkSessionRowRenderSignature(
      session: session,
      lane: lane,
      pullRequest: pullRequest,
      chatSummary: chatSummary,
      status: status,
      isArchived: isArchived,
      isMuted: isMuted,
      isSelectedTransitionSource: isSelectedTransitionSource,
      compact: compact
    )
  }

  static func == (lhs: WorkSessionRow, rhs: WorkSessionRow) -> Bool {
    lhs.renderSignature == rhs.renderSignature
  }

  var body: some View {
    if compact {
      compactBody
    } else {
      standardBody
    }
  }

  private var compactBody: some View {
    HStack(alignment: .center, spacing: 8) {
      WorkProviderBareLogo(
        provider: chatSummary?.provider ?? session.toolType,
        fallbackSymbol: sessionSymbol(session, provider: chatSummary?.provider),
        tint: providerTintColor,
        size: 20
      )

      Text(chatSummary?.title ?? session.title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.tail)

      if let badge = capsuleBadge {
        WorkSessionStatusCapsule(badge: badge)
      }

      Spacer(minLength: 6)

      if isPendingSyncCreation {
        Text("Pending sync")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      } else {
        Text(relativeTimestampCompact(workSessionActivityTimestamp(session: session, summary: chatSummary)))
          .font(.caption2.monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(providerTintColor.opacity(0.07), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .stroke(providerTintColor.opacity(0.18), lineWidth: 0.6)
    )
    .opacity(isSettled ? 0.7 : 1)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  private var standardBody: some View {
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
          Group {
            if isSettled {
              Circle()
                .stroke(Color.white.opacity(0.35), lineWidth: 1)
            } else {
              Circle()
                .fill(rowTint)
            }
          }
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
          if isMuted {
            Image(systemName: "bell.slash")
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .accessibilityLabel("Notifications muted")
          }
          if let badge = capsuleBadge {
            WorkSessionStatusCapsule(badge: badge)
          }
          Spacer(minLength: 6)
          Text(relativeTimestampCompact(workSessionActivityTimestamp(session: session, summary: chatSummary)))
            .font(.caption2.monospacedDigit())
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }

        if let preview = workSessionPreviewText(rowPreviewSource) {
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
            .layoutPriority(-1)

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

          if isPendingSyncCreation {
            HStack(spacing: 4) {
              Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 9, weight: .semibold))
              Text("Pending sync")
                .font(.caption2.weight(.semibold))
            }
            .foregroundStyle(ADEColor.textMuted)
          } else if isArchived {
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
    .background(providerTintColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(providerTintColor.opacity(0.25), lineWidth: 0.75)
    )
    .opacity(isSettled ? 0.7 : 1)
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "work-container-\(session.id)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
    .adeInspectable(
      "Work.Session.Row",
      metadata: [
        "sessionId": session.id,
        "laneId": session.laneId,
        "laneName": session.laneName,
        "title": chatSummary?.title ?? session.title
      ]
    )
  }

  var providerTintColor: Color {
    providerTint(chatSummary?.provider ?? session.toolType)
  }

  /// Canonical attention capsule (needs_you / failed / stale); nil for calm
  /// states so the row never shifts layout when no capsule renders.
  var capsuleBadge: SessionBadge? {
    canonicalState.badge
  }

  var canonicalState: CanonicalSessionState {
    workCanonicalSessionState(session: session, summary: chatSummary)
  }

  var isSettled: Bool {
    canonicalState.phase == .settled
  }

  var rowPreviewSource: String? {
    workSessionRowPreviewSource(
      session: session,
      chatSummary: chatSummary,
      isSettled: isSettled
    )
  }

  var isPendingSyncCreation: Bool {
    workIsPendingChatCreationSession(session)
  }

  var rowTint: Color {
    if isPendingSyncCreation { return ADEColor.textMuted }
    if isArchived { return ADEColor.warning }
    return workChatStatusTint(status)
  }

  var accessibilityLabel: String {
    var parts = [chatSummary?.title ?? session.title, session.laneName, sessionStatusLabel(for: status)]
    if session.pinned {
      parts.append("pinned")
    }
    if isArchived {
      parts.append("archived")
    }
    if isSettled {
      parts.append("settled")
    }
    return parts.joined(separator: ", ")
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
