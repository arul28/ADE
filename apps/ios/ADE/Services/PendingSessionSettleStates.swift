import Foundation

/// A settle-family change the phone has sent to the host and is still waiting on.
///
/// The phone must NOT write `settled_at` / `settle_override` / `settle_source`
/// into its own replica. `terminal_sessions` is a CRR table, so a local write
/// replicates upstream carrying no host lifecycle revision — which means an
/// optimistic settle can win a CRDT merge against a host that *rejected* the
/// settle, and file a live session as done. See
/// `docs/features/terminals-and-sessions/settle-teardown-design.md` §3c-i.
///
/// This is what replaces the write: a purely local overlay applied when session
/// rows are read, so the row responds immediately while the command is in
/// flight, and nothing leaves the device.
///
/// `settle_source` is deliberately absent. No iOS surface reads it, so
/// overlaying it would buy nothing and only add a value to guess wrong.
struct PendingSessionSettleIntent: Equatable {
  /// Two-level optionals mirror the column semantics: `nil` leaves the column
  /// alone, `.some(nil)` shows it cleared, `.some(value)` shows that value.
  var settledAt: String??
  var settleOverride: String??
  /// When the command was sent, for the staleness backstop.
  var startedAt: Date

  static func settle(now: Date, timestamp: String) -> PendingSessionSettleIntent {
    // A declared settle also clears a `"settled"` pin host-side. An `"active"`
    // pin survives, but a row carrying one cannot be settled from this menu in
    // the first place, so showing the override cleared is not a lie the user
    // can reach.
    PendingSessionSettleIntent(settledAt: .some(timestamp), settleOverride: .some(nil), startedAt: now)
  }

  static func unsettle(now: Date) -> PendingSessionSettleIntent {
    // Only `settled_at`. The host clears a `"settled"` override but preserves an
    // `"active"` one, and the phone cannot know which branch it will take —
    // exactly the reasoning that already kept `settle_override` out of the old
    // optimistic write.
    PendingSessionSettleIntent(settledAt: .some(nil), settleOverride: nil, startedAt: now)
  }

  static func settleOverride(_ value: String?, now: Date) -> PendingSessionSettleIntent {
    PendingSessionSettleIntent(settledAt: nil, settleOverride: .some(value), startedAt: now)
  }

  /// Whether the host's replicated row now reflects this intent.
  ///
  /// The two columns are checked differently on purpose. `settled_at` carries
  /// the *host's* timestamp, so only its presence is ours to predict — matching
  /// on the exact string would never resolve. `settle_override` is an exact
  /// value we asked for, so it is compared as one.
  func isSatisfied(by session: TerminalSessionSummary) -> Bool {
    if let settledAt {
      let intended = PendingSessionSettleIntent.normalized(settledAt) != nil
      guard (PendingSessionSettleIntent.normalized(session.settledAt) != nil) == intended else { return false }
    }
    if let settleOverride {
      guard PendingSessionSettleIntent.normalized(session.settleOverride)
        == PendingSessionSettleIntent.normalized(settleOverride) else { return false }
    }
    return true
  }

  func applied(to session: TerminalSessionSummary) -> TerminalSessionSummary {
    var next = session
    if let settledAt {
      next.settledAt = settledAt
    }
    if let settleOverride {
      next.settleOverride = settleOverride
    }
    return next
  }

  static func normalized(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
    return trimmed
  }
}

/// The set of in-flight settle intents, keyed by session id.
///
/// Deliberately a plain value type with no I/O: the whole point is that this
/// state never touches SQLite and so can never replicate.
struct PendingSessionSettleStates: Equatable {
  /// Backstop for an intent whose confirming changeset never arrives — a host
  /// that applied the settle but dropped the connection before replicating it,
  /// say. The overlay is a bridge across one round trip, not durable state, so
  /// it expires rather than lying indefinitely.
  static let staleAfter: TimeInterval = 20

  private var intents: [String: PendingSessionSettleIntent] = [:]

  init() {}

  var isEmpty: Bool { intents.isEmpty }

  subscript(sessionId: String) -> PendingSessionSettleIntent? { intents[normalizedKey(sessionId)] }

  mutating func begin(_ intent: PendingSessionSettleIntent, for sessionId: String) {
    let key = normalizedKey(sessionId)
    guard !key.isEmpty else { return }
    intents[key] = intent
  }

  /// Drop an intent because the command failed. The row snaps back to whatever
  /// the host actually has, which is the honest answer.
  mutating func clear(_ sessionId: String) {
    intents.removeValue(forKey: normalizedKey(sessionId))
  }

  /// Drop intents the host has now confirmed, plus any that outlived the
  /// backstop. Sessions absent from `sessions` are left alone — a partial or
  /// scoped read must not be mistaken for "the host disagrees".
  @discardableResult
  mutating func prune(against sessions: [TerminalSessionSummary], now: Date) -> Bool {
    guard !intents.isEmpty else { return false }
    var next = intents
    for session in sessions {
      let key = normalizedKey(session.id)
      guard let intent = next[key] else { continue }
      if intent.isSatisfied(by: session) {
        next.removeValue(forKey: key)
      }
    }
    for (key, intent) in next
    where now.timeIntervalSince(intent.startedAt) >= PendingSessionSettleStates.staleAfter {
      next.removeValue(forKey: key)
    }
    guard next != intents else { return false }
    intents = next
    return true
  }

  func apply(to session: TerminalSessionSummary) -> TerminalSessionSummary {
    guard let intent = intents[normalizedKey(session.id)] else { return session }
    return intent.applied(to: session)
  }

  func apply(to sessions: [TerminalSessionSummary]) -> [TerminalSessionSummary] {
    guard !intents.isEmpty else { return sessions }
    return sessions.map { apply(to: $0) }
  }

  private func normalizedKey(_ sessionId: String) -> String {
    sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
