import Foundation

/// The one remote action every plugin interaction on the phone rides.
///
/// Registered host-side alongside the other `plugins.*` commands in
/// `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts`. A single
/// generic action is a compile-time requirement, not a style choice: iOS gates
/// outbound commands against an allowlist of action strings it was built with
/// (`requireInvokableRemoteAction`), so a plugin installed after this build
/// shipped could never name its own action and be let through. The plugin's
/// action lives in `actionId` inside the payload instead, where it needs no
/// client-side vocabulary at all.
let pluginInvokeRemoteAction = "plugins.invoke"

/// Reply from `plugins.presenceList` — the attached machine reporting its own
/// installs. Shapes match `PluginPresenceRow` in
/// `apps/ade-cli/src/services/plugins/pluginTableWriters.ts`.
struct PluginPresenceListResult: Decodable, Equatable {
  var plugins: [PluginPresenceListEntry] = []

  private enum CodingKeys: String, CodingKey {
    case plugins
  }

  init(plugins: [PluginPresenceListEntry] = []) {
    self.plugins = plugins
  }

  init(from decoder: Decoder) throws {
    guard let container = try? decoder.container(keyedBy: CodingKeys.self) else { return }
    plugins = (try? container.decodeIfPresent([PluginPresenceListEntry].self, forKey: .plugins)) ?? []
  }
}

struct PluginPresenceListEntry: Decodable, Equatable, Identifiable {
  var id: String { pluginId }
  var pluginId: String = ""
  var version: String = ""
  var enabled: Bool = false
  var displayName: String = ""
  var icon: String = ""
  var accent: String = ""

  private enum CodingKeys: String, CodingKey {
    case pluginId, version, enabled, displayName, icon, accent
  }

  init(pluginId: String, version: String = "", enabled: Bool = true, displayName: String = "", icon: String = "", accent: String = "") {
    self.pluginId = pluginId
    self.version = version
    self.enabled = enabled
    self.displayName = displayName
    self.icon = icon
    self.accent = accent
  }

  /// Every field guarded, the way `AgentChatAdeCardPayload` decodes: this
  /// payload crosses from a machine that may be running a newer ADE, and a
  /// field it added must not cost the phone the whole list.
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    pluginId = (try? container.decodeIfPresent(String.self, forKey: .pluginId)) ?? ""
    version = (try? container.decodeIfPresent(String.self, forKey: .version)) ?? ""
    enabled = (try? container.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
    displayName = (try? container.decodeIfPresent(String.self, forKey: .displayName)) ?? ""
    icon = (try? container.decodeIfPresent(String.self, forKey: .icon)) ?? ""
    accent = (try? container.decodeIfPresent(String.self, forKey: .accent)) ?? ""
  }

  var label: String {
    displayName.isEmpty ? pluginId : displayName
  }
}

/// Reply from `plugins.invoke`.
///
/// Deliberately near-empty and never a decode failure. What a plugin action
/// returns is the plugin's business, and the phone's contract with it is only
/// "did this run, and is there a sentence to show". A handler that answers with
/// a bare `true`, an unexpected object, or nothing at all still resolves to a
/// success here — the throw path is reserved for transport and policy errors,
/// which are the ones a user can act on.
struct PluginInvokeResult: Decodable, Equatable {
  var ok = true
  var message: String?

  private enum CodingKeys: String, CodingKey {
    case ok, message, error
  }

  init(ok: Bool = true, message: String? = nil) {
    self.ok = ok
    self.message = message
  }

  init(from decoder: Decoder) throws {
    guard let container = try? decoder.container(keyedBy: CodingKeys.self) else { return }
    ok = (try? container.decodeIfPresent(Bool.self, forKey: .ok)) ?? true
    if let message = (try? container.decodeIfPresent(String.self, forKey: .message)) ?? nil {
      self.message = message
    } else if let error = (try? container.decodeIfPresent(String.self, forKey: .error)) ?? nil {
      self.message = error
      ok = false
    }
  }
}

/// What the root sheet is showing. `panelId` nil means "this plugin's panel
/// list", which is where an entry with several panels lands.
struct PluginPaneRequest: Identifiable, Equatable {
  var id: String { "\(pluginId)|\(panelId ?? "")" }
  var pluginId: String
  var panelId: String?
  /// Label carried from the entry point so the sheet has a title before its
  /// first read finishes.
  var title: String

  init(pluginId: String, panelId: String? = nil, title: String) {
    self.pluginId = pluginId
    self.panelId = panelId
    self.title = title
  }
}
