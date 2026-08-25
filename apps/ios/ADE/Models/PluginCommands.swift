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

/// One element of a tolerantly-decoded array: the value, or nil when this
/// element alone failed to decode.
///
/// Its initializer never throws, which is what lets the loop in
/// ``KeyedDecodingContainer/decodeLossyArrayIfPresent(_:forKey:)`` keep
/// advancing past a bad element — an unkeyed container does not move its cursor
/// when `decode` throws, so a plain `try?` there would spin forever.
private struct PluginLossyElement<Value: Decodable>: Decodable {
  let value: Value?

  init(from decoder: Decoder) throws {
    value = try? Value(from: decoder)
  }
}

extension KeyedDecodingContainer {
  /// Decode an array element by element, dropping only the elements that fail.
  ///
  /// `try? decodeIfPresent([T].self)` is all-or-nothing: ONE element a newer
  /// ADE wrote in a shape this build cannot read takes the entire list with it,
  /// and the caller sees "no plugins installed" rather than "one entry I could
  /// not read". Every list on this wire is a list of independent records, so
  /// element-wise is both the honest reading and the one that degrades the way
  /// the rest of this file does.
  ///
  /// Returns nil when the key is ABSENT or explicitly null, and that is not the
  /// same as `[]`: `PluginInstallRecordEntry.sockets` reads absent as "this
  /// host cannot see manifests" and empty as "the manifest declares nothing",
  /// and collapsing the two would drop every published contribution on any host
  /// too old to send the field.
  func decodeLossyArrayIfPresent<Value: Decodable>(
    _ type: Value.Type,
    forKey key: Key
  ) -> [Value]? {
    guard contains(key) else { return nil }
    if (try? decodeNil(forKey: key)) == true { return nil }
    guard var unkeyed = try? nestedUnkeyedContainer(forKey: key) else { return nil }
    var values: [Value] = []
    while !unkeyed.isAtEnd {
      // A throw here is the container itself failing, not one element; stop
      // rather than loop on a cursor that will not move.
      guard let element = try? unkeyed.decode(PluginLossyElement<Value>.self) else { break }
      if let value = element.value { values.append(value) }
    }
    return values
  }
}

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
    plugins = container.decodeLossyArrayIfPresent(PluginPresenceListEntry.self, forKey: .plugins) ?? []
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
  /// What the action asked the chat composer to do with the unsent draft.
  ///
  /// Only a composer has anywhere to put this, so every other caller decodes it
  /// and ignores it. That is the same shape `navigate` has for a caller with no
  /// pane: the verb belongs to the RESPONSE, not to the socket, and a client
  /// that cannot honour one simply does not.
  var composer: PluginInvokeComposerEdit?

  private enum CodingKeys: String, CodingKey {
    case ok, message, error, result, navigate, composer
  }

  init(
    ok: Bool = true,
    message: String? = nil,
    navigate: PluginInvokeNavigation? = nil,
    composer: PluginInvokeComposerEdit? = nil
  ) {
    self.ok = ok
    self.message = message
    self.navigate = navigate
    self.composer = composer
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
      composer = (try? handlerResult.decodeIfPresent(PluginInvokeComposerEdit.self, forKey: .composer)) ?? nil
    }
  }
}

/// What a plugin action asked the composer to do with the user's unsent draft.
/// Mirrors `readPluginActionComposerEdit` in
/// `apps/desktop/src/shared/plugins/sdk.ts`.
///
/// It cannot send the message. Composing and sending stay the user's — the verb
/// writes the text box they were already typing in, on the surface whose button
/// they just pressed, and stops there.
enum PluginInvokeComposerEdit: Decodable, Equatable {
  /// Insert at the caret, leaving the rest of the draft alone.
  case insert(String)
  /// Replace the whole draft. An empty string clears it.
  case replace(String)

  /// Mirrors `PLUGIN_COMPOSER_TEXT_MAX_BYTES`. A liveness bound rather than a
  /// permission: over it the edit is DROPPED, never truncated, because a prompt
  /// cut off mid-sentence and then sent is worse than one that never arrived.
  static let maxBytes = 32 * 1024

  private enum CodingKeys: String, CodingKey {
    case insertText, replaceText
  }

  var text: String {
    switch self {
    case let .insert(text): return text
    case let .replace(text): return text
    }
  }

  /// Throws on anything unrecognizable, which the reader above turns into
  /// `nil`: most action results carry no composer verb at all, so a missing or
  /// malformed one is the normal case and never an error the user sees.
  ///
  /// `replaceText` wins when a plugin sends both — "replace, then insert into
  /// the replacement" is not what either verb means, and picking the more total
  /// one makes the outcome predictable from the payload alone.
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    if let replaceText = (try? container.decodeIfPresent(String.self, forKey: .replaceText)) ?? nil {
      guard replaceText.utf8.count <= Self.maxBytes else {
        throw DecodingError.dataCorruptedError(
          forKey: .replaceText, in: container, debugDescription: "Composer text over the ceiling."
        )
      }
      self = .replace(replaceText)
      return
    }
    // Empty is meaningful for replace (clear the draft) and a no-op for insert,
    // so only replace accepts it.
    let insertText = (try? container.decodeIfPresent(String.self, forKey: .insertText)) ?? nil
    guard let insertText, !insertText.isEmpty, insertText.utf8.count <= Self.maxBytes else {
      throw DecodingError.dataCorruptedError(
        forKey: .insertText, in: container, debugDescription: "No usable composer edit."
      )
    }
    self = .insert(insertText)
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

/// Reply from `plugins.list` — the attached machine reporting its install
/// records, manifest detail and all.
///
/// A DIFFERENT read from `plugins.presenceList`, and the phone needs both. The
/// presence reply answers "is this plugin here", is the one the gate's
/// hide-by-default rules are built on, and rides the frozen `PluginPresenceRow`
/// shape — six columns, no manifest. This one carries `sockets`: the plugin's
/// static socket DECLARATIONS, which live in the manifest on disk and which no
/// phone can otherwise see. Without it iOS renders only what a plugin has
/// PUBLISHED, so a contribution a plugin merely declared is invisible here and
/// visible on desktop.
///
/// Shapes match `SyncPluginInstallRecord` in
/// `apps/ade-cli/src/services/plugins/pluginInstallServiceRef.ts`.
struct PluginInstallListResult: Decodable, Equatable {
  var plugins: [PluginInstallRecordEntry] = []

  private enum CodingKeys: String, CodingKey {
    case plugins
  }

  init(plugins: [PluginInstallRecordEntry] = []) {
    self.plugins = plugins
  }

  init(from decoder: Decoder) throws {
    guard let container = try? decoder.container(keyedBy: CodingKeys.self) else { return }
    plugins = container.decodeLossyArrayIfPresent(PluginInstallRecordEntry.self, forKey: .plugins) ?? []
  }
}

struct PluginInstallRecordEntry: Decodable, Equatable {
  var pluginId: String = ""
  var enabled: Bool = false
  /// Absent means "this host cannot see the manifest" — an older host, or one
  /// with no plugin host bound. Empty is the different, stronger claim that the
  /// manifest was read and declares no sockets.
  ///
  /// **Optional here, deliberately, and the distinction is load-bearing.** The
  /// phone joins published rows against these declarations and drops a row no
  /// declaration matches, exactly as the host does. Collapsing absent into
  /// empty would make that join say "this plugin declares nothing, drop
  /// everything it published" on every host too old to send the field — which
  /// would hide every contribution on the phone instead of falling back.
  var sockets: [PluginManifestSocketWire]?
  /// Manifest socket ids the user switched OFF. A list of what is off rather
  /// than what is on, because contributions are on by default: a reader holding
  /// the declarations but not the toggles would draw contributions the user has
  /// already dismissed.
  var disabledContributions: [String] = []

  private enum CodingKeys: String, CodingKey {
    case pluginId, enabled, sockets, disabledContributions
  }

  init(
    pluginId: String,
    enabled: Bool = true,
    sockets: [PluginManifestSocketWire]? = nil,
    disabledContributions: [String] = []
  ) {
    self.pluginId = pluginId
    self.enabled = enabled
    self.sockets = sockets
    self.disabledContributions = disabledContributions
  }

  /// Every field guarded. This record crosses from a machine that may be
  /// running a newer ADE, and a field it added must not cost the phone the list.
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    pluginId = (try? container.decodeIfPresent(String.self, forKey: .pluginId)) ?? ""
    enabled = (try? container.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
    // Absent stays nil — see the property's own note for why that is a
    // different claim from an empty list — while a single unreadable socket
    // drops only itself.
    sockets = container.decodeLossyArrayIfPresent(PluginManifestSocketWire.self, forKey: .sockets)
    disabledContributions =
      container.decodeLossyArrayIfPresent(String.self, forKey: .disabledContributions) ?? []
  }
}

/// One manifest socket declaration, as it rides the wire.
///
/// A mirror of the manifest entry rather than a projection of the fields any
/// one kind reads, matching `SyncPluginRecordSocket`: which fields matter is per
/// kind — `filter-chip` reads `filterKey`, `file-viewer` reads `extensions` —
/// so a projection is a list that has to grow every time a kind is added, and
/// the failure when it does not is a socket rendering with its label missing.
///
/// `socket` and `surface` stay plain strings for the same reason they do on the
/// wire: this is the wire shape, and a client that predates a kind must be able
/// to receive it and drop it. Narrowing happens in ``PluginSocketDeclarations``.
///
/// **This is a projection of a projection, and it omits five manifest fields on
/// purpose.** `SyncPluginRecordSocket` already drops `description`,
/// `argumentHint` and `section`; this type additionally drops `command` and
/// `dialog`. All five belong exclusively to `slash-command`, `dialog-section`
/// and `settings-section` — the three kinds the phone has no host for — so
/// every kind iOS DOES draw has each field its payload needs.
///
/// What keeps that true is not this comment. It is that
/// `PluginSocketDeclarations.payload(for:wire:)` switches exhaustively over
/// ``PluginSocketKind`` with no `default`, so teaching iOS a new kind fails to
/// compile until someone writes its arm — and writing the arm is where the
/// missing field becomes obvious. **Do not add a `default:` to that switch.**
/// It would turn a build error into a contribution that silently renders with
/// its label missing, which is the failure mode the TypeScript wire type has
/// already hit once.
struct PluginManifestSocketWire: Decodable, Equatable {
  var socket: String = ""
  var surface: String = ""
  var id: String = ""
  var order: Int?
  var label: String?
  var icon: String?
  var panelId: String?
  var actionId: String?
  var extensions: [String] = []
  var filterKey: String?
  /// Extra actions a declared split button carries, mirroring
  /// `SyncPluginRecordSocket.menu`. Empty for every kind that is not one of the
  /// action-button kinds, and for the older hosts that send no `menu` at all.
  var menu: [PluginActionMenuEntry] = []
  /// A declared button's own tint, mirroring `SyncPluginRecordSocket.color`.
  ///
  /// Carried loose, like `menu`: the contrast rule is applied once, by
  /// ``PluginContributionParser/sanitizeActionColor(_:)``, when the declaration
  /// becomes a payload. Nil for every kind that is not an action button, and for
  /// the older hosts that send no `color` at all.
  var color: String?

  private enum CodingKeys: String, CodingKey {
    case socket, surface, id, order, label, icon, panelId, actionId, extensions, filterKey, menu, color
  }

  init(
    socket: String,
    surface: String,
    id: String,
    order: Int? = nil,
    label: String? = nil,
    icon: String? = nil,
    panelId: String? = nil,
    actionId: String? = nil,
    extensions: [String] = [],
    filterKey: String? = nil,
    menu: [PluginActionMenuEntry] = [],
    color: String? = nil
  ) {
    self.socket = socket
    self.surface = surface
    self.id = id
    self.order = order
    self.label = label
    self.icon = icon
    self.panelId = panelId
    self.actionId = actionId
    self.extensions = extensions
    self.filterKey = filterKey
    self.menu = menu
    self.color = color
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    socket = (try? container.decodeIfPresent(String.self, forKey: .socket)) ?? ""
    surface = (try? container.decodeIfPresent(String.self, forKey: .surface)) ?? ""
    id = (try? container.decodeIfPresent(String.self, forKey: .id)) ?? ""
    // Through `Double` and the saturating clamp rather than `Int` directly:
    // `order` is a sort key written by another machine, and `Int(_:)` traps —
    // not throws — on anything outside `Int`'s range.
    order = (try? container.decodeIfPresent(Double.self, forKey: .order))
      .flatMap { $0 }
      .flatMap(pluginVocabSaturatingInt)
    label = (try? container.decodeIfPresent(String.self, forKey: .label)) ?? nil
    icon = (try? container.decodeIfPresent(String.self, forKey: .icon)) ?? nil
    panelId = (try? container.decodeIfPresent(String.self, forKey: .panelId)) ?? nil
    actionId = (try? container.decodeIfPresent(String.self, forKey: .actionId)) ?? nil
    extensions = (try? container.decodeIfPresent([String].self, forKey: .extensions)) ?? []
    filterKey = (try? container.decodeIfPresent(String.self, forKey: .filterKey)) ?? nil
    // Whole-array `try?`: a menu whose JSON this build cannot read costs the
    // declaration its extra actions, never its primary one.
    menu = (try? container.decodeIfPresent([PluginActionMenuEntry].self, forKey: .menu)) ?? [] ?? []
    color = (try? container.decodeIfPresent(String.self, forKey: .color)) ?? nil
  }
}
