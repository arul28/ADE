import Foundation

// ---------------------------------------------------------------------------
// The vocabulary of "is this machine awake, and what do we say about it".
//
// Lifted out of SyncService.swift, which had no business owning a set of pure
// functions two view layers and the navigation guard all read. Everything here
// is free of the service: give it a roster row's facts and it answers.
//
// Two windows live here and they are deliberately different lengths. Read the
// doc comments before collapsing them into one.
// ---------------------------------------------------------------------------

/// Why opening work on a machine should ask before it dials.
enum SyncMachineWakeNeed: Equatable {
  /// Not reachable, but seen recently — a Mac with its lid shut.
  case asleep
  /// Not reachable and not seen in a long time, or never seen.
  case unreachable

  /// Six words or fewer: this is a status line, not an explanation.
  var statusLabel: String {
    switch self {
    case .asleep: return "It\u{2019}s asleep."
    case .unreachable: return "It\u{2019}s offline."
    }
  }
}

/// How recently a machine must have checked in for a *confirm-before-dialling*
/// prompt to read "it's asleep" rather than "it's offline".
///
/// This is the wake question, not the presence question, and it is generous on
/// purpose: the user has just tapped a link that names this machine, dialling it
/// is what wakes it, and the cost of asking "wake it?" about a Mac that turns
/// out to be genuinely gone is one declined prompt. The cost of refusing to ask
/// is a dead link. `syncMachineSleepInferenceWindow` is the far shorter window
/// that governs what we are willing to SAY about a machine nobody asked to open.
let syncMachineRecentlySeenWindow: TimeInterval = 24 * 60 * 60

/// The single place that decides whether a machine is awake enough to open work
/// on without asking.
///
/// An announced `sleepState` outranks everything else here. The directory's
/// `online` flag is computed from heartbeat freshness, so a Mac that shut its
/// lid thirty seconds ago is still "online" — which is exactly how the machine
/// list came to offer "Connect" on a machine that was already dark, and how the
/// failure that followed got blamed on the relay. A host announces its suspend
/// in the beat before it goes down, and believing that announcement over a
/// heartbeat we now know to be stale is the whole point of publishing it.
///
/// Everything else still infers: `awake` tells us nothing `online` does not,
/// and a host that never announced (an older build, or a machine that lost
/// power mid-beat) falls back to presence — offline but seen recently is a lid
/// that was shut, offline and long silent is a machine that is gone.
func syncMachineWakeNeed(
  online: Bool,
  lastSeenAt: Date?,
  sleepState: AccountMachineSleepState? = nil,
  sleepStateAt: Date? = nil,
  now: Date = Date()
) -> SyncMachineWakeNeed? {
  if sleepState == .asleep,
     !syncSleepAnnouncementIsStale(sleepStateAt: sleepStateAt, now: now) {
    return .asleep
  }
  guard !online else { return nil }
  guard let lastSeenAt,
        now.timeIntervalSince(lastSeenAt) <= syncMachineRecentlySeenWindow,
        // A last-seen stamp from the future is a clock skew, not freshness.
        lastSeenAt.timeIntervalSince(now) <= 0 else {
    return .unreachable
  }
  return .asleep
}

/// How long after a machine's last heartbeat we still call its silence "asleep"
/// rather than "offline".
///
/// Mirrors `MACHINE_SLEEP_INFERENCE_WINDOW_MS` in
/// `apps/desktop/src/shared/types/power.ts` and must move with it: the phone,
/// the desktop and the brain are not allowed to disagree about whether a
/// machine is awake. Ten minutes, because past that the honest answer is "we
/// don't know", and a Mac that was powered off six hours ago must not read
/// "Asleep" next to a Wake button that cannot work.
let syncMachineSleepInferenceWindow: TimeInterval = 10 * 60

/// Whether an announced suspend has aged out of being a fact.
///
/// The directory's upsert coalesces `sleep_state`, so it can never write the
/// column back to NULL: a machine that slept and was then downgraded to a build
/// that omits the field — or whose resume announcement was lost — would keep a
/// stored `asleep` forever. Since asleep outranks connected, that pins a
/// reachable machine at "Asleep" with no way back. Bounding the announcement by
/// the same window we infer over is what makes the state recoverable.
///
/// Mirrors `sleepAnnouncementIsStale` in
/// `apps/desktop/src/shared/types/power.ts`, which means all three edges have
/// to agree, not just the window length:
/// - a missing stamp is stale — an announcement we cannot date is not evidence;
/// - a future stamp is clock skew, not age, so it stays fresh;
/// - the boundary is `>=`, so an announcement exactly one window old has
///   already aged out rather than surviving a tick longer on one platform.
func syncSleepAnnouncementIsStale(sleepStateAt: Date?, now: Date = Date()) -> Bool {
  guard let sleepStateAt else { return true }
  return now.timeIntervalSince(sleepStateAt) >= syncMachineSleepInferenceWindow
}

/// What a client shows for a machine, most-alive first. Mirrors
/// `MachinePresence` in `apps/desktop/src/shared/types/power.ts`.
enum SyncMachinePresence: Equatable {
  /// We hold a live channel to it right now.
  case connected
  /// It is heartbeating to the account directory.
  case online
  /// It announced a suspend, or went silent recently enough that sleep is the
  /// only reasonable reading.
  case asleep
  /// Silent long enough that we no longer claim to know.
  case offline
}

/// The single place the presence WORD comes from, mirroring
/// `resolveMachinePresence` on the desktop.
///
/// An announced suspend deliberately outranks `connected`. That ordering IS the
/// bug fix: a channel to a sleeping machine does not report itself closed — the
/// socket simply stops answering, and every layer above keeps rendering the last
/// thing it believed, which is how a phone said "Connected" to a Mac that had
/// been asleep for three minutes. The machine's own "I am going to sleep now",
/// sent while it could still speak, is better evidence than a connection flag
/// that has not yet discovered otherwise. A resume normally republishes `awake`
/// on the next heartbeat — but it is not guaranteed to arrive, and the directory
/// cannot clear the column, so the announcement is age-bounded rather than
/// trusted forever.
func syncMachinePresence(
  connected: Bool,
  online: Bool,
  sleepState: AccountMachineSleepState?,
  sleepStateAt: Date? = nil,
  lastSeenAt: Date?,
  now: Date = Date()
) -> SyncMachinePresence {
  // Bounded, for the reason `syncSleepAnnouncementIsStale` documents: an
  // announcement the directory can never clear must not pin a live machine.
  if sleepState == .asleep,
     !syncSleepAnnouncementIsStale(sleepStateAt: sleepStateAt, now: now) {
    return .asleep
  }
  if connected { return .connected }
  if online { return .online }
  guard let lastSeenAt else { return .offline }
  // A clock skew that puts the heartbeat in the future is still a recent
  // heartbeat, not a reason to call the machine gone — the same reading the
  // desktop takes, and the deliberate difference from `syncMachineWakeNeed`,
  // which refuses to promise a wake on a stamp it cannot trust.
  return now.timeIntervalSince(lastSeenAt) < syncMachineSleepInferenceWindow
    ? .asleep
    : .offline
}

/// Whether a power reading is recent enough to state as a fact.
///
/// A battery level from three days ago is a number, not a fact, and an
/// announced sleep does not refresh the heartbeat that carried the reading —
/// so a machine that suspended and then lost power would otherwise keep
/// reporting a charge it no longer has.
func syncMachinePowerReadingIsFresh(
  directoryOnline: Bool,
  lastSeenAt: Date?,
  now: Date = Date()
) -> Bool {
  if directoryOnline { return true }
  guard let lastSeenAt else { return false }
  return now.timeIntervalSince(lastSeenAt) < syncMachineSleepInferenceWindow
}

/// The one prompt shown when opening work means waking the machine it lives on.
struct SyncMachineWakeRequest: Identifiable, Equatable {
  enum Stage: Equatable {
    /// Waiting on the tap.
    case confirm
    /// Dialling. The dial is what wakes the machine.
    case waking
    /// The attempt ended badly and said why. Retryable from the same card.
    case failed(String)
  }

  let id: UUID
  let machineName: String
  let need: SyncMachineWakeNeed
  var stage: Stage
}

/// What the wake card is allowed to say after a wake attempt failed.
///
/// The attempt failure leads, and reading `lastError` first was the bug: a
/// failed switch restores the connection it interrupted, and that restore
/// clears `lastError` on the way out — once in `publishReconnectStarted` and
/// again on the restore's own `hello_ok`. On this flow's most common shape — a
/// phone attached to one Mac, opening a link that names another — the honest
/// "It didn't wake up in time." was therefore already erased by the time the
/// card asked for it, and the user got a generic line about a wake that had in
/// fact timed out. `SyncConnectAttemptFailure` is the value built to outlive
/// that restore, so it is the one the card reads.
///
/// `lastError` stays as the fallback because the authorization and
/// account-mismatch guards in `pairWithAccountMachine` return without recording
/// an attempt failure at all, and their message is the truest thing available.
func syncWakeRetryFailureMessage(
  attemptFailure: SyncConnectAttemptFailure?,
  lastError: String?
) -> String {
  // `syncNonEmpty` is a SyncService member and this is deliberately a free
  // function, so the same "blank is absent" trim is spelled out here.
  func stated(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty else { return nil }
    return trimmed
  }
  return stated(attemptFailure?.message)
    ?? stated(lastError)
    ?? "Couldn\u{2019}t reach it."
}

/// How long an unanswered wake prompt waits before it reads as "Not now".
///
/// Bounded so a navigation can never park forever behind a card that nothing
/// is on screen to answer.
let syncMachineWakePromptTimeout: TimeInterval = 90
