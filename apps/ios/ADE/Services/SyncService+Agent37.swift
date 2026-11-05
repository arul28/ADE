import Foundation

// The phone's Agent 37 page talks to whichever ADE machine it is connected to,
// through `agent37.read` and `agent37.write`: the same actions as
// `ade agent37` (apps/desktop/src/main/services/agent37/agent37AgentActions.ts).
// The key, the cap and the limits are the account's, so every machine answers
// the same. The phone is the person's own client, so nothing raises a card.

struct Agent37PhoneSleep: Decodable, Equatable {
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

struct Agent37PhoneReadyTag: Decodable, Equatable {
  let projectName: String
  let state: String
}

struct Agent37PhoneMachine: Decodable, Identifiable, Equatable, Hashable {
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
  let sleep: Agent37PhoneSleep?
  let madeByAde: Bool?
  let ready: Agent37PhoneReadyTag?
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

struct Agent37PhoneSpending: Decodable, Equatable {
  let monthlyCapUsd: Double?
  let monthSpentUsd: Double?
  let capReached: Bool
  let capNear: Bool
}

struct Agent37PhoneList: Decodable {
  let machines: [Agent37PhoneMachine]
  let balanceUsd: Double?
  let instanceLimit: Int?
  let runningCount: Int?
  let spending: Agent37PhoneSpending?
}

struct Agent37PhoneLimits: Decodable, Equatable {
  let unattendedSpend: Bool
  let machinesPerDay: Int
  let maxShape: String
  let preset: String
}

struct Agent37PhoneReadyPool: Decodable {
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
struct Agent37PhoneMakeJob: Decodable, Equatable {
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

struct Agent37PhoneMakeStarted: Decodable {
  let requestId: String
}

/// Any answer: the write's own result isn't read, only that it worked.
struct Agent37PhoneAck: Decodable {
  init(from decoder: Decoder) throws {}
}

@MainActor
extension SyncService {
  /// The connected machine can run the Agent 37 page.
  var agent37Supported: Bool { supportsRemoteAction("agent37.read") }

  func agent37Read<T: Decodable>(_ action: String, args: [String: Any] = [:], as type: T.Type) async throws -> T {
    try await sendDecodableCommand(action: "agent37.read", args: ["action": action, "args": args], as: type)
  }

  /// Writes that wait on Agent 37 (a wake, a resize restart) take longer than an ordinary command.
  func agent37Write<T: Decodable>(_ action: String, args: [String: Any] = [:], as type: T.Type) async throws -> T {
    try await sendDecodableCommand(
      action: "agent37.write",
      args: ["action": action, "args": args],
      timeoutNanoseconds: 120 * 1_000_000_000,
      as: type
    )
  }

  /// Whether Agent 37 is set up on the account, for the Work menu item. One
  /// list read; a machine without the command or without a key hides it.
  func refreshAgent37Availability() async {
    guard agent37Supported else {
      agent37Available = false
      return
    }
    do {
      _ = try await agent37Read("list", as: Agent37PhoneList.self)
      agent37Available = true
    } catch {
      agent37Available = false
    }
  }

  /// Wakes the Agent 37 box behind an account machine before the phone dials
  /// it, through the machine the phone is on now. False when it isn't an
  /// Agent 37 box, nothing here can ask, or the wake was refused.
  func wakeAgent37MachineIfNeeded(machineKey: String?) async -> Bool {
    guard let machineKey = syncNonEmpty(machineKey), agent37Supported, connectionState == .connected else { return false }
    do {
      let list = try await agent37Read("list", as: Agent37PhoneList.self)
      guard let box = list.machines.first(where: { $0.machineKey == machineKey }) else { return false }
      if box.isAwake { return true }
      _ = try await agent37Write("wake", args: ["machine": box.instanceId], as: Agent37PhoneAck.self)
      return true
    } catch {
      return false
    }
  }
}
