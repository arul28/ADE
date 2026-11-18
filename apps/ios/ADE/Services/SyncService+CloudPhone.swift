import Foundation

// MARK: - ADE Cloud iPhone

/// The `cloudPhone.status` answer: the account's access to the ADE Cloud
/// iPhone, the plan's minutes this period, and the phone while one is up.
/// `access` is `on`, `soon` (the beta list) or `off` (not set up on the
/// server); `supported` is true only with access `on`.
struct CloudPhoneStatus: Decodable, Equatable {
  struct Minutes: Decodable, Equatable {
    let included: Int
    let used: Int
    let left: Int
  }

  struct Phone: Decodable, Equatable {
    let id: String
    /// `starting`, `ready` or `ended`.
    let state: String
    /// `iphone`, `iphone-pro-max` or `ipad`.
    let device: String
    /// When it became ready, in ms since 1970.
    let readyAt: Double?
    /// While it waits in line for a free phone, in ms since 1970.
    let queueUntil: Double?
    /// `stopped`, `idle`, `time_limit` or `spend_cap`, once it ended.
    let endReason: String?
    /// A sentence about its coming stop, in the last 15 minutes.
    let stopNotice: String?

    private enum CodingKeys: String, CodingKey {
      case id, state, device, readyAt, queueUntil, endReason, stopNotice
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = (try? c.decode(String.self, forKey: .id)) ?? ""
      state = (try? c.decode(String.self, forKey: .state)) ?? "ended"
      device = (try? c.decode(String.self, forKey: .device)) ?? "iphone"
      readyAt = try? c.decodeIfPresent(Double.self, forKey: .readyAt)
      queueUntil = try? c.decodeIfPresent(Double.self, forKey: .queueUntil)
      endReason = try? c.decodeIfPresent(String.self, forKey: .endReason)
      stopNotice = try? c.decodeIfPresent(String.self, forKey: .stopNotice)
    }
  }

  let access: String
  let minutes: Minutes?
  let phone: Phone?
  /// What an agent may call on it; empty without access.
  let capabilities: [String]
  let supported: Bool
  /// Why it is not usable, in the host's words.
  let reason: String?

  var isOn: Bool { access == "on" }
  var isStarting: Bool { phone?.state == "starting" }
  var isReady: Bool { phone?.state == "ready" }

  private enum CodingKeys: String, CodingKey {
    case access, minutes, phone, capabilities, supported, reason
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    access = (try? c.decode(String.self, forKey: .access)) ?? "off"
    minutes = try? c.decodeIfPresent(Minutes.self, forKey: .minutes)
    phone = try? c.decodeIfPresent(Phone.self, forKey: .phone)
    capabilities = (try? c.decode([String].self, forKey: .capabilities)) ?? []
    supported = (try? c.decode(Bool.self, forKey: .supported)) ?? false
    reason = try? c.decodeIfPresent(String.self, forKey: .reason)
  }
}

/// `cloudPhone.view`: the NoMac page that shows the phone, signed for this
/// account. `expiresAt` is ms since 1970.
struct CloudPhoneViewLink: Decodable, Equatable {
  let url: String
  let expiresAt: Double
  /// The link lets the person take control of the phone.
  let control: Bool

  private enum CodingKeys: String, CodingKey { case url, expiresAt, control }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    url = try c.decode(String.self, forKey: .url)
    expiresAt = (try? c.decode(Double.self, forKey: .expiresAt)) ?? 0
    control = (try? c.decode(Bool.self, forKey: .control)) ?? true
  }
}

private struct CloudPhoneStopAnswer: Decodable {
  let stopped: Bool
}

private struct CloudPhoneScreenshotAnswer: Decodable {
  let artifactId: String?
}

@MainActor
extension SyncService {
  /// An ordinary read or a stop: the phone answers the status page quickly.
  static let cloudPhoneRequestTimeoutNanoseconds: UInt64 = 20_000_000_000

  /// A start can wait in line for a free phone for up to 6 minutes.
  static let cloudPhoneStartTimeoutNanoseconds: UInt64 = 380_000_000_000

  /// Files the screenshot and downloads it on the host, so it takes longer.
  static let cloudPhoneScreenshotTimeoutNanoseconds: UInt64 = 60_000_000_000

  /// The machine the chat runs on advertises the ADE Cloud iPhone.
  func supportsCloudPhone(sessionId: String) -> Bool {
    supportsChatRemoteAction("cloudPhone.status", sessionId: sessionId)
  }

  /// The phone's state, the minutes left, and what agents can do with it.
  func fetchCloudPhoneStatus(sessionId: String) async throws -> CloudPhoneStatus {
    try decode(
      try await sendCloudPhoneCommand(
        "cloudPhone.status",
        args: [:],
        sessionId: sessionId,
        timeoutNanoseconds: Self.cloudPhoneRequestTimeoutNanoseconds
      ),
      as: CloudPhoneStatus.self
    )
  }

  /// A fresh link to the live phone, a control link by default.
  func fetchCloudPhoneView(sessionId: String, control: Bool = true) async throws -> CloudPhoneViewLink {
    try decode(
      try await sendCloudPhoneCommand(
        "cloudPhone.view",
        args: ["control": control],
        sessionId: sessionId,
        timeoutNanoseconds: Self.cloudPhoneRequestTimeoutNanoseconds
      ),
      as: CloudPhoneViewLink.self
    )
  }

  /// Starts the account's phone, or reuses the one already up.
  func startCloudPhone(sessionId: String, device: String? = nil) async throws {
    var args: [String: Any] = [:]
    if let device { args["device"] = device }
    _ = try await sendCloudPhoneCommand(
      "cloudPhone.start",
      args: args,
      sessionId: sessionId,
      timeoutNanoseconds: Self.cloudPhoneStartTimeoutNanoseconds
    )
  }

  /// Stops the account's phone. Its apps and their data go; the workspace stays.
  @discardableResult
  func stopCloudPhone(sessionId: String) async throws -> Bool {
    try decode(
      try await sendCloudPhoneCommand(
        "cloudPhone.stop",
        args: [:],
        sessionId: sessionId,
        timeoutNanoseconds: Self.cloudPhoneRequestTimeoutNanoseconds
      ),
      as: CloudPhoneStopAnswer.self
    ).stopped
  }

  /// Takes a full-size screenshot and files it in the chat's proof drawer.
  /// Answers the proof's id, or nil when it could not be filed.
  @discardableResult
  func captureCloudPhoneScreenshot(sessionId: String) async throws -> String? {
    try decode(
      try await sendCloudPhoneCommand(
        "cloudPhone.screenshot",
        args: ["chatSessionId": sessionId],
        sessionId: sessionId,
        timeoutNanoseconds: Self.cloudPhoneScreenshotTimeoutNanoseconds
      ),
      as: CloudPhoneScreenshotAnswer.self
    ).artifactId
  }

  /// One `cloudPhone.*` command, sent to the machine the chat runs on: a chat
  /// of another project on this machine, or of any project on another one.
  /// The phone is machine-wide there, so its own commands carry no lane.
  private func sendCloudPhoneCommand(
    _ action: String,
    args: [String: Any],
    sessionId: String,
    timeoutNanoseconds: UInt64
  ) async throws -> Any {
    guard supportsChatRemoteAction(action, sessionId: sessionId) else {
      throw NSError(
        domain: "ADE",
        code: 17,
        userInfo: [
          NSLocalizedDescriptionKey: "The machine this chat runs on needs a newer ADE to show the ADE Cloud iPhone.",
          "ADEErrorCode": "unsupported_action",
        ]
      )
    }
    let scope = chatCommandScope(for: sessionId)
    return try await sendCommand(
      action: action,
      args: args,
      disconnectOnTimeout: false,
      timeoutNanoseconds: timeoutNanoseconds,
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
    )
  }
}
