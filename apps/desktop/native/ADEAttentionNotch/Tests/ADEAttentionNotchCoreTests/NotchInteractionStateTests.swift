import XCTest
@testable import ADEAttentionNotchCore

final class NotchInteractionStateTests: XCTestCase {
    /// Hover stops at prehover. The 145ms promotion to `.peek` is gone: that
    /// layout belongs to event toasts now, and a hover that grew into a card
    /// competed with the toast it looked identical to.
    func testHoverStopsAtPrehoverAndNeverOpensTheToastLayout() {
        var state = NotchInteractionState()
        state.pointerEntered(hasItems: true)
        XCTAssertEqual(state.presentation, .prehover)

        // Nothing else the hover flow can do promotes it further.
        state.pointerEntered(hasItems: true)
        XCTAssertEqual(state.presentation, .prehover)

        state.pointerExited()
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
        state.pointerEntered(hasItems: true, policy: .default)
        XCTAssertEqual(state.presentation, .prehover)
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
            state.pointerEntered(hasItems: true, policy: policy)
            XCTAssertEqual(state.presentation, .compact, "\(mode) grew on hover")
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

    /// Automatic reveal is a setting now, but "click only" still outranks it:
    /// that mode is literal, and nothing but a click may open anything.
    func testAutomaticRevealHonoursTheSettingAndDefersToClickOnlyMode() {
        for mode in NotchRevealMode.allCases {
            let allowed = NotchPresentationPolicy(revealMode: mode, automaticRevealEnabled: true)
            XCTAssertEqual(allowed.allowsAutomaticReveal, mode != .click, "\(mode)")

            var alerting = NotchInteractionState()
            alerting.setAttention(policy: allowed)
            XCTAssertEqual(alerting.presentation, mode == .click ? .compact : .attention, "\(mode)")

            var celebrating = NotchInteractionState()
            celebrating.setCelebration(policy: allowed)
            XCTAssertEqual(celebrating.presentation, mode == .click ? .compact : .celebration, "\(mode)")

            // Turned off, no mode may grow the surface on its own.
            let off = NotchPresentationPolicy(revealMode: mode, automaticRevealEnabled: false)
            XCTAssertFalse(off.allowsAutomaticReveal, "\(mode)")
            var suppressed = NotchInteractionState()
            suppressed.setAttention(policy: off)
            XCTAssertEqual(suppressed.presentation, .compact, "\(mode)")
            suppressed.setCelebration(policy: off)
            XCTAssertEqual(suppressed.presentation, .compact, "\(mode)")
        }
    }

    /// Turning automatic reveal off while a toast is on screen has to collapse
    /// it; otherwise the setting looks broken until the toast expires.
    func testTurningOffAutomaticRevealCollapsesAToastAlreadyOnScreen() {
        for treatment in [NotchToastTreatment.alert, .celebration] {
            var state = NotchInteractionState()
            let on = NotchPresentationPolicy(revealMode: .hover, automaticRevealEnabled: true)
            if treatment == .celebration {
                state.setCelebration(policy: on)
            } else {
                state.setAttention(policy: on)
            }
            XCTAssertEqual(state.presentation, treatment.presentation)

            state.applyPolicy(NotchPresentationPolicy(
                revealMode: .hover,
                automaticRevealEnabled: false
            ))
            XCTAssertEqual(state.presentation, .compact, "\(treatment)")
        }
    }

    /// The ticker belongs to the pinned strip, the one mode that keeps a bar on
    /// screen at rest.
    func testTickerOnlyRunsInThePinnedMode() {
        for mode in NotchRevealMode.allCases {
            XCTAssertEqual(
                NotchPresentationPolicy(revealMode: mode, tickerEnabled: true).showsTicker,
                mode == .minimal,
                "\(mode)"
            )
            XCTAssertFalse(
                NotchPresentationPolicy(revealMode: mode, tickerEnabled: false).showsTicker
            )
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
    func testClickingThroughAHoverLatchesInsteadOfClosing() {
        let policy = NotchPresentationPolicy(revealMode: .hover, expandedPanelEnabled: false)
        var state = NotchInteractionState()
        state.pointerEntered(hasItems: true, policy: policy)
        XCTAssertEqual(state.presentation, .prehover)
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
        hovering.pointerEntered(hasItems: true, policy: .default)
        hovering.applyPolicy(NotchPresentationPolicy(revealMode: .click))
        XCTAssertEqual(hovering.presentation, .compact)

        var alerting = NotchInteractionState()
        alerting.setAttention(policy: .default)
        alerting.applyPolicy(NotchPresentationPolicy(
            revealMode: .minimal,
            automaticRevealEnabled: false
        ))
        XCTAssertEqual(alerting.presentation, .compact)

        var manuallyExpanded = NotchInteractionState()
        manuallyExpanded.explicitToggle(hasItems: true, policy: .default)
        manuallyExpanded.applyPolicy(NotchPresentationPolicy(revealMode: .minimal))
        XCTAssertEqual(manuallyExpanded.presentation, .peek)
        XCTAssertTrue(manuallyExpanded.isExplicitlyInteractive)
    }

    /// A toast always settles back to the bar. `.peek` is the toast's own
    /// layout now, so landing there would leave a card on screen with nothing
    /// left to say — under a hovering pointer it lands on prehover instead.
    func testTransientsNeverSettleOntoTheToastLayout() {
        for (mode, pointerInside, expected) in [
            (NotchRevealMode.click, true, NotchPresentationState.compact),
            (.hover, true, .prehover),
            (.hover, false, .compact),
            (.minimal, true, .compact),
        ] {
            var state = NotchInteractionState()
            let policy = NotchPresentationPolicy(revealMode: mode)
            state.setAttention(policy: policy)
            state.finishTransient(pointerInside: pointerInside, policy: policy)
            XCTAssertEqual(state.presentation, expected, "\(mode) inside=\(pointerInside)")
            XCTAssertNotEqual(state.presentation, .peek)
        }
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
            state.setCelebration(policy: policy)
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

    /// The pager is gone — the panel scrolls — so selection is only ever set by
    /// pointing at a row, and only has to stay inside the list.
    func testSelectionIsClampedToTheListInsteadOfPaged() {
        var state = NotchInteractionState()
        state.select(index: 9, itemCount: 3)
        XCTAssertEqual(state.selectedIndex, 2)
        state.select(index: -4, itemCount: 3)
        XCTAssertEqual(state.selectedIndex, 0)
        state.select(index: 2, itemCount: 3)
        state.clampSelection(itemCount: 1)
        XCTAssertEqual(state.selectedIndex, 0)
        state.clampSelection(itemCount: 0)
        XCTAssertEqual(state.selectedIndex, 0)
    }

    // MARK: - Activity sections

    /// The panel files a row exactly where the desktop popover files it,
    /// including the rule that idle roster history is the ambient tail of Done
    /// no matter what phase it preserved.
    func testSectionsMirrorTheRendererPriorityFlatThree() {
        let needsYou = sectionFixture(id: "needs", phase: "needs_you")
        let failed = sectionFixture(id: "failed", phase: "failed")
        let running = sectionFixture(id: "running", phase: "running")
        let completed = sectionFixture(id: "completed", phase: "completed")
        let idleButRunning = sectionFixture(id: "idle", phase: "running", tier: "idle")

        let sections = notchActivitySections([completed, running, idleButRunning, failed, needsYou])
        XCTAssertEqual(sections.needsYou.map(\.id), ["needs", "failed"])
        XCTAssertEqual(sections.working.map(\.id), ["running"])
        XCTAssertEqual(sections.done.map(\.id), ["completed", "idle"])
        XCTAssertEqual(sections.live.map(\.id), ["needs", "failed", "running"])
        XCTAssertEqual(sections.total, 5)
    }

    /// A host that predates the counts block must not make the surface claim an
    /// overflow it cannot see.
    func testCountsFallBackToTheRowsOnHandWhenTheHostSendsNone() {
        let snapshot = AttentionSnapshot(
            revision: 1,
            generatedAt: "2026-08-01T12:00:00Z",
            items: [
                sectionFixture(id: "needs", phase: "needs_you"),
                sectionFixture(id: "running", phase: "running"),
            ]
        )
        let counts = snapshot.resolvedCounts()
        XCTAssertEqual(counts.needsYou, 1)
        XCTAssertEqual(counts.working, 1)
        XCTAssertEqual(counts.total, 2)
        XCTAssertEqual(counts.overflow(shownItemCount: 2), 0)

        // With counts, the totals are the account's, not the frame's.
        let projected = AttentionSnapshot(
            revision: 2,
            generatedAt: "2026-08-01T12:00:01Z",
            items: [sectionFixture(id: "needs", phase: "needs_you")],
            counts: AttentionCounts(needsYou: 3, working: 9, done: 49, total: 61)
        )
        XCTAssertEqual(projected.resolvedCounts().total, 61)
        XCTAssertEqual(projected.resolvedCounts().overflow(shownItemCount: 1), 60)
    }

    private func sectionFixture(
        id: String,
        phase: String,
        tier: String? = nil
    ) -> AttentionItem {
        AttentionItem(
            id: id,
            fingerprint: "fingerprint-\(id)",
            kind: "agent",
            eventKind: "agent_running",
            phase: phase,
            machine: AttentionMachine(machineKey: "mac-1", name: "Studio", online: true, lastSeenAt: nil),
            project: AttentionProject(projectId: "ade", name: "ADE"),
            title: "Work",
            preview: "Working",
            privacyPreview: "Agent update",
            destination: AttentionDestination(kind: "session", sessionId: "session-\(id)"),
            occurredAt: "2026-08-01T12:00:00Z",
            updatedAt: "2026-08-01T12:00:00Z",
            activityTier: tier
        )
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
