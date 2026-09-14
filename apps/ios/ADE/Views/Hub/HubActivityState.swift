import SwiftUI

// MARK: - The canonical state vocabulary, in the tree
//
// The project → lane → chat tree used to speak its own dialect: a bare coloured
// dot for the row and the words "N need you · N working" for the header. Both
// were locally invented, so a reader who had learnt the six marks from the notch,
// the Activity sheet or the widget met a seventh vocabulary on the home screen.
// Everything below reads `ActivityStateGroup` instead — glyph, hue, word and
// order all come from that one table.

/// Which canonical state one roster row is in.
///
/// Precedence matches `ActivityPhaseVocabulary.stateGroup(for:)`: a raised hand
/// outranks a failure, because what the reader has to do is the fact worth
/// counting.
///
/// `planning` is unreachable here, and that is a gap in the DATA, not an
/// omission: planning is carried on the chat's interaction mode and the roster
/// projection does not send it. A hub row mid-plan reads `working` — the same
/// answer the shared table gives when `chatActivityMode` is absent.
func hubChatStateGroup(_ chat: RemoteRosterChat) -> ActivityStateGroup {
  let group = hubChatStateGroup(chat.normalizedStatusString)
  if group == .needsYou { return .needsYou }
  if chat.status == .failed { return .failed }
  // Snooze is a visibility overlay. A running-but-snoozed chat (ADE-121
  // until-asked) must not count as working on the hub tree, or the project
  // card's blue tally disagrees with the Activity sheet the user just hid.
  if isSessionSnoozed(SessionSnoozeState(snoozedUntil: chat.snoozedUntil, snoozedAt: chat.snoozedAt)) {
    return .idle
  }
  return group
}

/// The coarse-string entry point, for callers holding only
/// `normalizedStatusString`. Blind to failure by construction — that string
/// files `failed` under `ended` — so prefer the row overload above wherever the
/// chat itself is in hand.
func hubChatStateGroup(_ status: String) -> ActivityStateGroup {
  switch status {
  case "awaiting-input": return .needsYou
  case "active": return .working
  // Both `idle` and `ended` land on `idle`, never `done`. `done` means work that
  // finished and nobody has looked at it yet; this tree is mostly weeks-old
  // roster history, and turning all of it emerald is the exact failure the
  // canonical split of `idle` from `done` exists to prevent.
  default: return .idle
  }
}

/// Row status in one word, and only when it says something. A resting chat gets
/// its glyph and nothing else — the timestamp already tells that story, and the
/// tree is dense enough that a word per row would be the loudest thing on it.
func hubChatStateLabel(_ group: ActivityStateGroup) -> String? {
  group.isResting ? nil : group.label
}

func hubChatStatusLabel(_ status: String) -> String? {
  hubChatStateLabel(hubChatStateGroup(status))
}

/// One state's mark at tree scale: the canonical glyph in the canonical hue.
///
/// The fixed square is load-bearing rather than tidiness — the six SF Symbols
/// have different intrinsic widths, and without it every row's title would start
/// at a different x depending on which state it happened to be in.
struct HubStateGlyph: View {
  let group: ActivityStateGroup
  var size: CGFloat = 9

  var body: some View {
    Image(systemName: group.glyph.systemImage)
      .font(.system(size: size, weight: .semibold))
      .foregroundStyle(activityToneColor(group.tone))
      .frame(width: 12, height: 12)
      // The word travels on the row's own label — see `HubChatRow` — so the mark
      // is never the only carrier of a state VoiceOver cannot reach.
      .accessibilityHidden(true)
  }
}

/// One clause of a header summary: a state and how many rows are in it.
struct HubStateCount: Equatable, Identifiable {
  let group: ActivityStateGroup
  let count: Int

  var id: String { group.rawValue }
}

/// Every nonzero clause of a tally, in canonical `rank` order — resting bands
/// included and nothing clipped, so the clauses always sum to the rows beneath
/// the header.
///
/// The glance surfaces do the opposite: the island's compact pill and the notch
/// popover drop `idle` and `done`, because there "12 idle" would print on
/// everything and crowd out the one clause that matters. The tree's headers are
/// the summary of a list the reader is already looking at, and they are the only
/// thing left saying how many rows a fold is hiding, so a lane of quiet chats
/// has to be able to say so.
func hubTreeStateCounts(_ tally: [ActivityStateGroup: Int]) -> [HubStateCount] {
  tally
    .filter { $0.value > 0 }
    .map { HubStateCount(group: $0.key, count: $0.value) }
    .sorted { $0.group.rank < $1.group.rank }
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
            Image(systemName: entry.group.glyph.systemImage)
              .font(.system(size: 9, weight: .semibold))
            Text("\(entry.count)")
              .font(.system(.caption2, design: .rounded).weight(.semibold).monospacedDigit())
          }
          .foregroundStyle(activityToneColor(entry.group.tone))
        }
      }
      .lineLimit(1)
      .fixedSize()
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(hubStateSummaryLabel(counts))
    }
  }
}

/// "2 needs you, 3 working, 4 idle" — the canonical words, never a second
/// phrasing of them. Count first, matching every other spoken tally in the app,
/// and every clause the summary draws including the resting ones: the tree's
/// headers no longer carry a spoken total behind them, so a clause left out here
/// is a row VoiceOver never hears about.
func hubStateSummaryLabel(_ counts: [HubStateCount]) -> String {
  counts
    .map { "\($0.count) \($0.group.label.lowercased())" }
    .joined(separator: ", ")
}

// MARK: - Hub roster filter

/// The four glance cards on Hub. `all` is the unfiltered tree; the other three
/// are client-side filters over the live machine roster. Planning is not a
/// card — Hub rows never carry `chatActivityMode`, and the shared table already
/// files a missing mode as working.
enum HubRosterFilter: String, CaseIterable, Identifiable, Hashable {
  case all
  case working
  case needsYou
  case finished

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .working: return "Working"
    case .needsYou: return "Needs you"
    case .finished: return "Finished"
    }
  }

  var accessibilityTitle: String {
    switch self {
    case .all: return "All agents"
    case .working: return ActivityStateGroup.working.label
    case .needsYou: return ActivityStateGroup.needsYou.label
    case .finished: return "Finished"
    }
  }

  /// Same SF Symbols the notch, Activity sheet, and Hub rows already use.
  /// `all` is the one extra: a compact grid, not a fifth state glyph.
  var systemImage: String {
    switch self {
    case .all: return "square.grid.2x2"
    case .working: return ActivityStateGroup.working.glyph.systemImage
    case .needsYou: return ActivityStateGroup.needsYou.glyph.systemImage
    case .finished: return ActivityStateGroup.done.glyph.systemImage
    }
  }

  var tone: ActivityTone? {
    switch self {
    case .all: return nil
    case .working: return ActivityStateGroup.working.tone
    case .needsYou: return ActivityStateGroup.needsYou.tone
    case .finished: return ActivityStateGroup.done.tone
    }
  }

  var emptyTitle: String {
    switch self {
    case .all: return "No chats yet"
    case .working: return "Nothing working"
    case .needsYou: return "Nothing needs you"
    case .finished: return "Nothing finished"
    }
  }

  var emptyMessage: String {
    switch self {
    case .all: return "Chats from every project on this machine show up here."
    case .working: return "Live and planning chats from every project will land in this filter."
    case .needsYou: return "When an agent is waiting on you, it shows up here."
    case .finished: return "Done and failed chats from every project land here."
    }
  }
}

func hubRosterFilterContains(_ group: ActivityStateGroup, _ filter: HubRosterFilter) -> Bool {
  switch filter {
  case .all:
    return true
  case .working:
    return group == .working || group == .planning
  case .needsYou:
    return group == .needsYou
  case .finished:
    return group == .done || group == .failed
  }
}

func hubRosterFilterCount(
  _ presentations: [HubProjectPresentation],
  filter: HubRosterFilter
) -> Int {
  presentations.reduce(0) { partial, presentation in
    partial + presentation.lanes.reduce(0) { lanePartial, lane in
      lanePartial + lane.rows.reduce(0) { rowPartial, row in
        rowPartial + hubChatRowFilterCount(row, filter: filter)
      }
    }
  }
}

func hubChatRowFilterCount(_ row: HubChatRowPresentation, filter: HubRosterFilter) -> Int {
  let selfCount = hubRosterFilterContains(row.stateGroup, filter) ? 1 : 0
  return selfCount + row.childRows.reduce(0) { $0 + hubChatRowFilterCount($1, filter: filter) }
}

func hubProjectPresentation(
  _ presentation: HubProjectPresentation,
  matching filter: HubRosterFilter
) -> HubProjectPresentation? {
  if filter == .all { return presentation }
  let lanes = presentation.lanes.compactMap { lane -> HubLanePresentation? in
    let rows = lane.rows.compactMap { hubChatRow($0, matching: filter) }
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
    laneCount: presentation.laneCount,
    chatCount: chatCount,
    lanes: lanes,
    attentionCount: presentation.attentionCount,
    runningCount: presentation.runningCount
  )
}

func hubChatRow(
  _ row: HubChatRowPresentation,
  matching filter: HubRosterFilter
) -> HubChatRowPresentation? {
  let matchingChildren = row.childRows.compactMap { hubChatRow($0, matching: filter) }
  if hubRosterFilterContains(row.stateGroup, filter) {
    return HubChatRowPresentation.make(chat: row.chat, childRows: row.childRows)
  }
  guard !matchingChildren.isEmpty else { return nil }
  return HubChatRowPresentation.make(chat: row.chat, childRows: matchingChildren)
}

/// Backing out of a Hub chat should cancel a switch that has not committed
/// locally yet. A switch that already flipped `activeProjectId` is left alone
/// so the next tap in that project is cheap.
func hubChatShouldAbandonActivationOnDismiss(
  isSwitchingTargetProject: Bool,
  targetAlreadyActive: Bool
) -> Bool {
  isSwitchingTargetProject && !targetAlreadyActive
}
