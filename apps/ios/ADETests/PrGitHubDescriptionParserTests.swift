import XCTest
@testable import ADE

final class PrGitHubDescriptionParserTests: XCTestCase {
  func testDetailsBecomeNativeDisclosureContent() {
    let blocks = parsePrGitHubDescriptionBlocks("""
    Bumps dorny/paths-filter from 3 to 4.
    <details>
    <summary>Release notes</summary>
    <h2>v4.0.0</h2>
    <ul>
      <li>feat: update runtime by <a href="https://github.com/octocat"><code>@octocat</code></a></li>
      <li><strong>Full changelog</strong></li>
    </ul>
    </details>
    """)

    XCTAssertEqual(blocks.count, 2)
    XCTAssertEqual(
      blocks.first,
      .markdown(id: "description-markdown-0", markdown: "Bumps dorny/paths-filter from 3 to 4.")
    )

    guard case .disclosure(_, let title, let markdown) = blocks[1] else {
      return XCTFail("Expected the GitHub details block to become a native disclosure")
    }
    XCTAssertEqual(title, "Release notes")
    XCTAssertTrue(markdown.contains("## v4.0.0"))
    XCTAssertTrue(markdown.contains("- feat: update runtime by [`@octocat`](https://github.com/octocat)"))
    XCTAssertTrue(markdown.contains("- **Full changelog**"))
    XCTAssertFalse(markdown.contains("<"))
  }

  func testHtmlNormalizationKeepsSafeLinksAndDropsUnsafeMarkup() {
    let markdown = normalizePrGitHubHtmlFragment("""
    <p>See <a href="https://github.com/ADE">ADE</a> &amp; <a href="javascript:alert(1)">unsafe</a>.</p>
    <script>alert("no")</script>
    """)

    XCTAssertTrue(markdown.contains("[ADE](https://github.com/ADE) & unsafe."))
    XCTAssertFalse(markdown.contains("javascript:"))
    XCTAssertFalse(markdown.contains("<script"))
  }

  func testHtmlNormalizationPreservesMarkdownCodeWithAngleBrackets() {
    let markdown = normalizePrGitHubHtmlFragment("""
    Use `<T>` in `Result<T>`.

    ```swift
    struct Box<T> {
      let value: T
    }
    ```
    """)

    XCTAssertTrue(markdown.contains("`<T>`"))
    XCTAssertTrue(markdown.contains("`Result<T>`"))
    XCTAssertTrue(markdown.contains("struct Box<T>"))
    XCTAssertTrue(markdown.contains("```swift"))
  }

  func testHtmlNormalizationPreservesSafeMarkdownAutolinks() {
    let markdown = normalizePrGitHubHtmlFragment("""
    Visit <https://example.com/docs?q=swift>.
    Email <user.name+ade@example.co.uk>.
    Strip <span>HTML</span> and <javascript:alert(1)>.
    """)

    XCTAssertTrue(markdown.contains("<https://example.com/docs?q=swift>"))
    XCTAssertTrue(markdown.contains("<user.name+ade@example.co.uk>"))
    XCTAssertTrue(markdown.contains("Strip HTML and ."))
    XCTAssertFalse(markdown.contains("<span>"))
    XCTAssertFalse(markdown.contains("<javascript:"))
  }

  func testDescriptionParserDoesNotPromoteFencedDetailsExample() {
    let blocks = parsePrGitHubDescriptionBlocks("""
    Example:

    ```html
    <details><summary>Example</summary>content</details>
    ```
    """)

    XCTAssertEqual(blocks.count, 1)
    guard case .markdown(_, let markdown) = blocks[0] else {
      return XCTFail("Expected fenced HTML to remain Markdown code")
    }
    XCTAssertTrue(markdown.contains("```html"))
    XCTAssertTrue(markdown.contains("<details><summary>Example</summary>content</details>"))
    XCTAssertFalse(blocks.contains { block in
      if case .disclosure = block { return true }
      return false
    })
  }

  func testDescriptionParserPreservesFourBacktickFence() {
    let blocks = parsePrGitHubDescriptionBlocks("""
    ````markdown
    <details><summary>Example</summary>content</details>
    ```
    ````
    """)

    XCTAssertEqual(blocks.count, 1)
    guard case .markdown(_, let markdown) = blocks[0] else {
      return XCTFail("Expected the four-backtick fence to remain Markdown")
    }
    XCTAssertTrue(markdown.contains("````markdown"))
    XCTAssertTrue(markdown.contains("<details><summary>Example</summary>content</details>"))
    XCTAssertFalse(markdown.contains("ADEPRCODE"))
  }

  func testDescriptionParserAllowsLongerClosingFence() {
    let blocks = parsePrGitHubDescriptionBlocks("""
    ```html
    <details><summary>Example</summary>content</details>
    ````
    """)

    XCTAssertEqual(blocks.count, 1)
    guard case .markdown(_, let markdown) = blocks[0] else {
      return XCTFail("Expected the longer closing fence to remain Markdown")
    }
    XCTAssertTrue(markdown.contains("```html"))
    XCTAssertTrue(markdown.contains("````"))
    XCTAssertTrue(markdown.contains("<details><summary>Example</summary>content</details>"))
    XCTAssertFalse(markdown.contains("ADEPRCODE"))
  }

  func testDescriptionParserRestoresInlineCodeInDisclosureTitle() {
    let blocks = parsePrGitHubDescriptionBlocks("""
    <details>
    <summary>About `Result<T>`</summary>
    Body
    </details>
    """)

    XCTAssertEqual(blocks.count, 1)
    guard case .disclosure(_, let title, let markdown) = blocks[0] else {
      return XCTFail("Expected a disclosure block")
    }
    XCTAssertEqual(title, "About `Result<T>`")
    XCTAssertEqual(markdown, "Body")
    XCTAssertFalse(title.contains("ADEPRCODE"))
  }

  func testDescriptionParserKeepsNestedDetailsInsideOuterDisclosure() {
    let blocks = parsePrGitHubDescriptionBlocks("""
    Before
    <details data-kind="outer">
    <summary>Outer title</summary>
    Outer beginning
    <DETAILS data-label="1 > 0">
    <summary>Inner title</summary>
    Inner body
    </DETAILS>
    Outer end
    </details>
    After
    """)

    XCTAssertEqual(blocks.count, 3)
    XCTAssertEqual(blocks[0], .markdown(id: "description-markdown-0", markdown: "Before"))
    guard case .disclosure(_, let title, let markdown) = blocks[1] else {
      return XCTFail("Expected the balanced outer details block to become a disclosure")
    }
    XCTAssertEqual(title, "Outer title")
    XCTAssertTrue(markdown.contains("Outer beginning"))
    XCTAssertTrue(markdown.contains("Inner title"))
    XCTAssertTrue(markdown.contains("Inner body"))
    XCTAssertTrue(markdown.contains("Outer end"))
    XCTAssertFalse(markdown.contains("<details"))
    XCTAssertEqual(blocks[2], .markdown(id: "description-markdown-2", markdown: "After"))
  }

  func testDescriptionParserDoesNotPromoteUnclosedOuterDetails() {
    let blocks = parsePrGitHubDescriptionBlocks("""
    Before
    <details>
    <summary>Outer title</summary>
    Outer beginning
    <details>
    <summary>Inner title</summary>
    Inner body
    </details>
    """)

    XCTAssertEqual(blocks.count, 1)
    guard case .markdown(_, let markdown) = blocks[0] else {
      return XCTFail("Expected malformed details markup to remain Markdown")
    }
    XCTAssertTrue(markdown.contains("Outer title"))
    XCTAssertTrue(markdown.contains("Outer beginning"))
    XCTAssertTrue(markdown.contains("Inner title"))
    XCTAssertTrue(markdown.contains("Inner body"))
    XCTAssertFalse(markdown.localizedCaseInsensitiveContains("<details"))
  }
}
