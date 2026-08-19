import Foundation

/// The wake prompt's own behaviour, split out of SyncService.swift so the
/// service file is not the place you go to read a four-method state machine.
/// The `@Published` state it drives stays on the class; everything here is the
/// logic that moves it.
@MainActor
extension SyncService {
  /// Reads the two local sources the decision compares, keeping the decision
  /// itself a pure function the tests can drive directly.
  func navigationMachineKey(
    rawMachineKey: String?,
    sessionId: String?
  ) -> String? {
    // Skip the container reads entirely on the common path — a link that names
    // its machine needs neither snapshot.
    if let named = syncNonEmpty(rawMachineKey) { return named }
    guard syncNonEmpty(sessionId) != nil else { return nil }
    return syncNavigationMachineKey(
      rawMachineKey: nil,
      sessionId: sessionId,
      attentionItems: ADESharedContainer.readAttentionSnapshot()?.items ?? [],
      workspaceSnapshot: ADESharedContainer.readWorkspaceSnapshot()
    )
  }

  /// Answers the live wake prompt. `wake` false is "Not now".
  func resolveMachineWake(_ id: UUID, wake: Bool) {
    guard pendingMachineWake?.id == id else { return }
    if wake {
      // Keep the card up through the dial so the tap has somewhere to land:
      // it becomes the progress, and then either the dismissal or the failure.
      pendingMachineWake?.stage = .waking
    } else {
      pendingMachineWake = nil
    }
    let decision = machineWakeDecision
    machineWakeDecision = nil
    decision?.resume(returning: wake)
  }

  /// Swipe-to-dismiss. Never a silent hang: an abandoned card is a "Not now".
  func cancelPendingMachineWake() {
    if let pending = pendingMachineWake {
      resolveMachineWake(pending.id, wake: false)
      return
    }
    let decision = machineWakeDecision
    machineWakeDecision = nil
    decision?.resume(returning: false)
  }

  /// Clears whatever else is holding the root's single sheet presenter.
  ///
  /// The wake card is the last of four sheets chained onto one presenter, so
  /// with Settings, Activity or Linear already up it simply never appears — and
  /// the navigation awaiting the tap parks for the full prompt timeout with
  /// nothing on screen to answer it. Closing them is the honest trade: the user
  /// asked to open work on another machine, and that question outranks the
  /// sheet they left open.
  /// Returns whether anything was actually up, so the caller only pays a
  /// main-actor hop when a dismissal has to commit first.
  @discardableResult
  func dismissSheetsCompetingWithMachineWake() -> Bool {
    let hadSheet = settingsPresented || attentionDrawerPresented || linearPanePresented
    settingsPresented = false
    attentionDrawerPresented = false
    linearPanePresented = false
    return hadSheet
  }

  /// Shows the prompt and waits for the single tap that answers it.
  func awaitMachineWakeDecision(
    machineName: String,
    need: SyncMachineWakeNeed,
    stage: SyncMachineWakeRequest.Stage
  ) async -> Bool {
    if dismissSheetsCompetingWithMachineWake() {
      // Presenting a fourth sheet in the same turn as a sibling's dismissal is
      // how SwiftUI drops it: the presenter is still animating the one that
      // just closed. Let the dismissal commit first. The prompt timeout stays
      // as the backstop for anything this hop does not cover.
      await Task.yield()
    }
    let id = UUID()
    pendingMachineWake = SyncMachineWakeRequest(
      id: id,
      machineName: machineName,
      need: need,
      stage: stage
    )
    let deadline = Task { @MainActor [weak self] in
      try? await Task.sleep(
        nanoseconds: UInt64(syncMachineWakePromptTimeout * 1_000_000_000)
      )
      guard !Task.isCancelled else { return }
      self?.resolveMachineWake(id, wake: false)
    }
    defer { deadline.cancel() }
    return await withCheckedContinuation { continuation in
      // A second prompt must not strand the first one's task. An overwritten
      // continuation is never resumed, so its navigation hangs forever and
      // `accountNavigationInFlight` is never cleared — every later navigation
      // to that machine then waits on a task that will not finish.
      let displaced = machineWakeDecision
      machineWakeDecision = continuation
      displaced?.resume(returning: false)
    }
  }

  /// Retires an "it's asleep" card once the directory says that machine is
  /// awake again.
  ///
  /// `lastConnectAttemptFailure` is otherwise cleared only by the next
  /// user-initiated attempt, which left the card amber — still naming a
  /// machine, still suppressing the route badge, still offering to wake a Mac
  /// that woke ten minutes ago — for the rest of the session.
  ///
  /// Only the sleep claim expires. The common wake is one where the Mac woke
  /// but the bridge was not ready inside the budget, so the directory reports
  /// it awake seconds later — dropping the whole failure there would erase
  /// "It didn't wake up in time." while the user was still reading it, and a
  /// tap that reports nothing looks like a tap that did nothing. The message
  /// stays until the user acts or a connection succeeds.
  func retireStaleSleepFailure(machines: [AccountMachine], now: Date = Date()) {
    guard syncSleepFailureIsStale(
      failure: lastConnectAttemptFailure,
      machines: machines,
      now: now
    ) else { return }
    retireSleepClaimOnLastConnectAttemptFailure()
  }
}

/// Whether an "it's asleep" failure has been outlived by the directory.
///
/// Only a sleep-flavoured failure expires here: a plain transport failure is
/// still the newest thing that happened and keeps its card. A failure naming a
/// machine the directory no longer lists cannot be checked, so it stays too —
/// silence is not evidence the machine woke.
func syncSleepFailureIsStale(
  failure: SyncConnectAttemptFailure?,
  machines: [AccountMachine],
  now: Date = Date()
) -> Bool {
  guard let failure, failure.machineWasAsleep else { return false }
  guard let machine = syncConnectAttemptFailureMachine(failure, in: machines) else {
    return false
  }
  return syncMachinePresence(
    connected: false,
    online: machine.online,
    sleepState: machine.sleepState,
    sleepStateAt: machineLastSeenDate(epochMilliseconds: machine.sleepStateAt),
    lastSeenAt: machineLastSeenDate(epochMilliseconds: machine.lastSeenAt),
    now: now
  ) != .asleep
}

/// The roster row a failure is about. Identity first, name only as a fallback:
/// two Macs in one account can carry the same name.
func syncConnectAttemptFailureMachine(
  _ failure: SyncConnectAttemptFailure,
  in machines: [AccountMachine]
) -> AccountMachine? {
  if let identity = failure.machineIdentity?
    .trimmingCharacters(in: .whitespacesAndNewlines),
    !identity.isEmpty,
    let byIdentity = machines.first(where: {
      $0.deviceId?.caseInsensitiveCompare(identity) == .orderedSame
    }) {
    return byIdentity
  }
  guard let name = failure.machineName else { return nil }
  return machines.first { $0.displayName == name }
}
