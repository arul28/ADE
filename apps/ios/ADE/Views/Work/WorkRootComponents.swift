import SwiftUI
import UIKit
import AVKit

// The session row card itself (`WorkSessionRow`, its leaf views and the preview-line
// helpers) lives in `WorkSessionRowCard.swift`; this file keeps the surrounding list chrome.

/// Work sidebar toolbar matching the desktop `SessionListPane` layout: one 44pt row holding the
/// search field, the funnel toggle that reveals the Group-by + Lane filter panel, and a compose
/// menu carrying both creation actions.
///
/// The header is one row on purpose. It used to be three — search + funnel, then a full-width
/// "Start new chat" / "Add lane" hero pair, then a `N waiting` chip — which pushed the first
/// session row most of a thumb below the top bar and spent amber on a count that the bell already
/// badges. Creation is a two-item menu behind one icon; the count rollup is gone entirely.
struct WorkFiltersSection: View {
  @Binding var searchText: String
  @Binding var selectedLaneId: String
  @Binding var selectedStatus: WorkSessionStatusFilter
  @Binding var organization: WorkSessionOrganization
  @Binding var filterOpen: Bool
  let lanes: [LaneSummary]
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
        // 44, not the old 32: a text field's tap target is its own bounds, so a
        // `.contentShape` on a taller wrapper would not extend it. This is the
        // one control in the row that has to grow to reach the minimum.
        .frame(minHeight: 44)
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
            // The chip stays 32pt; the hit area is grown to 44 around it rather
            // than by inflating the visual, which is what keeps the row's rhythm.
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Toggle filter panel")

        // Creation is one icon with two items. Both used to be full-width hero
        // buttons stacked under the search field; they are rare actions that were
        // spending the most valuable strip on the screen.
        Menu {
          Button(action: onNewChat) {
            Label("New chat", systemImage: "plus.bubble")
          }
          Button(action: onAddLane) {
            Label("New lane", systemImage: "plus.square.on.square")
          }
        } label: {
          Image(systemName: "square.and.pencil")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(isLive ? ADEColor.accent : ADEColor.textMuted)
            .frame(width: 32, height: 32)
            .background(ADEColor.composerBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(isLive ? ADEColor.accent.opacity(0.3) : ADEColor.glassBorder, lineWidth: 0.6)
            )
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isLive)
        .opacity(isLive ? 1 : 0.55)
        .accessibilityLabel("New chat or lane")
        .accessibilityHint(isLive ? "Opens chat and lane creation options" : "Reconnect to machine before creating lanes")
      }
      .frame(minHeight: 44)

      if hasActiveFilters {
        HStack(spacing: 6) {
          Spacer(minLength: 0)
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
          // Tail, never middle. Middle truncation eats the distinguishing middle
          // of a name and leaves two fragments that read as one mangled word.
          .truncationMode(.tail)
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
  var onRefreshOrphanedSessions: (() -> Void)? = nil
  /// Lane-scoped git state (dirty / ahead / behind). It used to be repeated on
  /// every session row of the lane, which said the same fact five times and made
  /// a row rebuild on every lane status poll. It is one lane's state, so it is
  /// stated once, here. Nil for status and time sections, which span lanes and
  /// therefore have no single true answer.
  var laneStatus: LaneStatus? = nil

  /// Collapsed and holding only settled work: render one thin muted row with the
  /// count folded in, instead of a full-weight header over nothing.
  private var isQuietRow: Bool { group.isQuiet && collapsed }

  var body: some View {
    HStack(spacing: isQuietRow ? 6 : 8) {
      Button(action: onToggle) {
        HStack(spacing: isQuietRow ? 6 : 8) {
          Image(systemName: collapsed ? "chevron.right" : "chevron.down")
            .font(.system(size: isQuietRow ? 8 : 9, weight: .bold))
            .foregroundStyle(ADEColor.textMuted.opacity(isQuietRow ? 0.55 : 1))
            .frame(width: 10, alignment: .center)

          sectionIcon

          Text(group.isOrphaned ? "Orphaned sessions: \(group.label)" : group.label)
            .font(isQuietRow ? .caption2.weight(.medium) : .caption.weight(.semibold))
            .foregroundStyle(quietAwareLabelColor)
            .lineLimit(1)

          Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .accessibilityLabel(accessibilityLabelText)

      if group.isOrphaned, let onRefreshOrphanedSessions {
        Button("Refresh", systemImage: "arrow.clockwise", action: onRefreshOrphanedSessions)
          .labelStyle(.iconOnly)
          .buttonStyle(.plain)
          .frame(minWidth: 44, minHeight: 44)
          .accessibilityHint("Refreshes lane and session records. Nothing is deleted.")
      }

      // Left of the PR indicator and deliberately quieter than both it and the
      // lane name: this is context, not a call to action. Dropped entirely on a
      // folded quiet row, where the section is one thin line and every glyph
      // competes with the count.
      if !isQuietRow, let laneStatus, laneGitStateIsNoteworthy(laneStatus) {
        laneGitStateChips(laneStatus)
      }

      if let pullRequest {
        Button {
          onOpenPullRequest(pullRequest)
        } label: {
          WorkLanePrIndicator(tag: pullRequest)
        }
        .buttonStyle(.plain)
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityHint("Opens in the PRs tab")
      }

      if isQuietRow {
        // Hollow ring + count: the settled tier's own language, matching the
        // desktop sidebar's inline quiet counts.
        HStack(spacing: 3) {
          Circle()
            .strokeBorder(ADEColor.textMuted.opacity(0.45), lineWidth: 1)
            .frame(width: 6, height: 6)
          Text("\(group.sessions.count)")
            .font(.caption2.monospacedDigit().weight(.medium))
        }
        .foregroundStyle(ADEColor.textMuted.opacity(0.6))
        .accessibilityHidden(true)
      } else {
        Text("\(group.sessions.count)")
          .font(.caption2.monospacedDigit().weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(ADEColor.surfaceBackground.opacity(0.65), in: Capsule())
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, 4)
    .padding(.vertical, isQuietRow ? 3 : 8)
    .opacity(isQuietRow ? 0.72 : 1)
  }

  /// Nothing to say when the worktree is clean and level with its base — an
  /// always-present "0 ahead, 0 behind" would be chrome, not information.
  private func laneGitStateIsNoteworthy(_ status: LaneStatus) -> Bool {
    status.dirty || status.ahead > 0 || status.behind > 0
  }

  @ViewBuilder
  private func laneGitStateChips(_ status: LaneStatus) -> some View {
    HStack(spacing: 5) {
      if status.dirty {
        Circle()
          .fill(ADEColor.warning.opacity(0.85))
          .frame(width: 5, height: 5)
      }
      if status.ahead > 0 {
        laneGitCountChip(symbol: "arrow.up", count: status.ahead)
      }
      if status.behind > 0 {
        laneGitCountChip(symbol: "arrow.down", count: status.behind)
      }
    }
    .foregroundStyle(ADEColor.textMuted)
    .fixedSize()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(laneGitStateAccessibilityLabel(status))
  }

  private func laneGitCountChip(symbol: String, count: Int) -> some View {
    HStack(spacing: 1) {
      Image(systemName: symbol)
        .font(.system(size: 7, weight: .bold))
      Text("\(count)")
        .font(.caption2.monospacedDigit())
    }
  }

  private func laneGitStateAccessibilityLabel(_ status: LaneStatus) -> String {
    var parts: [String] = []
    if status.dirty { parts.append("uncommitted changes") }
    if status.ahead > 0 { parts.append("\(status.ahead) ahead") }
    if status.behind > 0 { parts.append("\(status.behind) behind") }
    return parts.joined(separator: ", ")
  }

  private var quietAwareLabelColor: Color {
    if isQuietRow { return ADEColor.textSecondary }
    if group.isOrphaned { return ADEColor.warning }
    return group.laneColor != nil ? group.tint : ADEColor.textPrimary
  }

  private var accessibilityLabelText: String {
    let count = group.sessions.count
    let noun = "session\(count == 1 ? "" : "s")"
    let action = collapsed ? "expand" : "collapse"
    if isQuietRow {
      return "\(group.label), \(count) settled \(noun). Tap to \(action)."
    }
    let label = group.isOrphaned ? "Orphaned sessions: \(group.label)" : group.label
    return "\(label), \(count) \(noun). Tap to \(action)."
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
    case .warning:
      Image(systemName: "exclamationmark.triangle")
        .font(.caption)
        .foregroundStyle(ADEColor.warning)
        .frame(width: 12, height: 12)
    case .none:
      Color.clear.frame(width: 0, height: 0)
    }
  }
}

// `WorkFlatCountChip` and `WorkLiveCountPill` used to live here: an above-the-list
// "N waiting" chip and a tappable top-bar pill, both fed from one screen-wide
// needs-input count that `WorkRootSessionPresentation` no longer publishes at
// all. They are deleted, not moved. Amber means "your move"
// and nothing else, and spending it three times on one screen (pill, chip, row
// badge) is precisely what made the per-row badge stop registering. The pill's
// jump-to-attention is already covered by the bell → Activity drawer, which
// bands needs-you first with per-session navigation.

/// The lane half of a session row's long-press menu, mirroring desktop's
/// `Lane ▸` submenu (`laneContextMenuItems.tsx`).
///
/// Bundled instead of eight loose closures because every call site wires all of
/// them or none, and because the two availability flags have to travel with the
/// actions they gate. `colorAvailable` / `manageAvailable` are per-command
/// gates: a host that does not advertise `lanes.updateAppearance` must not show
/// a colour row that silently fails.
///
/// Desktop items with no phone analogue are deliberately absent, not forgotten:
/// Open in / Remove from Split, Close Other Tabs, Select All Lanes and Reveal in
/// Finder all describe a windowing model a phone does not have.
struct WorkSessionLaneMenuActions {
  var colorAvailable: Bool = false
  var manageAvailable: Bool = false
  var onStartChat: (LaneSummary) -> Void = { _ in }
  var onCopyLaneLink: (LaneSummary) -> Void = { _ in }
  var onCopyBranchLink: (LaneSummary) -> Void = { _ in }
  var onCopyLinearLink: (LaneSummary) -> Void = { _ in }
  var onCopyPath: (LaneSummary) -> Void = { _ in }
  var onSetColor: (LaneSummary, String?) -> Void = { _, _ in }
  var onManage: (LaneSummary) -> Void = { _ in }
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
  /// True when no lane header sits above this row — the singleton form, where
  /// the row carries the lane identity itself.
  var showsLaneIdentity: Bool = true
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
  // ADE-125 session lifecycle. Defaults are no-ops (and the affordances are
  // hidden) so preview harnesses and older hosts don't have to wire them.
  /// The host advertises settle / unsettle / settle-override.
  var lifecycleAvailable: Bool = false
  /// The host advertises snooze / wake.
  var snoozeAvailable: Bool = false
  var onSettle: (TerminalSessionSummary) -> Void = { _ in }
  /// Settle a needs-you row AND clear its pending prompt. Separate from
  /// `onSettle` because the host rejects the dismiss flag on a row with nothing
  /// pending — the two are different commands, not one command with a toggle.
  var onDismissAndSettle: (TerminalSessionSummary) -> Void = { _ in }
  var onUnsettle: (TerminalSessionSummary) -> Void = { _ in }
  var onKeepActive: (TerminalSessionSummary) -> Void = { _ in }
  var onSnooze: (TerminalSessionSummary, WorkSnoozeDuration) -> Void = { _, _ in }
  var onWake: (TerminalSessionSummary) -> Void = { _ in }
  /// The host advertises `work.deleteSession` — the stop-then-delete path for a
  /// non-chat row. Older hosts never had it, so a phone talking to one hides the
  /// two destructive items rather than offering a control that always fails.
  var deleteSessionAvailable: Bool = false
  /// Deletes a CLI/shell session (running or stopped). Chats keep `onDelete`;
  /// the two go through different host commands and different confirmations.
  var onDeleteSession: (TerminalSessionSummary) -> Void = { _ in }
  /// Opens this session in the hosted web client. Purely local — it builds a URL
  /// and hands it to the system, so it needs no host command and no gate.
  var onOpenInWeb: (TerminalSessionSummary) -> Void = { _ in }
  /// Lane-scoped actions for the `Lane ▸` submenu. Nil (the default) renders no
  /// submenu at all, which is also what a row with no resolvable lane gets.
  var laneMenu: WorkSessionLaneMenuActions? = nil

  /// Observed so the muted glyph and menu label re-render the moment a mute
  /// flips anywhere (this menu, the open chat's header menu, settings).
  @ObservedObject private var pushNotificationService = PushNotificationService.shared

  /// Mute only applies to chat sessions.
  private var isMuted: Bool {
    isChatSession(session)
      && pushNotificationService.prefs.mutedSessionIds.contains(session.id)
  }

  private var canonicalPhase: CanonicalSessionPhase {
    workCanonicalSessionState(session: session, summary: chatSummary).phase
  }

  private var isSnoozed: Bool {
    session.isSnoozed()
  }

  private var isChat: Bool { isChatSession(session) }

  /// Mid-flight. Desktop hides Settle for all three of these
  /// (`SessionContextMenu.tsx:196-199`): filing away a row the machine is still
  /// working in claims an outcome that has not happened yet, and the row is
  /// about to change state on its own anyway. iOS used to allow it, which let a
  /// user settle a session mid-turn.
  private var isActivelyRunning: Bool {
    canonicalPhase == .starting || canonicalPhase == .running || canonicalPhase == .stale
  }

  /// Whether a needs-you ask can be DISMISSED as part of settling. A chat
  /// resolves its own prompts, and an escalated ask carries a record the host
  /// knows how to clear. A bare terminal prompt has neither, so settling it
  /// would hide a question the machine is still blocked on — which is why
  /// desktop explains the absence instead of quietly dropping the item.
  ///
  /// These are exactly desktop's three clauses (`SessionContextMenu.tsx:200-203`).
  /// Do NOT add `attentionSource == "provider_structured"` here: that clause
  /// belongs to the status slot, which uses it to keep a heuristic row
  /// *settleable*, and it is a different question from "can the host dismiss
  /// this prompt". The only shape it admits that these three do not is a
  /// non-chat row with no `attentionRequestedAt` — which `ptyService.ts`
  /// documents as a MISLABEL from regex-scanning a plain PTY stream (search
  /// "is a MISLABEL and known to be one"; cited by phrase rather than line
  /// because that file moves). For that row `dismissPendingInputBeforeSettle`
  /// has nothing to
  /// clear and throws, so offering "Dismiss & settle" could only ever produce
  /// an error toast and a rolled-back optimistic write. Falling through to the
  /// disabled "Resolve input to settle" row is the honest answer.
  private var canDismissNeedsYou: Bool {
    canonicalPhase != .needsYou
      || isChat
      || session.attentionRequestedAt != nil
  }

  private var canSettle: Bool {
    lifecycleAvailable
      && canonicalPhase != .settled
      && !isActivelyRunning
      && canDismissNeedsYou
  }

  /// The settle for a needs-you row also clears the pending prompt, and says so.
  /// The host REJECTS the dismiss flag on a row with nothing pending, so this is
  /// the only condition under which the dismissing variant may be sent.
  private var settleDismissesPendingInput: Bool {
    canonicalPhase == .needsYou
  }

  /// Needs-you with an ask nothing can dismiss. Desktop renders a DISABLED row
  /// here rather than nothing: an item that silently disappears reads as a bug,
  /// while "Resolve input to settle" states the precondition.
  private var settleBlockedOnInput: Bool {
    lifecycleAvailable && canonicalPhase == .needsYou && !canDismissNeedsYou
  }

  private var canUnsettle: Bool {
    lifecycleAvailable && canonicalPhase == .settled
  }

  /// "Keep active" only means something against a DECLARED settle — one an
  /// agent, user, operator or merge policy wrote into `settled_at`. A settle the
  /// UI merely derived has no column for the pin to hold down, so desktop
  /// restricts the item the same way (`SessionContextMenu.tsx:209`, `:250`).
  private var canKeepActive: Bool {
    lifecycleAvailable
      && session.settledAt != nil
      && session.resolvedSettleOverride != .active
      && canonicalPhase == .settled
  }

  private var snoozeOptions: [WorkSnoozeOption] {
    workSnoozeOptions()
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
          compact: compact,
          showsLaneIdentity: showsLaneIdentity
        )
        .equatable()
      }
    }
    .buttonStyle(.plain)
    // No raw `LongPressGesture` here. A 0.45s press competed with the very same
    // long press that opens `.contextMenu`, so whichever recogniser won was a
    // coin toss and the menu felt broken. The menu's own "Select" item is the
    // single way into multi-select now.
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      if isStoppableRuntimeStatus(session, status: rowStatus) {
        Button("Stop runtime", role: .destructive) {
          onStopRuntime(session)
        }
        .tint(ADEColor.danger)
      } else if shouldShowDeleteAction {
        Button("Delete chat", role: .destructive) {
          onDelete(session)
        }
        .tint(ADEColor.danger)
      } else if canDeleteStoppedSession(status: rowStatus) {
        // A stopped CLI or shell row. Until `work.deleteSession` was wired there
        // was no way at all to delete one of these from a phone.
        Button("Delete session", role: .destructive) {
          onDeleteSession(session)
        }
        .tint(ADEColor.danger)
      }
      // The two lifecycle moves people make constantly get a swipe; everything
      // else lives in the long-press menu. iOS has no hover, so there is no
      // desktop-style always-visible moon button.
      if canSettle {
        Button {
          settle()
        } label: {
          Label(settleLabel, systemImage: "checkmark.circle")
        }
        .tint(ADEColor.accent)
      } else if canUnsettle {
        Button {
          onUnsettle(session)
        } label: {
          Label("Unsettle", systemImage: "arrow.uturn.backward.circle")
        }
        .tint(ADEColor.accent)
      }
      if snoozeAvailable {
        if isSnoozed {
          Button {
            onWake(session)
          } label: {
            Label("Wake", systemImage: "sun.max")
          }
          .tint(ADEColor.warning)
        } else {
          // The swipe is the fast path — one hour. Every other window is a
          // long-press away, so the swipe never opens a picker mid-gesture.
          Button {
            onSnooze(session, .oneHour)
          } label: {
            Label("Snooze 1h", systemImage: "moon.zzz")
          }
          .tint(ADEColor.info)
        }
      }
    }
    // Desktop's tree, in desktop's order (`SessionContextMenu.tsx`): identity
    // first, then lifecycle, then the places this session also appears, then —
    // fenced behind a divider and never before it — the deletes. Ordering is not
    // cosmetic here: a mis-tap right after the menu opens lands mid-list, which
    // is exactly where the deletes used to sit.
    .contextMenu {
      identityMenuSection
      lifecycleMenuSection(status: rowStatus)
      goToMenuSection
      destructiveMenuSection(status: rowStatus)
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

  /// Stop-then-delete for a live CLI/shell row: desktop's "Stop & delete".
  private func canStopAndDeleteSession(status: String) -> Bool {
    deleteSessionAvailable && isStoppableRuntimeStatus(session, status: status)
  }

  /// Plain delete for a CLI/shell row that is already stopped. `work.delete
  /// Session` handles both, but the labels differ because the consequences do.
  private func canDeleteStoppedSession(status: String) -> Bool {
    deleteSessionAvailable && !isChat && !isStoppableRuntimeStatus(session, status: status)
  }

  private var settleLabel: String {
    settleDismissesPendingInput ? "Dismiss & settle" : "Settle"
  }

  private func settle() {
    if settleDismissesPendingInput {
      onDismissAndSettle(session)
    } else {
      onSettle(session)
    }
  }

  // MARK: - Menu sections

  /// What this row is called and how it is filed. Unlabelled: it is the first
  /// block under the finger and needs no signpost.
  @ViewBuilder
  private var identityMenuSection: some View {
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
    Button {
      onPin(session)
    } label: {
      Label(session.pinned ? "Unpin from front" : "Pin to front",
            systemImage: session.pinned ? "pin.slash" : "pin")
    }
    if isChat {
      Button {
        PushNotificationService.shared.setMuted(!isMuted, sessionId: session.id)
      } label: {
        Label(isMuted ? "Unmute notifications" : "Mute notifications",
              systemImage: isMuted ? "bell" : "bell.slash")
      }
    }
  }

  /// Everything that changes where the list files this row: stop (runtime),
  /// snooze/wake (visibility), settle/keep-active (state). Durations use a
  /// native nested `Menu`, never a popover — this is a long press on a phone.
  ///
  /// Keep it exhaustive. A row that reaches the end of this block with nothing
  /// rendered is a row the user cannot un-hide.
  @ViewBuilder
  private func lifecycleMenuSection(status: String) -> some View {
    let canStopRuntime = isStoppableRuntimeStatus(session, status: status)
    if canStopRuntime || lifecycleAvailable || snoozeAvailable {
      Divider()
      // Stop runtime moved here from the identity block: it is a lifecycle
      // change, and it is NOT destructive — the session and its transcript
      // survive — so it must not sit next to the deletes.
      if canStopRuntime {
        Button {
          onStopRuntime(session)
        } label: {
          Label("Stop runtime", systemImage: "stop.fill")
        }
      }
      if snoozeAvailable {
        if isSnoozed {
          Button {
            onWake(session)
          } label: {
            Label("Wake now", systemImage: "sun.max")
          }
        } else {
          Menu {
            ForEach(snoozeOptions, id: \.duration.id) { option in
              Button {
                onSnooze(session, option.duration)
              } label: {
                Label(option.duration.label, systemImage: option.duration.symbol)
              }
            }
          } label: {
            Label("Snooze", systemImage: "moon.zzz")
          }
        }
      }
      if canSettle {
        Button {
          settle()
        } label: {
          Label(settleLabel, systemImage: "checkmark.circle")
        }
      } else if settleBlockedOnInput {
        // Disabled on purpose. Hiding Settle here would leave the user hunting
        // for an item that simply vanished; this states the precondition.
        Button {} label: {
          Label("Resolve input to settle", systemImage: "exclamationmark.bubble")
        }
        .disabled(true)
      }
      if canUnsettle {
        Button {
          onUnsettle(session)
        } label: {
          Label("Unsettle", systemImage: "arrow.uturn.backward.circle")
        }
      }
      if canKeepActive {
        Button {
          onKeepActive(session)
        } label: {
          Label("Keep active", systemImage: "pin.circle")
        }
      }
    }
  }

  /// The other surfaces that show this same session, plus the clipboard rows and
  /// the lane submenu. Copy and Lane are nested because a phone context menu
  /// past roughly ten top-level rows stops being scannable.
  @ViewBuilder
  private var goToMenuSection: some View {
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
      onOpenInWeb(session)
    } label: {
      Label("Open in web", systemImage: "safari")
    }
    Menu {
      Button {
        onCopyId(session)
      } label: {
        Label("Session ID", systemImage: "number")
      }
      Button {
        onCopyDeepLink(session)
      } label: {
        Label("Session link", systemImage: "link")
      }
    } label: {
      Label("Copy", systemImage: "doc.on.doc")
    }
    laneMenuSection
  }

  /// `Lane ▸`. Rendered only when the row actually resolves a lane and the
  /// screen wired the actions — on iOS every row has a lane header or a lane
  /// chip, so this is the lane menu for the whole app, not just singleton rows.
  @ViewBuilder
  private var laneMenuSection: some View {
    if let lane, let laneMenu {
      Menu {
        Button {
          laneMenu.onStartChat(lane)
        } label: {
          Label("Start chat in lane", systemImage: "plus.bubble")
        }
        Menu {
          Button {
            laneMenu.onCopyLaneLink(lane)
          } label: {
            Label("ADE lane link", systemImage: "link")
          }
          Button {
            laneMenu.onCopyBranchLink(lane)
          } label: {
            Label("Branch link", systemImage: "arrow.triangle.branch")
          }
          // Only a lane that actually carries a Linear issue URL — the copy is
          // that URL verbatim, so there is nothing to offer without one.
          if primaryLaneLinearIssue(for: lane)?.url != nil {
            Button {
              laneMenu.onCopyLinearLink(lane)
            } label: {
              Label("Linear issue link", systemImage: "square.on.square")
            }
          }
          Button {
            laneMenu.onCopyPath(lane)
          } label: {
            Label("Path", systemImage: "folder")
          }
        } label: {
          Label("Copy", systemImage: "doc.on.doc")
        }
        if laneMenu.colorAvailable {
          Menu {
            ForEach(LaneColorPalette.entries) { entry in
              Button {
                laneMenu.onSetColor(lane, entry.hex)
              } label: {
                Label(entry.name, systemImage: lane.color?.lowercased() == entry.hex.lowercased()
                  ? "checkmark.circle.fill"
                  : "circle.fill")
              }
            }
            Divider()
            Button {
              laneMenu.onSetColor(lane, nil)
            } label: {
              Label("No color", systemImage: "circle.dashed")
            }
          } label: {
            Label("Color", systemImage: "paintpalette")
          }
        }
        if laneMenu.manageAvailable {
          // Last inside the submenu, like desktop: it opens a surface that can
          // archive or delete the lane.
          Button {
            laneMenu.onManage(lane)
          } label: {
            Label("Manage lane", systemImage: "slider.horizontal.3")
          }
        }
      } label: {
        Label("Lane", systemImage: "arrow.triangle.branch")
      }
    }
  }

  /// Destructive, last, and behind a divider — the whole point of the reorder.
  @ViewBuilder
  private func destructiveMenuSection(status: String) -> some View {
    if canStopAndDeleteSession(status: status) || shouldShowDeleteAction || canDeleteStoppedSession(status: status) {
      Divider()
      if canStopAndDeleteSession(status: status) {
        Button(role: .destructive) {
          onDeleteSession(session)
        } label: {
          Label("Stop & delete", systemImage: "trash")
        }
      }
      if shouldShowDeleteAction {
        Button(role: .destructive) {
          onDelete(session)
        } label: {
          Label("Delete chat", systemImage: "trash")
        }
      }
      if canDeleteStoppedSession(status: status) {
        Button(role: .destructive) {
          onDeleteSession(session)
        } label: {
          Label("Delete session", systemImage: "trash")
        }
      }
    }
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
