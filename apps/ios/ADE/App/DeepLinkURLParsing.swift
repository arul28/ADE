import Foundation

struct ADEDeeplinkEnvelope: Equatable {
  var repoOwner: String?
  var repoName: String?
  var branch: String?
  var prNumber: Int?
  var linearIssue: String?

  var repoSlug: String? {
    guard let repoOwner, let repoName else { return nil }
    return "\(repoOwner)/\(repoName)"
  }

  var isEmpty: Bool {
    repoOwner == nil && repoName == nil && branch == nil && prNumber == nil && linearIssue == nil
  }
}

enum ADEDeeplinkForm {
  case ade
  case https
}

enum ADEDeepLinkURLParsing {
  static let canonicalWebHost = "ade-app.dev"
  static let legacyWebHosts: Set<String> = ["ade.app"]
  private static let pathValueAllowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))

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
          !pieces[1].isEmpty,
          isValidGithubOwner(pieces[0]),
          isValidGithubRepo(pieces[1]) else {
      return nil
    }
    return (pieces[0], pieces[1])
  }

  static func positiveInteger(_ value: String?) -> Int? {
    guard let value,
          value.range(of: #"^\d{1,15}$"#, options: .regularExpression) != nil,
          let number = Int(value),
          number > 0 else {
      return nil
    }
    return number
  }

  static func nonNegativeInteger(_ value: String?) -> Int? {
    guard let value else { return nil }
    guard value.range(of: #"^\d{1,15}$"#, options: .regularExpression) != nil,
          let number = Int(value),
          number >= 0 else {
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

  static func envelope(from query: [String: String]) -> ADEDeeplinkEnvelope? {
    var envelope = ADEDeeplinkEnvelope()
    if let repo = splitRepo(query["repo"]) {
      envelope.repoOwner = repo.owner
      envelope.repoName = repo.repo
    }
    if let branch = query["branch"], isValidBranch(branch) {
      envelope.branch = branch
    }
    if let prNumber = positiveInteger(query["pr"]) {
      envelope.prNumber = prNumber
    }
    if let linear = query["linear"], isValidLinearIdentifier(linear) {
      envelope.linearIssue = linear
    }
    return envelope.isEmpty ? nil : envelope
  }

  static func isValidUUID(_ value: String?) -> Bool {
    guard let value,
          value.count == 36,
          UUID(uuidString: value) != nil else {
      return false
    }
    return true
  }

  static func isValidOpaqueId(_ value: String?) -> Bool {
    guard let value else { return false }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= 512 else { return false }
    return !containsControlCharacter(trimmed)
  }

  static func isValidScopeComponent(_ value: String?) -> Bool {
    guard let value else { return false }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty,
          trimmed.count <= 512,
          trimmed == value,
          !trimmed.contains(where: \.isWhitespace),
          !trimmed.contains("/"),
          !trimmed.contains("\\") else {
      return false
    }
    return !containsControlCharacter(trimmed)
  }

  static func isValidRepoRelativePath(_ value: String?) -> Bool {
    guard let value, !value.isEmpty, value.count <= 1024 else { return false }
    if value.hasPrefix("/") || value.hasSuffix("/") || value.contains("\\") { return false }
    if value.range(of: #"^[A-Za-z]:"#, options: .regularExpression) != nil { return false }
    if containsControlCharacter(value) { return false }
    return value.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { segment in
      segment != "" && segment != "." && segment != ".."
    }
  }

  static func isValidCommitSha(_ value: String?) -> Bool {
    guard let value else { return false }
    return value.range(of: #"^[0-9a-fA-F]{7,40}$"#, options: .regularExpression) != nil
  }

  static func isValidLinearIdentifier(_ value: String?) -> Bool {
    guard let value else { return false }
    return value.range(of: #"^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$"#, options: .regularExpression) != nil
  }

  static func isValidBranch(_ value: String?) -> Bool {
    guard let value, !value.isEmpty, value.count <= 255 else { return false }
    if value.hasPrefix("/") || value.hasSuffix("/") || value.hasSuffix(".lock") { return false }
    if containsControlCharacter(value) { return false }
    return !value.split(separator: "/", omittingEmptySubsequences: false).contains("..")
  }

  static func encodedPathSegment(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: pathValueAllowed) ?? value
  }

  static func encodedPath(_ value: String) -> String {
    value
      .split(separator: "/", omittingEmptySubsequences: false)
      .map { encodedPathSegment(String($0)) }
      .joined(separator: "/")
  }

  static func queryString(_ items: [(String, String?)]) -> String {
    items.compactMap { name, value -> String? in
      guard let value, !value.isEmpty else { return nil }
      return "\(encodedPathSegment(name))=\(encodedPathSegment(value))"
    }
    .joined(separator: "&")
  }

  private static func isValidGithubOwner(_ value: String) -> Bool {
    value.range(of: #"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$"#, options: .regularExpression) != nil
  }

  private static func isValidGithubRepo(_ value: String) -> Bool {
    guard value != ".", value != ".." else { return false }
    return value.range(of: #"^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$"#, options: .regularExpression) != nil
  }

  private static func containsControlCharacter(_ value: String) -> Bool {
    value.unicodeScalars.contains { scalar in
      scalar.value < 0x20 || scalar.value == 0x7f
    }
  }
}
