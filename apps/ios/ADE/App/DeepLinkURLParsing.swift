import Foundation

enum ADEDeepLinkURLParsing {
  static let canonicalWebHost = "ade-app.dev"
  static let legacyWebHosts: Set<String> = ["ade.app"]

  static func isADEWebHost(_ value: String?) -> Bool {
    guard let value else { return false }
    let host = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return host == canonicalWebHost || legacyWebHosts.contains(host)
  }

  static func splitRepo(_ value: String?) -> (owner: String, repo: String)? {
    guard let value else { return nil }
    let pieces = value.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard pieces.count == 2,
          !pieces[0].isEmpty,
          !pieces[1].isEmpty else {
      return nil
    }
    return (pieces[0], pieces[1])
  }

  static func positiveInteger(_ value: String?) -> Int? {
    guard let value,
          let number = Int(value),
          number > 0 else {
      return nil
    }
    return number
  }

  static func adeQueryValues(from components: URLComponents) -> [String: String] {
    var query: [String: String] = [:]
    for item in components.queryItems ?? [] {
      guard let value = item.value else { continue }
      query[item.name.lowercased()] = value
    }
    return query
  }
}
