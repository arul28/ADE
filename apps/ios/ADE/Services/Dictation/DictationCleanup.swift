import Foundation

/// Deterministic cleanup for dictated transcripts.
///
/// The deterministic pass is pure, synchronous, and fast (<10ms for ordinary
/// prompt-length input). It must match the desktop implementation exactly so
/// the same spoken phrase produces the same cleaned text on both platforms:
///
///   a. Trim surrounding whitespace.
///   b. Remove fillers — each filler only as a standalone token/phrase
///      (case-insensitive word boundary), then collapse the doubled spaces.
///   c. Apply corrections longest-key-first, replacing case-insensitive
///      whole-phrase matches (word boundaries) with the canonical value.
///   d. Capitalize the first letter of each sentence (start of string and
///      after `.`/`!`/`?`). The rest of each word is left untouched so
///      canonical casing like "OpenAI" / "SwiftUI" survives.
///   e. Fix spacing — collapse runs of spaces and drop the space before
///      `, . ! ? ; :`.
///
///
/// There is deliberately no Foundation Models polish pass. The on-device model
/// treats dictated text as a prompt and answers it, so deterministic cleanup is
/// the final transcript.
enum DictationCleanup {
  // MARK: - Deterministic pass

  /// Run the full deterministic cleanup pipeline. Pure and synchronous.
  static func clean(_ raw: String, glossary: VoiceGlossary) -> String {
    // a. Trim.
    var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return "" }

    // b. Remove fillers as standalone tokens/phrases.
    text = removeFillers(text, fillers: glossary.fillers)

    // c. Apply corrections, longest key first (glossary is pre-sorted).
    text = applyCorrections(text, corrections: glossary.corrections)

    // d. Capitalize sentence starts. (Order matches the desktop implementation
    // exactly — see apps/desktop/src/main/services/transcription/dictationCleanup.ts.)
    text = capitalizeSentences(text)

    // e. Collapse whitespace and strip spaces before punctuation.
    text = fixSpacing(text)

    return text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Remove each filler word/phrase when it appears as a standalone token
  /// (surrounded by word boundaries), case-insensitive, then collapse the
  /// resulting double spaces.
  private static func removeFillers(_ input: String, fillers: [String]) -> String {
    var text = input
    for filler in fillers {
      let trimmed = filler.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { continue }
      let pattern = "\\b" + NSRegularExpression.escapedPattern(for: trimmed) + "\\b"
      text = replaceRegex(in: text, pattern: pattern, with: " ", caseInsensitive: true)
    }
    // Collapse the spaces the removals left behind.
    return replaceRegex(in: text, pattern: " {2,}", with: " ", caseInsensitive: false)
  }

  /// Apply corrections in the glossary's longest-first order. Each key is
  /// matched as a whole phrase on word boundaries, case-insensitively, and
  /// replaced with its canonical value (canonical casing preserved literally).
  private static func applyCorrections(_ input: String, corrections: [VoiceGlossary.Correction]) -> String {
    var text = input
    for correction in corrections {
      let key = correction.misheard.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !key.isEmpty else { continue }
      let pattern = "\\b" + NSRegularExpression.escapedPattern(for: key) + "\\b"
      // Escape `$` and `\` in the replacement so canonical values with those
      // characters aren't treated as regex templates.
      let template = correction.canonical
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "$", with: "\\$")
      text = replaceRegex(in: text, pattern: pattern, with: template, caseInsensitive: true)
    }
    return text
  }

  /// Capitalize the first alphabetic character at the start of the string and
  /// after each sentence terminator (`.`, `!`, `?`). Only the leading letter is
  /// touched; the remainder of every word keeps its casing so canonical terms
  /// like "OpenAI" survive. Leading punctuation such as quotes does not consume
  /// the pending capitalization; this matches the desktop cleanup pass.
  private static func capitalizeSentences(_ input: String) -> String {
    var result = ""
    result.reserveCapacity(input.count)
    var capitalizeNext = true

    for character in input {
      if capitalizeNext, character.isLetter {
        result.append(String(character).uppercased())
        capitalizeNext = false
      } else {
        result.append(character)
        if character == "." || character == "!" || character == "?" {
          capitalizeNext = true
        }
      }
    }
    return result
  }

  /// Collapse runs of spaces and remove the space preceding punctuation.
  private static func fixSpacing(_ input: String) -> String {
    var text = replaceRegex(in: input, pattern: " {2,}", with: " ", caseInsensitive: false)
    text = replaceRegex(in: text, pattern: "\\s+([,.!?;:])", with: "$1", caseInsensitive: false)
    return text
  }

  /// Small regex replace helper that fails closed: on an invalid pattern the
  /// original string is returned unchanged rather than throwing.
  private static func replaceRegex(
    in input: String,
    pattern: String,
    with template: String,
    caseInsensitive: Bool
  ) -> String {
    let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
    guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
      return input
    }
    let range = NSRange(input.startIndex..., in: input)
    return regex.stringByReplacingMatches(in: input, options: [], range: range, withTemplate: template)
  }

  // NOTE: A Foundation Models "polish" pass was deliberately removed. The
  // deterministic cleanup above is the final result (matching desktop).
}
