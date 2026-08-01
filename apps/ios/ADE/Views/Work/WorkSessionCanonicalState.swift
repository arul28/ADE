import SwiftUI

/// The ONE vocabulary for "what state is this session in", mirrored from the
/// desktop `apps/desktop/src/shared/sessionCanonicalState.ts` so a session's
/// Work-row capsule, its Live Activity phase, and any push notification always
/// tell the same story. This is a VIEW-layer vocabulary: the existing awaiting
/// derivation in `SyncService`/`normalizedWorkChatSessionStatus` is untouched.
///
/// Mapping to the Live Activity wire phases (names unchanged on the push side):
///   needs_you  ⇔ waiting_for_approval | waiting_for_input
///   failed     ⇔ failed
///   stale      ⇔ stale
///   starting/running ⇔ starting/running
///   ready/idle/stopped/ended/settled have no LA row (terminal or chat-resting
///   states).
enum CanonicalSessionPhase: Equatable {
  case starting
  case running
  case needsYou
  case failed
  case stale
  case ready
  case idle
  case stopped
  case ended
  case settled
}

/// The states that earn a capsule on a Work row.
///
/// The first three are the attention states — the only ones `badge` has ever
/// carried, and the only ones that survive on the `CanonicalSessionState` value
/// so nothing downstream starts treating "Working" as something to act on. The
/// rest are the descriptive half of the vocabulary, reached through
/// `workSessionStatusBadge`, which is what the row actually renders.
///
/// The truly resting phases (ready / idle / stopped / ended) still earn no
/// capsule: their story is the neutral dot and the timestamp, and a row must not
/// shift layout to say "nothing is happening".
enum SessionBadgeKind: Equatable {
  case needsYou
  case failed
  case stale
  case working
  case planning
  case done
}

struct SessionBadge: Equatable {
  let kind: SessionBadgeKind
  /// Short capsule copy; resting states get no badge at all.
  let label: String
  /// Hue token from the shared `ActivityPhaseVocabulary`, so a Work row and an
  /// Activity row describing the same session cannot pick different colours.
  let tone: ActivityTone
  let glyph: ActivityGlyph?

  init(kind: SessionBadgeKind, label: String, tone: ActivityTone, glyph: ActivityGlyph? = nil) {
    self.kind = kind
    self.label = label
    self.tone = tone
    self.glyph = glyph
  }
}

struct CanonicalSessionState: Equatable {
  let phase: CanonicalSessionPhase
  /// Non-nil ONLY for attention states — capsules never render for calm ones.
  let badge: SessionBadge?
}

/// A session still marked running that has produced no output for this long is
/// "stale" — running but silent. Distinct from the push relay's APNs TTLs and
/// the Live Activity 10-minute lock-screen dimming: this is the human-facing
/// "is anything actually happening" bar. Exactly mirrors the desktop
/// `SESSION_STALE_AFTER_MS` (3 hours); do not reuse other stale semantics
/// (e.g. the 7-day chat reclassification in `normalizedWorkChatSessionStatus`).
let sessionStaleAfterSeconds: TimeInterval = 3 * 60 * 60

/// The attention badges, worded and hued by the shared vocabulary rather than
/// by a second table that could drift away from it.
private let badgeByKind: [SessionBadgeKind: SessionBadge] = [
  .needsYou: workSessionBadge(kind: .needsYou, phase: .needsYou),
  .failed: workSessionBadge(kind: .failed, phase: .failed),
  .stale: workSessionBadge(kind: .stale, phase: .stale),
]

private func workSessionBadge(kind: SessionBadgeKind, phase: AccountAttentionPhase) -> SessionBadge {
  let presentation = ActivityPhaseVocabulary.presentation(for: phase)
  return SessionBadge(
    kind: kind,
    label: presentation.label,
    tone: presentation.tone,
    glyph: presentation.glyph
  )
}

private func isSilentPast(_ lastActivityAt: String?, now: Date, thresholdSeconds: TimeInterval) -> Bool {
  guard let at = workParsedDate(lastActivityAt) else { return false }
  return now.timeIntervalSince(at) >= thresholdSeconds
}

/// Whether a tool type is a chat provider (vs a raw terminal/CLI session).
/// Mirrors desktop `isChatToolType` — explicit chat tools plus `*-chat`
/// providers. `isChatSession(_:)` delegates here so both agree.
func isWorkChatToolType(_ toolType: String?) -> Bool {
  let raw = toolType?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased() ?? ""
  guard !raw.isEmpty else { return false }
  if raw == "codex-chat" || raw == "claude-chat" || raw == "opencode-chat" || raw == "cursor" {
    return true
  }
  return raw.hasSuffix("-chat")
}

/// The tri-state settle override persisted on `terminal_sessions.settle_override`.
/// Mirrors the desktop `SessionSettleOverride`. Consulted at the declared-settle
/// tier.
enum SessionSettleOverride: String, Equatable {
  /// Behaves exactly like a declared settle, without a `settled_at` stamp.
  case settled
  /// Explicit keep-active pin: suppresses a declared settle.
  case active

  /// Tolerant parse of the persisted column — unknown/blank values mean "no
  /// override" rather than crashing or inventing a state.
  init?(persisted: String?) {
    let raw = persisted?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    guard !raw.isEmpty, let parsed = SessionSettleOverride(rawValue: raw) else { return nil }
    self = parsed
  }
}

/// Canonical precedence (highest first), identical to the desktop module:
///   1. explicit/structured needs-input — pending item or an explicit
///      attention request (never outvoted by anything below),
///   2. settled — explicitly declared, or forced by a "settled" override; an
///      "active" override suppresses this tier entirely,
///   3. ended branch — stopped, failed, chat ready/ended,
///   4. running-chat turn failure,
///   5. stale — status running but silent ≥ `sessionStaleAfterSeconds`,
///   6. idle — ready(chat)/idle,
///   7. running.
///
/// Snooze is deliberately absent: it is a visibility overlay and never changes
/// the phase. See `isSessionSnoozed(_:now:)`.
func workCanonicalSessionState(
  status: String,
  runtimeState: String? = nil,
  toolType: String? = nil,
  pendingInputItemId: String? = nil,
  providerStructuredInput: Bool = false,
  lastOutputPreview: String? = nil,
  lastActivityAt: String? = nil,
  exitCode: Int? = nil,
  settledAt: String? = nil,
  settleOverride: String? = nil,
  attentionRequestedAt: String? = nil,
  lastTurnFailedAt: String? = nil,
  now: Date = Date(),
  isChatTool: (String?) -> Bool = isWorkChatToolType
) -> CanonicalSessionState {
  let chat = isChatTool(toolType)
  let statusLower = status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let runtimeLower = runtimeState?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let pending = pendingInputItemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let attentionRequested = attentionRequestedAt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let settled = settledAt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let lastTurnFailed = lastTurnFailedAt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let override = SessionSettleOverride(persisted: settleOverride)

  // 1. Deterministic attention beats everything — including the failure and
  // stale checks below (an agent explicitly asking is actionable regardless).
  // An escalated ask outranks BOTH override values.
  if !pending.isEmpty || providerStructuredInput || !attentionRequested.isEmpty {
    return CanonicalSessionState(phase: .needsYou, badge: badgeByKind[.needsYou])
  }

  // 2. Declared settle (or a "settled" override) — honored only AT REST,
  // mirroring desktop: a settled chat woken by scheduled work shows green while
  // the turn streams, then re-settles at idle (settledAt survives background
  // wakes; only user activity clears it).
  //
  // An "active" override suppresses a stale declared settle.
  let pinnedActive = override == .active
  let atRest = statusLower != "running" || runtimeLower == "idle"
  if !pinnedActive && atRest && (override == .settled || !settled.isEmpty) {
    return CanonicalSessionState(phase: .settled, badge: nil)
  }

  let ended = statusLower != "running"
  if ended {
    // 3. Stopped: an explicitly disposed PTY is resumable/closed, not a task
    // failure. Check before exit/runtime failures because disposed sessions are
    // currently persisted with runtimeState "killed" and often exitCode 130.
    if statusLower == "disposed" {
      return CanonicalSessionState(phase: .stopped, badge: nil)
    }

    // Failure: a non-clean exit, an explicit "failed" persisted status
    // (spawn/setup failures that die before an exit code), or a killed runtime
    // — all deterministic "failed" signals a terminal-backed session reports.
    if let exitCode, exitCode != 0 {
      return CanonicalSessionState(phase: .failed, badge: badgeByKind[.failed])
    }
    if statusLower == "failed" {
      return CanonicalSessionState(phase: .failed, badge: badgeByKind[.failed])
    }
    if runtimeLower == "killed" {
      return CanonicalSessionState(phase: .failed, badge: badgeByKind[.failed])
    }
    // Chats rest between turns unless their last turn failed or their backing
    // runtime detached, which is genuinely ended.
    if chat {
      if !lastTurnFailed.isEmpty {
        return CanonicalSessionState(phase: .failed, badge: badgeByKind[.failed])
      }
      if statusLower == "detached" {
        return CanonicalSessionState(phase: .ended, badge: nil)
      }
      return CanonicalSessionState(phase: .ready, badge: nil)
    }

    // Process completion is not a lifecycle declaration.
    return CanonicalSessionState(phase: .ended, badge: nil)
  }

  // Running chats keep status "running" when a turn dies, so carry the
  // persisted failure marker ahead of calm running/ready states.
  if chat && !lastTurnFailed.isEmpty {
    return CanonicalSessionState(phase: .failed, badge: badgeByKind[.failed])
  }

  // 5. Stale: running but silent past the threshold.
  if isSilentPast(lastActivityAt, now: now, thresholdSeconds: sessionStaleAfterSeconds) {
    return CanonicalSessionState(phase: .stale, badge: badgeByKind[.stale])
  }

  // Idle chats between turns are ready (calm); idle agent CLIs stay calm here —
  // there is no deterministic ask.
  if runtimeLower == "idle" {
    return chat
      ? CanonicalSessionState(phase: .ready, badge: nil)
      : CanonicalSessionState(phase: .idle, badge: nil)
  }

  return CanonicalSessionState(phase: .running, badge: nil)
}

// MARK: - Row capsule wiring

/// The one-word attention capsule for a Work session row, backed by the shared
/// canonical state so the capsule, the Live Activity phase, and notifications
/// always agree. Returns nil for every calm state — rows must not shift layout
/// when no capsule renders.
///
/// This maps iOS's awaiting derivation (chat summary `awaitingInput`, plus
/// `awaiting_input` session statuses) onto the canonical "waiting-input" runtime
/// so a chat blocked on a question/plan/approval reads as needs_you exactly like
/// `SyncService.isAwaiting`, without touching that derivation.
func workSessionCapsuleBadge(
  session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?,
  now: Date = Date()
) -> SessionBadge? {
  return workCanonicalSessionState(
    session: session,
    summary: summary,
    now: now
  ).badge
}

// MARK: - The full status vocabulary

/// Canonical phase → the shared Activity phase, so a Work row reads its label
/// and its hue out of the same table the drawer, the hub strip, and the widget
/// use. The four resting phases have no Activity phase of their own and are
/// carried as additive raw values, which `ActivityPhaseVocabulary` answers with
/// the quiet neutral presentation they want.
func workActivityPhase(for phase: CanonicalSessionPhase) -> AccountAttentionPhase {
  switch phase {
  case .starting: return .starting
  case .running: return .running
  case .needsYou: return .needsYou
  case .failed: return .failed
  case .stale: return .stale
  // Settled is a declared "this is finished and filed", which is exactly what
  // the emerald `completed` presentation says.
  case .settled: return .completed
  case .ready: return .unrecognized("ready")
  case .idle: return .unrecognized("idle")
  case .stopped: return .unrecognized("stopped")
  case .ended: return .unrecognized("ended")
  }
}

/// Planning is a PRESENTATION fact, never a canonical phase — the same split
/// desktop makes, where `chatActivityMode` is derived from the chat's
/// interaction mode and folded in at render time
/// (`chatSessionProjection.ts`: `interactionMode === "plan"`).
func workSessionIsPlanning(summary: AgentChatSessionSummary?) -> Bool {
  summary?.interactionMode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "plan"
}

/// The capsule a Work row renders: the full vocabulary, not just the attention
/// third. Nil for the resting phases, which say what they need to say with the
/// neutral dot alone.
func workSessionStatusBadge(
  session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?,
  now: Date = Date()
) -> SessionBadge? {
  let canonical = workCanonicalSessionState(session: session, summary: summary, now: now)
  if canonical.phase == .running && workSessionIsPlanning(summary: summary) {
    return workSessionBadge(kind: .planning, phase: .unrecognized("planning"))
  }
  switch canonical.phase {
  case .needsYou, .failed, .stale:
    return canonical.badge
  case .starting, .running:
    return workSessionBadge(kind: .working, phase: workActivityPhase(for: canonical.phase))
  case .settled:
    return workSessionBadge(kind: .done, phase: .completed)
  case .ready, .idle, .stopped, .ended:
    return nil
  }
}

/// The hue of the row's status dot. Same table as the capsule, so a row whose
/// capsule says "Working" can never wear a green dot.
func workSessionRowTone(
  session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?,
  now: Date = Date()
) -> ActivityTone {
  let canonical = workCanonicalSessionState(session: session, summary: summary, now: now)
  if canonical.phase == .running && workSessionIsPlanning(summary: summary) {
    return ActivityPhaseVocabulary.presentation(for: .unrecognized("planning")).tone
  }
  return ActivityPhaseVocabulary.presentation(for: workActivityPhase(for: canonical.phase)).tone
}

/// Canonical state for a concrete Work row. This is the one bridge from the
/// mobile summary/awaiting projection into the scalar canonical state machine.
func workCanonicalSessionState(
  session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?,
  now: Date = Date()
) -> CanonicalSessionState {
  return workCanonicalSessionState(
    status: session.status,
    runtimeState: session.runtimeState,
    toolType: session.toolType,
    pendingInputItemId: summary?.pendingInputItemId ?? session.pendingInputItemId,
    providerStructuredInput: summary?.awaitingInput == true || session.attentionSource == "provider_structured",
    lastOutputPreview: session.lastOutputPreview,
    lastActivityAt: workSessionStaleActivityTimestamp(session: session, summary: summary),
    exitCode: session.exitCode,
    settledAt: session.settledAt,
    settleOverride: session.settleOverride,
    attentionRequestedAt: session.attentionRequestedAt,
    lastTurnFailedAt: session.lastTurnFailedAt,
    now: now
  )
}

/// The genuine last-activity timestamp used ONLY to drive the stale check.
/// Unlike `workSessionActivityTimestamp` (which feeds display/sort and falls
/// back to `session.startedAt`), this returns nil when no real activity signal
/// exists — the iOS `TerminalSessionSummary` carries no desktop-style
/// `lastActivityAt`, so a plain terminal has no output timestamp. Falling back
/// to `startedAt` would flag any terminal open >3h as Stale even with output
/// seconds ago; nil disables the check, mirroring the desktop caller which
/// passes the real `lastActivityAt` or null (never `startedAt`).
private func workSessionStaleActivityTimestamp(
  session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?
) -> String? {
  summary?.lastActivityAt ?? session.chatIdleSinceAt
}

// MARK: - Snooze — a synced VISIBILITY OVERLAY, deliberately NOT a lifecycle state

/// Why a snoozed session woke. Persisted on `terminal_sessions.woke_reason`;
/// raw values mirror the desktop `SessionWakeReason` exactly.
enum SessionWakeReason: String, Equatable {
  /// The snooze window elapsed (DERIVED from `snoozed_until`, no scheduler).
  case timer
  /// A pending approval / input request raised a hand.
  case needsYou = "needs_you"
  /// A session error strictly newer than `snoozed_at`.
  case error
  /// A running turn finished while the row was asleep.
  case turnComplete = "turn_complete"
  /// The user woke it by hand.
  case manual

  /// Tolerant parse of the persisted column; unknown values read as no marker.
  init?(persisted: String?) {
    let raw = persisted?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    guard !raw.isEmpty, let parsed = SessionWakeReason(rawValue: raw) else { return nil }
    self = parsed
  }

  /// Specific, operational copy for why a snoozed row came back. Deliberately
  /// not "woke up" — the user needs to know what changed. Matches the desktop
  /// `wakeReasonLabel` word for word so both surfaces say the same thing.
  var wokeLabel: String {
    switch self {
    case .needsYou: return "needs approval"
    case .error: return "errored"
    case .turnComplete: return "turn finished"
    case .timer: return "snooze ended"
    case .manual: return "woken by you"
    }
  }
}

/// The two columns snooze is derived from. Snooze never alters a session's
/// canonical phase: `workCanonicalSessionState` does not read these at all — a
/// snoozed row is still running/failed/needs_you exactly as before, snooze only
/// decides where the UI files it. Keeping the two orthogonal is what lets
/// desktop, `ade code`, and iOS agree without re-deriving the lifecycle.
struct SessionSnoozeState: Equatable {
  /// ISO deadline; expiry is DERIVED by comparing to now — there is no timer.
  var snoozedUntil: String?
  /// ISO instant the snooze was taken; the early-wake comparison baseline.
  var snoozedAt: String?

  init(snoozedUntil: String? = nil, snoozedAt: String? = nil) {
    self.snoozedUntil = snoozedUntil
    self.snoozedAt = snoozedAt
  }
}

/// Hand-raise signals that can wake a snoozed row before its deadline.
struct SessionWakeSignals: Equatable {
  /// A pending approval / input request is showing on the row.
  var hasPendingInput: Bool?
  /// ISO timestamp of the session's most recent error, if any.
  var errorAt: String?
  /// A running turn just completed.
  var turnCompleted: Bool?

  init(hasPendingInput: Bool? = nil, errorAt: String? = nil, turnCompleted: Bool? = nil) {
    self.hasPendingInput = hasPendingInput
    self.errorAt = errorAt
    self.turnCompleted = turnCompleted
  }
}

/// Strict ISO parse mirroring the desktop `parseIsoMs`: blank and unparseable
/// values are indistinguishable from absent, so every comparison fails closed.
private func sessionSnoozeParsedDate(_ value: String?) -> Date? {
  guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
    return nil
  }
  return workParsedDate(trimmed)
}

/// The one derivation of "this row is currently snoozed", shared with desktop
/// and the CLI. Timer expiry is derived here (`snoozedUntil <= now`), which is
/// why no scheduler or background watchdog exists for snooze on any surface.
func isSessionSnoozed(_ session: SessionSnoozeState, now: Date = Date()) -> Bool {
  guard let until = sessionSnoozeParsedDate(session.snoozedUntil) else { return false }
  return until > now
}

/// The FILING rule: "should the list hide this row in its Snoozed tail?".
///
/// Mirrors the desktop `isSessionFiledAsSnoozed`. Snooze is a visibility overlay
/// and an overlay must YIELD to a session actually blocked on the user, or the
/// "Until I'm asked" window (~100 years) buries the very row whose hand is
/// raised. Explicit and structured requests project to `needsYou`, so deriving
/// the filing rule from the phase covers chat and CLI identically.
///
/// Deliberately separate from `isSessionSnoozed`, which stays the raw
/// two-column read that chips, menus, and wake labels want, and the canonical
/// state machine still never reads the snooze columns.
func isSessionFiledAsSnoozed(
  _ session: SessionSnoozeState,
  phase: CanonicalSessionPhase?,
  now: Date = Date()
) -> Bool {
  guard isSessionSnoozed(session, now: now) else { return false }
  return phase != .needsYou
}

/// A snooze that was taken but whose window has already elapsed.
func isSessionSnoozeExpired(_ session: SessionSnoozeState, now: Date = Date()) -> Bool {
  guard let until = sessionSnoozeParsedDate(session.snoozedUntil) else { return false }
  return until <= now
}

/// Upper bound on the single snooze-expiry refresh. Mirrors the desktop
/// `SNOOZE_TICK_MAX_DELAY_MS`. Expiry stays DERIVED — there is still no
/// scheduler and no persisted wake event — but a list that CACHES its groups
/// has to be told to re-derive, and the "Until I'm asked" preset parks its
/// deadline ~100 years out. Waiting that literally is not a wait, so the delay
/// is clamped and simply re-armed each time it lapses.
let workSnoozeTickMaxDelay: TimeInterval = 10 * 60

/// Floor so a deadline sitting exactly on `now` still makes forward progress
/// instead of spinning the rebuild.
private let workSnoozeTickMinDelay: TimeInterval = 0.25

/// Soonest still-future snooze deadline across `sessions`, or nil when nothing
/// is snoozed. Mirrors the desktop `nextSnoozeDeadlineMs`: rows with a missing,
/// unparseable, or already-lapsed deadline never arm anything.
func nextSessionSnoozeDeadline(
  _ sessions: [TerminalSessionSummary],
  now: Date = Date()
) -> Date? {
  var soonest: Date?
  for session in sessions {
    guard let until = sessionSnoozeParsedDate(session.snoozedUntil), until > now else { continue }
    if let current = soonest, current <= until { continue }
    soonest = until
  }
  return soonest
}

/// How long the Work list should wait before re-deriving its Snoozed section,
/// or nil when no row is snoozed — in which case nothing is scheduled at all.
/// Exactly one wait, at the nearest deadline, clamped at both ends.
func workSnoozeRegroupDelay(
  sessions: [TerminalSessionSummary],
  now: Date = Date()
) -> TimeInterval? {
  guard let deadline = nextSessionSnoozeDeadline(sessions, now: now) else { return nil }
  let remaining = deadline.timeIntervalSince(now)
  return min(max(remaining, workSnoozeTickMinDelay), workSnoozeTickMaxDelay)
}

/// The load-bearing early-wake comparison.
///
/// An error only raises a hand when it is STRICTLY NEWER than `snoozedAt`.
/// Without this, the very error the user snoozed on top of re-wakes the row
/// immediately and snooze does nothing at all. An error stamped at exactly
/// `snoozedAt` is the one being snoozed, so it does not wake either.
///
/// If the row carries no parseable `snoozedAt` we fail CLOSED (no wake): an
/// unknown baseline must not resurrect every historical error.
func isWakingSessionError(_ session: SessionSnoozeState, errorAt: String?) -> Bool {
  guard let errorDate = sessionSnoozeParsedDate(errorAt) else { return false }
  guard let snoozedAtDate = sessionSnoozeParsedDate(session.snoozedAt) else { return false }
  return errorDate > snoozedAtDate
}

/// Resolve why a snoozed row should wake right now, or nil to stay asleep.
/// Hand-raises are reported ahead of plain timer expiry because they carry the
/// more useful "woke" marker copy. A row that is not snoozed at all never wakes.
func resolveSessionWakeReason(
  _ session: SessionSnoozeState,
  signals: SessionWakeSignals = SessionWakeSignals(),
  now: Date = Date()
) -> SessionWakeReason? {
  guard sessionSnoozeParsedDate(session.snoozedUntil) != nil else { return nil }
  if signals.hasPendingInput == true { return .needsYou }
  if isWakingSessionError(session, errorAt: signals.errorAt) { return .error }
  if signals.turnCompleted == true { return .turnComplete }
  if isSessionSnoozeExpired(session, now: now) { return .timer }
  return nil
}

/// The snooze windows offered on iOS. Keys, copy, and deadline math mirror the
/// desktop `SNOOZE_DURATION_OPTIONS` / `snoozeDeadlineIso` exactly, so the same
/// choice means the same instant on both surfaces. Menu order is fixed:
/// shortest window first, open-ended last. `thisEvening` is omitted from the
/// resolved menu once 18:00 is within an hour or already past, matching
/// desktop's `resolveSnoozePresets`.
enum WorkSnoozeDuration: String, CaseIterable, Identifiable {
  case oneHour
  case thisEvening
  case tomorrowMorning
  case nextWeek
  case untilAsked

  var id: String { rawValue }

  var label: String {
    switch self {
    case .oneHour: return "In 1 hour"
    case .thisEvening: return "This evening"
    case .tomorrowMorning: return "Tomorrow"
    case .nextWeek: return "Next week"
    case .untilAsked: return "Until I'm asked"
    }
  }

  var symbol: String {
    switch self {
    case .oneHour: return "clock"
    case .thisEvening: return "sunset"
    case .tomorrowMorning: return "sunrise"
    case .nextWeek: return "calendar"
    case .untilAsked: return "hand.raised"
    }
  }

  /// Evening starts at 18:00 local; morning at 09:00 local.
  private static let eveningHour = 18
  private static let morningHour = 9

  /// Concrete deadline for a menu choice, computed on the client — there is no
  /// scheduler anywhere, every surface derives expiry by comparing to now.
  func deadline(from now: Date = Date(), calendar: Calendar = .current) -> Date? {
    func atLocalHour(_ hour: Int, dayOffset: Int = 0) -> Date? {
      guard let day = calendar.date(byAdding: .day, value: dayOffset, to: now) else { return nil }
      return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)
    }

    switch self {
    case .oneHour:
      return now.addingTimeInterval(60 * 60)
    case .thisEvening:
      guard let evening = atLocalHour(Self.eveningHour) else { return nil }
      // Past 6pm already: this evening has gone, so roll to the next one.
      return evening > now ? evening : atLocalHour(Self.eveningHour, dayOffset: 1)
    case .tomorrowMorning:
      return atLocalHour(Self.morningHour, dayOffset: 1)
    case .nextWeek:
      // Calendar weekday values are Sunday = 1, Monday = 2. A choice made on
      // Monday means the following Monday, never a few hours later today.
      let monday = 2
      let today = calendar.component(.weekday, from: now)
      let daysUntilMonday = (monday - today + 7) % 7
      return atLocalHour(Self.morningHour, dayOffset: daysUntilMonday == 0 ? 7 : daysUntilMonday)
    case .untilAsked:
      return calendar.date(byAdding: .day, value: workSnoozeIndefiniteDays, to: now)
    }
  }
}

struct WorkSnoozeOption: Equatable {
  let duration: WorkSnoozeDuration
  let deadline: Date
}

/// Resolve the native menu from one wall-clock snapshot so filtering and
/// deadlines cannot disagree around the 17:00 / 18:00 boundary.
func workSnoozeOptions(
  now: Date = Date(),
  calendar: Calendar = .current
) -> [WorkSnoozeOption] {
  let eveningIsUseful: Bool = {
    guard let evening = calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now) else {
      return false
    }
    return evening.timeIntervalSince(now) > 60 * 60
  }()

  return WorkSnoozeDuration.allCases.compactMap { duration in
    if duration == .thisEvening && !eveningIsUseful { return nil }
    guard let deadline = duration.deadline(from: now, calendar: calendar) else { return nil }
    return WorkSnoozeOption(duration: duration, deadline: deadline)
  }
}

extension TerminalSessionSummary {
  /// The row's snooze columns as the shared derivation input.
  var snoozeState: SessionSnoozeState {
    SessionSnoozeState(snoozedUntil: snoozedUntil, snoozedAt: snoozedAt)
  }

  /// True while the snooze window is still open. Purely derived from the clock.
  /// This is the RAW read the row chrome (chips, menus, wake labels) wants — use
  /// `isFiledAsSnoozed(summary:now:)` for anything that HIDES the row.
  func isSnoozed(now: Date = Date()) -> Bool {
    isSessionSnoozed(snoozeState, now: now)
  }

  /// Whether a list may file this row into its quiet Snoozed tail. A row whose
  /// canonical phase is `needsYou` is filed normally even while snoozed: the
  /// overlay yields to a raised hand, which keeps "Until I'm asked" honest.
  func isFiledAsSnoozed(summary: AgentChatSessionSummary?, now: Date = Date()) -> Bool {
    guard isSnoozed(now: now) else { return false }
    let phase = workCanonicalSessionState(session: self, summary: summary, now: now).phase
    return isSessionFiledAsSnoozed(snoozeState, phase: phase, now: now)
  }

  /// The "woke" marker a row carries until it is opened. Prefers the persisted
  /// `wokeReason`; a row whose snooze merely lapsed (expiry is derived, so no
  /// backend ever wrote a marker) falls back to the shared resolver so timer
  /// wakes still explain themselves. Mirrors the desktop `sessionWokeMarker`.
  func wokeMarker(now: Date = Date()) -> SessionWakeReason? {
    if sessionSnoozeParsedDate(wokeAt) != nil {
      let raw = wokeReason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      // An empty persisted reason means "the snooze lapsed"; an unrecognized
      // one is no marker at all rather than an invented state.
      return raw.isEmpty ? .timer : SessionWakeReason(persisted: raw)
    }
    guard isSessionSnoozeExpired(snoozeState, now: now) else { return nil }
    let pending = pendingInputItemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return resolveSessionWakeReason(
      snoozeState,
      signals: SessionWakeSignals(hasPendingInput: !pending.isEmpty, errorAt: lastTurnFailedAt),
      now: now
    )
  }

  /// Current settle override, if any.
  var resolvedSettleOverride: SessionSettleOverride? {
    SessionSettleOverride(persisted: settleOverride)
  }
}

// MARK: - Snooze / woke row presentation

/// "Until I'm asked" has no clock deadline, so it parks the row far enough out
/// that only a hand-raise brings it back. Mirrors the desktop `INDEFINITE_MS`.
let workSnoozeIndefiniteDays = 100 * 365
/// Any deadline beyond this reads as open-ended rather than a countdown.
/// Mirrors the desktop `INDEFINITE_LABEL_THRESHOLD_MS`.
private let workSnoozeIndefiniteLabelThreshold: TimeInterval = 365 * 24 * 60 * 60

/// The per-row wake line in the Snoozed group: "wakes in 3h", "wakes tomorrow",
/// "wakes when asked". Nil when the row has no usable deadline. Word-for-word
/// the desktop `snoozeWakeLabel`, including its calendar-day rounding.
func workSnoozeWakeLabel(
  _ snoozedUntil: String?,
  now: Date = Date(),
  calendar: Calendar = .current
) -> String? {
  guard let until = sessionSnoozeParsedDate(snoozedUntil) else { return nil }
  let remaining = until.timeIntervalSince(now)
  if remaining <= 0 { return "wakes now" }
  if remaining >= workSnoozeIndefiniteLabelThreshold { return "wakes when asked" }
  if remaining < 60 { return "wakes in 1m" }
  if remaining < 3600 { return "wakes in \(Int((remaining / 60).rounded()))m" }

  let dayDelta = calendar.dateComponents(
    [.day],
    from: calendar.startOfDay(for: now),
    to: calendar.startOfDay(for: until)
  ).day ?? 0
  if dayDelta == 0 { return "wakes in \(Int((remaining / 3600).rounded()))h" }
  if dayDelta == 1 {
    return remaining < 12 * 3600 ? "wakes in \(Int((remaining / 3600).rounded()))h" : "wakes tomorrow"
  }
  return "wakes in \(max(1, dayDelta))d"
}

/// Compact glyph + text chip for the snoozed / woke row markers. Deliberately
/// quieter than `WorkSessionStatusCapsule`: neither is an attention state.
struct WorkSessionLifecycleTag: View {
  let symbol: String
  let text: String
  let tint: Color

  var body: some View {
    HStack(spacing: 3) {
      Image(systemName: symbol)
        .font(.system(size: 9, weight: .semibold))
      Text(text)
        .font(.caption2.weight(.medium))
        .lineLimit(1)
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(tint.opacity(0.12), in: Capsule())
    .fixedSize()
  }
}

/// Small status capsule shown next to a Work row title. The hue comes from the
/// shared tone token — amber for needs_you and nothing else, blue for work in
/// flight, emerald for finished, red for failed, violet for planning — so the
/// row cannot describe a session differently from the drawer or the widget.
/// Neutral badges render outlined rather than filled, which keeps a calm row
/// calm. Resting states have no badge at all, so callers gate on a non-nil
/// badge and the row never shifts layout.
struct WorkSessionStatusCapsule: View {
  let badge: SessionBadge

  var body: some View {
    HStack(spacing: 3) {
      if let glyph = badge.glyph, showsGlyph {
        Image(systemName: glyph.systemImage)
          .font(.system(size: 8, weight: .semibold))
      }
      Text(badge.label)
        .font(.caption2.weight(.semibold))
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 7)
    .padding(.vertical, 2)
    .background(fill, in: Capsule())
    .overlay(Capsule().stroke(stroke, lineWidth: 0.5))
    .fixedSize()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
  }

  /// Only where the word alone is ambiguous: "Stale" wants the clock that asks
  /// how long, "Planning" wants the list that says what kind of work. The rest
  /// read fine as plain words and stay uncluttered.
  private var showsGlyph: Bool {
    badge.kind == .stale || badge.kind == .planning
  }

  private var isOutlined: Bool { badge.tone == .neutral }

  private var tint: Color {
    activityToneColor(badge.tone)
  }

  private var fill: Color {
    isOutlined ? Color.clear : tint.opacity(0.14)
  }

  private var stroke: Color {
    isOutlined ? tint.opacity(0.4) : tint.opacity(0.3)
  }

  private var accessibilityLabel: String {
    switch badge.kind {
    case .needsYou: return "Needs your input"
    case .failed: return "Failed"
    case .stale: return "Stale, no recent activity"
    case .working: return "Working"
    case .planning: return "Planning"
    case .done: return "Done"
    }
  }
}
