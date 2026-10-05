import ApplicationServices
import XCTest
@testable import ADEDesktopDriver

/// The left-click fallback policy and the element name a refusal prints.
///
/// A live Safari check found a left click on web text falling through to
/// `AXShowMenu` and opening the context menu. These pin the policy: only a
/// control whose press *is* a menu may show one, and a refusal names the
/// element by the first non-empty of its title, label and value.
final class AccessibilityDriverTests: XCTestCase {
    private func observedElement(
        role: String = kAXButtonRole,
        title: String? = nil,
        label: String? = nil,
        value: String? = nil
    ) -> ObservedElement {
        ObservedElement(
            index: 1,
            handle: "obs-1:e:1",
            role: role,
            subrole: nil,
            title: title,
            label: label,
            value: value,
            identifier: nil,
            help: nil,
            enabled: true,
            focused: false,
            actions: [],
            frame: .zero,
            windowId: nil,
            pid: 0,
            parentIndex: nil
        )
    }

    func testMenuTypeRolesKeepAXShowMenu() {
        for role in ["AXMenuBarItem", "AXMenuButton", "AXPopUpButton"] {
            XCTAssertTrue(
                AccessibilityDriver.clickPreferredActions(forRole: role).contains("AXShowMenu"),
                "\(role) is a menu, so AXShowMenu stays in its preferred list"
            )
        }
    }

    func testNonMenuRolesNeitherPreferNorFallBackToAXShowMenu() {
        XCTAssertTrue(AccessibilityDriver.clickNeverActions.contains("AXShowMenu"))
        for role in ["AXButton", "AXStaticText", "AXImage", "AXWebArea"] {
            XCTAssertFalse(
                AccessibilityDriver.clickPreferredActions(forRole: role).contains("AXShowMenu"),
                "\(role) should not prefer AXShowMenu"
            )
        }
    }

    func testTheLastResortFallbackKeepsOnlyRealPressActions() {
        let actions = ["AXShowMenu", "AXCancel", "AXIncrement", "AXScrollToVisible", "AXPress", "AXOpen"]
        let fallback = actions.filter { !AccessibilityDriver.clickNeverActions.contains($0) }
        XCTAssertEqual(fallback, ["AXPress", "AXOpen"])
    }

    func testDisplayNameUsesTheFirstNonEmptyOfTitleLabelValue() {
        XCTAssertEqual(
            AccessibilityDriver.displayName(of: observedElement(title: "Save", label: "Save button", value: "x")),
            "Save"
        )
        XCTAssertEqual(
            AccessibilityDriver.displayName(of: observedElement(title: "", label: "Read more", value: "Read more value")),
            "Read more"
        )
        XCTAssertEqual(
            AccessibilityDriver.displayName(of: observedElement(title: "  ", label: nil, value: "Read more value")),
            "Read more value"
        )
        XCTAssertEqual(AccessibilityDriver.displayName(of: observedElement()), "untitled")
    }

    func testDisplayNameTruncatesAVeryLongName() {
        let name = AccessibilityDriver.displayName(of: observedElement(title: String(repeating: "a", count: 80)))
        XCTAssertEqual(name.count, 60)
        XCTAssertTrue(name.hasSuffix("…"))
    }
}
