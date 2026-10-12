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

  func testHtmlNormalizationPreservesAngleBracketProseAndStripsActualTags() {
    let markdown = normalizePrGitHubHtmlFragment("""
    Replace <placeholder> or <article-placeholder> when 1 < 2 and 3 > 2.
    <iframe src="https://unsafe.example">Fallback</iframe>
    <img src="invalid" onerror="alert(1)">
    """)

    XCTAssertTrue(
      markdown.contains("Replace <placeholder> or <article-placeholder> when 1 < 2 and 3 > 2.")
    )
    XCTAssertTrue(markdown.contains("Fallback"))
    XCTAssertFalse(markdown.contains("<iframe"))
    XCTAssertFalse(markdown.contains("</iframe>"))
    XCTAssertFalse(markdown.contains("<img"))
    XCTAssertFalse(markdown.contains("onerror"))
  }

  func testHtmlNormalizationPreservesMarkdownIndentation() {
    let markdown = normalizePrGitHubHtmlFragment("""
    - Parent
      - Nested

        Indented code
          continuation
    """)

    XCTAssertEqual(
      markdown,
      """
      - Parent
        - Nested

          Indented code
            continuation
      """
    )
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

  // MARK: Pictures and videos in a PR text

  private let attachment = "https://github.com/user-attachments/assets/83908590-2459-482d-bce8-9fbe8c7b7974"

  private func image(_ url: String, _ label: String) -> PrDescriptionMedia {
    PrDescriptionMedia(kind: .image, url: URL(string: url)!, label: label)
  }

  func testAPictureAVideoAndTextAroundThemBecomeSeparatePieces() {
    let pieces = prDescriptionPieces("""
    ## Evidence

    ![The new list](\(attachment))

    The upload ran.

    \(attachment)
    """)

    XCTAssertEqual(pieces, [
      .markdown("## Evidence"),
      .media(image(attachment, "The new list")),
      .markdown("The upload ran."),
      .media(PrDescriptionMedia(kind: .video, url: URL(string: attachment)!, label: "")),
    ])
  }

  func testABeforeAndAfterTableOfPicturesBecomesAComparison() {
    let other = "https://private-user-images.githubusercontent.com/1/after.png"
    let pieces = prDescriptionPieces("""
    | Before | After (default) |
    | --- | --- |
    | ![Old](\(attachment) "ade-proof:a1") | ![New](\(other)) |

    The strip is on top.
    """)

    XCTAssertEqual(pieces, [
      .compare([
        PrDescriptionCompareSide(title: "Before", media: image(attachment, "Old")),
        PrDescriptionCompareSide(title: "After (default)", media: image(other, "New")),
      ]),
      .markdown("The strip is on top."),
    ])
  }

  func testTextThatOnlyLooksLikeMediaStaysText() {
    // A table of numbers, a picture inside a sentence, a link inside a
    // sentence, and anything inside a code fence are not media.
    let text = """
    | Before | After |
    | --- | --- |
    | 137 ms | 47 ms |

    See ![icon](\(attachment)) here, and \(attachment) there.

    ```
    \(attachment)
    ![x](\(attachment))
    ```
    """
    XCTAssertEqual(prDescriptionPieces(text), [.markdown(text)])
  }

  func testOnlyMediaThatGitHubServesIsLoaded() {
    // A PR text can be written by anyone, so a picture on another host stays
    // words: loading it would tell its author who read the PR.
    let tracker = "![chart](https://tracker.example.com/pixel.png)"
    XCTAssertEqual(prDescriptionPieces(tracker), [.markdown(tracker)])
    XCTAssertEqual(prDescriptionPieces("![chart](http://github.com/user-attachments/assets/x.png)").count, 1)
    XCTAssertFalse(prIsGitHubMediaURL("https://github.com/someone/repo/raw/main/a.png"))
    XCTAssertFalse(prIsGitHubMediaURL("https://evilgithubusercontent.com/a.png"))
    XCTAssertTrue(prIsGitHubMediaURL("https://user-images.githubusercontent.com/1/a.png"))
  }

  func testAnHtmlImageFromGitHubIsDrawnAndAnyOtherStaysWords() {
    let blocks = parsePrGitHubDescriptionBlocks("""
    Before the fix:
    <img width="800" alt="The old list" src="\(attachment)" />
    <img alt="A chart" src="https://tracker.example.com/pixel.png">
    """)

    guard case .markdown(_, let markdown) = blocks[0] else {
      return XCTFail("Expected one markdown block")
    }
    XCTAssertEqual(prDescriptionPieces(markdown), [
      .markdown("Before the fix:"),
      .media(image(attachment, "The old list")),
      .markdown("[Image: A chart]"),
    ])
  }
}
