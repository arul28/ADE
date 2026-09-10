import Foundation

/// Usage-limit resume: the pure model + every string the pill, the sheet, and
/// the session-list badge render.
///
/// Nothing here touches SwiftUI and nothing reads the wall clock implicitly —
/// every label takes `now`, so the countdown copy is testable to the second.
/// The copy itself is locked by `.specs/CONTRACT.md`; keep it verb-first,
/// sentence case, and neutral. A usage limit is a wait, not a failure, so no
/// label here earns a warning or danger tint.

// MARK: - Model

/// The one shape the resume UI renders from.
///
/// Built from `AgentChatSessionSummary.usageLimitResume` when the paired host
/// sends it, and — only then — from the deprecated `usageLimitParkedUntil`
/// mirror so a client paired with an older host still shows the wait instead of
/// a bare failed turn.
struct WorkUsageLimitResumeModel: Equatable {
  let state: AgentChatUsageLimitResumeState
  /// Raw provider slug from the host. Use `providerName` for display.
  let provider: String
  /// When ADE sends the continue prompt. Absent for `paused` / `opted_out` /
  /// `no_reset`, and for an armed row whose reset instant the host never learned.
  let fireAt: Date?
  /// The instant the provider published as the reset, when it published one.
  let resetAt: Date?
  let attempts: Int
  /// Raw provider text. Shown verbatim, and only behind the details disclosure.
  let providerDetail: String?
  /// The turn that hit the limit, so the transcript footer can be anchored to it.
  let turnId: String?
  /// True when this was reconstructed from `usageLimitParkedUntil` because the
  /// host predates `usageLimitResume`. Never set when the host sends the row.
  let isLegacyFallback: Bool

  init(
    state: AgentChatUsageLimitResumeState,
    provider: String,
    fireAt: Date? = nil,
    resetAt: Date? = nil,
    attempts: Int = 0,
    providerDetail: String? = nil,
    turnId: String? = nil,
    isLegacyFallback: Bool = false
  ) {
    self.state = state
    self.provider = provider
    self.fireAt = fireAt
    self.resetAt = resetAt
    self.attempts = attempts
    self.providerDetail = providerDetail
    self.turnId = turnId
    self.isLegacyFallback = isLegacyFallback
  }

  var providerName: String { workChatSurfaceProviderName(provider) }

  /// The instant the pill counts down to, when there is one to count to.
  var countdownTarget: Date? {
    switch state {
    case .armed, .resuming: return fireAt
    case .paused, .optedOut, .noReset, .unknown: return nil
    }
  }

  /// The instant a `paused` row can next be retried at, if the provider named one.
  var retryTarget: Date? { resetAt ?? fireAt }
}

/// Build the render model for a chat, preferring the host's computed row.
///
/// Returns nil when no usage limit is live — that, not a flag, is what hides the
/// pill. `unknown` (a state this build predates) also returns nil: showing copy
/// written for a different state would be worse than showing nothing.
func workUsageLimitResumeModel(
  for summary: AgentChatSessionSummary?,
  now: Date = Date()
) -> WorkUsageLimitResumeModel? {
  guard let summary else { return nil }

  if let resume = summary.usageLimitResume {
    guard resume.state != .unknown else { return nil }
    return WorkUsageLimitResumeModel(
      state: resume.state,
      provider: resume.provider.isEmpty ? summary.provider : resume.provider,
      fireAt: workParsedDate(resume.fireAt),
      resetAt: workParsedDate(resume.resetAt),
      attempts: resume.attempts,
      providerDetail: resume.providerDetail?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true
        ? nil
        : resume.providerDetail,
      turnId: resume.turnId,
      isLegacyFallback: false
    )
  }

  // Older host: the deprecated mirror is the only signal there is. Reconstruct
  // the armed case only — the mirror carries no streak, no detail, and no way to
  // tell paused from opted out.
  guard WorkUsageLimitOptOut.shouldShow(
    autoContinueAtUsageLimit: summary.autoContinueAtUsageLimit,
    usageLimitParkedUntil: summary.usageLimitParkedUntil,
    scheduledWork: summary.scheduledWork,
    now: now
  ) else { return nil }

  let fireAt = workParsedDate(
    summary.usageLimitParkedUntil
      ?? WorkUsageLimitOptOut.pendingSchedule(summary.scheduledWork)?.nextRunAt
  )
  return WorkUsageLimitResumeModel(
    state: .armed,
    provider: summary.provider,
    fireAt: fireAt,
    isLegacyFallback: true
  )
}

// MARK: - Actions

/// What the sheet's primary button does. `paused` and `opted_out` both re-arm
/// through `chat.updateSession { autoContinueAtUsageLimit: true }`; every other
/// state sends the continue prompt now via `chat.resumeUsageLimitNow`.
enum WorkUsageLimitResumePrimaryAction: Equatable {
  case resumeNow
  case tryAgain
  case turnOn

  var label: String {
    switch self {
    case .resumeNow: return "Resume now"
    case .tryAgain: return "Try again"
    case .turnOn: return "Turn on"
    }
  }

  var hint: String {
    switch self {
    case .resumeNow: return "Sends continue to this chat right now."
    case .tryAgain: return "Arms auto-resume again and retries at the next reset."
    case .turnOn: return "Turns auto-resume back on for this chat."
    }
  }
}

func workUsageLimitPrimaryAction(_ state: AgentChatUsageLimitResumeState) -> WorkUsageLimitResumePrimaryAction {
  switch state {
  case .paused: return .tryAgain
  case .optedOut: return .turnOn
  case .armed, .resuming, .noReset, .unknown: return .resumeNow
  }
}

/// Whether the sheet renders its primary button at all.
///
/// `Resume now` needs `chat.resumeUsageLimitNow`, which older hosts do not
/// advertise; the caller passes no handler in that case and the button is
/// hidden rather than shown dead — there is no state this pairing can reach
/// where it would work. Every other primary re-arms through
/// `chat.updateSession`, which every supported host has, so those stay visible
/// and merely disable while an action is in flight or the host is unreachable.
///
/// Note that "not invokable right now" (viewer device, no live connection) is
/// deliberately NOT a reason to hide: the button stays, and the tap reports the
/// real cause through `requireInvokableRemoteAction`.
func workUsageLimitShowsPrimaryButton(
  state: AgentChatUsageLimitResumeState,
  hasResumeNowAction: Bool
) -> Bool {
  workUsageLimitPrimaryAction(state) != .resumeNow || hasResumeNowAction
}

/// "Don't continue" cancels a live arm. There is nothing to cancel once the user
/// has already opted out, so the sheet drops the row rather than showing a
/// button that would be a no-op.
func workUsageLimitShowsOptOut(_ state: AgentChatUsageLimitResumeState) -> Bool {
  state != .optedOut
}

// MARK: - Time formatting

/// Short clock time in the *viewer's* zone. Transcript notices carry the host
/// zone and a zone label and are rendered as-is; the pill and sheet count down
/// against the device, so they format here.
func workUsageLimitClockLabel(_ date: Date) -> String {
  let formatter = DateFormatter()
  formatter.locale = .current
  formatter.dateStyle = .none
  formatter.timeStyle = .short
  return formatter.string(from: date)
}

/// "in 3 min" / "in 4 min 20 s" / "in 2 hr 5 min" / "now".
///
/// Seconds appear only under five minutes, which is exactly the window where the
/// pill also ticks per second — the precision and the refresh rate agree, so the
/// label never looks frozen and never burns a timer to redraw an unchanged
/// string.
func workUsageLimitRelativePhrase(to date: Date, now: Date) -> String {
  let remaining = date.timeIntervalSince(now)
  if remaining <= 0 { return "now" }
  let seconds = Int(remaining.rounded(.up))
  if seconds < 60 { return "in \(seconds) s" }
  if seconds < 300 {
    let minutes = seconds / 60
    let rest = seconds % 60
    return rest == 0 ? "in \(minutes) min" : "in \(minutes) min \(rest) s"
  }
  if seconds < 3_600 { return "in \((seconds + 59) / 60) min" }
  let hours = seconds / 3_600
  let minutes = (seconds % 3_600) / 60
  return minutes == 0 ? "in \(hours) hr" : "in \(hours) hr \(minutes) min"
}

/// Per-second under five minutes, per-minute above it. One timer, two rates.
func workUsageLimitTickInterval(fireAt: Date?, now: Date) -> TimeInterval {
  guard let fireAt else { return 60 }
  let remaining = fireAt.timeIntervalSince(now)
  return remaining <= 300 ? 1 : 60
}

private func workUsageLimitAttemptsPhrase(_ attempts: Int) -> String {
  let count = max(1, attempts)
  return "\(count) \(count == 1 ? "try" : "tries")"
}

// MARK: - Pill copy

/// The compact line above the composer. Verb-first, no tint, no exclamation.
func workUsageLimitPillLabel(_ model: WorkUsageLimitResumeModel, now: Date = Date()) -> String {
  switch model.state {
  case .armed:
    guard let fireAt = model.fireAt else { return "Resumes when the limit lifts · usage limit" }
    if fireAt <= now { return "Resuming…" }
    return "Resumes \(workUsageLimitRelativePhrase(to: fireAt, now: now)) · usage limit"
  case .resuming:
    return "Resuming…"
  case .paused:
    let head = "Paused after \(workUsageLimitAttemptsPhrase(model.attempts))"
    guard let retry = model.retryTarget else { return "\(head) · Try again" }
    return "\(head) · Try at \(workUsageLimitClockLabel(retry))"
  case .optedOut:
    return "Won't auto-resume · Turn on"
  case .noReset:
    return "Usage limit · no reset time · Retry"
  case .unknown:
    return ""
  }
}

/// SF Symbol for the pill's leading glyph. Neutral shapes only — a clock is a
/// wait, a triangle would be an error.
func workUsageLimitPillGlyph(_ state: AgentChatUsageLimitResumeState) -> String {
  switch state {
  case .armed: return "clock"
  case .resuming: return "arrow.clockwise"
  case .paused: return "pause.circle"
  case .optedOut: return "clock.badge.xmark"
  case .noReset, .unknown: return "clock.badge.questionmark"
  }
}

/// Spelled-out equivalent of the pill label: VoiceOver should not read "·".
func workUsageLimitPillAccessibilityLabel(
  _ model: WorkUsageLimitResumeModel,
  now: Date = Date()
) -> String {
  switch model.state {
  case .armed:
    guard let fireAt = model.fireAt else {
      return "\(model.providerName) usage limit. Resumes when the limit lifts."
    }
    if fireAt <= now { return "\(model.providerName) usage limit. Resuming now." }
    return "\(model.providerName) usage limit. Resumes \(workUsageLimitRelativePhrase(to: fireAt, now: now)), at \(workUsageLimitClockLabel(fireAt))."
  case .resuming:
    return "\(model.providerName) usage limit. Resuming now."
  case .paused:
    let head = "\(model.providerName) usage limit. Paused after \(workUsageLimitAttemptsPhrase(model.attempts))"
    guard let retry = model.retryTarget else { return "\(head)." }
    return "\(head). Can try again at \(workUsageLimitClockLabel(retry))."
  case .optedOut:
    return "\(model.providerName) usage limit. This chat won't auto-resume."
  case .noReset:
    return "\(model.providerName) usage limit. No reset time published."
  case .unknown:
    return "\(model.providerName) usage limit."
  }
}

// MARK: - Sheet copy

func workUsageLimitSheetTitle(_ model: WorkUsageLimitResumeModel) -> String {
  "\(model.providerName) usage limit"
}

/// Body of the sheet: what happens next, then the reassurance. Two lines, in
/// that order, for every state.
func workUsageLimitSheetBodyLines(
  _ model: WorkUsageLimitResumeModel,
  now: Date = Date()
) -> [String] {
  let lead: String
  switch model.state {
  case .armed:
    if let fireAt = model.fireAt, fireAt > now {
      lead = "ADE sends \u{201C}continue\u{201D} at \(workUsageLimitClockLabel(fireAt)) (\(workUsageLimitRelativePhrase(to: fireAt, now: now)))."
    } else if model.fireAt != nil {
      lead = "ADE is sending \u{201C}continue\u{201D} now."
    } else {
      lead = "ADE sends \u{201C}continue\u{201D} as soon as the limit lifts."
    }
  case .resuming:
    lead = "ADE is sending \u{201C}continue\u{201D} now."
  case .paused:
    lead = "ADE stopped after \(workUsageLimitAttemptsPhrase(model.attempts)). The limit did not lift at the published reset."
  case .optedOut:
    lead = "Auto-resume is off for this chat. Nothing will be sent until you say so."
  case .noReset:
    lead = "\(model.providerName) published no reset time, so ADE won't resume on its own."
  case .unknown:
    lead = ""
  }
  return [lead, "Nothing is lost. Subagents restart with it."].filter { !$0.isEmpty }
}

// MARK: - Session-list badge

/// The Work / hub row status for a chat waiting on a usage limit, or nil when
/// the row should fall through to the ordinary phase table.
///
/// `opted_out` and `no_reset` fall through on purpose: nothing is scheduled, so
/// the row's real state (idle, failed) is the honest thing to show.
struct WorkUsageLimitRowStatus: Equatable {
  let label: String
  let glyph: ActivityGlyph
  /// `armed`/`resuming` are neutral — a scheduled appointment is not a problem.
  /// `paused` is amber: two arms have already come and gone, so the chat is
  /// waiting on the user to try again and the row should say so.
  let tone: ActivityTone
}

func workUsageLimitRowStatus(
  _ model: WorkUsageLimitResumeModel?,
  now: Date = Date()
) -> WorkUsageLimitRowStatus? {
  guard let model else { return nil }
  switch model.state {
  case .armed, .resuming:
    // `Resumes 7:31 PM` is a promise about the future, so it may only be made
    // about a future instant. Once the row is due — state `resuming`, or an
    // `armed` row whose fire time has passed while the turn boundary has not
    // come round yet — the clock would quote a time already gone, so the row
    // says the neutral, still-true `Resuming`. Mirrors desktop's
    // `usageLimitResumeRowStatus`.
    guard model.state != .resuming, let fireAt = model.fireAt, fireAt > now else {
      return WorkUsageLimitRowStatus(label: "Resuming", glyph: .parked, tone: .neutral)
    }
    return WorkUsageLimitRowStatus(
      label: "Resumes \(workUsageLimitClockLabel(fireAt))",
      glyph: .parked,
      tone: .neutral
    )
  case .paused:
    return WorkUsageLimitRowStatus(label: "Paused · limit", glyph: .parked, tone: .amber)
  case .optedOut, .noReset, .unknown:
    return nil
  }
}

// MARK: - Transcript attribution

/// Does this text read like a provider usage / rate limit?
///
/// Used only to group already-failed subagent rows by cause. Deliberately narrow:
/// the host owns limit *detection* (SDK rate-limit events and result-frame
/// errors, never prose — see `.specs/CONTRACT.md`), and this must not become a
/// second, sloppier detector that promotes an assistant sentence into a state.
/// Mirrors desktop's `isUsageLimitFailureText`: normalize to lowercase
/// alphanumerics (so `usage_limit`, `Usage Limit` and `usage-limit` are one
/// token), then match named limit phrases.
///
/// A bare `429` is deliberately NOT enough. `AssertionError at parser.ts:429`
/// and `context overflow: 4290 tokens` both carry the digits and neither is a
/// limit; the status code only counts when the same sentence also says what
/// kind of limit it is.
func workTextIndicatesUsageLimit(_ text: String?) -> Bool {
  guard let text else { return false }
  let identity = String(text.lowercased().unicodeScalars.filter {
    CharacterSet.alphanumerics.contains($0)
  })
  guard !identity.isEmpty else { return false }
  if identity.contains("usagelimit")
    || identity.contains("ratelimit")
    || identity.contains("quotaexceeded")
    || identity.contains("quotaexhausted") {
    return true
  }
  guard identity.contains("429") else { return false }
  return identity.contains("rate")
    || identity.contains("usage")
    || identity.contains("limit")
    || identity.contains("quota")
}
