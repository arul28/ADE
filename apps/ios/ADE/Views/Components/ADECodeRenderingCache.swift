import Foundation
import SwiftUI

final class ADECodeRenderingCache {
  static let shared = ADECodeRenderingCache()

  private let tokenCache = NSCache<NSString, SyntaxTokenArrayBox>()
  private let attributedCache = NSCache<NSString, AttributedStringBox>()
  private let regexCache = NSCache<NSString, NSRegularExpression>()
  private let regexLock = NSLock()
  /// Streaming state, not a cache: one in-progress code block per language.
  /// Guarded by its own lock because highlighting is reachable from any actor.
  private let prefixLock = NSLock()
  private var highlightPrefixes: [FilesLanguage: SyntaxHighlightPrefix] = [:]

  private init() {
    tokenCache.countLimit = 64
    attributedCache.countLimit = 160
    regexCache.countLimit = 64
  }

  func tokens(for key: String) -> [SyntaxToken]? {
    tokenCache.object(forKey: key as NSString)?.value
  }

  func storeTokens(_ tokens: [SyntaxToken], for key: String) {
    tokenCache.setObject(SyntaxTokenArrayBox(value: tokens), forKey: key as NSString)
  }

  func highlightedString(for key: String) -> AttributedString? {
    attributedCache.object(forKey: key as NSString)?.value
  }

  func storeHighlightedString(_ attributed: AttributedString, for key: String) {
    attributedCache.setObject(AttributedStringBox(value: attributed), forKey: key as NSString)
  }

  func highlightPrefix(for language: FilesLanguage) -> SyntaxHighlightPrefix? {
    prefixLock.lock()
    defer { prefixLock.unlock() }
    return highlightPrefixes[language]
  }

  func storeHighlightPrefix(_ prefix: SyntaxHighlightPrefix, for language: FilesLanguage) {
    prefixLock.lock()
    defer { prefixLock.unlock() }
    highlightPrefixes[language] = prefix
  }

  /// Drops derived renders. Compiled regexes are cheap to hold and hot on every
  /// highlight, so they stay.
  func purgeOnMemoryWarning() {
    tokenCache.removeAllObjects()
    attributedCache.removeAllObjects()
    prefixLock.lock()
    highlightPrefixes.removeAll()
    prefixLock.unlock()
  }

  func regex(for pattern: String) -> NSRegularExpression? {
    let key = pattern as NSString
    if let cached = regexCache.object(forKey: key) {
      return cached
    }

    regexLock.lock()
    defer { regexLock.unlock() }

    if let cached = regexCache.object(forKey: key) {
      return cached
    }

    guard let compiled = try? NSRegularExpression(pattern: pattern, options: []) else {
      return nil
    }

    regexCache.setObject(compiled, forKey: key)
    return compiled
  }
}

private final class SyntaxTokenArrayBox: NSObject {
  let value: [SyntaxToken]

  init(value: [SyntaxToken]) {
    self.value = value
  }
}

private final class AttributedStringBox: NSObject {
  let value: AttributedString

  init(value: AttributedString) {
    self.value = value
  }
}
