import Foundation

/// Parsed representation of the shared `VoiceGlossary.json` resource.
///
/// The JSON ships in the app bundle and is also consumed by the desktop
/// transcription pipeline, so the schema is intentionally minimal and shared:
/// `{ version, contextualTerms: [String], corrections: { misheard: Canonical },
/// fillers: [String] }`.
///
/// Loaded once and cached (see `VoiceGlossary.shared`). The bundle lookup
/// mirrors the existing pattern in `Services/Database.swift` for
/// `DatabaseBootstrap.sql` (`Bundle.url(forResource:withExtension:)`).
struct VoiceGlossary: Sendable {
  /// Schema version of the loaded glossary (1 for the current resource).
  let version: Int

  /// Terms fed to the recognizer to bias toward ADE/dev vocabulary. iOS caps
  /// contextual phrases at ~100, so the resource keeps this list curated.
  let contextualTerms: [String]

  /// Misheard → canonical corrections, pre-sorted **longest key first** so the
  /// deterministic cleanup applies multi-word phrases before their substrings.
  let corrections: [Correction]

  /// Filler words/phrases removed as standalone tokens during cleanup.
  let fillers: [String]

  /// A single misheard → canonical correction. Stored as an ordered array
  /// (rather than a dictionary) so longest-first iteration order is preserved.
  struct Correction: Sendable {
    let misheard: String
    let canonical: String
  }

  /// Empty glossary used as a safe fallback when the resource is missing or
  /// malformed. Cleanup with an empty glossary is a no-op beyond trimming.
  static let empty = VoiceGlossary(version: 0, contextualTerms: [], corrections: [], fillers: [])
}

extension VoiceGlossary {
  /// Wire-format mirror of `VoiceGlossary.json`. Decoded then transformed into
  /// the ordered `VoiceGlossary` above.
  private struct Wire: Decodable {
    let version: Int?
    let contextualTerms: [String]?
    let corrections: [String: String]?
    let fillers: [String]?
  }

  /// Process-wide cache of the parsed bundle glossary. Resolved lazily on first
  /// access; failures fall back to `.empty` so dictation degrades gracefully
  /// rather than crashing.
  static let shared: VoiceGlossary = load()

  /// Resource basename and extension in the app bundle.
  private static let resourceName = "VoiceGlossary"
  private static let resourceExtension = "json"

  /// Load and parse the bundled glossary, caching nothing here (the cache is
  /// `shared`). Exposed for tests that want a fresh parse from a custom bundle.
  static func load(from bundles: [Bundle] = [.main, Bundle(for: BundleToken.self)]) -> VoiceGlossary {
    for bundle in bundles {
      guard let url = bundle.url(forResource: resourceName, withExtension: resourceExtension),
            let data = try? Data(contentsOf: url) else {
        continue
      }
      if let parsed = try? parse(data) {
        return parsed
      }
    }
    return .empty
  }

  /// Decode raw JSON data into an ordered glossary. Throws on malformed JSON.
  static func parse(_ data: Data) throws -> VoiceGlossary {
    let wire = try JSONDecoder().decode(Wire.self, from: data)

    // Sort corrections by descending key length so the cleanup pass replaces
    // longer phrases ("cr sequel light") before shorter overlapping ones
    // ("sequel light"). Ties break on the key for deterministic ordering.
    let corrections = (wire.corrections ?? [:])
      .map { Correction(misheard: $0.key, canonical: $0.value) }
      .sorted { lhs, rhs in
        if lhs.misheard.count != rhs.misheard.count {
          return lhs.misheard.count > rhs.misheard.count
        }
        return lhs.misheard < rhs.misheard
      }

    return VoiceGlossary(
      version: wire.version ?? 1,
      contextualTerms: wire.contextualTerms ?? [],
      corrections: corrections,
      fillers: wire.fillers ?? []
    )
  }
}

/// Anchor class so `Bundle(for:)` resolves the framework/app bundle that
/// contains the dictation sources — matching the `Bundle(for: DatabaseService.self)`
/// fallback used by `Services/Database.swift`.
private final class BundleToken {}
