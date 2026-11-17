import Foundation

// The files and commits of a lane's branch, read straight from GitHub with
// the ADE account's GitHub sign-in, while the lane's ADE Cloud computer is
// not awake. The same rules as the PR reads (`GitHubDirectClient.swift`):
//
// - One folder at a time (`GET /repos/:o/:r/contents/:path?ref=`), only when
//   the person opens it. No tree walk.
// - A file opens as text up to 1 MiB. A larger file, or one that is not
//   text, opens as "too large" or "not text", with a link to GitHub.
// - Every GET is ETag'd: an unchanged folder is a free `304`.
// - A rate limit stops every read until GitHub's reset time, with no request.
// - A `404` on the branch means it is not on GitHub yet (never pushed). A
//   `404` on the repository is refined into the state the person fixes (the
//   App is not installed, or the repository is not in it).

/// One entry of a folder on GitHub.
struct GitHubDirectContentEntry: Equatable, Hashable, Identifiable {
  let name: String
  let path: String
  /// `dir`, `file`, `symlink` or `submodule`.
  let type: String
  let size: Int

  var id: String { path }
  var isFolder: Bool { type == "dir" }
}

/// One file's text on GitHub at a branch.
struct GitHubDirectFile: Equatable {
  let path: String
  let size: Int
  /// Nil when the file is too large or is not text.
  let text: String?
  let tooLarge: Bool
  let htmlUrl: URL?
}

/// One commit on a branch on GitHub.
struct GitHubDirectCommit: Equatable, Identifiable {
  let sha: String
  let title: String
  let author: String?
  let date: Date?
  let htmlUrl: URL?

  var id: String { sha }
  var shortSha: String { String(sha.prefix(7)) }
}

extension GitHubDirectClient {
  /// The largest file that opens as text (GitHub sends contents up to 1 MB here).
  static let contentsMaxBytes = 1024 * 1024
  static let commitsPageSize = 30

  /// One path segment at a time, so a `#` or `?` in a file name stays part of the path.
  private static func contentsPath(_ repo: GitHubDirectRepoRef, path: String) -> String {
    let encoded = path
      .split(separator: "/", omittingEmptySubsequences: true)
      .map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) ?? String($0) }
      .joined(separator: "/")
    return "/repos/\(repo.owner)/\(repo.name)/contents" + (encoded.isEmpty ? "" : "/\(encoded)")
  }

  /// The entries of one folder at `ref`, folders first, then by name.
  func listFolder(_ repo: GitHubDirectRepoRef, path: String, ref: String) async -> Result<[GitHubDirectContentEntry], GitHubDirectError> {
    #if DEBUG
    if let contentsPreview { return contentsPreview.listFolder(path) }
    #endif
    return await read(repo: repo, background: false) { token, scope in
      let body = try await self.single(path: Self.contentsPath(repo, path: path), query: ["ref": ref], token: token, scope: scope, repo: repo)
      guard let items = body as? [Any] else {
        // A path that names a file answers an object, not a list.
        return .failure(GitHubDirectError(kind: .invalidRequest))
      }
      let entries = items.compactMap { item -> GitHubDirectContentEntry? in
        guard let object = item as? [String: Any],
              let name = object["name"] as? String,
              let entryPath = object["path"] as? String else { return nil }
        return GitHubDirectContentEntry(
          name: name,
          path: entryPath,
          type: object["type"] as? String ?? "file",
          size: (object["size"] as? NSNumber)?.intValue ?? 0
        )
      }
      return .success(entries.sorted { lhs, rhs in
        if lhs.isFolder != rhs.isFolder { return lhs.isFolder }
        return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
      })
    }
  }

  /// One file's text at `ref`, up to `contentsMaxBytes`.
  func fileContent(_ repo: GitHubDirectRepoRef, path: String, ref: String) async -> Result<GitHubDirectFile, GitHubDirectError> {
    #if DEBUG
    if let contentsPreview { return contentsPreview.file(path) }
    #endif
    return await read(repo: repo, background: false) { token, scope in
      let body = try await self.single(path: Self.contentsPath(repo, path: path), query: ["ref": ref], token: token, scope: scope, repo: repo)
      guard let object = body as? [String: Any], (object["type"] as? String) == "file" else {
        return .failure(GitHubDirectError(kind: .invalidRequest))
      }
      let size = (object["size"] as? NSNumber)?.intValue ?? 0
      let htmlUrl = (object["html_url"] as? String).flatMap(URL.init(string:))
      let encoded = object["content"] as? String ?? ""
      // Over 1 MB GitHub sends no content (`encoding: none`).
      guard size <= Self.contentsMaxBytes, (object["encoding"] as? String) == "base64", !encoded.isEmpty || size == 0 else {
        return .success(GitHubDirectFile(path: path, size: size, text: nil, tooLarge: true, htmlUrl: htmlUrl))
      }
      let data = Data(base64Encoded: encoded, options: .ignoreUnknownCharacters) ?? Data()
      return .success(GitHubDirectFile(path: path, size: size, text: githubDirectText(data), tooLarge: false, htmlUrl: htmlUrl))
    }
  }

  /// The newest commits of `ref` (the lane's pushed history).
  func listCommits(_ repo: GitHubDirectRepoRef, ref: String) async -> Result<[GitHubDirectCommit], GitHubDirectError> {
    #if DEBUG
    if let contentsPreview { return contentsPreview.commits() }
    #endif
    return await read(repo: repo, background: false) { token, scope in
      let body = try await self.single(
        path: "/repos/\(repo.owner)/\(repo.name)/commits",
        query: ["sha": ref, "per_page": String(Self.commitsPageSize)],
        token: token, scope: scope, repo: repo
      )
      let commits = (body as? [Any] ?? []).compactMap { item -> GitHubDirectCommit? in
        guard let object = item as? [String: Any], let sha = object["sha"] as? String else { return nil }
        let commit = object["commit"] as? [String: Any]
        let message = commit?["message"] as? String ?? ""
        let authorObject = commit?["author"] as? [String: Any]
        let login = (object["author"] as? [String: Any])?["login"] as? String
        return GitHubDirectCommit(
          sha: sha,
          title: message.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? sha,
          author: login ?? authorObject?["name"] as? String,
          date: (authorObject?["date"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) },
          htmlUrl: (object["html_url"] as? String).flatMap(URL.init(string:))
        )
      }
      return .success(commits)
    }
  }
}

/// The text of a file, or nil when it is not text (a NUL byte, or not UTF-8). Pure.
func githubDirectText(_ data: Data) -> String? {
  if data.prefix(8_000).contains(0) { return nil }
  return String(data: data, encoding: .utf8)
}

/// A read that failed because the branch (or the path) is not on GitHub.
func githubDirectIsMissingRef(_ error: GitHubDirectError) -> Bool {
  error.kind == .notFound || error.kind == .invalidRequest
}

#if DEBUG
/// Canned answers for the fixture screens.
struct GitHubContentsPreviewAnswers {
  var error: GitHubDirectError?
  var folders: [String: [GitHubDirectContentEntry]]
  var files: [String: String]
  var commitList: [GitHubDirectCommit]

  func listFolder(_ path: String) -> Result<[GitHubDirectContentEntry], GitHubDirectError> {
    if let error { return .failure(error) }
    guard let entries = folders[path] else { return .failure(GitHubDirectError(kind: .notFound)) }
    return .success(entries)
  }

  func file(_ path: String) -> Result<GitHubDirectFile, GitHubDirectError> {
    if let error { return .failure(error) }
    guard let text = files[path] else { return .failure(GitHubDirectError(kind: .notFound)) }
    return .success(GitHubDirectFile(path: path, size: text.utf8.count, text: text, tooLarge: false, htmlUrl: nil))
  }

  func commits() -> Result<[GitHubDirectCommit], GitHubDirectError> {
    if let error { return .failure(error) }
    if folders.isEmpty { return .failure(GitHubDirectError(kind: .notFound)) }
    return .success(commitList)
  }
}
#endif
