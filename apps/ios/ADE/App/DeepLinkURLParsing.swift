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

/// Which machine and project a shared link belongs to. Mirrors
/// `DeeplinkOwnership` in `apps/desktop/src/shared/deeplinks.ts`: both keys
/// travel together, and a link that carries one without the other is broken.
struct ADEDeeplinkOwnership: Equatable {
  var accountMachineKey: String
  /// The owning machine's canonical project id (`project_<hash>`), never a path.
  var projectId: String
  /// The account project of that folder (`ap_<32 hex>`), when the phone knows
  /// it. A minted link adds it next to the pair; a reader that does not know
  /// it keeps the pair.
  var accountProjectId: String? = nil
}

extension ADEDeeplinkOwnershipParse {
  /// The pair, when the link carries a valid one.
  var owner: ADEDeeplinkOwnership? {
    if case .owned(let owner) = self { return owner }
    return nil
  }
}

/// What a link's `accountProjectId` parsed to.
enum ADEDeeplinkAccountProjectParse: Equatable {
  /// The link names no account project.
  case none
  case id(String)
  /// The key is present, but its value is not an account project id.
  case malformed
}

/// What a link's ownership pair parsed to.
enum ADEDeeplinkOwnershipParse: Equatable {
  /// The link names no owner: it keeps the pre-ownership behaviour.
  case none
  case owned(ADEDeeplinkOwnership)
  /// One key without the other, or a value no machine could have minted.
  case malformed
}

enum ADEDeeplinkForm {
  case ade
  case https
}

enum ADEDeepLinkURLParsing {
  static let canonicalWebHost = "ade-app.dev"
  /// `app.ade-app.dev` is the web client's host, which older `ade link --web`
  /// builds minted `/open` links on. Same list as
  /// `ADE_DEEPLINK_LEGACY_HTTPS_HOSTS` on desktop.
  static let legacyWebHosts: Set<String> = ["ade.app", "app.ade-app.dev"]
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

  /// Reads `accountMachineKey` + `projectId` off a lowercased query map (see
  /// `adeQueryValues`). Desktop's `readOwnershipParams` rules, with one iOS
  /// carve-out: a lone `accountMachineKey` is the Activity / widget / push
  /// link this app has always minted (machine only, the session finds its
  /// project). It stays `.none` so those links keep their old route; only a
  /// link that carries `projectId` must carry a valid pair.
  static func ownership(from query: [String: String]) -> ADEDeeplinkOwnershipParse {
    let machineKey = query["accountmachinekey"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let projectId = query["projectid"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if projectId.isEmpty && query["projectid"] == nil { return .none }
    guard !machineKey.isEmpty, !projectId.isEmpty,
          machineKey.count <= 128,
          projectId.count <= 512,
          isValidOpaqueId(machineKey),
          isValidOpaqueId(projectId) else {
      return .malformed
    }
    return .owned(ADEDeeplinkOwnership(accountMachineKey: machineKey, projectId: projectId))
  }

  /// Reads `accountProjectId` off a lowercased query map. The id pattern is the
  /// directory's `ACCOUNT_PROJECT_ID_PATTERN`.
  static func accountProjectId(from query: [String: String]) -> ADEDeeplinkAccountProjectParse {
    guard let raw = query["accountprojectid"] else { return .none }
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return isAccountProjectId(value) ? .id(value) : .malformed
  }

  static func isAccountProjectId(_ value: String?) -> Bool {
    guard let value else { return false }
    return value.range(of: #"^ap_[0-9a-f]{32}$"#, options: .regularExpression) != nil
  }

  /// The ownership query items for a minted link, or none when either half is
  /// unknown. Only a canonical `project_<hash>` id is minted: an older host's
  /// local id or a path would point the reader at nothing (or leak the path).
  static func ownershipQueryItems(_ ownership: ADEDeeplinkOwnership?) -> [(String, String?)] {
    guard let ownership,
          isValidScopeComponent(ownership.accountMachineKey),
          ownership.accountMachineKey.count <= 128,
          ownership.projectId.hasPrefix("project_"),
          isValidScopeComponent(ownership.projectId) else { return [] }
    var items: [(String, String?)] = [("accountMachineKey", ownership.accountMachineKey), ("projectId", ownership.projectId)]
    if let accountProjectId = ownership.accountProjectId, isAccountProjectId(accountProjectId) {
      items.append(("accountProjectId", accountProjectId))
    }
    return items
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

// MARK: - Links that name an account project

/// Where a link that names an account project goes (spec 2.8).
enum AccountProjectLinkTarget: Equatable {
  /// Open this folder on this computer.
  case copy(accountMachineKey: String, checkoutId: String)
  /// The project was removed from the account.
  case removed
  /// The account list has no row with this id.
  case unknown
  /// The project is on the account, but no computer that can start holds a copy.
  case noCopy(projectName: String)
}

/// Pure: resolves a link's `accountProjectId`.
///
/// 1. A merged id follows to the project it merged into.
/// 2. The link's own pair wins when it names a copy of that project.
/// 3. Then a copy on the computer the link names.
/// 4. Then the first copy in the Start-on order (`startOnOrder`).
func resolveAccountProjectLink(
  id: String,
  owner: ADEDeeplinkOwnership?,
  machineHint: String?,
  state: AccountProjectListState,
  startOnOrder: (AccountProject) -> [StartOnCandidate]
) -> AccountProjectLinkTarget {
  let targetId = state.mergedTargets[id] ?? id
  guard let project = state.rows[targetId], project.isLive else {
    if let row = state.rows[targetId], row.removedAt != nil, row.mergedInto == nil { return .removed }
    return .unknown
  }
  if let owner,
     project.copies.contains(where: { $0.machineKey == owner.accountMachineKey && $0.checkoutId == owner.projectId }) {
    return .copy(accountMachineKey: owner.accountMachineKey, checkoutId: owner.projectId)
  }
  if let hint = owner?.accountMachineKey ?? machineHint,
     let copy = project.copies.filter({ $0.machineKey == hint }).sorted(by: { $0.isMain && !$1.isMain }).first {
    return .copy(accountMachineKey: hint, checkoutId: copy.checkoutId)
  }
  for candidate in startOnOrder(project) where candidate.kind == .copy {
    if let copy = project.copies.filter({ $0.machineKey == candidate.accountMachineKey })
      .sorted(by: { $0.isMain && !$1.isMain }).first {
      return .copy(accountMachineKey: candidate.accountMachineKey, checkoutId: copy.checkoutId)
    }
  }
  return .noCopy(projectName: project.name)
}
