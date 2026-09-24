import Foundation
import XCTest
@testable import ADEDesktopDriverCore

/// The words to type and the place to type them used to share `text`, so the
/// simplest documented command, `type "hello"`, could never find a target.
final class TypeCommandTests: XCTestCase {
    func testTypeTextIsTheWordsAndTextStaysALabel() {
        let (text, target) = TypeCommand.split([
            "typeText": .string("hello"),
            "text": .string("Search"),
            "clear": .bool(true),
        ])
        XCTAssertEqual(text, "hello")
        XCTAssertEqual(target["text"]?.stringValue, "Search")
        XCTAssertNil(target["clear"])
        XCTAssertTrue(TypeCommand.hasTarget(target))
    }

    func testAnOlderServiceTextIsTheWordsAndNeverALabel() {
        let (text, target) = TypeCommand.split(["text": .string("hello")])
        XCTAssertEqual(text, "hello")
        XCTAssertNil(target["text"])
        // No target: the driver types into the focused element instead of
        // searching the screen for the word it was asked to type.
        XCTAssertFalse(TypeCommand.hasTarget(target))
    }

    func testAHandleIsATarget() {
        let (_, target) = TypeCommand.split([
            "typeText": .string("hello"),
            "handle": .string("obs-1-1:e:8"),
        ])
        XCTAssertTrue(TypeCommand.hasTarget(target))
    }

    func testWordsAloneHaveNoTarget() {
        let (text, target) = TypeCommand.split(["typeText": .string("hello")])
        XCTAssertEqual(text, "hello")
        XCTAssertFalse(TypeCommand.hasTarget(target))
    }
}
