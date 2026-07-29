import XCTest
@testable import ADEAttentionNotchCore

final class NotchInteractionStateTests: XCTestCase {
    func testStaleHoverGenerationCannotOpenPeekAfterPointerExit() {
        var state = NotchInteractionState()
        let hoverGeneration = state.pointerEntered(hasItems: true)
        XCTAssertEqual(state.presentation, .prehover)

        state.pointerExited()
        state.applyPeek(generation: hoverGeneration, pointerInside: true)

        XCTAssertEqual(state.presentation, .compact)
    }

    func testExplicitExpansionOnlyHappensWithItems() {
        var state = NotchInteractionState()
        state.explicitToggle(hasItems: false)
        XCTAssertEqual(state.presentation, .compact)
        XCTAssertFalse(state.isExplicitlyInteractive)

        state.explicitToggle(hasItems: true)
        XCTAssertEqual(state.presentation, .expanded)
        XCTAssertTrue(state.isExplicitlyInteractive)
    }

    func testHidingStopsExplicitPresentation() {
        var state = NotchInteractionState()
        state.explicitToggle(hasItems: true)
        XCTAssertEqual(state.presentation, .expanded)

        state.setVisible(false)

        XCTAssertEqual(state.presentation, .compact)
        XCTAssertFalse(state.isVisible)
    }

    // MARK: - Presentation modes

    /// Hover mode is the shipped behaviour and stays the default a caller gets
    /// when it passes no policy at all.
    func testHoverModeIsTheDefaultPolicy() {
        XCTAssertEqual(NotchPresentationPolicy.default.revealMode, .hover)
        XCTAssertTrue(NotchPresentationPolicy.default.expandedPanelEnabled)
        XCTAssertEqual(NotchPresentationPolicy(settings: NotchSettings()), .default)

        var state = NotchInteractionState()
        let token = state.pointerEntered(hasItems: true, policy: .default)
        state.applyPeek(generation: token, pointerInside: true)
        XCTAssertEqual(state.presentation, .peek)
    }

    func testHoverModeIsVisuallyDormantOnlyWhileResting() {
        XCTAssertTrue(notchSurfaceIsDormant(
            presentation: .compact,
            revealMode: .hover
        ))
        for presentation in [
            NotchPresentationState.prehover, .peek, .expanded, .attention, .celebration,
        ] {
            XCTAssertFalse(notchSurfaceIsDormant(
                presentation: presentation,
                revealMode: .hover
            ))
        }
        for mode in [NotchRevealMode.minimal, .click] {
            XCTAssertFalse(notchSurfaceIsDormant(
                presentation: .compact,
                revealMode: mode
            ))
        }
    }

    func testDormantHoverHotZoneIsBoundedButEasyToEnter() {
        let physical = notchHoverHotZoneSize(
            physicalNotchWidth: 182,
            safeAreaTop: 34
        )
        XCTAssertEqual(physical.width, 270)
        XCTAssertEqual(physical.height, 42)
        XCTAssertLessThan(
            physical.width,
            notchSurfaceSize(
                presentation: .compact,
                physicalNotchWidth: 182,
                safeAreaTop: 34
            ).width
        )

        let fallback = notchHoverHotZoneSize(physicalNotchWidth: nil)
        XCTAssertEqual(fallback, NotchSize(width: 96, height: 34))
    }

    /// Click-only and compact+peek both mean "the pointer alone changes
    /// nothing", so a hover may not grow the surface in either.
    func testPointerNeverRevealsOutsideHoverMode() {
        for mode in [NotchRevealMode.click, .minimal] {
            let policy = NotchPresentationPolicy(revealMode: mode)
            var state = NotchInteractionState()
            let token = state.pointerEntered(hasItems: true, policy: policy)
            XCTAssertEqual(state.presentation, .compact, "\(mode) grew on hover")
            state.applyPeek(generation: token, pointerInside: true)
            XCTAssertEqual(state.presentation, .compact, "\(mode) peeked on hover")
        }
    }

    /// Every mode keeps the click, so neither the notch nor the menu-bar status
    /// item that stands in for it can ever become an inert control.
    func testClickStillOpensInEveryMode() {
        for mode in NotchRevealMode.allCases {
            var state = NotchInteractionState()
            state.explicitToggle(hasItems: true, policy: NotchPresentationPolicy(revealMode: mode))
            let expected: NotchPresentationState = mode == .minimal ? .peek : .expanded
            XCTAssertEqual(state.presentation, expected, "\(mode) ignored an explicit click")
            XCTAssertTrue(state.isExplicitlyInteractive)
        }
    }

    /// Presentation choices never let an event override the user's reveal
    /// preference; hover means the pointer is what reveals the surface.
    func testEveryModeSuppressesAlertAndCelebrationGrowth() {
        for mode in NotchRevealMode.allCases {
            let policy = NotchPresentationPolicy(revealMode: mode)
            var state = NotchInteractionState()
            state.setAttention(policy: policy)
            XCTAssertEqual(state.presentation, .compact)
            state.setCelebration(policy: policy)
            XCTAssertEqual(state.presentation, .compact)
        }
    }

    /// With the tall panel off, a click may only ever open the short peek — the
    /// point of the setting is that nothing covers menu-bar content.
    func testDisabledExpandedPanelDowngradesTheClickToAPeek() {
        let policy = NotchPresentationPolicy(revealMode: .hover, expandedPanelEnabled: false)
        XCTAssertEqual(policy.clickPresentation, .peek)

        var state = NotchInteractionState()
        state.explicitToggle(hasItems: true, policy: policy)
        XCTAssertEqual(state.presentation, .peek)
        XCTAssertTrue(state.isExplicitlyInteractive)

        // A second click closes it again.
        state.explicitToggle(hasItems: true, policy: policy)
        XCTAssertEqual(state.presentation, .compact)
        XCTAssertFalse(state.isExplicitlyInteractive)
    }

    /// A hover-opened peek is not "open": clicking through one has to latch the
    /// surface rather than dismiss it.
    func testClickingThroughAHoverPeekLatchesInsteadOfClosing() {
        let policy = NotchPresentationPolicy(revealMode: .hover, expandedPanelEnabled: false)
        var state = NotchInteractionState()
        let token = state.pointerEntered(hasItems: true, policy: policy)
        state.applyPeek(generation: token, pointerInside: true)
        XCTAssertEqual(state.presentation, .peek)
        XCTAssertFalse(state.isExplicitlyInteractive)

        state.explicitToggle(hasItems: true, policy: policy)
        XCTAssertEqual(state.presentation, .peek)
        XCTAssertTrue(state.isExplicitlyInteractive)
    }

    /// Turning the tall panel off while it is open has to act immediately;
    /// otherwise the setting looks broken until the next interaction.
    func testTurningOffTheExpandedPanelStepsAnOpenPanelDown() {
        var state = NotchInteractionState()
        state.explicitToggle(hasItems: true, policy: .default)
        XCTAssertEqual(state.presentation, .expanded)

        state.applyPolicy(NotchPresentationPolicy(revealMode: .hover, expandedPanelEnabled: false))

        XCTAssertEqual(state.presentation, .peek)
        XCTAssertTrue(state.isExplicitlyInteractive)
    }

    /// Switching to a stricter mode also has to reclaim whatever the previous
    /// mode had already put on screen.
    func testSwitchingModesCollapsesSurfacesTheNewModeForbids() {
        var hovering = NotchInteractionState()
        let token = hovering.pointerEntered(hasItems: true, policy: .default)
        hovering.applyPeek(generation: token, pointerInside: true)
        hovering.applyPolicy(NotchPresentationPolicy(revealMode: .click))
        XCTAssertEqual(hovering.presentation, .compact)

        var alerting = NotchInteractionState()
        alerting.setAttention(policy: .default)
        alerting.applyPolicy(NotchPresentationPolicy(revealMode: .minimal))
        XCTAssertEqual(alerting.presentation, .compact)

        var manuallyExpanded = NotchInteractionState()
        manuallyExpanded.explicitToggle(hasItems: true, policy: .default)
        manuallyExpanded.applyPolicy(NotchPresentationPolicy(revealMode: .minimal))
        XCTAssertEqual(manuallyExpanded.presentation, .peek)
        XCTAssertTrue(manuallyExpanded.isExplicitlyInteractive)
    }

    /// Settling out of an alert under a pointer that is not allowed to reveal
    /// anything has to land on compact, not on a peek hover never opened.
    func testTransientsSettleToCompactWhenHoverCannotReveal() {
        var state = NotchInteractionState()
        state.setAttention(policy: NotchPresentationPolicy(revealMode: .click))
        state.finishTransient(pointerInside: true, policy: NotchPresentationPolicy(revealMode: .click))
        XCTAssertEqual(state.presentation, .compact)

        let hoverToken = state.pointerEntered(hasItems: true, policy: .default)
        state.applyPeek(generation: hoverToken, pointerInside: true)
        XCTAssertEqual(state.presentation, .peek)
    }

    /// Turning the notch off entirely stays the strongest setting: it outranks
    /// whatever presentation mode is selected.
    func testDisablingTheNotchOutranksEveryPresentationMode() {
        for mode in NotchRevealMode.allCases {
            var state = NotchInteractionState()
            let policy = NotchPresentationPolicy(revealMode: mode)
            state.explicitToggle(hasItems: true, policy: policy)
            state.setVisible(false)

            XCTAssertFalse(state.isVisible)
            XCTAssertEqual(state.presentation, .compact)
            state.explicitToggle(hasItems: true, policy: policy)
            state.setAttention(policy: policy)
            XCTAssertEqual(state.presentation, .compact, "\(mode) reappeared while off")
        }
    }

    /// Every mode's largest reachable surface still has to fit the panel, and
    /// turning the tall panel off has to actually make the surface shorter.
    func testDisablingTheExpandedPanelKeepsTheSurfaceShorter() {
        for width in [Double?.none, 200] {
            let safeAreaTop: Double = width == nil ? 0 : 34
            let peek = notchSurfaceSize(
                presentation: NotchPresentationPolicy(expandedPanelEnabled: false).clickPresentation,
                physicalNotchWidth: width,
                safeAreaTop: safeAreaTop
            )
            let expanded = notchSurfaceSize(
                presentation: NotchPresentationPolicy(expandedPanelEnabled: true).clickPresentation,
                physicalNotchWidth: width,
                safeAreaTop: safeAreaTop
            )
            XCTAssertLessThan(peek.height, expanded.height)
        }
    }

    func testNavigationWrapsInBothDirections() {
        var state = NotchInteractionState()
        state.navigate(delta: -1, itemCount: 3)
        XCTAssertEqual(state.selectedIndex, 2)
        state.navigate(delta: 1, itemCount: 3)
        XCTAssertEqual(state.selectedIndex, 0)
        state.select(index: 9, itemCount: 3)
        XCTAssertEqual(state.selectedIndex, 2)
    }

    func testPhysicalSurfaceReservesHardwareAndSideEars() {
        let compact = notchSurfaceSize(
            presentation: .compact,
            physicalNotchWidth: 182,
            safeAreaTop: 34
        )
        let peek = notchSurfaceSize(
            presentation: .peek,
            physicalNotchWidth: 182,
            safeAreaTop: 34
        )
        XCTAssertEqual(compact.width, 406)
        XCTAssertGreaterThan(peek.width, compact.width)
        XCTAssertEqual(notchSurfaceSize(presentation: .compact, physicalNotchWidth: nil).width, 272)
    }

    /// Compact has to end exactly on the hardware cutout's bottom edge. A taller
    /// or shorter bar leaves a visible step where the two blacks meet.
    func testCompactPhysicalSurfaceIsExactlyTheMenuBarBand() {
        for safeAreaTop in [32.0, 34.0, 38.0] {
            let compact = notchSurfaceSize(
                presentation: .compact,
                physicalNotchWidth: 200,
                safeAreaTop: safeAreaTop
            )
            XCTAssertEqual(compact.height, safeAreaTop)
        }
    }

    /// A rounded or inset top edge is what makes the hardware cutout look
    /// bitten out of a floating slab, so every physical state stays square and
    /// flush at the top.
    func testPhysicalSurfaceTopEdgeIsFlushAndSquareInEveryState() {
        for presentation in [
            NotchPresentationState.compact, .prehover, .peek, .expanded, .attention, .celebration,
        ] {
            let size = notchSurfaceSize(
                presentation: presentation,
                physicalNotchWidth: 200,
                safeAreaTop: 34
            )
            let corners = notchSurfaceCorners(
                presentation: presentation,
                hasPhysicalNotch: true,
                size: size
            )
            XCTAssertEqual(corners.top, 0, "\(presentation) must stay flush with the display top")
            XCTAssertGreaterThan(corners.bottom, 0)
        }
    }

    /// Without a notch the surface floats below the menu bar and is rounded on
    /// every side.
    func testFloatingSurfaceRoundsEveryCorner() {
        let size = notchSurfaceSize(presentation: .compact, physicalNotchWidth: nil)
        let corners = notchSurfaceCorners(presentation: .compact, hasPhysicalNotch: false, size: size)
        XCTAssertEqual(corners.top, corners.bottom)
        XCTAssertGreaterThan(corners.top, 0)
    }

    /// Hover is a glance, not a panel: it stays well under the expanded height
    /// and only grows a little past the menu bar.
    func testHoverStaysCalmerThanExpansion() {
        let band = notchMenuBarBandHeight(safeAreaTop: 34)
        let peek = notchSurfaceSize(presentation: .peek, physicalNotchWidth: 200, safeAreaTop: 34)
        let expanded = notchSurfaceSize(presentation: .expanded, physicalNotchWidth: 200, safeAreaTop: 34)
        XCTAssertLessThanOrEqual(peek.height - band, 64)
        XCTAssertLessThan(peek.height, expanded.height / 2)
    }

    /// Hovering or clicking may only grow the surface. A state narrower than
    /// compact reads as the notch flinching away from the pointer.
    func testNoStateIsNarrowerThanCompact() {
        for notchWidth in [140.0, 182.0, 200.0, 240.0] {
            let compact = notchSurfaceSize(
                presentation: .compact,
                physicalNotchWidth: notchWidth,
                safeAreaTop: 34
            )
            for presentation in [
                NotchPresentationState.prehover, .peek, .expanded, .attention, .celebration,
            ] {
                let size = notchSurfaceSize(
                    presentation: presentation,
                    physicalNotchWidth: notchWidth,
                    safeAreaTop: 34
                )
                XCTAssertGreaterThanOrEqual(
                    size.width,
                    compact.width,
                    "\(presentation) at notch \(notchWidth) shrinks below compact"
                )
                XCTAssertGreaterThanOrEqual(size.height, compact.height)
            }
        }
    }

    /// Every state has to fit the fixed panel the helper draws into.
    func testEverySurfaceFitsInsideThePanel() {
        for presentation in [
            NotchPresentationState.compact, .prehover, .peek, .expanded, .attention, .celebration,
        ] {
            for width in [Double?.none, 140, 200, 240] {
                let size = notchSurfaceSize(
                    presentation: presentation,
                    physicalNotchWidth: width,
                    safeAreaTop: width == nil ? 0 : 38
                )
                XCTAssertLessThanOrEqual(size.width, NotchDisplayGeometry.panelSize.width)
                XCTAssertLessThanOrEqual(size.height, NotchDisplayGeometry.panelSize.height)
            }
        }
    }

    /// A display reporting an implausible cutout width must not produce a
    /// surface narrower than its own ears.
    func testImplausibleNotchWidthIsClamped() {
        let absurd = notchSurfaceSize(presentation: .compact, physicalNotchWidth: 4_000, safeAreaTop: 34)
        XCTAssertEqual(absurd.width, notchSurfaceSize(presentation: .compact, physicalNotchWidth: 240, safeAreaTop: 34).width)
        let tiny = notchSurfaceSize(presentation: .compact, physicalNotchWidth: 1, safeAreaTop: 34)
        XCTAssertGreaterThanOrEqual(tiny.width, 364)
    }
}
