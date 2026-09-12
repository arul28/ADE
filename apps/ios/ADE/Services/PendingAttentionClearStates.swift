import Foundation

/// One local "the user has answered this ask" guess, applied over session reads
/// so a Work row leaves "Needs you" at the moment the answer is known.
///
/// The needs-you tier in `workCanonicalSessionState` reads three
/// host-authoritative columns — `pending_input_item_id`,
/// `attention_requested_at`, `attention_source`. The host clears them when the
/// card settles, but that clear rides the CRDT changeset, which lands well
/// behind the `pending_input_resolved` / `user_message` chat event that already
/// told the phone the user answered. This overlay covers exactly that window,
/// and like `PendingSessionSettleStates` it is purely local: a replicating
/// write here would clear attention on the HOST, which is precisely the state
/// the phone must never fabricate.
///
/// The safety rule is the REVERSE of the settle overlay's. A stale "Needs you"
/// is a nuisance; a hidden one loses the agent that is waiting. So this overlay
/// is deliberately timid:
///
/// - it is keyed to the exact attention row the user answered, so the instant
///   the host's row differs in any way — the clear we predicted, or a fresh ask
///   from an agent that raised its hand again — the overlay goes inert and the
///   host's row shows through unmodified. Newer host state always wins;
/// - its backstop is short, and unlike the settle overlay's it is never held
///   open while the host is unreachable. An unreachable host is exactly when a
///   suppression must lapse rather than persist.
struct PendingAttentionClearIntent: Equatable {
  /// The attention columns as the host had them when the user answered. This is
  /// the key: the overlay applies only while the row still reads exactly this.
  struct Baseline: Equatable {
    var pendingInputItemId: String?
    var attentionRequestedAt: String?
    var attentionSource: String?

    init(_ session: TerminalSessionSummary) {
      pendingInputItemId = PendingAttentionClearIntent.normalized(session.pendingInputItemId)
      attentionRequestedAt = PendingAttentionClearIntent.normalized(session.attentionRequestedAt)
      attentionSource = PendingAttentionClearIntent.normalized(session.attentionSource)
    }

    /// Whether this row is asking for the user at all. There is nothing to
    /// suppress otherwise, and an overlay begun over a calm row would be a
    /// suppression lying in wait for the NEXT, genuine ask.
    var hasAttention: Bool {
      pendingInputItemId != nil
        || attentionRequestedAt != nil
        || attentionSource == "provider_structured"
    }
  }

  var baseline: Baseline
  /// When the user answered, on the MONOTONIC clock
  /// (`ProcessInfo.processInfo.systemUptime`), for the staleness backstop —
  /// same reasoning as `PendingSessionSettleIntent.startedAtUptime`: a clock
  /// correction must not expire a fresh overlay or extend a spent one.
  var startedAtUptime: TimeInterval
  fileprivate var token: UInt64 = 0

  /// Whether the host's row is still the ask the user answered.
  func matches(_ session: TerminalSessionSummary) -> Bool {
    Baseline(session) == baseline
  }

  func applied(to session: TerminalSessionSummary) -> TerminalSessionSummary {
    guard matches(session) else { return session }
    var next = session
    next.pendingInputItemId = nil
    next.attentionRequestedAt = nil
    next.attentionSource = nil
    return next
  }

  fileprivate static func normalized(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
    return trimmed
  }
}

/// The set of in-flight attention clears, keyed by session id. A plain value
/// type with no I/O, for the same reason `PendingSessionSettleStates` is one:
/// this state must never touch SQLite and so can never replicate.
struct PendingAttentionClearStates: Equatable {
  /// Short on purpose. This is a bridge across ONE changeset, and every extra
  /// second is a second in which a genuine ask could be hidden.
  /// `PendingSessionSettleStates` can afford 20s because its failure mode is a
  /// row that looks filed; this one's is a row that looks calm while an agent
  /// waits for an answer.
  static let staleAfter: TimeInterval = 8

  private var intents: [String: PendingAttentionClearIntent] = [:]
  private var nextToken: UInt64 = 0

  init() {}

  var isEmpty: Bool { intents.isEmpty }

  subscript(sessionId: String) -> PendingAttentionClearIntent? { intents[sessionId] }

  /// Begin an overlay for a session whose ask the user has just answered.
  /// Returns `0` — and records nothing — when the row is not asking for
  /// anything, so an ordinary message into a calm chat leaves no suppression
  /// behind for a later ask to run into.
  @discardableResult
  mutating func begin(
    for sessionId: String,
    baseline: TerminalSessionSummary?,
    uptime: TimeInterval
  ) -> UInt64 {
    guard let baseline else { return 0 }
    let snapshot = PendingAttentionClearIntent.Baseline(baseline)
    guard snapshot.hasAttention else { return 0 }
    nextToken &+= 1
    intents[sessionId] = PendingAttentionClearIntent(
      baseline: snapshot,
      startedAtUptime: uptime,
      token: nextToken
    )
    return nextToken
  }

  /// Drop an overlay by token, so a stale caller cannot retire one the user has
  /// since replaced. Mirrors `PendingSessionSettleStates.clear(_:token:)`.
  mutating func clear(_ sessionId: String, token: UInt64) {
    guard intents[sessionId]?.token == token else { return }
    intents.removeValue(forKey: sessionId)
  }

  /// Forget everything in flight — used when the ground the overlay refers to
  /// moves (project switch, unpair), where the session ids it holds no longer
  /// describe what is on screen.
  mutating func removeAll() {
    intents.removeAll()
  }

  /// Retire overlays the host has overtaken, plus any that outlived the
  /// backstop. Sessions absent from `sessions` are left alone: a partial or
  /// scoped read is not the host disagreeing.
  ///
  /// Returns whether anything was retired, so the caller can repaint — an
  /// expiry changes what the row should show with no database write to notice.
  @discardableResult
  mutating func prune(against sessions: [TerminalSessionSummary], uptime: TimeInterval) -> Bool {
    guard !intents.isEmpty else { return false }
    let before = intents.count
    for session in sessions {
      guard let intent = intents[session.id] else { continue }
      // The row has moved off the ask the user answered — either the clear this
      // overlay was predicting, or a brand-new ask from an agent that raised its
      // hand again. Either way the host is now the better answer, so the local
      // guess retires rather than lingering as a suppression that a later
      // identical-looking row could re-activate.
      guard !intent.matches(session) else { continue }
      intents.removeValue(forKey: session.id)
    }
    intents = intents.filter { entry in
      uptime - entry.value.startedAtUptime < PendingAttentionClearStates.staleAfter
    }
    return intents.count != before
  }

  func apply(to session: TerminalSessionSummary) -> TerminalSessionSummary {
    guard let intent = intents[session.id] else { return session }
    return intent.applied(to: session)
  }

  func apply(to sessions: [TerminalSessionSummary]) -> [TerminalSessionSummary] {
    guard !intents.isEmpty else { return sessions }
    return sessions.map { apply(to: $0) }
  }
}
