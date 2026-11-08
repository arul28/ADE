import Foundation

// The phone's ADE Cloud page talks to whichever ADE machine it is connected to,
// through `cloud.read` and `cloud.write`: the same actions as
// `ade cloud` (apps/desktop/src/main/services/adeCloud/cloudAgentActions.ts).
// ADE Cloud access, the cap and the limits are the account's, so every machine answers
// the same. The phone is the person's own client, so nothing raises a card.

struct CloudPhoneSleep: Decodable, Equatable {
  let state: String
  let afterMinutes: Int?

  var label: String {
    switch state {
    case "auto": return "after \(afterMinutes ?? 10) min idle"
    case "never": return "never"
    default: return "once ADE on it updates"
    }
  }
}

struct CloudPhoneReadyTag: Decodable, Equatable {
  let projectName: String
  let state: String
}

struct CloudPhoneMachine: Decodable, Identifiable, Equatable, Hashable {
  let instanceId: String
  let name: String?
  let machineKey: String?
  let state: String
  let type: String?
  let size: String?
  let shape: String?
  let runningHourlyUsd: Double?
  let idleHourlyUsd: Double?
  let spentUsd: Double?
  let savedUsd: Double?
  let sleep: CloudPhoneSleep?
  let madeByAde: Bool?
  let ready: CloudPhoneReadyTag?
  let pastDue: Bool?

  var id: String { instanceId }
  var displayName: String { name?.isEmpty == false ? name! : instanceId }
  var isVM: Bool { type == "vm" }
  var isAwake: Bool { state == "running" }
  var isAsleep: Bool { state == "asleep" || state == "stopped" }
  var isMoving: Bool { state == "starting" || state == "stopping" || state == "deleting" }

  var stateLabel: String {
    switch state {
    case "running": return "Awake"
    case "asleep": return "Asleep"
    case "starting": return "Waking…"
    case "stopping": return "Going to sleep…"
    case "stopped": return "Stopped"
    case "deleting": return "Deleting…"
    default: return "Needs attention"
    }
  }

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.instanceId == rhs.instanceId && lhs.state == rhs.state && lhs.name == rhs.name
      && lhs.shape == rhs.shape && lhs.spentUsd == rhs.spentUsd && lhs.sleep == rhs.sleep
  }

  func hash(into hasher: inout Hasher) { hasher.combine(instanceId) }
}

struct CloudPhoneSpending: Decodable, Equatable {
  let monthlyCapUsd: Double?
  let monthSpentUsd: Double?
  let capReached: Bool
  let capNear: Bool
}

struct CloudPhoneList: Decodable {
  let machines: [CloudPhoneMachine]
  let runningCount: Int?
  let spending: CloudPhoneSpending?
}

struct CloudPhoneLimits: Decodable, Equatable {
  let unattendedSpend: Bool
  let machinesPerDay: Int
  let maxShape: String
  let preset: String
}

struct CloudPhoneReadyPool: Decodable {
  struct Entry: Decodable, Identifiable, Equatable {
    let identity: String
    let projectName: String
    let keptReady: Bool
    let ready: Int
    let preparing: Int
    let inUse: Int
    let failed: Int
    let failure: String?
    var id: String { identity }
  }
  let projects: [Entry]
}

/// A make, copy or move the phone started in the background (`make_status`).
struct CloudPhoneMakeJob: Decodable, Equatable {
  let requestId: String
  let kind: String
  let stage: String
  let message: String
  let instanceId: String?
  /// While the new machine waits for the person: the sign-in link to approve.
  let approvalUrl: String?
  let done: Bool
  let error: String?

  /// The approval as the phone's own sign-in sheet takes it: the custom-scheme
  /// form, which works whatever host the account service answers from.
  var approvalRequest: DeviceSignInRequest? {
    guard let raw = approvalUrl,
          let components = URLComponents(string: raw),
          let code = components.queryItems?.first(where: { $0.name == "user_code" })?.value,
          let url = URL(string: "ade://device?user_code=\(code)") else { return nil }
    return DeviceSignInRequest(url: url)
  }
}

struct CloudPhoneMakeStarted: Decodable {
  let requestId: String
}

/// Any answer: the write's own result isn't read, only that it worked.
struct CloudPhoneAck: Decodable {
  init(from decoder: Decoder) throws {}
}

@MainActor
extension SyncService {
  /// The connected machine can run the ADE Cloud page.
  var cloudSupported: Bool { supportsRemoteAction("cloud.read") }

  func cloudRead<T: Decodable>(_ action: String, args: [String: Any] = [:], as type: T.Type) async throws -> T {
    try await sendDecodableCommand(action: "cloud.read", args: ["action": action, "args": args], as: type)
  }

  /// Writes that wait on the provider (a wake, a resize restart) take longer than an ordinary command.
  func cloudWrite<T: Decodable>(_ action: String, args: [String: Any] = [:], as type: T.Type) async throws -> T {
    try await sendDecodableCommand(
      action: "cloud.write",
      args: ["action": action, "args": args],
      timeoutNanoseconds: 120 * 1_000_000_000,
      as: type
    )
  }

  /// Whether the provider is set up on the account, for the Work menu item. One
  /// list read; a machine without the command or without access hides it.
  func refreshCloudAvailability() async {
    guard cloudSupported else {
      cloudAvailable = false
      return
    }
    do {
      _ = try await cloudRead("list", as: CloudPhoneList.self)
      cloudAvailable = true
    } catch {
      cloudAvailable = false
    }
  }

  /// Wakes the cloud box behind an account machine before the phone dials
  /// it, through the machine the phone is on now. False when it isn't an
  /// cloud box, nothing here can ask, or the wake was refused.
  func wakeCloudMachineIfNeeded(machineKey: String?) async -> Bool {
    guard let machineKey = syncNonEmpty(machineKey), cloudSupported, connectionState == .connected else { return false }
    do {
      let list = try await cloudRead("list", as: CloudPhoneList.self)
      guard let box = list.machines.first(where: { $0.machineKey == machineKey }) else { return false }
      if box.isAwake { return true }
      _ = try await cloudWrite("wake", args: ["machine": box.instanceId], as: CloudPhoneAck.self)
      return true
    } catch {
      return false
    }
  }
}
