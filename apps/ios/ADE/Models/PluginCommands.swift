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
  /// Where the action asked the pane to go next, when it asked at all.
  var navigate: PluginInvokeNavigation?

  private enum CodingKeys: String, CodingKey {
    case ok, message, error, result, navigate
  }

  init(ok: Bool = true, message: String? = nil, navigate: PluginInvokeNavigation? = nil) {
    self.ok = ok
    self.message = message
    self.navigate = navigate
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
    // One level down, unlike desktop. `plugins.invoke` answers
    // `{ok, message?, result}` where `result` is the plugin handler's own
    // return — the value `readPluginActionNavigation` is given on the clients
    // that call the handler directly. Reading `navigate` beside `ok` would find
    // the envelope's field, which no plugin writes.
    //
    // A navigation this build cannot use drops on its own; the sentence and the
    // outcome above it are what the user is owed either way.
    if let handlerResult = try? container.nestedContainer(keyedBy: CodingKeys.self, forKey: .result) {
      navigate = (try? handlerResult.decodeIfPresent(PluginInvokeNavigation.self, forKey: .navigate)) ?? nil
    }
  }
}

/// Where an action asked the pane to go next. Mirrors `readPluginActionNavigation`
/// in `apps/desktop/src/shared/plugins/sdk.ts`.
///
/// The panel is named without a plugin: an action can only send the reader to a
/// panel of the plugin whose button they pressed.
struct PluginInvokeNavigation: Decodable, Equatable {
  var panelId: String
  var context: [String: RemoteJSONValue]?

  private enum CodingKeys: String, CodingKey {
    case panelId, context
  }

  init(panelId: String, context: [String: RemoteJSONValue]? = nil) {
    self.panelId = panelId
    self.context = context
  }

  /// Throws on a panel id no link could address either — the whole navigation
  /// goes, because half of one would send the reader nowhere in particular. The
  /// context is the tolerant half and drops by itself.
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let panelId = try container.decode(String.self, forKey: .panelId)
    guard ADEDeepLinkURLParsing.isValidPluginPanelId(panelId) else {
      throw DecodingError.dataCorruptedError(
        forKey: .panelId,
        in: container,
        debugDescription: "Not a panel id."
      )
    }
    self.panelId = panelId
    context = PluginPanelContext.read(
      value: (try? container.decodeIfPresent(RemoteJSONValue.self, forKey: .context)) ?? nil
    )
  }
}

/// The render context a panel is opened with — from a `ade://plugin/…?ctx=`
/// link, or from the `navigate` an action returned.
///
/// Values are ``RemoteJSONValue``, the app's loose-JSON type, rather than
/// `[String: Any]`: it is `Equatable` (which every model holding a context
/// needs) and its decoder keeps a JSON `true` from arriving as the number 1,
/// which an `NSNumber` cast cannot.
enum PluginPanelContext {
  /// Mirrors `PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES` in
  /// `apps/desktop/src/shared/plugins/sdk.ts`.
  static let maxBytes = 2_048

  /// Tolerant by contract: over the ceiling, unparseable, or not an object all
  /// read as absent. Every caller keeps the panel and loses only the context —
  /// dropping it costs a detail, refusing the link costs the page.
  ///
  /// An empty object reads as absent too. There is nothing to render and
  /// nothing to send, and it is what the desktop link builder omits.
  static func read(json raw: String?) -> [String: RemoteJSONValue]? {
    guard let raw, !raw.isEmpty else { return nil }
    // Measured before decoding, so an oversized context is refused rather than
    // expanded first.
    guard raw.utf8.count <= maxBytes, let data = raw.data(using: .utf8) else { return nil }
    return decode(data)
  }

  /// The same reading for a context that arrived already decoded.
  static func read(value: RemoteJSONValue?) -> [String: RemoteJSONValue]? {
    guard case let .object(object) = value, !object.isEmpty else { return nil }
    return json(object) == nil ? nil : object
  }

  /// The same reading for a context that arrived as raw `JSONSerialization`
  /// output, which is what the transcript parser walks.
  static func read(object raw: Any?) -> [String: RemoteJSONValue]? {
    guard let raw,
          JSONSerialization.isValidJSONObject(raw),
          let data = try? adeJSONData(withJSONObject: raw),
          data.count <= maxBytes else {
      return nil
    }
    return decode(data)
  }

  /// The context as the value of a `ctx=` parameter. Keys sort so the same
  /// context always mints the same link.
  static func json(_ context: [String: RemoteJSONValue]) -> String? {
    guard !context.isEmpty,
          let data = try? adeJSONData(withJSONObject: payload(context), options: [.sortedKeys]),
          data.count <= maxBytes else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  /// The context as it rides on an action — under `context`, the field name
  /// `PluginPanelHost.tsx` sends, so a plugin sees one shape wherever the
  /// button was pressed.
  static func payload(_ context: [String: RemoteJSONValue]) -> [String: Any] {
    context.mapValues { foundationObject(from: $0) }
  }

  private static func decode(_ data: Data) -> [String: RemoteJSONValue]? {
    guard let object = try? JSONDecoder().decode([String: RemoteJSONValue].self, from: data),
          !object.isEmpty else {
      return nil
    }
    return object
  }
}

/// What the root sheet is showing: one panel of one plugin, with the context it
/// was opened with.
struct PluginPaneRequest: Identifiable, Equatable {
  /// The panel is part of the identity because two panels of one plugin are two
  /// different sheets — a link into a second panel has to replace the first,
  /// not reuse the store that is already showing another one.
  var id: String { "\(pluginId)|\(panelId ?? "")" }
  var pluginId: String
  /// The panel to open, or nothing to open the plugin whole: the sheet then
  /// picks the first of its panels and offers the rest in its own picker, which
  /// is what the top-bar entry point wants.
  var panelId: String?
  /// Label carried from the entry point so the sheet has a title before its
  /// first read finishes.
  var title: String
  var context: [String: RemoteJSONValue] = [:]
}

/// A plugin link this phone will not open, and the name to say it under.
///
/// Refused out loud rather than dropped: the link already resolved to the
/// machine this phone is attached to, so there is no other computer to offer it
/// to and silence would read as a broken link.
struct PluginLinkRefusal: Identifiable, Equatable {
  let id = UUID()
  var pluginLabel: String
}
