import XCTest
@testable import ADE

/// The direct client sends the account's GitHub token with every page it
/// follows, so a next page on another host must never be followed.
final class GitHubDirectClientTests: XCTestCase {
  func testNextPageIsFollowedOnlyOnTheGitHubAPIHost() {
    let api = "api.github.com"
    let cases: [(link: String?, expected: String?)] = [
      (#"<https://api.github.com/repos/o/r/pulls?page=2>; rel="next", <https://api.github.com/repos/o/r/pulls?page=5>; rel="last""#,
       "https://api.github.com/repos/o/r/pulls?page=2"),
      (#"<https://api.github.com/repos/o/r/pulls?page=1>; rel="prev", <https://api.github.com/repos/o/r/pulls?page=3>; rel="next""#,
       "https://api.github.com/repos/o/r/pulls?page=3"),
      (#"<https://evil.example/steal?page=2>; rel="next""#, nil),
      (#"<https://api.github.com.evil.example/x?page=2>; rel="next""#, nil),
      (#"<http://api.github.com/repos/o/r/pulls?page=2>; rel="next""#, nil),
      (#"<https://api.github.com/repos/o/r/pulls?page=5>; rel="last""#, nil),
      (nil, nil),
    ]
    for (index, item) in cases.enumerated() {
      XCTAssertEqual(githubNextPageURL(item.link, apiHost: api)?.absoluteString, item.expected, "case \(index)")
    }
  }
}
