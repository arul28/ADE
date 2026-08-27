import SwiftUI

/// The compiled surfaces a plugin can *own* rather than draw.
///
/// A surface listed here is a screen this app already ships — the Linear pane is
/// hand-written SwiftUI, not a plugin panel — but the plugin decides whether it
/// exists at all. Which way that decision runs is the surface's
/// ``PluginBuiltinSurface/presence``: an `.enables` surface exists only while its
/// plugin does, a `.supersedes` surface exists only while its plugin does NOT,
/// because the plugin ships a replacement and the user must never be offered
/// both. Either way the answer reaches every entry point for that screen —
/// button, sheet, deep link, copy-a-link row. A hidden button is not access
/// control, so each entry point checks rather than trusting the one before it.
///
/// The list mirrors `PLUGIN_BUILTIN_SURFACE_IDS` in
/// `apps/desktop/src/shared/plugins/manifest.ts`, which is the source of truth
/// every client validates against — the same hand-mirroring
/// `pluginRowBadgeVisibleLimit` does for `sockets.ts`. Keep the two in step: an
/// id here that no manifest declares gates nothing, and a manifest surface
/// missing here would ship un-gated on the phone.
///
/// Only `linear` and `cursor-cloud` have a screen on iOS today. The rest are
/// listed because the list is closed and shared, not because this app draws
/// them — the phone has no Graph, Review, History, iOS-Simulator or App-Control
/// screen to hide.
enum PluginBuiltinSurface: String, CaseIterable {
  case graph
  case review
  case history
  case linear
  case iosSimulator = "ios"
  case appControl = "app-control"
  case cursorCloud = "cursor-cloud"

  /// The plugin that must be installed and enabled for this surface to exist.
  /// Matches the `name` field of each manifest under `plugins/`, which is the
  /// id `plugins.presenceList` reports.
  var ownerPluginId: String {
    switch self {
    case .graph: return "ade-graph"
    case .review: return "ade-review"
    case .history: return "ade-history"
    case .linear: return "ade-linear"
    case .iosSimulator: return "ade-ios-sim"
    case .appControl: return "ade-app-control"
    case .cursorCloud: return "ade-cursor-cloud"
    }
  }

  /// Which way round the owner plugin and the compiled screen relate.
  ///
  /// Mirrors `PLUGIN_BUILTIN_SURFACE_PRESENCE` in
  /// `apps/desktop/src/shared/plugins/manifest.ts`, and it exists because the
  /// two relationships are opposites and a single boolean cannot carry both.
  ///
  /// See ``PluginSurfacePresence`` for what each polarity means at render time.
  /// The reason a surface picks one rather than the other is a product fact
  /// about who draws the screen: `ade-linear` is the *only* reason a Linear pane
  /// exists at all, while `ade-cursor-cloud` REPLACES a fleet pane this app has
  /// shipped compiled since before the plugin existed. Uninstalling the former
  /// removes a feature; uninstalling the latter must hand the feature back.
  var presence: PluginSurfacePresence {
    switch self {
    case .graph, .review, .history, .linear, .iosSimulator, .appControl:
      return .enables
    case .cursorCloud:
      return .supersedes
    }
  }
}

/// The two directions a plugin can relate to a compiled surface.
///
/// The distinction is entirely about which way the *unknowns* fall, and the
/// unknowns are the common case: a cold launch before the first
/// `plugins.presenceList` reply, a host too old to answer it, a dropped socket,
/// the instant after attaching to a different machine.
enum PluginSurfacePresence: Equatable {
  /// The plugin is the only reason the screen exists. Visible ONLY on a
  /// positive answer — every unknown hides, because an entry point that opens a
  /// screen the attached machine cannot serve reads as a broken app.
  case enables

  /// The plugin REPLACES a screen this app already ships. Visible UNLESS a
  /// positive answer says the owner is installed and enabled — every unknown
  /// shows, because the built-in is what the product has always done and a
  /// machine without the plugin (or a phone that has not heard back yet) must
  /// behave exactly as it did before the plugin existed. Hiding on an unknown
  /// would delete a shipped feature every time the socket blinked.
  case supersedes
}

/// What the gate needs from the sync layer, and nothing more. Narrow on purpose
/// so a test can answer these three without standing up a socket.
@MainActor
protocol PluginPresenceGateSyncing: AnyObject {
  /// Whether the attached machine can answer `plugins.presenceList` at all.
  var supportsPluginPresenceList: Bool { get }

  /// Cheap identity of the answer's scope: which machine, and how many times
  /// plugin rows have changed. A different value means the previous answer
  /// belongs to a different machine or a different install set.
  var pluginPresenceTrigger: String { get }

  func fetchAttachedMachinePlugins() async throws -> PluginPresenceListResult
}

/// Answers one question: is plugin `<id>` installed and enabled on the machine
/// this phone is attached to, right now.
///
/// **Not-installed is the default and every unknown collapses into it.** Before
/// the first reply, after a failed reply, on a host too old to know the action,
/// and the moment the phone attaches to a different machine — all "no". The
/// alternative is an entry point that opens a screen the machine cannot serve,
/// which reads as a broken app rather than as an uninstalled plugin.
///
/// That default is about the PLUGIN, not about pixels, and the two are only the
/// same thing for a surface the plugin `.enables`. A surface the plugin
/// `.supersedes` reads the identical default and draws the opposite way — see
/// ``drawsBuiltin(_:)``, which is what every gated entry point should call.
///
/// Availability comes from the ATTACHED MACHINE, never from the synced
/// `plugin_presence` mirror: that table carries rows for every machine on the
/// account, and the only machine whose screens this phone can open is the one it
/// is talking to. The mirror is still right for labels and colours, which are
/// manifest-derived and identical wherever the plugin is installed.
///
/// One instance per `SyncService` (see `SyncService.pluginPresenceGate`), shared
/// by every gated entry point, so a machine switch costs one round trip rather
/// than one per button.
@MainActor
final class PluginPresenceGate: ObservableObject {
  /// Installed AND enabled on the attached machine, with a usable id. Empty
  /// until a reply says otherwise — see the type comment.
  @Published private(set) var installedPlugins: [PluginPresenceListEntry] = []

  /// Whether `installedPlugins` reflects a real answer for the current trigger
  /// rather than the pre-answer default. Only decisions that cannot be redrawn
  /// later (a deep link is handled once) need to care.
  private(set) var hasAnswer = false

  private let sync: PluginPresenceGateSyncing
  /// Scope the current contents belong to, answered or not — the machine and
  /// install-set the list was resolved against.
  private var resolvedTrigger: String?
  /// In-flight resolve, keyed by the trigger it is resolving, so several
  /// entry points refreshing at once share one round trip — and so a caller
  /// that arrives mid-flight waits for the real answer instead of reading the
  /// default and concluding "not installed".
  private var inFlight: (trigger: String, task: Task<Void, Never>)?

  init(sync: PluginPresenceGateSyncing) {
    self.sync = sync
  }

  /// The render-time answer: whatever is known this instant, defaulting to
  /// hidden. Views call this — a view that renders too early re-renders when the
  /// answer lands, so waiting here would only stall the frame.
  func isInstalled(_ pluginId: String) -> Bool {
    installedPlugins.contains { $0.pluginId == pluginId }
  }

  func owns(_ surface: PluginBuiltinSurface) -> Bool {
    isInstalled(surface.ownerPluginId)
  }

  /// The render-time answer to "is ADE's OWN compiled version of this surface
  /// still part of the product on this phone".
  ///
  /// This is the question every built-in entry point actually has, and it is not
  /// the same question ``owns(_:)`` answers. `owns` says whether the plugin is
  /// there; whether that makes the compiled screen appear or disappear depends
  /// on ``PluginBuiltinSurface/presence``:
  ///
  /// - `.enables` — the plugin is the whole reason the screen exists, so the
  ///   built-in draws only when the plugin is positively known to be installed
  ///   and enabled. Identical to `owns(_:)`, which is why Linear's callers are
  ///   unchanged and can keep calling `owns` directly.
  /// - `.supersedes` — the plugin replaces a screen this app already ships, so
  ///   the built-in draws unless we positively know the plugin is there. Every
  ///   unknown — no answer yet, a host too old to be asked, a failed call, the
  ///   gap right after attaching to another machine — leaves the built-in up,
  ///   because that is exactly how the app behaved before the plugin existed and
  ///   a machine without the plugin must not lose the feature to a slow socket.
  ///
  /// The two are never on screen at once. The plugin's own entry point is drawn
  /// from ``PluginEntryListModel``, which lists nothing until `refresh()` has
  /// filled `installedPlugins` from a real reply — the same list this reads. So
  /// the instant the plugin appears in the entry menu is the instant this starts
  /// returning false for the surface it supersedes, and before that reply the
  /// plugin entry is absent while the built-in is present.
  ///
  /// There is deliberately no `await` twin for `.supersedes`. The one-shot form
  /// exists for decisions with no second chance — a deep link is consumed once —
  /// and iOS has no Cursor Cloud deep link. A view that renders before the answer
  /// lands simply re-renders when it does, because `installedPlugins` is
  /// `@Published`. Add the awaited twin alongside the first such entry point,
  /// not before it.
  func drawsBuiltin(_ surface: PluginBuiltinSurface) -> Bool {
    switch surface.presence {
    case .enables:
      return owns(surface)
    case .supersedes:
      return !owns(surface)
    }
  }

  /// The one-shot answer, for decisions with no second chance: a deep link is
  /// consumed once, so reading the pre-answer default would make the same URL
  /// work or not depending on how fast the socket came up after a cold launch.
  /// Waits for the first real answer, then decides.
  func awaitInstalled(_ pluginId: String) async -> Bool {
    await ensureAnswer()
    return isInstalled(pluginId)
  }

  /// Resolve once per scope, and no more.
  ///
  /// The difference from ``refresh()`` is who pays: `refresh` always re-asks,
  /// which is what a user-visible entry point wants after an install. A caller
  /// that only needs *an* answer — filtering contribution rows down to plugins
  /// this machine actually has — would otherwise spend a round trip every time
  /// a list reappeared, on four surfaces, for an answer that cannot have
  /// changed without moving `pluginPresenceTrigger`.
  func ensureAnswer() async {
    guard !hasAnswer || resolvedTrigger != sync.pluginPresenceTrigger else { return }
    await refresh()
  }

  func awaitOwner(of surface: PluginBuiltinSurface) async -> Bool {
    await awaitInstalled(surface.ownerPluginId)
  }

  /// Re-asks the attached machine. Safe to call from several views at once and
  /// on every trigger change; concurrent calls collapse into one round trip.
  func refresh() async {
    let trigger = sync.pluginPresenceTrigger

    // Attaching to a different machine (or a local install/uninstall) retires
    // the previous answer immediately, before the new one is known. Holding the
    // old list across the gap would show the *previous* machine's plugins on a
    // machine that may not have them — the exact false-positive this gate
    // exists to prevent.
    if trigger != resolvedTrigger {
      installedPlugins = []
      hasAnswer = false
    }

    if let pending = inFlight, pending.trigger == trigger {
      await pending.task.value
      return
    }

    let task = Task { @MainActor in
      await self.resolve(trigger: trigger)
    }
    inFlight = (trigger, task)
    await task.value
    if inFlight?.trigger == trigger {
      inFlight = nil
    }
  }

  private func resolve(trigger: String) async {
    // A host that predates the plugin platform never advertises the action.
    // That is a definitive answer for this host — nothing to wait for — so it
    // counts as answered and every gated entry point simply is not there.
    guard sync.supportsPluginPresenceList else {
      apply(plugins: [], trigger: trigger, answered: true)
      return
    }
    // A failed call clears rather than keeps: `plugins.presenceList` also
    // throws when the machine has no plugin host bound, and an entry that opens
    // a screen the machine can no longer serve is worse than no entry. Left
    // unanswered on purpose so the next one-shot consult retries instead of
    // treating a dropped socket as "uninstalled forever".
    guard let reply = try? await sync.fetchAttachedMachinePlugins() else {
      apply(plugins: [], trigger: trigger, answered: false)
      return
    }
    apply(
      plugins: reply.plugins.filter { $0.enabled && !$0.pluginId.isEmpty },
      trigger: trigger,
      answered: true
    )
  }

  private func apply(plugins: [PluginPresenceListEntry], trigger: String, answered: Bool) {
    // The machine can change while the round trip is out — attach elsewhere and
    // the reply that lands describes a machine this phone is no longer talking
    // to. Drop it; the refresh for the new trigger is already on its way.
    guard sync.pluginPresenceTrigger == trigger else { return }
    installedPlugins = plugins
    resolvedTrigger = trigger
    hasAnswer = answered
  }
}

extension SyncService: PluginPresenceGateSyncing {}
