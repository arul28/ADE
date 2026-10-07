import SwiftUI

// MARK: - The four states, in the tree
//
// The project → lane → chat tree counts by the Work board's four columns, the
// same model the Activity drawer, the widgets and the Live Activity use:
// Needs you, Working, Waiting, Done. A failure is Needs you and keeps its own
// red mark on the row.

/// Which column one roster row is in, and why when it says more than the column.
struct HubChatBoardState: Hashable {
  let column: ActivityBoardColumn
  /// A failed turn files under Needs you and keeps the red failure mark.
  let failed: Bool
  let waitingReason: ActivityWaitingReason?

  var tone: ActivityTone { failed ? .red : column.tone }

  var systemImage: String { failed ? ActivityGlyph.failed.systemImage : column.systemImage }

  /// Row status in one or two words, and only when it says something. A Done
  /// row gets its mark and nothing else — the timestamp already tells that
  /// story, and a word on every resting row would be the loudest thing here.
  var label: String? {
    if failed { return "Failed" }
    switch column {
    case .needsYou: return column.label
    case .working: return column.label
    case .waiting: return waitingReason?.label ?? column.label
    case .done: return nil
    }
  }

  /// The word VoiceOver speaks, including for a Done row.
  var accessibilityLabel: String { label ?? column.label }
}

/// The board rule for a roster row, the Swift copy of `rosterBoardColumn` plus
/// the snooze overlay in `apps/ade-cli/src/services/push/attentionItemBuilder.ts`:
///
///   awaiting, failed                 → Needs you
///   snoozed (not failed or awaiting) → Waiting, reason snoozed
///   running, lane PR CI or review    → Waiting, reason ci / review
///   running                          → Working
///   idle, scheduled wake pending     → Waiting, reason scheduled
///   idle, ended                      → Done
func hubChatBoardState(
  _ chat: RemoteRosterChat,
  lane: RemoteRosterLane?,
  now: Date = Date()
) -> HubChatBoardState {
  if chat.status == .failed {
    return HubChatBoardState(column: .needsYou, failed: true, waitingReason: nil)
  }
  if chat.awaitingInput == true || chat.status == .awaiting {
    return HubChatBoardState(column: .needsYou, failed: false, waitingReason: nil)
  }
  if isSessionSnoozed(SessionSnoozeState(snoozedUntil: chat.snoozedUntil, snoozedAt: chat.snoozedAt)) {
    return HubChatBoardState(column: .waiting, failed: false, waitingReason: .snoozed)
  }
  switch chat.status {
  case .running:
    if let reason = ActivityWaitingReason(wireValue: lane?.prWaitingReason), reason != .snoozed {
      return HubChatBoardState(column: .waiting, failed: false, waitingReason: reason)
    }
    return HubChatBoardState(column: .working, failed: false, waitingReason: nil)
  case .idle where workScheduledWakeIsPending(chat.nextWakeAt, now: now):
    return HubChatBoardState(column: .waiting, failed: false, waitingReason: .scheduled)
  case .idle, .ended, .awaiting, .failed:
    return HubChatBoardState(column: .done, failed: false, waitingReason: nil)
  }
}

/// One state's mark at tree scale: the column glyph in the column hue, or the
/// red failure mark.
///
/// The fixed square is load-bearing rather than tidiness — the SF Symbols have
/// different intrinsic widths, and without it every row's title would start at
/// a different x depending on which state it happened to be in.
struct HubStateGlyph: View {
  let state: HubChatBoardState
  var size: CGFloat = 9

  var body: some View {
    Image(systemName: state.systemImage)
      .font(.system(size: size, weight: .semibold))
      .foregroundStyle(activityToneColor(state.tone))
      .frame(width: 12, height: 12)
      // The word travels on the row's own label — see `HubChatRow` — so the mark
      // is never the only carrier of a state VoiceOver cannot reach.
      .accessibilityHidden(true)
  }
}

/// One clause of a header summary: a state and how many rows are in it.
struct HubStateCount: Equatable, Identifiable {
  let column: ActivityBoardColumn
  let count: Int

  var id: String { column.rawValue }
}

/// Every nonzero clause of a tally, in board order — Done included and nothing
/// clipped, so the clauses always sum to the rows beneath the header. The
/// tree's headers are the only thing left saying how many rows a fold is
/// hiding, so a lane of quiet chats has to be able to say so.
func hubTreeStateCounts(_ tally: [ActivityBoardColumn: Int]) -> [HubStateCount] {
  ActivityBoardColumn.allCases.compactMap { column in
    let count = tally[column, default: 0]
    return count > 0 ? HubStateCount(column: column, count: count) : nil
  }
}

/// A header's state summary: glyph and count per state, read as one thing.
///
/// `accessibilityElement(children: .ignore)` plus a composed label is what makes
/// it one element. Left to itself VoiceOver walks the marks and the numbers as
/// separate stops, and the numbers are the only ones that speak — "2", "3", with
/// no state attached to either.
///
/// Kept as tight as the glyphs allow: a header can now carry a clause per state
/// rather than the two live ones, and the run between clauses is what pushes a
/// lane name into truncation on a phone.
struct HubStateSummary: View {
  let counts: [HubStateCount]

  @ViewBuilder
  var body: some View {
    if !counts.isEmpty {
      HStack(spacing: 6) {
        ForEach(counts) { entry in
          HStack(spacing: 2) {
            Image(systemName: entry.column.systemImage)
              .font(.system(size: 9, weight: .semibold))
            Text("\(entry.count)")
              .font(.system(.caption2, design: .rounded).weight(.semibold).monospacedDigit())
          }
          .foregroundStyle(activityToneColor(entry.column.tone))
        }
      }
      .lineLimit(1)
      .fixedSize()
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(hubStateSummaryLabel(counts))
    }
  }
}

/// "2 needs you, 3 working, 4 done" — the canonical words, never a second
/// phrasing of them. Count first, matching every other spoken tally in the app,
/// and every clause the summary draws including the resting ones: the tree's
/// headers no longer carry a spoken total behind them, so a clause left out here
/// is a row VoiceOver never hears about.
func hubStateSummaryLabel(_ counts: [HubStateCount]) -> String {
  counts
    .map { "\($0.count) \($0.column.label.lowercased())" }
    .joined(separator: ", ")
}

// MARK: - Hub roster filter

/// The Hub's five chips: All, then the four board columns. `all` is the
/// unfiltered tree and is not a state; the other four filter the live machine
/// roster client-side.
enum HubRosterFilter: String, CaseIterable, Identifiable, Hashable {
  case all
  case needsYou
  case working
  case waiting
  case done

  var id: String { rawValue }

  init(column: ActivityBoardColumn?) {
    switch column {
    case nil: self = .all
    case .needsYou: self = .needsYou
    case .working: self = .working
    case .waiting: self = .waiting
    case .done: self = .done
    }
  }

  /// The column this chip filters to, or nil for All.
  var column: ActivityBoardColumn? {
    switch self {
    case .all: return nil
    case .needsYou: return .needsYou
    case .working: return .working
    case .waiting: return .waiting
    case .done: return .done
    }
  }

  var title: String { column?.label ?? "All" }

  var accessibilityTitle: String { column?.label ?? "All agents" }

  /// The column glyphs. `all` is the one extra: a compact grid, not a state.
  var systemImage: String { column?.systemImage ?? "square.grid.2x2" }

  var tone: ActivityTone? { column?.tone }

  var emptyTitle: String {
    switch self {
    case .all: return "No chats yet"
    case .needsYou: return "Nothing needs you"
    case .working: return "Nothing working"
    case .waiting: return "Nothing waiting"
    case .done: return "Nothing done"
    }
  }

  var emptyMessage: String {
    switch self {
    case .all: return "Chats from every project on this machine show up here."
    case .needsYou: return "When an agent asks you something or fails, it shows up here."
    case .working: return "Chats that are running now show up here."
    case .waiting: return "Snoozed chats, and chats whose pull request waits on CI or a review, show up here."
    case .done: return "Finished and resting chats show up here."
    }
  }
}

func hubRosterFilterContains(_ column: ActivityBoardColumn, _ filter: HubRosterFilter) -> Bool {
  guard let filterColumn = filter.column else { return true }
  return column == filterColumn
}

func hubRosterFilterCount(
  _ presentations: [HubProjectPresentation],
  filter: HubRosterFilter
) -> Int {
  presentations.reduce(0) { partial, presentation in
    partial + presentation.lanes.reduce(0) { lanePartial, lane in
      lanePartial + lane.rows.reduce(0) { rowPartial, row in
        rowPartial + (hubRosterFilterContains(row.boardState.column, filter) ? 1 : 0)
      }
    }
  }
}

func hubProjectPresentation(
  _ presentation: HubProjectPresentation,
  matching filter: HubRosterFilter
) -> HubProjectPresentation? {
  if filter == .all { return presentation }
  let lanes = presentation.lanes.compactMap { lane -> HubLanePresentation? in
    let rows = lane.rows.compactMap { hubChatRow($0, lane: lane.lane, matching: filter) }
    guard !rows.isEmpty else { return nil }
    return HubLanePresentation(lane: lane.lane, rows: rows, totalCount: rows.count)
  }
  guard !lanes.isEmpty else { return nil }
  let chatCount = lanes.reduce(0) { $0 + $1.rows.count }
  return HubProjectPresentation(
    project: presentation.project,
    isActive: presentation.isActive,
    isSwitching: presentation.isSwitching,
    isLoading: presentation.isLoading,
    laneCount: lanes.count,
    chatCount: chatCount,
    lanes: lanes,
    attentionCount: hubLaneColumnCount(lanes, .needsYou),
    runningCount: hubLaneColumnCount(lanes, .working)
  )
}

/// Top-level rows in one column, for the project's sentence summary.
func hubLaneColumnCount(_ lanes: [HubLanePresentation], _ column: ActivityBoardColumn) -> Int {
  lanes.reduce(0) { partial, lane in
    partial + lane.rows.filter { $0.boardState.column == column }.count
  }
}

func hubChatRow(
  _ row: HubChatRowPresentation,
  lane: RemoteRosterLane?,
  matching filter: HubRosterFilter
) -> HubChatRowPresentation? {
  // Children are tally-only on Hub — they are not drawn — so a nested CLI
  // must not promote its parent into a column it is not in.
  guard hubRosterFilterContains(row.boardState.column, filter) else { return nil }
  return HubChatRowPresentation.make(chat: row.chat, lane: lane, childRows: [])
}
