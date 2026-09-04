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

/// The one door a captured sign-in callback comes back through.
///
/// Generic for the same reason `plugins.invoke` is, and narrow for a second
/// one: its only argument is the parameters the provider returned. The host
/// routes them by the `state` it minted, so this action cannot be used to
/// address a particular plugin or a particular flow — only to deliver an answer
/// to whichever flow that host is still holding open.
let pluginCompleteAuthSessionRemoteAction = "plugins.completeAuthSession"

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
  /// Where on the open web the action asked to send the reader.
  ///
  /// The one verb that leaves ADE. `https:` only, and the URL is validated
  /// before it is stored, so a caller opens what was checked rather than what
  /// was sent. Mirrors `readPluginActionOpenUrl` in
  /// `apps/desktop/src/shared/plugins/sdk.ts`.
  var openURL: URL?
  /// Host settings page the action asked to open, when it asked at all.
  ///
  /// Closed list — the same `PLUGIN_OPEN_SETTINGS_ENTRY_IDS` desktop reads.
  /// The phone has no host Settings surface (keys and secrets live on the Mac),
  /// so the pane store turns a recognised id into a sentence rather than a route.
  var openSettings: String?
  /// The plugin's OWN `settings-section` socket id, when it named one instead
  /// of a host page.
  ///
  /// A different question from ``openSettings`` and deliberately a different
  /// field. That one names one of ADE's own pages off a closed list; this one
  /// names a section the plugin itself put on a settings page, so there is no
  /// list to close — but the phone draws no settings surface either way, so
  /// both end as a sentence naming where the thing is. Mirrors the
  /// `{ openSettings: { socketId } }` shape in
  /// `apps/desktop/src/shared/plugins/sdk.ts`.
  var openSettingsSectionId: String?
  /// Which `segmented` controls the action asked to put back on their defaults.
  ///
  /// The explicit reset in the panel-state lifecycle. A plugin that just
  /// archived everything the "Active" filter was showing can put the reader back
  /// on "All" rather than leaving them staring at an empty list they have to
  /// debug. Mirrors `readPluginActionResetState` in `vocabularyState.ts`.
  var resetState: PluginInvokeStateReset?
  /// The one-field question the action asked before it can finish.
  ///
  /// The only verb that comes BACK: the client asks it and then invokes the
  /// SAME action again with the same arguments plus the answer under
  /// `args.prompt`. Mirrors `readPluginActionPrompt` in
  /// `apps/desktop/src/shared/plugins/sdk.ts`.
  var prompt: PluginActionPrompt?
  /// Whether the action asked a question AT ALL, however malformed — true even
  /// when ``prompt`` is nil because the request was refused.
  var askedForPrompt = false

  /// The sign-in the action asked the client to present, already stamped by the
  /// host with the URL to open.
  ///
  /// The plugin's own result named a session and nothing else; everything here
  /// that could send the reader somewhere was filled in by the machine from the
  /// manifest. Mirrors `readPluginActionAuthSession` in
  /// `apps/desktop/src/shared/plugins/sdk.ts`.
  var authSession: PluginInvokeAuthSession?

  /// The plugin PAGE the action asked to open, when it asked at all.
  ///
  /// The page tier's answer to `navigate`. `navigate` names a vocabulary panel
  /// the client draws from a schema; this names a `webview` surface the plugin
  /// draws itself, so the two cannot be one field — a client that can render
  /// one and not the other has to be able to tell them apart. Mirrors the
  /// `{ openWebview: { surfaceId, placement } }` shape in
  /// `apps/desktop/src/shared/plugins/sdk.ts`.
  var openWebview: PluginInvokeOpenWebview?

  private enum CodingKeys: String, CodingKey {
    case ok, message, error, result, navigate, composer, openUrl, openSettings, resetState, prompt, authSession
    case openWebview
  }

  init(
    ok: Bool = true,
    message: String? = nil,
    navigate: PluginInvokeNavigation? = nil,
    composer: PluginInvokeComposerEdit? = nil,
    openURL: URL? = nil,
    openSettings: String? = nil,
    openSettingsSectionId: String? = nil,
    resetState: PluginInvokeStateReset? = nil,
    prompt: PluginActionPrompt? = nil,
    authSession: PluginInvokeAuthSession? = nil,
    openWebview: PluginInvokeOpenWebview? = nil
  ) {
    self.authSession = authSession
    self.openWebview = openWebview
    self.ok = ok
    self.message = message
    self.navigate = navigate
    self.composer = composer
    self.openURL = openURL
    self.openSettings = openSettings
    self.openSettingsSectionId = openSettingsSectionId
    self.resetState = resetState
    self.prompt = prompt
  }

  /// Mirrors `PLUGIN_OPEN_URL_MAX_CHARS`.
  static let maxOpenURLChars = 2_048

  /// The `{openUrl}` verb, read the way every client reads it.
  ///
  /// Accepts both the object form `{"openUrl": {"url": "…"}}` and the bare
  /// string, because a tolerant reader is what keeps four clients agreeing
  /// about a value a plugin wrote by hand.
  ///
  /// Refuses everything that is not `https:`. `file:` would make a link a local
  /// read, `javascript:` and `data:` would make it script, and `ade:` belongs to
  /// `navigate`, which passes the installed-and-enabled gate this would bypass.
  static func parseOpenURL(_ raw: Any?) -> URL? {
    let text: String?
    if let string = raw as? String {
      text = string
    } else if let object = raw as? [String: Any] {
      text = object["url"] as? String
    } else {
      text = nil
    }
    guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty,
          trimmed.count <= maxOpenURLChars,
          let url = URL(string: trimmed),
          url.scheme?.lowercased() == "https",
          let host = url.host, !host.isEmpty else {
      return nil
    }
    return url
  }

  /// Closed list matching `PLUGIN_OPEN_SETTINGS_ENTRY_IDS`.
  static let allowedOpenSettingsEntryIds: Set<String> = ["agents.provider.cursor", "secrets.secrets"]

  /// A plugin's own settings-section socket id, as the manifest parser bounds
  /// one: lowercase letters, digits and dashes, starting with a letter.
  ///
  /// Validated rather than trusted for the same reason the panel id above is.
  /// The value comes out of a plugin's handler, and this one is quoted back at
  /// the reader in a sentence.
  static func parseOpenSettingsSectionId(_ raw: String?) -> String? {
    guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
          ADEDeepLinkURLParsing.isValidPluginPanelId(trimmed) else {
      return nil
    }
    return trimmed
  }

  /// What the phone says when a plugin asks to open its OWN settings section.
  ///
  /// The same shape as ``openSettingsNotice(for:)`` and for the same reason:
  /// the phone draws no settings surface, so naming where the section is beats
  /// inventing a route to somewhere that cannot hold it.
  static let openSettingsOwnSectionNotice =
    "Open this plugin's section in ADE Settings on the Mac that holds it."

  /// The `{openSettings}` verb. Unknown ids drop rather than opening a guessed page.
  static func parseOpenSettings(_ raw: Any?) -> String? {
    let text: String?
    if let string = raw as? String {
      text = string
    } else if let object = raw as? [String: Any] {
      text = object["entryId"] as? String
    } else {
      text = nil
    }
    guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines),
          allowedOpenSettingsEntryIds.contains(trimmed) else {
      return nil
    }
    return trimmed
  }

  /// What the phone says when a plugin asks to open a host settings page.
  ///
  /// The Cursor API key lives on the Mac. Naming the page is the honest
  /// answer; inventing a phone settings route would send the reader nowhere.
  static func openSettingsNotice(for entryId: String) -> String {
    switch entryId {
    case "agents.provider.cursor":
      return "Add a Cursor API key in ADE Settings → Agents → Cursor on the Mac that holds this plugin."
    case "secrets.secrets":
      return "Manage project secrets in ADE Settings → Secrets on the Mac that holds this plugin."
    default:
      return "Open ADE Settings on the Mac that holds this plugin."
    }
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
      // Both shapes the tolerant reader accepts, tried in the same order.
      if let object = (try? handlerResult.decodeIfPresent(PluginOpenURLPayload.self, forKey: .openUrl)) ?? nil {
        openURL = Self.parseOpenURL(object.url)
      } else if let bare = (try? handlerResult.decodeIfPresent(String.self, forKey: .openUrl)) ?? nil {
        openURL = Self.parseOpenURL(bare)
      }
      if let object = (try? handlerResult.decodeIfPresent(PluginOpenSettingsPayload.self, forKey: .openSettings)) ?? nil {
        openSettings = Self.parseOpenSettings(object.entryId)
        // `entryId` first when a payload carries both, the same order the
        // desktop reader uses: it is the older shape and the closed one, so a
        // plugin sending the pair gets the answer that cannot depend on what it
        // has published.
        if openSettings == nil {
          openSettingsSectionId = Self.parseOpenSettingsSectionId(object.socketId)
        }
      } else if let bare = (try? handlerResult.decodeIfPresent(String.self, forKey: .openSettings)) ?? nil {
        openSettings = Self.parseOpenSettings(bare)
      }
      // `true` for every control, or a list of the keys to reset. Anything else
      // is read as "the action said nothing about state", which is what almost
      // every action means.
      if let everything = (try? handlerResult.decodeIfPresent(Bool.self, forKey: .resetState)) ?? nil {
        resetState = everything ? .all : nil
      } else if let keys = (try? handlerResult.decodeIfPresent([String].self, forKey: .resetState)) ?? nil {
        resetState = PluginInvokeStateReset(keys: keys)
      }
      // A question with no usable `id` drops the whole prompt: the answer would
      // come back unattributable, and a handler that cannot tell its own two
      // questions apart is worse off than one that was never asked.
      prompt = (try? handlerResult.decodeIfPresent(PluginActionPrompt.self, forKey: .prompt)) ?? nil
      // The warning half of the pair, mirroring `hasPluginActionPromptRequest`:
      // a question this client refused is a line a caller can say out loud
      // rather than a button that silently does nothing.
      if case .object = (try? handlerResult.decodeIfPresent(RemoteJSONValue.self, forKey: .prompt)) ?? nil {
        askedForPrompt = true
      }
      // A malformed sign-in instruction drops to nil rather than taking the
      // whole result with it, the way every other verb here does — the outcome
      // and the sentence the action wrote are still owed to the reader. The
      // caller says so out loud instead of leaving a Connect button that looks
      // broken.
      authSession = (try? handlerResult.decodeIfPresent(PluginInvokeAuthSession.self, forKey: .authSession)) ?? nil
      // Same tolerance as every verb above: a page request this build cannot
      // read drops to nil and the outcome the action reported still reaches the
      // reader. A phone with no cached page for the plugin falls back to the
      // vocabulary panel rather than refusing the press.
      openWebview = (try? handlerResult.decodeIfPresent(PluginInvokeOpenWebview.self, forKey: .openWebview)) ?? nil
    }
  }
}

/// The `{openWebview}` verb: draw this plugin's own page.
///
/// `surfaceId` names a `webview` surface in the plugin's manifest. `placement`
/// is a REQUEST, not an instruction — the desktop honours `popover`, and a phone
/// has no popover on a compact screen, so it reads the field and then decides
/// for itself. A placement this build does not know reads as the default.
struct PluginInvokeOpenWebview: Decodable, Equatable {
  var surfaceId: String
  var placement: String?
  /// A plugin-authored hint the page reads as `context.pointer`. Labelled apart
  /// from the host's own word about the subject precisely so a page never
  /// mistakes one for the other.
  var pointer: [String: RemoteJSONValue]?

  private enum CodingKeys: String, CodingKey {
    case surfaceId, placement, pointer
  }

  init(surfaceId: String, placement: String? = nil, pointer: [String: RemoteJSONValue]? = nil) {
    self.surfaceId = surfaceId
    self.placement = placement
    self.pointer = pointer
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let raw = try container.decode(String.self, forKey: .surfaceId).trimmingCharacters(in: .whitespacesAndNewlines)
    // The same identifier rule a panel id passes. A surface id is quoted back
    // into a URL host's path, so an unvalidated one is a page opening something
    // the manifest never declared.
    guard ADEDeepLinkURLParsing.isValidPluginPanelId(raw) else {
      throw DecodingError.dataCorruptedError(forKey: .surfaceId, in: container, debugDescription: "invalid surfaceId")
    }
    surfaceId = raw
    placement = (try? container.decodeIfPresent(String.self, forKey: .placement)) ?? nil
    pointer = (try? container.decodeIfPresent([String: RemoteJSONValue].self, forKey: .pointer)) ?? nil
  }
}

/// The `{resetState}` verb: every declared control, or the named ones.
///
/// A closed pair rather than an optional array, so a caller cannot confuse "all
/// of them" with "none of them" — the two answers a bare `[String]?` would have
/// had to carry between them.
enum PluginInvokeStateReset: Equatable {
  case all
  case keys([String])

  /// Named keys, cleaned and capped the way every other list in the vocabulary
  /// is. `nil` when nothing usable survived, because a reset of no keys is not a
  /// reset the plugin can have meant.
  init?(keys raw: [String]) {
    var cleaned: [String] = []
    for entry in raw.prefix(PluginVocabLimits.maxStateKeys) {
      guard let key = PluginPanelParser.parseStateKey(entry), !cleaned.contains(key) else { continue }
      cleaned.append(key)
    }
    guard !cleaned.isEmpty else { return nil }
    self = .keys(cleaned)
  }
}

/// The `{authSession}` verb, as the HOST stamped it: present this sign-in.
///
/// Two halves live behind one field name and only this one reaches a client. A
/// plugin writes `{authSession: {sessionId}}` and nothing more; the machine
/// resolves that id against the manifest's declared flow, mints the `state` it
/// keeps to itself, builds the authorize URL and stamps it here. So `url` is a
/// host-built value, never a plugin-supplied one — which is why a plugin cannot
/// point ADE's sign-in sheet at an origin its manifest never declared.
///
/// Mirrors `PluginActionAuthSession` in `apps/desktop/src/shared/plugins/sdk.ts`.
struct PluginInvokeAuthSession: Decodable, Equatable {
  /// Which callback the client's in-app auth session must watch for. The phone
  /// can only finish `app`; see ``PluginInvokeAuthSession/transport``.
  enum Transport: String, Decodable, Equatable {
    /// The host catches the redirect on `127.0.0.1` itself. Desktop-only: the
    /// phone is not the machine that has the listener open.
    case loopback
    /// The provider is sent to ADE's relay, which bounces the query to the
    /// app's custom scheme for `ASWebAuthenticationSession` to capture.
    case app
  }

  /// The flow's manifest id. Carried for the sentence a client writes and for
  /// logging — it is NOT what the callback is routed by, which is the host's
  /// `state`.
  var sessionId: String
  /// Host-built authorize URL. `https:` and nothing else.
  var url: URL
  var transport: Transport
  /// The scheme to watch for, on the `app` transport. Absent on `loopback`,
  /// where nothing ever sends one and a client watching for a scheme would wait
  /// forever.
  var callbackScheme: String?

  private enum CodingKeys: String, CodingKey {
    case sessionId, url, transport, callbackScheme
  }

  init(sessionId: String, url: URL, transport: Transport, callbackScheme: String? = nil) {
    self.sessionId = sessionId
    self.url = url
    self.transport = transport
    self.callbackScheme = callbackScheme
  }

  /// Throws on anything the client could not act on, so the caller's `try?`
  /// turns a bad instruction into "no sign-in was asked for" rather than a sheet
  /// pointed somewhere unintended.
  ///
  /// `url` is held to the same rule as ``PluginInvokeResult/parseOpenURL(_:)``:
  /// `https:` with a real host. `file:` would make a sign-in a local read,
  /// `javascript:` and `data:` would make it script, and `ade:` would aim the
  /// flow back into the app's own deep links. An unknown `transport` throws too
  /// — a client that guessed would either strand the reader in a browser it
  /// cannot get an answer out of, or watch for a callback nothing will send.
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let sessionId = try container.decode(String.self, forKey: .sessionId)
    guard ADEDeepLinkURLParsing.isValidPluginPanelId(sessionId) else {
      throw DecodingError.dataCorruptedError(
        forKey: .sessionId,
        in: container,
        debugDescription: "Not a plugin identifier."
      )
    }
    self.sessionId = sessionId
    let rawURL = try container.decode(String.self, forKey: .url)
    guard let url = PluginInvokeResult.parseOpenURL(rawURL) else {
      throw DecodingError.dataCorruptedError(
        forKey: .url,
        in: container,
        debugDescription: "Not an https sign-in URL."
      )
    }
    self.url = url
    transport = try container.decode(Transport.self, forKey: .transport)
    // Tolerant, unlike the two above: a blank scheme reads as absent, and the
    // caller decides what a missing one means for the transport it got.
    let scheme = (try? container.decodeIfPresent(String.self, forKey: .callbackScheme)) ?? nil
    let trimmed = scheme?.trimmingCharacters(in: .whitespacesAndNewlines)
    callbackScheme = (trimmed?.isEmpty == false) ? trimmed : nil
  }
}

/// The object form of the `{openUrl}` verb. Its own type only so `Decodable`
/// can tell it apart from the bare-string form.
private struct PluginOpenURLPayload: Decodable, Equatable {
  var url: String
}

/// The object form of the `{openSettings}` verb.
private struct PluginOpenSettingsPayload: Decodable, Equatable {
  /// One of ADE's own pages. Optional because the payload carries either half.
  var entryId: String?
  /// One of the plugin's own `settings-section` sockets.
  var socketId: String?
}

/// One closed choice on a `{prompt}`. The answer's `text` is `value`.
struct PluginActionPromptOption: Equatable {
  var value: String
  var label: String
}

/// The `{prompt}` verb: a one-field question an action asks before it can
/// finish. Mirrors `PluginActionPrompt` in
/// `apps/desktop/src/shared/plugins/sdk.ts`.
///
/// The only verb that comes BACK. A button that answers with one is re-invoked:
/// the client asks the question and calls the SAME action again with the same
/// arguments plus ``answerPayload(text:)`` under `args.prompt`. Cancelling
/// invokes nothing at all.
///
/// **One hop.** A re-invocation's own `{prompt}` is ignored by every client, so
/// a plugin cannot build a wizard out of it and cannot trap the reader in a
/// question it keeps re-opening. A plugin needing a second field has a panel
/// `form`.
struct PluginActionPrompt: Decodable, Equatable {
  /// Mirrors `PLUGIN_PROMPT_TEXT_MAX_BYTES`. Measured in UTF-8 BYTES, like
  /// every other text ceiling on this wire, and REFUSED rather than truncated:
  /// a note cut in half and then saved is worse than one the reader was asked
  /// to shorten.
  static let maxTextBytes = 4 * 1024
  /// Mirrors `PLUGIN_PROMPT_TITLE_MAX_CHARS`.
  static let maxTitleChars = 120
  /// Mirrors `PLUGIN_PROMPT_PLACEHOLDER_MAX_CHARS`.
  static let maxPlaceholderChars = 120
  /// Mirrors `PLUGIN_PROMPT_SUBMIT_LABEL_MAX_CHARS`.
  static let maxSubmitLabelChars = 24

  /// WHICH question this is, echoed back verbatim in the answer. Required: one
  /// action may ask more than one thing across its branches, and a handler that
  /// cannot tell them apart has nowhere to keep the distinction.
  var id: String
  /// The question. Absent means the caller uses the control's own label.
  var title: String?
  /// Grey text in the empty field.
  var placeholder: String?
  /// The confirm button's word. Absent means the client's own default.
  var submitLabel: String?
  /// A plugin-authored pointer, handed back untouched in the answer. Bounded
  /// like a navigation's context and used the same way.
  var context: [String: RemoteJSONValue]?
  /// Closed choices. Non-empty means every client draws a picker and the
  /// answer's `text` is the chosen value. Empty is still one line of free text.
  /// Capped at ``PluginVocabLimits/maxSelectOptions``.
  var options: [PluginActionPromptOption]

  private enum CodingKeys: String, CodingKey {
    case id, title, placeholder, submitLabel, context, options
  }

  init(
    id: String,
    title: String? = nil,
    placeholder: String? = nil,
    submitLabel: String? = nil,
    context: [String: RemoteJSONValue]? = nil,
    options: [PluginActionPromptOption] = []
  ) {
    self.id = id
    self.title = title
    self.placeholder = placeholder
    self.submitLabel = submitLabel
    self.context = context
    self.options = options
  }

  /// Throws only on an unusable `id`, which is the one field the question
  /// cannot be asked without: the answer would be unattributable, and a handler
  /// receiving it could not tell which of its questions was answered. Every
  /// other field is tolerant — a title that is blank, not a string, or past its
  /// ceiling DROPS and the question is still asked, because the caller has the
  /// control's own label to fall back on.
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let id = try container.decode(String.self, forKey: .id)
    // The manifest identifier rule every other plugin id is held to — the same
    // check `navigate.panelId` makes.
    guard ADEDeepLinkURLParsing.isValidPluginPanelId(id) else {
      throw DecodingError.dataCorruptedError(
        forKey: .id,
        in: container,
        debugDescription: "Not a plugin identifier."
      )
    }
    self.id = id
    title = Self.bounded(container, .title, max: Self.maxTitleChars)
    placeholder = Self.bounded(container, .placeholder, max: Self.maxPlaceholderChars)
    submitLabel = Self.bounded(container, .submitLabel, max: Self.maxSubmitLabelChars)
    // Same ceiling and the same tolerance a navigation's context gets: over it,
    // the pointer drops and the question survives.
    context = PluginPanelContext.read(
      value: (try? container.decodeIfPresent(RemoteJSONValue.self, forKey: .context)) ?? nil
    )
    options = Self.readOptions(container)
  }

  /// Trimmed, non-empty, and REFUSED rather than cut past its ceiling. Mirrors
  /// `bounded` in `apps/desktop/src/shared/plugins/parse.ts` — deliberately not
  /// ``PluginPanelParser/cleanString(_:max:)``, which truncates with an
  /// ellipsis. A label the plugin wrote too long is one the client falls back
  /// from, not one it edits.
  private static func bounded(
    _ container: KeyedDecodingContainer<CodingKeys>,
    _ key: CodingKeys,
    max: Int
  ) -> String? {
    guard let raw = (try? container.decodeIfPresent(String.self, forKey: key)) ?? nil else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= max else { return nil }
    return trimmed
  }

  /// Closed choices, first-wins on duplicate values, extras past the select
  /// ceiling dropped. A malformed entry is skipped so one bad lane does not
  /// take the whole question with it.
  private static func readOptions(
    _ container: KeyedDecodingContainer<CodingKeys>
  ) -> [PluginActionPromptOption] {
    guard let raw = (try? container.decodeIfPresent([RemoteJSONValue].self, forKey: .options)) ?? nil
    else { return [] }
    var seen = Set<String>()
    var options: [PluginActionPromptOption] = []
    for entry in raw {
      guard options.count < PluginVocabLimits.maxSelectOptions else { break }
      guard case let .object(object) = entry else { continue }
      guard let value = boundedJSON(object["value"], max: PluginVocabLimits.maxValueChars),
            seen.insert(value).inserted else { continue }
      let label = boundedJSON(object["label"], max: PluginVocabLimits.maxLabelChars)
      options.append(PluginActionPromptOption(value: value, label: label ?? value))
    }
    return options
  }

  private static func boundedJSON(_ value: RemoteJSONValue?, max: Int) -> String? {
    guard case let .string(raw) = value else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= max else { return nil }
    return trimmed
  }

  /// The answer, as the `args.prompt` frame the re-invocation carries. Mirrors
  /// `buildPluginActionPromptAnswer`.
  ///
  /// `nil` past the ceiling: the caller must NOT re-invoke and should say why.
  /// Bytes, not characters — a line of emoji is four times its own length here.
  func answerPayload(text: String) -> [String: Any]? {
    guard text.utf8.count <= Self.maxTextBytes else { return nil }
    var answer: [String: Any] = ["id": id, "text": text]
    if let context, !context.isEmpty {
      answer["context"] = PluginPanelContext.payload(context)
    }
    return answer
  }

  /// Whether an answer of this length may be sent. The alert's confirm button
  /// reads it, so the refusal is visible before the reader presses anything.
  static func acceptsAnswer(_ text: String) -> Bool {
    text.utf8.count <= maxTextBytes
  }
}

/// One question waiting on screen, with what to title it when the plugin named
/// no title of its own.
struct PluginPendingPrompt: Identifiable, Equatable {
  /// Fresh per question, so asking the same question twice re-presents the
  /// alert and clears the field rather than reusing the last answer.
  let id = UUID()
  var prompt: PluginActionPrompt
  /// The control's own label — the fallback title, as on every client.
  var fallbackTitle: String

  /// What the alert is titled: the plugin's question, or the control's label.
  var title: String { prompt.title ?? fallbackTitle }

  /// The confirm button's word. "Done" is the phone's own default, deliberately
  /// plain: the verb belongs to the plugin when it named one.
  var submitLabel: String { prompt.submitLabel ?? "Done" }
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
  /// Where the plugin asked the panel to open, when it named a place at all.
  ///
  /// Read and then honoured by having exactly one place, which is the phone's
  /// honest answer: the sheet IS this device's popover, and it is also its tab
  /// and its side pane. Decoded rather than ignored so a target this build has
  /// never heard of is `nil` — the tolerant reading the desktop's `oneOf` gives
  /// it — and so ``PluginPaneOpening/forTarget(_:)`` is the one switch that has
  /// to be updated when a fourth place is invented.
  var target: PluginInvokeNavigationTarget?

  private enum CodingKeys: String, CodingKey {
    case panelId, context, target
  }

  init(
    panelId: String,
    context: [String: RemoteJSONValue]? = nil,
    target: PluginInvokeNavigationTarget? = nil
  ) {
    self.panelId = panelId
    self.context = context
    self.target = target
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
    // Tolerant, like the context beside it and unlike the panel id above: a
    // target is a preference, not an address, so one this build has never heard
    // of drops and the reader still lands on the panel.
    target = (try? container.decodeIfPresent(PluginInvokeNavigationTarget.self, forKey: .target))
      ?? nil
  }
}

/// The places a plugin may ask a client to put a navigated-to panel.
///
/// Mirrors `PLUGIN_ACTION_NAVIGATION_TARGETS` in
/// `apps/desktop/src/shared/plugins/sdk.ts`. Not a client-specific list: each
/// case names an IDEA of a place, and a client renders it with whatever it has.
enum PluginInvokeNavigationTarget: String, Decodable, Equatable {
  /// A whole surface of its own.
  case tab
  /// Beside the thing the reader was doing — the desktop's Work tools rail.
  case toolsPane = "tools-pane"
  /// Attached to the control that opened it, dismissed by looking away.
  case popover
}

/// How the phone opens a navigated-to panel.
///
/// One case, and a switch rather than an ignore, because that is what makes the
/// next target a compile error here instead of a silently dropped preference.
/// The phone has one place to draw a plugin panel and it is the right answer to
/// all three: a sheet takes the screen the way a tab does, sits over the thing
/// the reader was doing the way a rail pane does, and is dismissed by a
/// downward drag the way a popover is dismissed by a click away.
enum PluginPaneOpening: Equatable {
  case sheet

  static func forTarget(_ target: PluginInvokeNavigationTarget?) -> PluginPaneOpening {
    guard let target else { return .sheet }
    switch target {
    case .tab: return .sheet
    case .toolsPane: return .sheet
    case .popover: return .sheet
    }
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

/// A host settings page a plugin action asked to open, as the phone can answer.
///
/// The desktop NAVIGATES for `{openSettings}`. The phone names the page
/// instead, and that is the honest answer rather than a lesser one: the pages
/// on the closed list are a Mac's own — the Cursor API key and the project
/// secret store both live on the machine that holds the plugin, and inventing a
/// phone route would send the reader somewhere that cannot hold the value.
struct PluginSettingsNotice: Identifiable, Equatable {
  let id = UUID()
  /// An entry id from ``PluginInvokeResult/allowedOpenSettingsEntryIds``, or
  /// nil when the plugin named one of its OWN settings sections instead.
  var entryId: String?
  var pluginLabel: String

  var message: String {
    guard let entryId else { return PluginInvokeResult.openSettingsOwnSectionNotice }
    return PluginInvokeResult.openSettingsNotice(for: entryId)
  }

  /// The plugin's own section, which the phone answers exactly as it answers a
  /// host page: by naming where it is.
  static func ownSection(pluginLabel: String) -> PluginSettingsNotice {
    PluginSettingsNotice(entryId: nil, pluginLabel: pluginLabel)
  }
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
  /// The plugin's rail surfaces, in MANIFEST order, as `toRecordTabs` sends
  /// them — already filtered to the rail kinds and therefore carrying no `kind`
  /// of their own.
  ///
  /// Absent means the same thing it means for ``sockets``: this host could not
  /// read the manifest. The phone then falls back to guessing from the panel
  /// rows, which is what it did everywhere before this field existed.
  var tabs: [PluginManifestTabWire]?
  /// Manifest socket ids the user switched OFF. A list of what is off rather
  /// than what is on, because contributions are on by default: a reader holding
  /// the declarations but not the toggles would draw contributions the user has
  /// already dismissed.
  var disabledContributions: [String] = []

  private enum CodingKeys: String, CodingKey {
    case pluginId, enabled, sockets, tabs, disabledContributions
  }

  init(
    pluginId: String,
    enabled: Bool = true,
    sockets: [PluginManifestSocketWire]? = nil,
    tabs: [PluginManifestTabWire]? = nil,
    disabledContributions: [String] = []
  ) {
    self.pluginId = pluginId
    self.enabled = enabled
    self.sockets = sockets
    self.tabs = tabs
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
    tabs = container.decodeLossyArrayIfPresent(PluginManifestTabWire.self, forKey: .tabs)
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
  /// A declared `composer-action` that claims Send, mirroring
  /// `SyncPluginRecordSocket.ownsSend`.
  ///
  /// On the wire for the same reason `menu` and `color` are: the phone has no
  /// manifest on disk, and the Cursor Cloud launch button is DECLARED and never
  /// published — without this field it drew here as an ordinary button that
  /// invoked on tap while the same button armed Send on the desktop.
  var ownsSend: Bool = false

  private enum CodingKeys: String, CodingKey {
    case socket, surface, id, order, label, icon, panelId, actionId, extensions, filterKey, menu, color, ownsSend
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
    color: String? = nil,
    ownsSend: Bool = false
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
    self.ownsSend = ownsSend
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
    // Strictly the JSON boolean, like every other tolerant read here: a host
    // sending `"ownsSend": 1` leaves Send with ADE rather than handing it to a
    // plugin on a value the desktop would have refused.
    ownsSend = ((try? container.decodeIfPresent(Bool.self, forKey: .ownsSend)) ?? nil) == true
  }
}

/// One rail surface of a plugin's manifest, as `SyncPluginRecordTab` sends it.
///
/// `kind` is absent from a host too old to send it, because `toRecordTabs` used
/// to drop it: the list is already filtered to the rail kinds, so it looked
/// redundant. It is not. This app asks a question those hosts never had to
/// answer — "is this surface a PAGE I can draw, or the panel behind it" — and
/// `kind` is the answer. Absent reads as the panel, which is what those hosts'
/// readers were already showing. ``pluginRailTabSurface(_:)`` still accepts a
/// surface with no kind, exactly as `pluginRailTabSurface` in
/// `shared/plugins/manifest.ts` does.
struct PluginManifestTabWire: Decodable, Equatable {
  var id: String = ""
  var title: String?
  var panelId: String?
  var icon: String?
  var kind: String?
  /// `true` when a `webview` surface's author opted its PAGE into the phone.
  ///
  /// Mirrors `PluginManifestSurface.mobile`, whose default on a webview is
  /// false: a page written for a desktop tab is not a phone screen until its
  /// author says so. Nil therefore means "draw the panel", which is both the
  /// desktop default and what a host too old to send the field intends.
  var mobile: Bool?
  /// `false` when this surface must NOT be listed as a rail tab — the plugin
  /// reaches its page through its own sockets, as `ade-ios-sim` and
  /// `ade-app-control` do. Mirrors `PluginManifestSurface.railTab`.
  ///
  /// Nil on a host too old to send the field, and nil is the tab that host was
  /// already drawing, so the absent case must stay "yes".
  var railTab: Bool?

  private enum CodingKeys: String, CodingKey {
    case id, title, panelId, icon, kind, mobile, railTab
  }

  init(
    id: String,
    title: String? = nil,
    panelId: String? = nil,
    icon: String? = nil,
    kind: String? = nil,
    mobile: Bool? = nil,
    railTab: Bool? = nil
  ) {
    self.id = id
    self.title = title
    self.panelId = panelId
    self.icon = icon
    self.kind = kind
    self.mobile = mobile
    self.railTab = railTab
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = (try? container.decodeIfPresent(String.self, forKey: .id)) ?? ""
    title = (try? container.decodeIfPresent(String.self, forKey: .title)) ?? nil
    panelId = (try? container.decodeIfPresent(String.self, forKey: .panelId)) ?? nil
    icon = (try? container.decodeIfPresent(String.self, forKey: .icon)) ?? nil
    kind = (try? container.decodeIfPresent(String.self, forKey: .kind)) ?? nil
    // A non-boolean `mobile` decodes to nil, which reads as "draw the panel" —
    // the safe half, and the one every older host means.
    mobile = (try? container.decodeIfPresent(Bool.self, forKey: .mobile)) ?? nil
    // A non-boolean `railTab` decodes to nil, which reads as "claims a tab" —
    // the same judgement the desktop parser makes when it warns and ignores.
    railTab = (try? container.decodeIfPresent(Bool.self, forKey: .railTab)) ?? nil
  }
}

/// Kinds that draw as a rail tab. Mirrors `PLUGIN_RAIL_TAB_SURFACE_KINDS`.
///
/// A `webview` is a tab whose page the plugin draws itself; it differs from a
/// `tab` only in what is inside it, so filtering on `tab` alone gave a plugin
/// whose only full-page surface is a webview zero rail tabs.
let pluginRailTabSurfaceKinds: Set<String> = ["tab", "webview"]

/// The ONE surface a plugin's rail tab, its badge address and its default panel
/// all mean: the first in MANIFEST order whose kind is a rail kind.
///
/// A transcription of `pluginRailTabSurface` in `shared/plugins/manifest.ts`,
/// and it has to stay one. Four places used to answer this question three ways
/// — the desktop record, the TUI and this app each had a copy — so a plugin
/// whose webview comes first badged one surface on the desktop and another in
/// the terminal, against the same manifest. A tab badge is addressed by
/// `"<pluginId>/<surfaceId>"`, so those were two different addresses for one
/// pill.
///
/// A surface carrying no `kind` counts as a rail surface, which is what lets
/// the same rule serve a wire list that was already filtered.
///
/// A surface that opted out with `railTab == false` is SKIPPED, and skipped
/// BEFORE the kind is read — the wire drops `kind`, so on this client the
/// opt-out is the only field left that can answer the question. A plugin whose
/// only page opts out has no rail tab here, exactly as it has none on the
/// desktop and none in the terminal.
func pluginRailTabSurface(_ surfaces: [PluginManifestTabWire]?) -> PluginManifestTabWire? {
  for surface in surfaces ?? [] {
    if surface.railTab == false { continue }
    guard let kind = surface.kind else { return surface }
    if pluginRailTabSurfaceKinds.contains(kind) { return surface }
  }
  return nil
}
