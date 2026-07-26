import Foundation
import SwiftUI

/// Storage mechanism shared by the Work draft stores: one versioned JSON
/// dictionary in the App Group defaults, small enough to rewrite whole on each
/// save and bounded (LRU by `updatedAt`) so a long-lived install can't grow it
/// without limit.
///
/// Deliberately three free functions rather than a generic store type — the two
/// call sites agree on the *mechanism* but not on the *policy* (key, cap, and
/// what counts as a no-op write all genuinely differ), and a shared type would
/// have to model those differences back out again.
enum WorkDefaultsJSONMap {
  private static var defaults: UserDefaults { ADESharedContainer.defaults }

  /// The stored map, or an empty one when the key is absent or the blob no
  /// longer matches the current shape — restoring a draft must never be able to
  /// fail loudly in a view body.
  static func load<V: Decodable>(_ storageKey: String) -> [String: V] {
    guard let data = defaults.data(forKey: storageKey),
          let decoded = try? JSONDecoder().decode([String: V].self, from: data)
    else { return [:] }
    return decoded
  }

  static func persist<V: Encodable>(_ map: [String: V], under storageKey: String) {
    guard let data = try? JSONEncoder().encode(map) else { return }
    defaults.set(data, forKey: storageKey)
  }

  /// Trims the map to `maxEntries`, dropping least-recently-updated entries
  /// first. Returned rather than mutated in place so callers keep their single
  /// "build the map, then persist it" statement order.
  static func evictingOldest<V>(
    _ map: [String: V],
    keeping maxEntries: Int,
    updatedAt: (V) -> Double
  ) -> [String: V] {
    guard map.count > maxEntries else { return map }
    let survivors = map
      .sorted { updatedAt($0.value) > updatedAt($1.value) }
      .prefix(maxEntries)
    return Dictionary(uniqueKeysWithValues: survivors.map { ($0.key, $0.value) })
  }
}

/// Keystroke debounce for every Work draft autosave. Long enough that a burst of
/// typing costs one `UserDefaults` write instead of one per character, short
/// enough that a user who pauses and then kills the app keeps their text.
/// Shared so the surfaces that schedule their own autosave (the question card
/// and the in-session composer, whose payloads aren't a plain `String` binding)
/// can't drift from the modifier below.
let workDraftAutosaveDebounce: Duration = .milliseconds(400)

/// Unsent composer text, persisted per surface so leaving a chat (or the app)
/// never discards what the user typed — desktop keeps its draft, and mobile
/// silently dropping it was the single most-reported chat regression.
/// One JSON dictionary under a versioned key: small enough to rewrite whole on
/// each save, bounded by `maxEntries` (LRU by `updatedAt`) so a long-lived
/// install can't grow it without limit.
enum WorkComposerDraftStore {
  struct Entry: Codable, Equatable {
    var text: String
    var updatedAt: Double
  }

  /// Versioned so a future shape change can migrate rather than mis-decode.
  private static let storageKey = "ade.work.composerDrafts.v1"
  /// Enough to cover every chat a user realistically juggles; older drafts are
  /// evicted oldest-first rather than kept forever.
  private static let maxEntries = 60
  /// A composer draft is a prompt, not a document — clamp pathological pastes so
  /// one entry can't dominate the shared defaults store.
  private static let maxLength = 20_000

  /// Per-chat key. Blank session ids yield a blank key so callers that render
  /// before the session resolves can't write everyone's draft into one bucket.
  static func chatKey(sessionId: String) -> String {
    let trimmed = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "" }
    return "chat:\(trimmed)"
  }

  /// The two "new chat" composers are singletons, so they get fixed keys.
  static let hubNewChatKey = "hub-new-chat"
  static let workNewChatKey = "work-new-chat"

  /// The stored draft, or "" when the key is blank, absent, or undecodable —
  /// restoring must never be able to fail loudly in a view body.
  static func load(_ key: String) -> String {
    guard !key.isEmpty else { return "" }
    return loadAll()[key]?.text ?? ""
  }

  /// Persists (or clears) the draft for one surface. An emptied composer removes
  /// its entry outright: a user who deletes their text must not have it
  /// resurrected the next time the screen mounts.
  static func save(_ text: String, for key: String) {
    guard !key.isEmpty else { return }
    var map = loadAll()
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      guard map.removeValue(forKey: key) != nil else { return }
      WorkDefaultsJSONMap.persist(map, under: storageKey)
      return
    }
    let clipped = String(text.prefix(maxLength))
    // Autosave runs on a keystroke debounce; skip the UserDefaults write when
    // the content is unchanged so idle typing pauses cost nothing.
    if map[key]?.text == clipped { return }
    map[key] = Entry(text: clipped, updatedAt: Date().timeIntervalSince1970)
    map = WorkDefaultsJSONMap.evictingOldest(map, keeping: maxEntries, updatedAt: \.updatedAt)
    WorkDefaultsJSONMap.persist(map, under: storageKey)
  }

  /// Drops a draft that has been consumed (sent) so it can't reappear.
  static func clear(_ key: String) {
    guard !key.isEmpty else { return }
    var map = loadAll()
    guard map.removeValue(forKey: key) != nil else { return }
    WorkDefaultsJSONMap.persist(map, under: storageKey)
  }

  private static func loadAll() -> [String: Entry] {
    WorkDefaultsJSONMap.load(storageKey)
  }
}

/// In-progress answers for a still-open question request, persisted per request
/// id. The card's selections and freeform text were plain `@State`, so backing
/// out of a chat to check something in the transcript — the exact reason a user
/// minimizes the card — silently discarded everything they had picked or typed.
/// Same storage shape as `WorkComposerDraftStore`: one JSON dictionary under a
/// versioned key, bounded and evicted oldest-first.
enum WorkQuestionDraftStore {
  struct Snapshot: Codable, Equatable {
    var selections: [String: Set<String>] = [:]
    var freeform: [String: String] = [:]
    var sharedFreeform: String = ""
    var page: Int = 0

    /// Nothing worth persisting — used to decide between a write and a removal.
    var isEmpty: Bool {
      selections.values.allSatisfy(\.isEmpty)
        && freeform.values.allSatisfy { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        && sharedFreeform.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && page == 0
    }
  }

  /// The timestamp lives beside the snapshot, not inside it: metadata that
  /// changes on every write cannot also be part of the value it timestamps, or
  /// "did the answer actually change?" can only be asked by first neutralizing
  /// the field. Mirrors `WorkComposerDraftStore.Entry`.
  private struct Stored: Codable {
    var snapshot: Snapshot
    var updatedAt: Double
  }

  /// v2 because `updatedAt` moved out of `Snapshot` into the wrapper. Drafts for
  /// open gates are ephemeral, so the v1 blob is abandoned rather than migrated.
  private static let storageKey = "ade.work.questionDrafts.v2"
  /// Open question gates are short-lived; a small cap is plenty and keeps the
  /// blob from accumulating answers to requests that were resolved elsewhere.
  private static let maxEntries = 30

  static func load(_ requestId: String) -> Snapshot? {
    guard !requestId.isEmpty else { return nil }
    return loadAll()[requestId]?.snapshot
  }

  static func save(_ snapshot: Snapshot, for requestId: String) {
    guard !requestId.isEmpty else { return }
    guard !snapshot.isEmpty else {
      clear(requestId)
      return
    }
    var map = loadAll()
    // Autosave runs on a keystroke debounce; skip the write when the answer is
    // unchanged so idle typing pauses cost nothing.
    if map[requestId]?.snapshot == snapshot { return }
    map[requestId] = Stored(snapshot: snapshot, updatedAt: Date().timeIntervalSince1970)
    map = WorkDefaultsJSONMap.evictingOldest(map, keeping: maxEntries, updatedAt: \.updatedAt)
    WorkDefaultsJSONMap.persist(map, under: storageKey)
  }

  static func clear(_ requestId: String) {
    guard !requestId.isEmpty else { return }
    var map = loadAll()
    guard map.removeValue(forKey: requestId) != nil else { return }
    WorkDefaultsJSONMap.persist(map, under: storageKey)
  }

  private static func loadAll() -> [String: Stored] {
    WorkDefaultsJSONMap.load(storageKey)
  }
}

/// The three legs of composer-draft persistence, which only work as a set.
///
/// - Restore is guarded on empty because a re-appear (or an init-seeded value,
///   or a failed send that put its text back) is fresher than what's on disk;
///   an unguarded restore would clobber text the user can see.
/// - The autosave debounce is what keeps typing off `UserDefaults`, but a
///   cancelled `.task` throws out of its sleep *before* the write, so the
///   in-flight edit is lost on any teardown.
/// - Hence the flush on disappear: a navigation pop is exactly the case the
///   debounce misses, and it is also the most common way a draft is abandoned.
private struct WorkPersistedDraftModifier: ViewModifier {
  @Binding var text: String
  let key: String

  func body(content: Content) -> some View {
    content
      .task {
        if text.isEmpty {
          text = WorkComposerDraftStore.load(key)
        }
      }
      .task(id: text) {
        try? await Task.sleep(for: workDraftAutosaveDebounce)
        guard !Task.isCancelled else { return }
        WorkComposerDraftStore.save(text, for: key)
      }
      .onDisappear { WorkComposerDraftStore.save(text, for: key) }
  }
}

extension View {
  /// Restore-if-empty on appear, debounced autosave while typing, flush on
  /// teardown — see `WorkPersistedDraftModifier` for why all three legs are
  /// required. Send paths still call `WorkComposerDraftStore.clear(_:)`
  /// explicitly: consuming a draft is not the same event as leaving the screen.
  func workPersistedDraft(_ text: Binding<String>, key: String) -> some View {
    modifier(WorkPersistedDraftModifier(text: text, key: key))
  }
}
