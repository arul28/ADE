import XCTest
@testable import ADE

/// The GitHub Issues pane reads GitHub's REST shape through the brain and
/// renders bodies with the chat's markdown renderer, which does not read HTML.
final class GitHubIssuesPaneContractTests: XCTestCase {
  func testDecodesBrainRepliesAndDropsPullRequestsFromTheList() throws {
    let json = #"""
    [
      {"number": 12, "title": "Crash", "html_url": "https://github.com/acme/ade/issues/12", "state": "closed",
       "state_reason": "not_planned", "labels": ["bug", {"name": "ui", "color": "a2eeef"}],
       "assignees": [{"login": "octo", "avatar_url": null}], "user": null, "comments": 3},
      {"number": 13, "title": "A pull request", "html_url": "https://github.com/acme/ade/pull/13", "state": "open",
       "pull_request": {"url": "https://api.github.com/repos/acme/ade/pulls/13"}},
      {"number": 14, "title": "Plain", "html_url": "https://github.com/acme/ade/issues/14", "pull_request": null}
    ]
    """#
    let rows = try JSONDecoder().decode([GitHubIssueRow].self, from: Data(json.utf8))
    XCTAssertEqual(rows.map(\.isPullRequest), [false, true, false])
    XCTAssertEqual(rows[0].labels.map(\.name), ["bug", "ui"])
    XCTAssertEqual(rows[0].stateReason, "not_planned")
    XCTAssertFalse(rows[0].isOpen)
    XCTAssertTrue(rows[2].isOpen, "A missing state reads as open")
  }

  func testHTMLBecomesMarkdownButCodeIsLeftAsWritten() {
    XCTAssertEqual(
      githubIssueDisplayMarkdown(#"<!-- linear-linkback --><p><a href="https://linear.app/x/issue/ADE-1">ADE-1</a></p>"#),
      "[ADE-1](https://linear.app/x/issue/ADE-1)"
    )
    XCTAssertEqual(githubIssueDisplayMarkdown("Use `List<String>` when a < b."), "Use `List<String>` when a < b.")
    XCTAssertEqual(
      githubIssueDisplayMarkdown("```html\n<div class=\"x\">hi</div>\n```\nthen <b>bold</b> &amp; done"),
      "```html\n<div class=\"x\">hi</div>\n```\nthen bold & done"
    )
  }
}
