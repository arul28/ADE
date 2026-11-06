import Foundation

// The reads and writes behind Settings › Chat, Providers, Integrations and
// Lanes. Each goes to the connected machine's brain through a remote command
// the phone may call (`syncRemoteCommandService.ts`), and the project-scoped
// ones act on the phone's active project there, the same values the desktop
// Settings page for that tab reads and writes.

// MARK: - Shared copy

/// The notices every machine-backed Settings page shows the same way.
enum SettingsPageCopy {
  static let connectMachine = "Connect a machine to change these."
  static let openProject = "Open a project to change these."

  static func updateADE(on machine: String) -> String {
    "Update ADE on \(machine) to change this here."
  }

  static func queued(on machine: String) -> String {
    "Saved. It reaches \(machine) when it reconnects."
  }
}

// MARK: - Writes

/// How a settings write ended: applied on the machine, or held in the phone's
/// queue (an offline write of a queueable command) to apply when it is back.
enum SettingsWriteOutcome: Equatable {
  case applied
  case queued
}

// MARK: - Project chat settings (`projectConfig.get` / `ai.updateConfig`)

/// One boolean of `ai.chat` in the project's `.ade/local.yaml`, with the same
/// default the desktop's `useChatConfigToggle` gives it.
enum SettingsChatKey: String, CaseIterable {
  case codexPromptSuggestionsEnabled
  case promptSuggestionsEnabled
  case smartDecisionsEnabled
  case smartChatStatusEnabled
  case smartPlainTerminalsEnabled
  case smartSettleNudgeEnabled
  case smartPaletteEnabled
  case smartLaneEmojiEnabled
  case jevZenCreditEnabled
  case claudePluginUiEnabled
  case scheduledWorkPaused

  /// On unless saved as false (true), or off unless saved as true (false).
  var defaultOn: Bool {
    switch self {
    case .promptSuggestionsEnabled, .jevZenCreditEnabled, .claudePluginUiEnabled, .scheduledWorkPaused:
      return false
    default:
      return true
    }
  }

  /// Read from this machine's own `.ade/local.yaml` only, as the brain does.
  var localOnly: Bool { self == .jevZenCreditEnabled }
}

/// Jev's model and effort hint (`ai.chat.modelHintMode`).
enum SettingsModelHintMode: String, CaseIterable {
  case modelAndEffort = "model_and_effort"
  case effortOnly = "effort_only"
  case off

  var title: String {
    switch self {
    case .modelAndEffort: return "Model and effort"
    case .effortOnly: return "Effort only"
    case .off: return "Off"
    }
  }
}

/// The parts of `projectConfig.get` the Settings pages show: `ai.chat` as the
/// brain sees it (shared, then local) and as this machine's local file has it,
/// plus the providers switched off for this project.
struct SettingsProjectChatConfig: Equatable {
  var effective: [String: Bool] = [:]
  var local: [String: Bool] = [:]
  var modelHintMode: SettingsModelHintMode = .modelAndEffort
  var disabledProviders: Set<String> = []

  func isOn(_ key: SettingsChatKey) -> Bool {
    let saved = (key.localOnly ? local : effective)[key.rawValue]
    return key.defaultOn ? saved != false : saved == true
  }

  /// The value a successful save leaves, so a page can keep one snapshot.
  mutating func set(_ key: SettingsChatKey, _ value: Bool) {
    if key.localOnly {
      local[key.rawValue] = value
    } else {
      effective[key.rawValue] = value
      local[key.rawValue] = value
    }
  }

  init() {}

  init(snapshot raw: Any) {
    let root = raw as? [String: Any]
    func chat(_ layer: String) -> [String: Any] {
      ((root?[layer] as? [String: Any])?["ai"] as? [String: Any])?["chat"] as? [String: Any] ?? [:]
    }
    func booleans(_ values: [String: Any]) -> [String: Bool] {
      values.compactMapValues { $0 as? Bool }
    }
    let effectiveChat = chat("effective")
    effective = booleans(effectiveChat)
    local = booleans(chat("local"))
    modelHintMode = (effectiveChat["modelHintMode"] as? String).flatMap(SettingsModelHintMode.init(rawValue:)) ?? .modelAndEffort
    let ai = (root?["effective"] as? [String: Any])?["ai"] as? [String: Any]
    disabledProviders = Set(((ai?["disabledProviders"] as? [Any]) ?? []).compactMap { ($0 as? String)?.lowercased() })
  }
}

// MARK: - Providers (`ai.getStatus`)

/// The slice of `AiSettingsStatus` (desktop `shared/types/config.ts`) the
/// provider list reads. Every field is optional: an older brain omits some.
struct SettingsAiStatus: Decodable, Equatable {
  struct ClaudeAvailability: Decodable, Equatable {
    struct Binary: Decodable, Equatable {
      var present: Bool?
      var version: String?
    }
    struct Auth: Decodable, Equatable {
      var ready: Bool?
    }
    var binary: Binary?
    var auth: Auth?
  }

  struct AvailableProviders: Decodable, Equatable {
    var claude: ClaudeAvailability?
  }

  struct Connection: Decodable, Equatable {
    var authAvailable: Bool?
    var runtimeDetected: Bool?
    var runtimeAvailable: Bool?
    var blocker: String?
    var accountEmail: String?
  }

  struct PiInstallation: Decodable, Equatable {
    var installed: Bool?
    var sdkAvailable: Bool?
  }

  var availableProviders: AvailableProviders?
  var providerConnections: [String: Connection]?
  var opencodeBinaryInstalled: Bool?
  var opencodeInventoryError: String?
  var piInstallation: PiInstallation?
}

// MARK: - Integrations

/// `github.getStatus`, the fields the Integrations card shows.
struct SettingsGitHubStatus: Decodable, Equatable {
  var connected: Bool?
  var userLogin: String?
  var authSource: String?
  var credentialStoreUnreadable: Bool?
  /// Present when ADE found a token but could not finish checking it (a JSON
  /// null decodes as nil).
  var authFailure: RemoteJSONValue?
  var repo: GitHubRepoRef?

  var needsAttention: Bool {
    credentialStoreUnreadable == true || authFailure != nil
  }
}

/// `jira.getConnectionStatus`, the fields the Integrations card shows.
struct SettingsJiraStatus: Decodable, Equatable {
  struct Failure: Decodable, Equatable {
    var reason: String?
    var message: String?
  }
  var connected: Bool
  var siteUrl: String?
  var email: String?
  var error: Failure?
}

// MARK: - Lanes (`lanes.getNewLaneDefaults`)

/// `lanes.getNewLaneDefaults` with the git user name the branch pattern
/// presets show (`branchUser`, which `NewLaneDefaultsSnapshot` leaves out).
struct SettingsNewLaneDefaults: Decodable, Equatable {
  var defaults: NewLaneDefaults
  var scope: NewLaneSettingsScope?
  var defaultBranch: String
  var primaryBranch: String?
  /// Absent on a brain that ignores a saved branch pattern.
  var branchPrefix: String?
  var branchUser: String?
}

// MARK: - SyncService

private let settingsStatusTimeout: UInt64 = 35_000_000_000

extension SyncService {
  /// A settings write: never disconnects on a slow answer, and a write that
  /// already reached the machine is not queued again behind the person's back.
  private func sendSettingsWrite(action: String, args: [String: Any]) async throws -> SettingsWriteOutcome {
    let response = try await sendCommand(
      action: action,
      args: args,
      disconnectOnTimeout: false,
      attemptedLiveFailurePolicy: .preserveForManualRetry
    )
    if let payload = response as? [String: Any], payload["queued"] as? Bool == true {
      return .queued
    }
    return .applied
  }

  // Chat

  func fetchProjectChatConfig() async throws -> SettingsProjectChatConfig {
    let raw = try await sendCommand(action: "projectConfig.get", args: [:], disconnectOnTimeout: false)
    if let payload = raw as? [String: Any], payload["queued"] as? Bool == true {
      throw QueuedRemoteCommandError(action: "projectConfig.get")
    }
    return SettingsProjectChatConfig(snapshot: raw)
  }

  /// Merges `values` into the project's `ai.chat`, as the desktop's
  /// `ai.updateConfig({ chat: { … } })` does.
  func updateProjectChatConfig(_ values: [String: Any]) async throws -> SettingsWriteOutcome {
    try await sendSettingsWrite(action: "ai.updateConfig", args: ["chat": values])
  }

  /// This machine's OpenCode Zen sign-in for Jev (`ai.jevStatus`). Nil when
  /// the machine has no Jev, predates the command, or did not answer: the
  /// desktop hides Smart decisions in all three cases.
  func fetchJevZenState() async -> String? {
    guard supportsRemoteAction("ai.jevStatus") else { return nil }
    guard let raw = try? await sendCommand(action: "ai.jevStatus", args: [:], disconnectOnTimeout: false),
          let payload = raw as? [String: Any],
          payload["queued"] as? Bool != true
    else { return nil }
    return payload["zen"] as? String
  }

  // Providers

  /// `ai.getStatus` can take up to the host's 30 s budget; the phone waits a
  /// little longer so the host's own timeout message arrives first.
  ///
  /// The machine files `ai.getStatus` under a project, but the providers it
  /// reports are the machine's own. On the hub no project is open, so the
  /// command names one the machine has open, as the desktop does from any page.
  func fetchAiSettingsStatus() async throws -> SettingsAiStatus {
    let fallback = activeProject == nil ? settingsMachineWideProject : nil
    return try await sendDecodableCommand(
      action: "ai.getStatus",
      args: [:],
      disconnectOnTimeout: false,
      timeoutNanoseconds: settingsStatusTimeout,
      targetProjectId: fallback?.id,
      targetProjectRootPath: fallback?.rootPath,
      as: SettingsAiStatus.self
    )
  }

  /// A project open on the machine, for a machine-wide read the brain files
  /// under a project. Prefers one already open there.
  private var settingsMachineWideProject: MobileProjectSummary? {
    projects.first { $0.isOpen == true && $0.isAvailable } ?? projects.first { $0.isAvailable }
  }

  // Integrations

  func fetchGitHubSettingsStatus() async throws -> SettingsGitHubStatus {
    try await sendDecodableCommand(
      action: "github.getStatus",
      args: [:],
      disconnectOnTimeout: false,
      timeoutNanoseconds: settingsStatusTimeout,
      as: SettingsGitHubStatus.self
    )
  }

  func fetchJiraSettingsStatus() async throws -> SettingsJiraStatus {
    try await sendDecodableCommand(
      action: "jira.getConnectionStatus",
      args: [:],
      disconnectOnTimeout: false,
      timeoutNanoseconds: settingsStatusTimeout,
      as: SettingsJiraStatus.self
    )
  }

  // Lanes

  func fetchSettingsNewLaneDefaults() async throws -> SettingsNewLaneDefaults {
    try await sendDecodableCommand(
      action: "lanes.getNewLaneDefaults",
      args: [:],
      disconnectOnTimeout: false,
      as: SettingsNewLaneDefaults.self
    )
  }

  /// Saves only the fields given; the brain merges them into the rest.
  func saveNewLaneDefaults(start: LaneStart? = nil, branchPattern: String? = nil) async throws -> SettingsWriteOutcome {
    var defaults: [String: Any] = [:]
    if let start { defaults["start"] = start.commandPayload }
    if let branchPattern { defaults["branchPattern"] = branchPattern }
    return try await sendSettingsWrite(action: "lanes.setNewLaneDefaults", args: ["defaults": defaults])
  }

  /// Nil clears the default template.
  func setDefaultLaneTemplate(_ templateId: String?) async throws -> SettingsWriteOutcome {
    try await sendSettingsWrite(
      action: "lanes.setDefaultTemplate",
      args: ["templateId": templateId.map { $0 as Any } ?? NSNull()]
    )
  }
}
