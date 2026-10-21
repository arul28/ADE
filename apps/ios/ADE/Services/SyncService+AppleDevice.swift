import Foundation

// MARK: - Apple device (watch and control)

/// The `apple.*` commands this phone sends, and which machine each one is
/// about.
///
/// `sendCommand` routes an `apple.*` command by the lane's namespaced id. The
/// capability checks and the video socket do not go through it, so they ask
/// `appleCommandDescriptor` and `appleStreamEndpoint` which machine they are
/// about: a lane on another Mac answers there, never on the focused one.
extension SyncService {
  /// What the machine owning `laneId` advertises for `action`.
  ///
  /// A lane on another machine whose connection is gone answers nil: the
  /// focused machine knows nothing about that lane's device, so falling back
  /// to it would offer a stream or a Control switch it cannot serve.
  private func appleCommandDescriptor(_ action: String, laneId: String?) -> SyncRemoteCommandDescriptor? {
    guard
      let laneId,
      let remote = workParseRemoteLaneId(laneId),
      remote.machineKey != focusedMachineKey
    else { return commandDescriptor(for: action) }
    return machineFleet?.connection(for: remote.machineKey)?.commandDescriptor(for: action)
  }

  /// The fleet connection of a lane on another machine, or nil for a lane of
  /// the focused machine (or one whose machine is not connected).
  private func appleLaneConnection(laneId: String) -> MachineConnection? {
    guard
      let remote = workParseRemoteLaneId(laneId),
      remote.machineKey != focusedMachineKey
    else { return nil }
    return machineFleet?.connection(for: remote.machineKey)
  }

  /// Whether the lane's machine can describe its Apple device at all.
  ///
  /// Feature-detected rather than assumed: `apple.*` is an optional action set,
  /// so a Mac that predates the Apple device environment simply omits it and
  /// the phone's Simulator card says "update the host" instead of putting an
  /// unknown command on the wire behind a poll.
  func supportsAppleDeviceStatus(laneId: String) -> Bool {
    appleCommandDescriptor("apple.status", laneId: laneId) != nil
  }

  /// Whether a stream ticket can be minted. Detected apart from the status read
  /// because a host can know about its device without being able to forward
  /// video to a remote viewer — in that case the card still shows the device
  /// and its last still, and only the live view is withheld.
  func supportsAppleDeviceStream(laneId: String) -> Bool {
    appleCommandDescriptor("apple.streamTicket", laneId: laneId) != nil
  }

  /// Whether the lane's machine lets this phone drive its simulator.
  ///
  /// Both input commands, and both callable from a phone: `apple.input` for
  /// touches and text, `apple.invoke` for the Home button. A host that refuses
  /// either would show a Control switch whose first gesture fails.
  func supportsAppleDeviceControl(laneId: String) -> Bool {
    ["apple.input", "apple.invoke"].allSatisfy { action in
      appleCommandDescriptor(action, laneId: laneId)?.policy.allowsPhone == true
    }
  }

  /// The name of the machine a lane lives on, when it is not the focused one.
  func appleLaneMachineName(laneId: String) -> String? {
    appleLaneConnection(laneId: laneId)?.hostName
  }

  /// The lane's device, app, stream, recording and owner, as one snapshot.
  ///
  /// `disconnectOnTimeout: false` for the same reason `fetchWorkToolsLaneState`
  /// sets it: this is a poll behind a card, and a read-only card must not be
  /// able to drop the user's whole sync connection. It shares the Work tools
  /// timeout, so a slow cellular round trip is dropped and retried, never
  /// escalated into a socket teardown.
  func fetchAppleDeviceStatus(laneId: String) async throws -> AppleDeviceStatus {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard supportsAppleDeviceStatus(laneId: trimmed) else {
      throw appleUnsupportedError(appleDeviceHostUnsupportedMessage)
    }
    return try decode(
      try await sendCommand(
        action: "apple.status",
        args: ["laneId": trimmed],
        disconnectOnTimeout: false,
        timeoutNanoseconds: Self.workToolsRequestTimeoutNanoseconds
      ),
      as: AppleDeviceStatus.self
    )
  }

  /// Mints a short-lived ticket for the binary video socket.
  ///
  /// The host picks the URL for the transport this client is actually on —
  /// direct to the brain's listener, or dialed through the tunnel relay — so
  /// the phone never constructs one from a guess about its own route. Video
  /// never rides this JSON envelope; only the address of the pipe does.
  func requestAppleStreamTicket(laneId: String) async throws -> AppleStreamTicket {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard supportsAppleDeviceStream(laneId: trimmed) else {
      throw appleUnsupportedError(appleDeviceHostUnsupportedMessage)
    }
    return try decode(
      try await sendCommand(
        action: "apple.streamTicket",
        args: ["laneId": trimmed],
        disconnectOnTimeout: false,
        timeoutNanoseconds: Self.workToolsRequestTimeoutNanoseconds
      ),
      as: AppleStreamTicket.self
    )
  }

  /// Where the lane's video socket resolves a ticket path: the live address of
  /// the machine that minted the ticket, and its port for a bare host.
  ///
  /// A ticket is single-use and lives on one brain. Resolving a ticket from
  /// another machine against the focused machine's address dials a brain that
  /// never issued it, which reads to the viewer as an expired pass. A lane on
  /// another machine that is not connected gets no address at all.
  func appleStreamEndpoint(laneId: String) -> (address: String?, fallbackPort: Int) {
    if let remote = workParseRemoteLaneId(laneId), remote.machineKey != focusedMachineKey {
      let connection = appleLaneConnection(laneId: laneId)
      return (connection?.liveAddress, connection?.profile.port ?? 4599)
    }
    return (currentAddress, activeHostProfile?.port ?? 4599)
  }

  /// One gesture or one string of text on the lane's simulator.
  ///
  /// Never queued and never retried: a tap replayed after a reconnect lands
  /// on whatever the device shows by then, which is a different gesture. A
  /// timeout leaves the sync socket alone; the viewer reports the failure and
  /// the person taps again.
  func sendAppleDeviceInput(laneId: String, chatSessionId: String?, input: AppleDeviceInput) async throws {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    try requireAppleControl(laneId: trimmed)
    let (action, args) = input.command(laneId: trimmed, chatSessionId: chatSessionId)
    _ = try await sendCommand(
      action: action,
      args: args,
      disconnectOnTimeout: false,
      timeoutNanoseconds: Self.appleInputTimeoutNanoseconds,
      attemptedLiveFailurePolicy: .preserveForManualRetry
    )
  }

  /// Long enough for a drag the host replays at its real duration (up to 2s)
  /// behind a queued tap; short enough that a dead route says so.
  private static let appleInputTimeoutNanoseconds: UInt64 = 8_000_000_000

  private func requireAppleControl(laneId: String) throws {
    guard supportsAppleDeviceControl(laneId: laneId) else {
      throw appleUnsupportedError("Controlling this simulator needs a newer ADE on the Mac.")
    }
  }

  private func appleUnsupportedError(_ message: String) -> NSError {
    NSError(
      domain: "ADE",
      code: 17,
      userInfo: [
        NSLocalizedDescriptionKey: message,
        "ADEErrorCode": "unsupported_action",
      ]
    )
  }
}
