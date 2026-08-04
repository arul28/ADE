import SwiftUI
import UIKit
import AVKit

// Owns the Work session row card: `WorkSessionRow` and its private layout/title/status
// leaf views, plus the preview-line helpers (`workSessionRowPreviewSource`,
// `workLinkifiedPreview`, `workPreviewLinkTokenRegex`) and the
// `WorkSessionRowRenderSignature` equality shim.
//
// Split out of `WorkRootComponents.swift`, which keeps the surrounding list chrome:
// filters/chips, the sidebar section header, the running banner, the
// `WorkSessionListRow` action shell (swipe + context menus), the child-shell section,
// provider logos, the lane PR indicator and `WorkTag`.

/// The compact second line shared by every native Work session row.
///
/// Keep this precedence identical to the desktop card:
/// explicit ask → agent note → sanitized last output → summary → goal.
/// Output intentionally wins over the older AI summary so a failed/missing
/// status-note write still leaves the user with the freshest truthful line.
///
/// Returns the provenance alongside the text, because whether a `#123` in the
/// line is a real reference depends entirely on who wrote it: only `ask` and
/// `note` are prose an agent aimed at the reader, so only those two linkify.
/// Terminal output, a rolled-up summary and a goal are machine-shaped text where
/// the same token is far more often a coincidence than a link. Mirrors the
/// desktop `SessionCard.tsx:174-179` split.
func workSessionRowPreviewSource(
  session: TerminalSessionSummary,
  chatSummary: AgentChatSessionSummary?,
  isSettled: Bool
) -> WorkSessionPreviewLine? {
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
    return WorkSessionPreviewLine(text: message, linkify: true, source: .ask)
  }
  if let note = inlineText(session.statusNote) {
    return WorkSessionPreviewLine(
      text: isSettled ? "Done: \(note)" : note,
      linkify: true,
      source: .note
    )
  }
  for rawOutput in [chatSummary?.lastOutputPreview, session.lastOutputPreview] {
    if let output = inlineText(rawOutput, terminalOutput: true), output != primaryText {
      return WorkSessionPreviewLine(text: output, linkify: false, source: .output)
    }
  }
  for rawSummary in [chatSummary?.summary, session.summary] {
    if let summary = inlineText(rawSummary), summary != primaryText {
      return WorkSessionPreviewLine(text: summary, linkify: false, source: .summary)
    }
  }
  for rawGoal in [chatSummary?.goal, session.goal] {
    if let goal = inlineText(rawGoal), goal != primaryText {
      return WorkSessionPreviewLine(text: goal, linkify: false, source: .goal)
    }
  }
  return nil
}

/// The two reference shapes ADE's own prose uses: `#123` is a pull request and
/// `ABC-123` is a Linear issue. Same pair the desktop card matches with
/// `PREVIEW_LINK_TOKEN` (`SessionCard.tsx:211-213`).
///
/// `\b` in front of the Linear shape is what keeps it from firing inside a
/// longer word — a boundary only exists where a non-word character precedes the
/// first capital, so `xABC-1` and `ABCDEFGH-1` are both left alone.
private let workPreviewLinkTokenRegex = try? NSRegularExpression(
  pattern: "#\\d+|\\b[A-Z]{2,6}-\\d+\\b"
)

/// Marks `#123` / `ABC-123` inside a preview line so they read as references
/// rather than as ordinary words swallowed by the italic muted run.
///
/// **These tokens are deliberately NOT tappable, and the styling is chosen to
/// say so.** Desktop makes them links because it has a pointer and a hover
/// state; on iOS the whole row is a `Button` whose label this text sits inside,
/// and a tappable range inside a `Button` label never receives the tap — SwiftUI
/// hands the gesture to the button. The documented fix is to demote the row from
/// a `Button` to `.contentShape(Rectangle())` plus a tap gesture, which is a
/// change to the primary open gesture of every Work row and cannot be proven
/// from reading alone. Rather than ship link affordances that silently do
/// nothing, the tokens get weight and a contrast step and nothing else: no
/// underline, no accent hue, no touch target. If the row is ever converted, the
/// routing already exists and needs no new callback chain —
/// `SyncService.shared?.requestedPrNavigation = PrNavigationRequest(prNumber:)`
/// and `requestedLinearIssueNavigation = LinearIssueNavigationRequest(identifier:)`,
/// exactly what `DeepLinkRouter` assigns (`:405-430`, `:602-612`).
func workLinkifiedPreview(_ text: String, linkify: Bool) -> AttributedString {
  guard linkify, let regex = workPreviewLinkTokenRegex else { return AttributedString(text) }
  let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
  guard !matches.isEmpty else { return AttributedString(text) }

  // Built by concatenation rather than by converting UTF-16 match offsets into
  // `AttributedString.Index` values: preview text is arbitrary agent prose, and
  // index arithmetic across those two representations traps on the emoji and
  // combining marks that prose actually contains.
  var result = AttributedString()
  var cursor = text.startIndex
  for match in matches {
    guard let range = Range(match.range, in: text), range.lowerBound >= cursor else { continue }
    result += AttributedString(String(text[cursor..<range.lowerBound]))
    var token = AttributedString(String(text[range]))
    // Weight first, hue second. A token has to be legible for a reader who
    // cannot separate it from the muted text by colour, so the difference is
    // carried by the run's weight and only reinforced by the contrast step.
    token.font = .caption2.italic().weight(.semibold)
    token.foregroundColor = ADEColor.textSecondary
    result += token
    cursor = range.upperBound
  }
  result += AttributedString(String(text[cursor...]))
  return result
}

private struct WorkSessionRowRenderSignature: Equatable {
  let sessionId: String
  let title: String
  let provider: String?
  let symbolProvider: String?
  let laneName: String
  let laneColor: String?
  /// The lane's glyph, which line 1 actually draws. Without it in the signature
  /// a lane icon changed from the manage sheet leaves every row of that lane
  /// wearing the old mark until some unrelated field moves.
  let laneIcon: LaneIcon?
  // Lane git state is captured ONLY on a `showsLaneIdentity` row — the one shape
  // that still draws it, because there is no lane header above it to own it
  // (a headerless singleton lane, or a cross-lane status/time section where each
  // row is a different lane anyway). Scoping it that way is what keeps the old
  // problem away: a lane-status poll used to invalidate every row of a lane
  // whether or not the row said anything about it. Only the three RENDERED
  // fields are held, so `rebaseInProgress` / `remoteBehind` churn invalidates
  // nothing.
  let laneDirty: Bool
  let laneAhead: Int
  let laneBehind: Int
  let activityTimestamp: String
  /// The whole preview line, not just its text: `linkify` and `source` are part
  /// of what gets rendered, so equality has to cover them or a note that becomes
  /// terminal output with identical text would keep its tappable ranges.
  let previewLine: WorkSessionPreviewLine?
  let pinned: Bool
  let pullRequestNumber: Int?
  let pullRequestState: String?
  let status: String
  let canonicalPhase: CanonicalSessionPhase
  /// The rendered capsule and dot, not just the phase behind them: the badge
  /// moves on its own when planning starts or stops, and the tone is what the
  /// dot is painted with. The WHOLE badge, because the compact row renders its
  /// label and tone — re-deriving it at body time would put a second, later
  /// clock outside the equality gate.
  let badge: SessionBadge?
  let rowTone: ActivityTone
  /// The status slot's rendered contents. The label is what the slot literally
  /// says — including a snooze's "wakes in 2h", which moves on its own while the
  /// phase behind it never changes — so the phase alone cannot stand in for it.
  ///
  /// `showsElapsed` is here; the elapsed VALUE deliberately is not. The ticker is
  /// rendered by a leaf `TimelineView` inside the slot, so a 1 Hz tick redraws
  /// one `Text` instead of invalidating every visible row.
  let statusLabel: String?
  let statusGlyph: ActivityGlyph?
  /// The slot's hue token, never a resolved `Color`: this signature is built on
  /// the detached presentation rebuild, and `ActivityTone` is a String-backed
  /// enum that crosses that boundary safely where a `Color` would not.
  let statusTone: ActivityTone?
  let showsElapsed: Bool
  /// Drives the recede rule. Non-prominent rows render at 70% so the few rows
  /// that want a human stand out with no banner at all.
  let isProminent: Bool
  let model: String?
  let showsLaneIdentity: Bool
  let settledAt: String?
  let statusNote: String?
  let attentionRequestedAt: String?
  let attentionMessage: String?
  let lastTurnFailedAt: String?
  let settleOverride: String?
  let snoozedUntil: String?
  // `snoozedAt` is the early-wake comparison baseline behind
  // `session.wokeMarker()`, which the row body renders. Without it a change
  // confined to that column leaves the stale woke marker on screen.
  let snoozedAt: String?
  let wokeAt: String?
  let wokeReason: String?
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
    compact: Bool,
    showsLaneIdentity: Bool
  ) {
    self.sessionId = session.id
    self.title = chatSummary?.title ?? session.title
    self.provider = chatSummary?.provider ?? session.toolType
    self.symbolProvider = chatSummary?.provider
    self.laneName = session.laneName
    self.laneColor = lane?.color
    self.laneIcon = lane?.icon
    // Under a lane header the header states the lane's git state once; capturing
    // it here too would put it back on every row and re-invalidate them all.
    //
    // `!compact` is the other half of that gate, and it is load-bearing rather
    // than belt-and-braces: a compact row has no line 1 at all, and child shells
    // are always compact WITH `showsLaneIdentity` left at its default true. On
    // `showsLaneIdentity` alone, a lane-status poll would invalidate every child
    // shell in the lane to redraw state none of them draws.
    let drawsLaneGitState = showsLaneIdentity && !compact
    self.laneDirty = drawsLaneGitState && lane?.status.dirty == true
    self.laneAhead = drawsLaneGitState ? (lane?.status.ahead ?? 0) : 0
    self.laneBehind = drawsLaneGitState ? (lane?.status.behind ?? 0) : 0
    self.activityTimestamp = workSessionActivityTimestamp(session: session, summary: chatSummary)
    // One derivation, one clock. The phase, the capsule, the dot hue and the
    // status slot all fall out of a single canonical state; reaching for the
    // thin wrappers instead meant four passes AND four `Date()` values per row
    // per rebuild, so two of them could land on opposite sides of a stale or
    // snooze boundary and the row would paint a capsule from one instant beside
    // a status slot from another.
    let now = Date()
    let row = workSessionRowPresentation(session: session, summary: chatSummary, now: now)
    self.previewLine = workSessionRowPreviewSource(
      session: session,
      chatSummary: chatSummary,
      isSettled: row.phase == .settled
    )
    self.pinned = session.pinned
    self.pullRequestNumber = pullRequest?.githubPrNumber
    self.pullRequestState = pullRequest.map { lanePrStateLabel($0.state) }
    self.status = status
    self.canonicalPhase = row.phase
    self.badge = row.badge
    self.rowTone = row.tone
    self.statusLabel = row.status?.label
    self.statusGlyph = row.status?.glyph
    self.showsElapsed = row.status?.showsElapsed ?? false
    // Settled resolves to a nil presentation, so it is not prominent and recedes.
    // That is the intent, not an oversight: the timestamp owns its slot.
    self.isProminent = row.status?.prominent ?? false
    self.statusTone = row.status?.tone
    self.model = chatSummary?.model
    self.showsLaneIdentity = showsLaneIdentity
    self.settledAt = session.settledAt
    self.statusNote = session.statusNote
    self.attentionRequestedAt = session.attentionRequestedAt
    self.attentionMessage = session.attentionMessage
    self.lastTurnFailedAt = session.lastTurnFailedAt
    self.settleOverride = session.settleOverride
    self.snoozedUntil = session.snoozedUntil
    self.snoozedAt = session.snoozedAt
    self.wokeAt = session.wokeAt
    self.wokeReason = session.wokeReason
    self.runtimeState = session.runtimeState
    self.pendingInputItemId = session.pendingInputItemId
    self.exitCode = session.exitCode
    self.isArchived = isArchived
    self.isMuted = isMuted
    self.isSelectedTransitionSource = isSelectedTransitionSource
    self.compact = compact
  }

  var previewText: String? { previewLine?.text }
  var previewLinkify: Bool { previewLine?.linkify ?? false }
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
  /// The singleton form: no lane header above this row, so the row shows the
  /// lane itself. Under a lane header the chip would just repeat the header.
  var showsLaneIdentity: Bool = true
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
    compact: Bool = false,
    showsLaneIdentity: Bool = true
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
    self.showsLaneIdentity = showsLaneIdentity
    self.renderSignature = WorkSessionRowRenderSignature(
      session: session,
      lane: lane,
      pullRequest: pullRequest,
      chatSummary: chatSummary,
      status: status,
      isArchived: isArchived,
      isMuted: isMuted,
      isSelectedTransitionSource: isSelectedTransitionSource,
      compact: compact,
      showsLaneIdentity: showsLaneIdentity
    )
  }

  static func == (lhs: WorkSessionRow, rhs: WorkSessionRow) -> Bool {
    lhs.renderSignature == rhs.renderSignature
  }

  var body: some View {
    if compact {
      compactBody
    } else {
      // The Dynamic Type branch lives in a leaf rather than in this view because
      // `WorkSessionRow` is rendered through `.equatable()`: an environment
      // dependency read here can be short-circuited by the equality check, while
      // a child that reads it owns the dependency itself and always re-evaluates.
      WorkSessionRowLayoutSwitch(
        standard: { standardBody },
        accessible: { accessibleBody }
      )
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
    // Neutral, like the standard card: the provider tint survives only on the
    // logo, which is the one place it is identity rather than state.
    .background(surfaceFill, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    .overlay {
      if isSelectedTransitionSource {
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .stroke(ADEColor.accent.opacity(0.38), lineWidth: 0.8)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
    .opacity(shouldRecede ? 0.7 : 1)
  }

  /// Three lines with fixed roles: line 1 is *where and what state*, line 2 is
  /// *what it is*, line 3 is *the latest word*. The line count is fixed on
  /// purpose — a column of rows whose shape is identical is scannable — but the
  /// HEIGHT deliberately is not, so Dynamic Type can grow it.
  private var standardBody: some View {
    sessionCardSurface {
      VStack(alignment: .leading, spacing: 3) {
        lineOne
        lineTwo
        lineThree
      }
    }
  }

  /// Leading chrome glyphs, the lane and its git state (headerless rows only),
  /// the floor, then the one status slot hard against the trailing edge.
  ///
  /// **Layout contract.** Exactly two children claim width: the lane chip when
  /// it is present, and the floor label's flexible frame. Everything else —
  /// including the status slot — is `.fixedSize()`, and an inflexible child is
  /// sized before a flexible one. THAT is what guarantees the invariant that
  /// matters: the status slot never truncates, never drops, and never degrades
  /// to a glyph. (Note the floor label is `.fixedSize()` AND flexible-framed: it
  /// takes its ideal width and the frame only holds the remaining space open, so
  /// it pushes the slot to the trailing edge without ever competing for it.)
  ///
  /// Do not "fix" this by adding `layoutPriority` to the lane chip: a
  /// higher-priority child is offered the entire remaining width first, which
  /// would let a long lane name starve the status word. Do not reach for
  /// `ViewThatFits` either — a candidate containing a `Spacer` reports an ideal
  /// width that always fits, so the ladder would never advance past its first
  /// rung.
  private var lineOne: some View {
    HStack(spacing: 5) {
      if session.pinned {
        // Muted, matching desktop: pinning is an ordering fact, not a state, and
        // accent belongs to interaction.
        Image(systemName: "pin.fill")
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize()
      }
      if isMuted {
        Image(systemName: "bell.slash")
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize()
      }
      if showsLaneIdentity {
        laneChip
        laneGitState
      }
      // Always rendered, even when empty: its flexible frame is what holds the
      // status slot against the trailing edge. `.lineLimit` / `.truncationMode`
      // are deliberately absent — `.fixedSize()` gives this label its ideal
      // width, so there is nothing left for them to do.
      Text(rowFloorLabel)
        .font(.caption2.monospacedDigit())
        .foregroundStyle(ADEColor.textMuted)
        .fixedSize()
        .frame(maxWidth: .infinity, alignment: .leading)
      Spacer(minLength: 4)
      statusSlot(wraps: false)
    }
  }

  private var lineTwo: some View {
    HStack(spacing: 6) {
      titleView(lineLimit: 1)

      // Only on a headerless row. Under a lane header the PR already sits on the
      // header, so rendering it per row prints the same "#14 Open" down the
      // whole section.
      if showsLaneIdentity, let pullRequest {
        WorkLanePrIndicator(tag: pullRequest)
          .fixedSize()
      }
    }
  }

  private var lineThree: some View {
    HStack(spacing: 6) {
      if renderSignature.previewText != nil {
        previewView(lineLimit: 1)
      } else {
        Spacer()
      }

      if isPendingSyncCreation {
        HStack(spacing: 3) {
          Image(systemName: "clock.arrow.circlepath")
            .font(.caption2)
          Text("Pending sync")
            .font(.caption2.weight(.semibold))
        }
        .foregroundStyle(ADEColor.textMuted)
        .fixedSize()
      } else if isArchived {
        // Neutral, not amber. Archived is true but not actionable, and amber is
        // spent exclusively on "your move" — an amber chip here would compete
        // with the one status word that is allowed to claim a human.
        Text("ARCHIVED")
          .font(.caption2.monospaced().weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize()
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "work-status-\(session.id)" : nil, in: transitionNamespace)
      }

      if let exitCode = failedExitCode {
        Text("EXIT \(exitCode)")
          .font(.caption2.monospaced().weight(.semibold))
          .foregroundStyle(ADEColor.danger)
          .fixedSize()
      }

      // The branded mark, and only the mark. The provider's NAME used to sit on
      // this same line next to it, restating in words what the logo already says
      // — and between them, the model label and the lane chip, they left the
      // preview truncating mid-word.
      WorkProviderBareLogo(
        provider: chatSummary?.provider ?? session.toolType,
        fallbackSymbol: sessionSymbol(session, provider: chatSummary?.provider),
        tint: providerTintColor,
        size: 18
      )
      .opacity(0.75)
      .fixedSize()
      .adeMatchedGeometry(id: isSelectedTransitionSource ? "work-icon-\(session.id)" : nil, in: transitionNamespace)
    }
  }

  /// At accessibility sizes every element wants the full width, so competing for
  /// one line stops being honest. The row stacks instead: status first (it is
  /// what should be read first), then the title and preview at up to two lines,
  /// then the lane. The pin/mute glyphs and the EXIT chip leave the VISUAL row —
  /// they never leave `accessibilityLabel`, which is built from the raw session,
  /// not from what was rendered.
  private var accessibleBody: some View {
    sessionCardSurface {
      VStack(alignment: .leading, spacing: 6) {
        statusSlot(wraps: true)

        titleView(lineLimit: 2)

        if renderSignature.previewText != nil {
          previewView(lineLimit: 2)
        }

        if showsLaneIdentity {
          laneChip
          laneGitState
          if let pullRequest {
            WorkLanePrIndicator(tag: pullRequest)
          }
        }
      }
    }
  }

  /// Interaction owns the surface. Background, border and shadow are reserved
  /// for selection and press; state never spends them.
  ///
  /// This card used to paint its whole body in the provider's brand hue
  /// (`providerTintColor.opacity(0.12)` fill, a 0.25 stroke), and `providerTint`
  /// maps Claude to amber — so every Claude row was already amber, and the amber
  /// "Needs you" badge that is supposed to mean *your move* stopped registering.
  /// Status now lives in exactly one place: the right-anchored slot on line 1.
  private func sessionCardSurface<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    content()
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(surfaceFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay {
        if isSelectedTransitionSource {
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(ADEColor.accent.opacity(0.38), lineWidth: 1)
        }
      }
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
      // Last modifier, so it dims the finished card whole. Settled resolves to a
      // nil status presentation and therefore recedes — intended, not an
      // oversight: filed work should sit back.
      .opacity(shouldRecede ? 0.7 : 1)
  }

  private var surfaceFill: Color {
    isSelectedTransitionSource
      ? ADEColor.accent.opacity(0.12)
      : ADEColor.surfaceBackground.opacity(0.6)
  }

  /// Non-prominent states recede to 70%, which is how the few rows that want a
  /// human stand out with no banner anywhere on screen.
  private var shouldRecede: Bool { !renderSignature.isProminent }

  /// The lane, stated once and only where nothing above the row states it.
  ///
  /// Tail truncation, never middle. Middle truncation at a negative layout
  /// priority turned a lane called "Ok Needs Closing Issue" into
  /// "Ok Need…osing Issue" — a name mangled into something the eye parses as a
  /// status string. The lane-coloured dot that sat beside it is gone for the same
  /// reason: a coloured dot on a row that also carries state reads as state.
  private var laneChip: some View {
    HStack(spacing: 3) {
      WorkLaneLogoMark(color: laneTint, laneIcon: renderSignature.laneIcon, size: 11)
      Text(renderSignature.laneName)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(laneTint)
        .lineLimit(1)
        .truncationMode(.tail)
    }
  }

  /// Dirty / ahead / behind for the lane, on `showsLaneIdentity` rows only.
  ///
  /// A LANE header owns this fact wherever there is one — stating it once per
  /// lane instead of identically on every row of it is the whole point of moving
  /// it there. But a lane with exactly one top-level session renders a
  /// headerless `Section`, which is the common shape, and a status/time section
  /// spans lanes so its header cannot speak for any of them. In both cases the
  /// state would otherwise be unreachable anywhere in the Work tab. `laneChip`
  /// is rendered under exactly the same condition, so the two travel together
  /// and this can never print on every row of a lane again.
  ///
  /// Muted and `.fixedSize()`: this is context, not a call to action, and line 1
  /// still owes its elastic width to the floor label alone. Nothing is drawn
  /// when the worktree is clean and level — an always-present "0 ahead, 0
  /// behind" would be chrome. Colour never carries the meaning: the dot is
  /// accompanied by the arrow counts, and VoiceOver gets the words.
  @ViewBuilder
  private var laneGitState: some View {
    if laneGitStateIsNoteworthy {
      HStack(spacing: 5) {
        if renderSignature.laneDirty {
          Circle()
            .fill(ADEColor.warning.opacity(0.85))
            .frame(width: 5, height: 5)
        }
        if renderSignature.laneAhead > 0 {
          laneGitCountChip(symbol: "arrow.up", count: renderSignature.laneAhead)
        }
        if renderSignature.laneBehind > 0 {
          laneGitCountChip(symbol: "arrow.down", count: renderSignature.laneBehind)
        }
      }
      .foregroundStyle(ADEColor.textMuted)
      .fixedSize()
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(laneGitStateAccessibilityLabel)
    }
  }

  private var laneGitStateIsNoteworthy: Bool {
    renderSignature.laneDirty || renderSignature.laneAhead > 0 || renderSignature.laneBehind > 0
  }

  private func laneGitCountChip(symbol: String, count: Int) -> some View {
    HStack(spacing: 1) {
      Image(systemName: symbol)
        // Sized off the caption text style rather than a fixed point size, so
        // the arrow grows with the count beside it under Dynamic Type.
        .font(.caption2.weight(.bold))
      Text("\(count)")
        .font(.caption2.monospacedDigit())
    }
  }

  private var laneGitStateAccessibilityLabel: String {
    var parts: [String] = []
    if renderSignature.laneDirty { parts.append("uncommitted changes") }
    if renderSignature.laneAhead > 0 { parts.append("\(renderSignature.laneAhead) ahead") }
    if renderSignature.laneBehind > 0 { parts.append("\(renderSignature.laneBehind) behind") }
    return parts.joined(separator: ", ")
  }

  private var laneTint: Color {
    LaneColorPalette.color(forHex: lane?.color) ?? ADEColor.textSecondary
  }

  /// Whether a title changing under the reader deserves the flash.
  ///
  /// The flash exists to explain a name that moved on its own — the agent's
  /// generated title replacing the seed. A person who just renamed their own
  /// chat needs no explanation, so a manual name suppresses it.
  ///
  /// Deliberately absent from `WorkSessionRowRenderSignature`: it changes only
  /// alongside a rename, which moves `title` and reopens the gate anyway, and a
  /// change confined to this flag has nothing to redraw.
  /// Only the session row carries the flag — `AgentChatSessionSummary` has no
  /// `manuallyNamed`, so there is nothing to fall back to.
  private var flashesOnRename: Bool {
    session.manuallyNamed != true
  }

  /// Line 1 is never allowed to be empty — an empty leading edge reads as a
  /// half-loaded row. The model comes first because on a phone it is the only
  /// thing that distinguishes two rows on the same provider; the compact
  /// timestamp is the fallback.
  private var rowFloorLabel: String {
    let model = shortModelLabel(renderSignature.model)
    if !model.isEmpty { return model }
    // With no status word the slot itself renders the timestamp, so repeating it
    // here would print the same "12m" twice on one line.
    if renderSignature.statusLabel == nil { return "" }
    return relativeTimestampCompact(renderSignature.activityTimestamp)
  }

  /// The row's ONE status slot. When there is no status word — settled, and only
  /// settled — the slot renders the compact timestamp instead, which is the same
  /// contract as desktop's `SessionStatusSlot` timestamp fallback: down in the
  /// quiet tail the section is the status, and "when" is the only thing left
  /// worth reading.
  @ViewBuilder
  private func statusSlot(wraps: Bool) -> some View {
    if let label = renderSignature.statusLabel, let tone = renderSignature.statusTone {
      WorkSessionRowStatusSlot(
        label: label,
        tone: tone,
        glyph: renderSignature.statusGlyph,
        showsElapsed: renderSignature.showsElapsed,
        elapsedSince: renderSignature.showsElapsed
          ? workParsedDate(renderSignature.activityTimestamp)
          : nil,
        wraps: wraps,
        // The slot pulses once when this flips true underneath a reader who is
        // already looking at the row. Passing the phase rather than a trigger
        // keeps the decision in the leaf, which is the only view that knows
        // whether it was on screen for the transition.
        needsYou: renderSignature.canonicalPhase == .needsYou
      )
    } else {
      HStack(spacing: 4) {
        if isSettled {
          // Hollow, not filled: settled work is put away, and the ring says that
          // without spending a solid dot on it. Same treatment as before — it has
          // only moved from line 2 into the slot it belongs in.
          Circle()
            .strokeBorder(rowTint.opacity(0.7), lineWidth: 1)
            .frame(width: 6, height: 6)
        }
        Text(relativeTimestampCompact(renderSignature.activityTimestamp))
          .font(.caption2.monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
      .fixedSize(horizontal: !wraps, vertical: false)
    }
  }

  /// The title, shared by both bodies. Only the line limit differs between them
  /// — the accent, the rename flash and the matched-geometry id are the same
  /// facts at every type size, and a second copy of them is how a transition id
  /// quietly stops matching on one branch only.
  private func titleView(lineLimit: Int) -> some View {
    WorkSessionRowTitle(
      title: chatSummary?.title ?? session.title,
      accent: laneTint,
      flashesOnRename: flashesOnRename,
      lineLimit: lineLimit
    )
    .adeMatchedGeometry(id: isSelectedTransitionSource ? "work-title-\(session.id)" : nil, in: transitionNamespace)
  }

  /// The italic line-3 preview. Same reason as `titleView`: one place decides
  /// whether the preview linkifies, so the two bodies cannot drift on it.
  @ViewBuilder
  private func previewView(lineLimit: Int) -> some View {
    if let preview = renderSignature.previewText {
      Text(workLinkifiedPreview(preview, linkify: renderSignature.previewLinkify))
        .font(.caption2.italic())
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(lineLimit)
        .truncationMode(.tail)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  /// 0 is success, and 130 (SIGINT) / 143 (SIGTERM) are how a person or ADE stops
  /// a runtime on purpose. Painting those red would make every deliberate stop
  /// look like a crash.
  private var failedExitCode: Int? {
    guard let code = renderSignature.exitCode, ![0, 130, 143].contains(code) else { return nil }
    return code
  }

  var providerTintColor: Color {
    providerTint(chatSummary?.provider ?? session.toolType)
  }

  /// The row's status capsule, in the full shared vocabulary — needs you,
  /// failed, stale, working, planning, done. Nil for the resting states, so the
  /// row never shifts layout to say that nothing is happening.
  ///
  /// Read from the signature, never re-derived. The signature is built on the
  /// detached presentation rebuild; deriving the same fact again here would run
  /// it on a LATER clock and outside the equality gate, so a row could show a
  /// capsule and a status slot that disagree across a stale boundary.
  var capsuleBadge: SessionBadge? { renderSignature.badge }

  /// Same rule as `capsuleBadge`: the phase the row was BUILT with, not a fresh
  /// one, so the settled ring and the status slot cannot disagree.
  var isSettled: Bool { renderSignature.canonicalPhase == .settled }

  var isPendingSyncCreation: Bool {
    workIsPendingChatCreationSession(session)
  }

  /// The phase hue, read through the shared tone table rather than the coarse
  /// four-value status string. Now spent on exactly one mark — the settled
  /// hollow ring in the status slot — since the row no longer carries a separate
  /// status dot that could tell a different story from the status word.
  var rowTint: Color {
    if isPendingSyncCreation { return ADEColor.textMuted }
    if isArchived { return ADEColor.warning }
    return activityToneColor(renderSignature.rowTone)
  }

  /// Built from the raw session, never from what was rendered.
  ///
  /// That distinction is load-bearing now that the row sheds chrome under
  /// Dynamic Type and hides the lane chip and the PR under a section header: a
  /// fact that leaves the VISUAL row must not leave VoiceOver with it. Every
  /// clause below reads a model field, not a view.
  var accessibilityLabel: String {
    var parts = [chatSummary?.title ?? session.title, session.laneName, sessionStatusLabel(for: status)]
    if let statusLabel = renderSignature.statusLabel {
      parts.append(statusLabel)
    }
    if let model = renderSignature.model, !model.isEmpty {
      parts.append(shortModelLabel(model))
    }
    if let pullRequest {
      parts.append("pull request #\(pullRequest.githubPrNumber), \(lanePrStateLabel(pullRequest.state))")
    }
    if let exitCode = failedExitCode {
      parts.append("exited with code \(exitCode)")
    }
    if session.pinned {
      parts.append("pinned")
    }
    if isMuted {
      parts.append("notifications muted")
    }
    if isArchived {
      parts.append("archived")
    }
    // The card combines its children and then overrides the label, so the git
    // chips' own label never reaches VoiceOver — it has to be stated here or the
    // dot would be colour-only meaning. Headerless rows only, matching what is
    // drawn: under a header the header says it.
    if showsLaneIdentity && laneGitStateIsNoteworthy {
      parts.append(laneGitStateAccessibilityLabel)
    }
    if isSettled {
      parts.append("settled")
    }
    // Snooze and woke are NOT appended here. The status slot already speaks for
    // both — `workSessionStatusSlot` puts "wakes in 30m" or "Woke" in the slot
    // ahead of the phase — so `statusLabel` above is that sentence. Saying it
    // again read as "wakes in 30m, snoozed wakes in 30m" to VoiceOver, and it was
    // a third derivation of the same fact on a third clock.
    return parts.joined(separator: ", ")
  }
}

/// Picks the session row's layout for the current Dynamic Type size.
///
/// A leaf rather than an `@Environment` read on `WorkSessionRow` itself: that row
/// is rendered through `.equatable()`, so an environment dependency declared up
/// there can be short-circuited by the equality check. Declared here, the
/// dependency belongs to a view whose body always re-evaluates when the trait
/// changes.
private struct WorkSessionRowLayoutSwitch<Standard: View, Accessible: View>: View {
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  let standard: () -> Standard
  let accessible: () -> Accessible

  init(
    @ViewBuilder standard: @escaping () -> Standard,
    @ViewBuilder accessible: @escaping () -> Accessible
  ) {
    self.standard = standard
    self.accessible = accessible
  }

  var body: some View {
    if dynamicTypeSize >= .accessibility1 {
      accessible()
    } else {
      standard()
    }
  }
}

/// The row's title, plus the one moment it needs to explain itself.
///
/// A chat is created with a seed name and renamed later by the agent that ran
/// it, so a reader watching the list sees a row's name change with no input of
/// their own. Desktop answers that by flashing the title's background in the
/// lane accent for about 900ms (`SessionCard.tsx:906-920`) — long enough to draw
/// the eye to what moved, short enough to leave nothing behind.
///
/// A leaf for the same reason the status slot is one: `WorkSessionRow` renders
/// through `.equatable()`, so the reduce-motion environment read and the
/// transient flash state both belong to a view that always re-evaluates rather
/// than to one whose body can be short-circuited. The `@State` survives across
/// updates because rows carry `.id(session.id)`, so SwiftUI keeps this view's
/// identity as long as the session stays in the list.
private struct WorkSessionRowTitle: View {
  let title: String
  /// The lane accent. The flash is the one place a lane hue touches the card
  /// body, and it is gone in under a second.
  let accent: Color
  /// False when the user named this chat themselves — see `flashesOnRename`.
  let flashesOnRename: Bool
  var lineLimit: Int = 1

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var flashing = false

  var body: some View {
    Text(title)
      .font(.subheadline.weight(.semibold))
      .foregroundStyle(ADEColor.textPrimary)
      .lineLimit(lineLimit)
      .truncationMode(.tail)
      // Before the flexible frame, so the flash hugs the words instead of
      // painting the full row width behind a short title. A background never
      // participates in layout, so nothing here can move the card.
      .background {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
          .fill(accent.opacity(flashing ? 0.3 : 0))
          .padding(.horizontal, -4)
          .padding(.vertical, -2)
          .allowsHitTesting(false)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .onChange(of: title) { _, _ in
        // Reduce motion takes the whole thing, not a shortened version of it:
        // there is no cross-fade and no flash, just the new title. A brief
        // colour wash IS the animation here, so softening it would still be one.
        guard flashesOnRename, !reduceMotion else { return }
        // Unanimated on, animated off. The wash should already be there when the
        // new title lands — fading it in would draw the eye after the change it
        // is supposed to announce.
        flashing = true
        withAnimation(ADEMotion.standard(reduceMotion: reduceMotion).delay(0.3)) {
          flashing = false
        }
      }
  }
}

/// The Work row's one status slot.
///
/// A separate leaf view for exactly one reason: the elapsed ticker.
/// `TimelineView(.periodic(by: 1))` re-evaluates only its own body, so a running
/// row redraws a single `Text` each second instead of invalidating every visible
/// row — which is why the elapsed VALUE is deliberately absent from
/// `WorkSessionRowRenderSignature` while `showsElapsed` is present.
private struct WorkSessionRowStatusSlot: View {
  let label: String
  let tone: ActivityTone
  let glyph: ActivityGlyph?
  let showsElapsed: Bool
  /// **Divergence, stated so nobody hunts for a bug.** iOS's
  /// `TerminalSessionSummary` carries no `currentTurnStartedAt`, so the ticker
  /// anchors on the row's activity timestamp: it measures time since last
  /// activity, where desktop's `SessionStatusSlot` measures time since the turn
  /// started. On a live turn the two agree closely; on a quiet one this reads
  /// larger.
  let elapsedSince: Date?
  /// Accessibility sizes let the slot wrap instead of holding one line.
  var wraps: Bool = false
  /// The row is asking for a human right now. Only a TRANSITION into this state
  /// pulses; the steady state does nothing.
  var needsYou: Bool = false

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var pulsing = false

  var body: some View {
    HStack(spacing: 3) {
      if let glyph {
        // Sized via the text style, not a point size, so the mark scales with
        // the label it sits beside.
        Image(systemName: glyph.systemImage)
          .font(.caption2.weight(.semibold))
      }
      if showsElapsed, let elapsedSince {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          Text(tickerLabel(since: elapsedSince, now: context.date))
            .font(.caption2.weight(.semibold).monospacedDigit())
        }
      } else {
        Text(label)
          .font(.caption2.weight(.semibold))
      }
    }
    .foregroundStyle(activityToneColor(tone))
    .lineLimit(wraps ? 2 : 1)
    // The slot never truncates, never drops and never degrades to a glyph-only
    // form: the word IS the deliverable, and the glyph set is deliberately
    // partial (snoozed and woke have no `ActivityGlyph` at all). The only
    // permitted compression is omitting the elapsed ticker.
    .fixedSize(horizontal: !wraps, vertical: false)
    // `scaleEffect` and not a size or padding change: it is drawn, not laid out,
    // so a pulsing row cannot nudge line 1's width and re-truncate the lane name
    // beside it.
    .scaleEffect(pulsing ? 1.12 : 1)
    .onChange(of: needsYou) { wasNeedsYou, isNeedsYou in
      // ONE pulse, on the way in only. `onChange` never fires on first
      // appearance, which is the whole reason the trigger lives here instead of
      // in an `onAppear` comparison: a row scrolled into view already in
      // needs-you is not news, it is just the list.
      //
      // A row arriving from settled misses this, because settled resolves to a
      // nil presentation and renders the timestamp branch instead — the slot is
      // constructed fresh and has no previous value to differ from. Accepted:
      // the alternative is a trigger in the parent, which would put transient
      // animation state behind the row's equality gate.
      guard isNeedsYou, !wasNeedsYou, !reduceMotion else { return }
      // `emphasis`, never `ADEMotion.pulse` — that one is `repeatForever` and
      // would leave the row breathing for as long as it is on screen.
      withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) { pulsing = true }
      withAnimation(ADEMotion.quick(reduceMotion: reduceMotion).delay(0.22)) { pulsing = false }
    }
  }

  private func tickerLabel(since: Date, now: Date) -> String {
    guard let elapsed = ActivityRowPresentation.formatDuration(now.timeIntervalSince(since)) else {
      return label
    }
    return "\(label) \(elapsed)"
  }
}
