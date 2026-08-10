import Foundation

/// A settle-family change the phone has sent to the host and is still waiting on.
///
/// The phone does not write the settle columns into its replica — they are
/// host-authoritative, and a replicating write can defeat a host rejection by
/// CRDT merge. See the invariant in
/// `docs/features/terminals-and-sessions/README.md` ("Gotchas") for the full
/// argument. This overlay is what replaces that write: purely local, applied
/// when session rows are read, so the row responds immediately while the
/// command is in flight and nothing leaves the device.
///
/// `settle_source` is deliberately absent. No iOS surface reads it, so
/// overlaying it would buy nothing and only add a value to guess wrong.
struct PendingSessionSettleIntent: Equatable {
  /// The three things a settle-family command can ask for. Modelled as a closed
  /// set rather than per-column optionals so an intent cannot be built that
  /// means nothing, and so each one's confirmation rule is stated once.
  enum Kind: Equatable {
    /// `timestamp` is only what we display while waiting; the host stamps its own.
    case settle(timestamp: String)
    case unsettle
    case override(String?)
  }

  var kind: Kind
  /// When the command was sent, for the staleness backstop.
  var startedAt: Date
  /// Identifies this specific command, so a slow one's failure cannot retire an
  /// intent the user has since replaced. Assigned by `begin`.
  fileprivate var token: UInt64 = 0
  /// The row as it stood when the command was sent, and whether it has moved
  /// since. Matching the intent is not enough on its own: two commands can
  /// overlap (settle, then unsettle before the settle lands), and the newer
  /// one's target value can be exactly what the stale row still holds. Without
  /// a baseline it would confirm against the state it was issued *from* and
  /// retire immediately, letting the first command's changeset paint the row
  /// while the user's later intent is still in flight. `nil` means the row was
  /// unknown at begin, in which case value equality alone has to do.
  fileprivate var baseline: Baseline?
  fileprivate var sawRowChange = false
  /// The override as it was PRESENTED to the user when this command was issued
  /// — the raw row with any intent this one replaced already applied over it.
  /// An unsettle's override branch has to follow what the user acted on, not
  /// the stale row: a settle overlay has already cleared a keep-active pin that
  /// the row still carries, and the host will clear it too when it processes the
  /// commands in order. Outer `nil` means the row was unknown at begin.
  fileprivate var presentedOverride: String??

  struct Baseline: Equatable {
    var settledAt: String?
    var settleOverride: String?
  }

  static func settle(now: Date, timestamp: String) -> PendingSessionSettleIntent {
    PendingSessionSettleIntent(kind: .settle(timestamp: timestamp), startedAt: now)
  }

  static func unsettle(now: Date) -> PendingSessionSettleIntent {
    PendingSessionSettleIntent(kind: .unsettle, startedAt: now)
  }

  static func settleOverride(_ value: String?, now: Date) -> PendingSessionSettleIntent {
    PendingSessionSettleIntent(kind: .override(value), startedAt: now)
  }

  func applied(to session: TerminalSessionSummary) -> TerminalSessionSummary {
    var next = session
    switch kind {
    case .settle(let timestamp):
      // A declared settle also clears any override host-side, including an
      // `"active"` pin — `sessionService.settleMany` / `settleSession` both set
      // `settle_override = null` unconditionally, so that a pin cannot silently
      // veto the settle the user just asked for.
      next.settledAt = timestamp
      next.settleOverride = nil
    case .unsettle:
      next.settledAt = nil
      // The host clears a `"settled"` override and PRESERVES an `"active"` pin
      // (`settle_override = case when settle_override = 'settled' then null else
      // settle_override end`). Which branch it takes is decided by the value in
      // the row when the host gets there, so we can predict it exactly rather
      // than guess — and must, because a row settled purely BY that pin has a
      // null `settled_at` already, so clearing the timestamp alone would show
      // the user nothing at all.
      //
      // `presentedOverride`, not the live row: if this unsettle replaced a
      // settle that has not landed yet, the host will clear the pin as part of
      // that settle, so reading the stale row here would resurrect a pin that
      // is on its way out.
      if let presented = presentedOverride {
        next.settleOverride = presented == "settled" ? nil : presented
      } else if PendingSessionSettleIntent.normalized(session.settleOverride) == "settled" {
        next.settleOverride = nil
      }
    case .override(let value):
      next.settleOverride = value
    }
    return next
  }

  /// Whether the host's replicated row now reflects this intent.
  func isSatisfied(by session: TerminalSessionSummary) -> Bool {
    let settledAt = PendingSessionSettleIntent.normalized(session.settledAt)
    let override = PendingSessionSettleIntent.normalized(session.settleOverride)
    switch kind {
    case .settle:
      // `settled_at` carries the HOST's timestamp, so only its presence is ours
      // to predict — matching the exact string would never resolve. The cleared
      // override is ours to predict, because the host always clears it.
      return settledAt != nil && override == nil
    case .unsettle:
      // A `"settled"` pin still on the row means the host has not applied the
      // unsettle yet, even though `settled_at` may already read null.
      return settledAt == nil && override != "settled"
    case .override(let value):
      // Unlike the settle timestamp, this is an exact value we asked for.
      return override == PendingSessionSettleIntent.normalized(value)
    }
  }

  fileprivate func currentBaseline(of session: TerminalSessionSummary) -> Baseline {
    Baseline(
      settledAt: PendingSessionSettleIntent.normalized(session.settledAt),
      settleOverride: PendingSessionSettleIntent.normalized(session.settleOverride)
    )
  }

  fileprivate static func normalized(_ value: String?) -> String? {
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
  /// it expires rather than lying indefinitely. Measures reachable time, not
  /// wall clock — see `holdBackstop`.
  static let staleAfter: TimeInterval = 20

  private var intents: [String: PendingSessionSettleIntent] = [:]
  private var nextToken: UInt64 = 0

  init() {}

  var isEmpty: Bool { intents.isEmpty }

  subscript(sessionId: String) -> PendingSessionSettleIntent? { intents[sessionId] }

  /// Replaces any intent already in flight for the session: the newest command
  /// is the one the user is waiting on. Returns the token that identifies it.
  @discardableResult
  mutating func begin(
    _ intent: PendingSessionSettleIntent,
    for sessionId: String,
    baseline: TerminalSessionSummary?
  ) -> UInt64 {
    nextToken &+= 1
    var stamped = intent
    stamped.token = nextToken
    stamped.baseline = baseline.map { stamped.currentBaseline(of: $0) }
    // What the user was looking at when they issued this: the row with any
    // intent this one replaces already applied over it.
    stamped.presentedOverride = baseline.map { row in
      PendingSessionSettleIntent.normalized((intents[sessionId]?.applied(to: row) ?? row).settleOverride)
    }
    intents[sessionId] = stamped
    return nextToken
  }

  /// Drop an intent because its command failed. The row snaps back to whatever
  /// the host actually has, which is the honest answer.
  ///
  /// Scoped by token: two commands for one session can overlap (tap "Keep
  /// active", then "Settle" before the first returns), and the loser's failure
  /// must not retire the intent the user is now waiting on.
  mutating func clear(_ sessionId: String, token: UInt64) {
    guard intents[sessionId]?.token == token else { return }
    intents.removeValue(forKey: sessionId)
  }

  /// Forget everything in flight — used when the ground the overlay refers to
  /// moves, e.g. a project or host switch, where the session ids it holds no
  /// longer describe what is on screen.
  mutating func removeAll() {
    intents.removeAll()
  }

  /// Hold every deadline open because the host is unreachable.
  ///
  /// Nothing can confirm an intent while we cannot talk to the host, so ageing
  /// one out would only mean forgetting a command that is still on its way: a
  /// settle taken offline is durably queued by `enqueueOperation` and can sit
  /// for minutes.
  ///
  /// The deadline is sampled at each read rather than integrated, so a flapping
  /// connection can stretch the real elapsed time well past `staleAfter`. That
  /// is the safe direction — the durable queue means the command is still
  /// coming — and it is why `staleAfter` is a backstop rather than a promise.
  ///
  /// Returns nothing on purpose — this can never resolve an intent, so it can
  /// never be a reason to repaint.
  mutating func holdBackstop(now: Date) {
    for key in intents.keys {
      intents[key]?.startedAt = now
    }
  }

  /// Drop intents the host has now confirmed, plus any that outlived the
  /// backstop. Sessions absent from `sessions` are left alone — a partial or
  /// scoped read must not be mistaken for "the host disagrees".
  ///
  /// Returns whether anything was retired, so the caller can repaint — an
  /// expiry changes what the row should show and no database write accompanies
  /// it.
  @discardableResult
  mutating func prune(against sessions: [TerminalSessionSummary], now: Date) -> Bool {
    guard !intents.isEmpty else { return false }
    let before = intents.count
    for session in sessions {
      guard var intent = intents[session.id] else { continue }
      if let baseline = intent.baseline, !intent.sawRowChange {
        if intent.currentBaseline(of: session) != baseline {
          intent.sawRowChange = true
          intents[session.id] = intent
        }
      }
      let movedSinceCommand = intent.baseline == nil || intent.sawRowChange
      guard movedSinceCommand, intent.isSatisfied(by: session) else { continue }
      intents.removeValue(forKey: session.id)
    }
    intents = intents.filter { now.timeIntervalSince($0.value.startedAt) < PendingSessionSettleStates.staleAfter }
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
