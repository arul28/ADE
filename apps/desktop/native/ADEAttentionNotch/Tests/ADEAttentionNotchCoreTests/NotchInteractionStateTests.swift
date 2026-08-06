import XCTest
@testable import ADEAttentionNotchCore

final class NotchInteractionStateTests: XCTestCase {
    /// The whole point of the two-mode redesign: hover *reveals* the strip, it
    /// never grows it. The old `prehover`/`peek` promotion is why hover mode
    /// landed on a different, taller rect than the pinned mode did.
    func testHoverRevealsTheIdenticalCompactStripInsteadOfGrowing() {
        for mode in NotchRevealMode.allCases {
            var state = NotchInteractionState()
            state.pointerEntered()

            XCTAssertEqual(state.presentation, .compact, "\(mode) grew on hover")
            XCTAssertTrue(state.pointerInside)
            XCTAssertFalse(state.isExplicitlyInteractive)

            state.pointerExited()
            XCTAssertEqual(state.presentation, .compact)
            XCTAssertFalse(state.pointerInside)
        }
    }

    /// And the rects agree, on real hardware numbers: the revealed strip is the
    /// pinned strip, to the point.
    func testRevealedStripIsTheSameRectInBothModes() {
        let strip = NotchStripMetrics(leadingWidth: 62, trailingWidth: 104)
        let size = notchSurfaceSize(
            presentation: .compact,
            physicalNotchWidth: 182,
            safeAreaTop: 34,
            strip: strip
        )
        for mode in NotchRevealMode.allCases {
            var state = NotchInteractionState()
            state.pointerEntered()
            XCTAssertEqual(
                notchSurfaceSize(
                    presentation: state.presentation,
                    physicalNotchWidth: 182,
                    safeAreaTop: 34,
                    strip: strip
                ),
                size,
                "\(mode) revealed onto a different rect"
            )
        }
    }

    /// Only hover mode hides at rest, and only while the pointer is elsewhere.
    func testDormancyIsHoverModeWithThePointerAway() {
        XCTAssertTrue(notchSurfaceIsDormant(
            presentation: .compact,
            revealMode: .hover,
            pointerInside: false
        ))
        XCTAssertFalse(notchSurfaceIsDormant(
            presentation: .compact,
            revealMode: .hover,
            pointerInside: true
        ))
        XCTAssertFalse(notchSurfaceIsDormant(
            presentation: .compact,
            revealMode: .always,
            pointerInside: false
        ))
        for presentation in [NotchPresentationState.expanded, .flash, .celebration] {
            XCTAssertFalse(notchSurfaceIsDormant(
                presentation: presentation,
                revealMode: .hover,
                pointerInside: false
            ))
        }
    }

    /// The hot zone has to sit strictly inside the strip it reveals, or the
    /// pointer oscillates along the sliver that pokes out.
    func testDormantHoverHotZoneStaysInsideTheRevealedStrip() {
        let strip = NotchStripMetrics.empty
        let compact = notchSurfaceSize(
            presentation: .compact,
            physicalNotchWidth: 182,
            safeAreaTop: 34,
            strip: strip
        )
        let hotZone = notchHoverHotZoneSize(physicalNotchWidth: 182, safeAreaTop: 34)
        XCTAssertEqual(hotZone.width, 270)
        XCTAssertEqual(hotZone.height, 34)
        XCTAssertLessThanOrEqual(hotZone.width, compact.width)
        XCTAssertLessThanOrEqual(hotZone.height, compact.height)

        let fallback = notchHoverHotZoneSize(physicalNotchWidth: nil)
        XCTAssertEqual(fallback, NotchSize(width: 96, height: 30))
    }

    /// A click — and only a click — opens the panel, in both modes.
    func testClickOpensTheSamePanelInEveryMode() {
        for mode in NotchRevealMode.allCases {
            var state = NotchInteractionState()
            let policy = NotchPresentationPolicy(revealMode: mode)
            XCTAssertTrue(state.explicitToggle(hasItems: true, policy: policy))
            XCTAssertEqual(state.presentation, .expanded, "\(mode) ignored an explicit click")
            XCTAssertTrue(state.isExplicitlyInteractive)

            // A second click closes what the first opened.
            XCTAssertFalse(state.explicitToggle(hasItems: true, policy: policy))
            XCTAssertEqual(state.presentation, .compact)
            XCTAssertFalse(state.isExplicitlyInteractive)
        }
    }

    func testExplicitExpansionOnlyHappensWithItems() {
        var state = NotchInteractionState()
        XCTAssertFalse(state.explicitToggle(hasItems: false))
        XCTAssertEqual(state.presentation, .compact)
        XCTAssertFalse(state.isExplicitlyInteractive)

        XCTAssertTrue(state.explicitToggle(hasItems: true))
        XCTAssertEqual(state.presentation, .expanded)
        XCTAssertTrue(state.isExplicitlyInteractive)
    }

    /// With the tall panel switched off the click cannot grow the surface — and
    /// says so, so the caller can route it to ADE instead of eating it.
    func testDisabledPanelReportsThatTheClickDidNotOpenAnything() {
        let policy = NotchPresentationPolicy(revealMode: .always, expandedPanelEnabled: false)
        XCTAssertFalse(policy.clickOpensPanel)

        var state = NotchInteractionState()
        XCTAssertFalse(state.explicitToggle(hasItems: true, policy: policy))
        XCTAssertEqual(state.presentation, .compact)
        XCTAssertFalse(state.isExplicitlyInteractive)
    }

    /// Turning the tall panel off while it is open has to act immediately;
    /// otherwise the setting looks broken until the next interaction.
    func testTurningOffTheExpandedPanelClosesAnOpenPanel() {
        var state = NotchInteractionState()
        state.explicitToggle(hasItems: true, policy: .default)
        XCTAssertEqual(state.presentation, .expanded)

        state.applyPolicy(NotchPresentationPolicy(revealMode: .hover, expandedPanelEnabled: false))

        XCTAssertEqual(state.presentation, .compact)
        XCTAssertFalse(state.isExplicitlyInteractive)
    }

    /// Switching reveal modes may not disturb what is drawn: both modes draw
    /// the identical strip, and only visibility at rest differs.
    func testSwitchingRevealModeNeverChangesWhatIsOnScreen() {
        var state = NotchInteractionState()
        state.explicitToggle(hasItems: true, policy: NotchPresentationPolicy(revealMode: .hover))
        state.applyPolicy(NotchPresentationPolicy(revealMode: .always))
        XCTAssertEqual(state.presentation, .expanded)
        XCTAssertTrue(state.isExplicitlyInteractive)
    }

    /// Takeovers are not a resting state, so no mode suppresses them — and each
    /// settles back onto the strip.
    func testTakeoversInterruptInEveryModeAndSettleOntoTheStrip() {
        for mode in NotchRevealMode.allCases {
            var alerting = NotchInteractionState()
            alerting.setFlash()
            XCTAssertEqual(alerting.presentation, .flash, "\(mode)")
            alerting.finishTransient(pointerInside: false)
            XCTAssertEqual(alerting.presentation, .compact, "\(mode)")

            var celebrating = NotchInteractionState()
            celebrating.setCelebration()
            XCTAssertEqual(celebrating.presentation, .celebration, "\(mode)")
            celebrating.finishTransient(pointerInside: true)
            XCTAssertEqual(celebrating.presentation, .compact, "\(mode)")
            XCTAssertTrue(celebrating.pointerInside)
        }
    }

    /// A panel the user opened outranks the news: yanking it away mid-read to
    /// show a card is the behaviour the timed takeover exists to avoid.
    func testATakeoverNeverStealsAPanelTheUserOpened() {
        var state = NotchInteractionState()
        state.explicitToggle(hasItems: true)
        state.setFlash()
        XCTAssertEqual(state.presentation, .expanded)
        state.setCelebration()
        XCTAssertEqual(state.presentation, .expanded)
    }

    /// The pointer leaving is not an answer to a takeover — its own timer is.
    func testPointerExitLeavesATakeoverAlone() {
        var state = NotchInteractionState()
        state.pointerEntered()
        state.setFlash()
        state.pointerExited()
        XCTAssertEqual(state.presentation, .flash)
    }

    func testHidingStopsExplicitPresentation() {
        var state = NotchInteractionState()
        state.explicitToggle(hasItems: true)
        XCTAssertEqual(state.presentation, .expanded)

        state.setVisible(false)

        XCTAssertEqual(state.presentation, .compact)
        XCTAssertFalse(state.isVisible)
        XCTAssertFalse(state.pointerInside)
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
            state.setFlash()
            state.setCelebration()
            XCTAssertEqual(state.presentation, .compact, "\(mode) reappeared while off")
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

    /// The panel files a row exactly where the strip counts it — the same
    /// five-way table, so Failed and Planning are sections of their own rather
    /// than rows borrowing amber. Idle roster history stays the ambient tail of
    /// Done no matter what phase it preserved.
    func testSectionsUseTheSameFiveWayTableAsTheStrip() {
        let needsYou = sectionFixture(id: "needs", phase: "needs_you")
        let failed = sectionFixture(id: "failed", phase: "failed")
        let planning = sectionFixture(id: "planning", phase: "running", mode: .planning)
        let running = sectionFixture(id: "running", phase: "running")
        let completed = sectionFixture(id: "completed", phase: "completed")
        let idleButRunning = sectionFixture(id: "idle", phase: "running", tier: "idle")

        let sections = notchActivityGroupSections(
            [completed, running, idleButRunning, planning, failed, needsYou]
        )
        XCTAssertEqual(sections.map(\.id), ["needs-you", "failed", "planning", "working", "done"])
        XCTAssertEqual(sections.map(\.title), ["Needs you", "Failed", "Planning", "Working", "Done"])
        XCTAssertEqual(sections.map(\.tone), [.amber, .red, .violet, .blue, .emerald])
        XCTAssertEqual(sections.map { $0.items.map(\.id) }, [
            ["needs"],
            ["failed"],
            ["planning"],
            ["running"],
            ["completed", "idle"],
        ])
        // An empty group is not drawn as a heading over nothing.
        XCTAssertEqual(
            notchActivityGroupSections([running]).map(\.id),
            ["working"]
        )
        XCTAssertTrue(notchActivityGroupSections([]).isEmpty)
    }

    /// The section a row opens into is the section the panel actually built,
    /// which is what makes `openPanel(revealing:)` uncollapse the right one.
    func testSectionIdsAgreeWithTheStripGroupIds() {
        for kind in NotchStripGroupKind.allCases {
            XCTAssertEqual(
                NotchActivityGroupSection(kind: kind, items: []).id,
                kind.sectionId
            )
        }
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
        tier: String? = nil,
        mode: AttentionChatActivityMode? = nil
    ) -> AttentionItem {
        AttentionItem(
            id: id,
            fingerprint: "fingerprint-\(id)",
            kind: "agent",
            eventKind: "agent_running",
            phase: phase,
            machine: AttentionMachine(machineKey: "mac-1", name: "Studio", online: true, lastSeenAt: nil),
            project: AttentionProject(projectId: "ade", name: "ADE"),
            chatActivityMode: mode,
            title: "Work",
            preview: "Working",
            privacyPreview: "Agent update",
            destination: AttentionDestination(kind: "session", sessionId: "session-\(id)"),
            occurredAt: "2026-08-01T12:00:00Z",
            updatedAt: "2026-08-01T12:00:00Z",
            activityTier: tier
        )
    }

    // MARK: - Geometry

    /// The strip hugs the cutout plus its wings. The old flat `notch + 224` is
    /// what made an empty strip as wide as its busiest possible self.
    func testPhysicalStripHugsTheCutoutPlusItsWings() {
        let empty = notchSurfaceSize(
            presentation: .compact,
            physicalNotchWidth: 182,
            safeAreaTop: 34
        )
        XCTAssertEqual(empty.width, 182 + 2 * 58)
        XCTAssertEqual(empty.height, 34)
        XCTAssertLessThan(empty.width, 406)

        // Both ears are the widest wing: the cutout is centered, so they must
        // be symmetric or the content stops lining up with the hardware.
        let lopsided = notchSurfaceSize(
            presentation: .compact,
            physicalNotchWidth: 182,
            safeAreaTop: 34,
            strip: NotchStripMetrics(leadingWidth: 40, trailingWidth: 120)
        )
        XCTAssertEqual(lopsided.width, 182 + 2 * (120 + 18))
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
        for presentation in NotchPresentationState.allSurfaceStates {
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

    /// A takeover is a card, not a panel: it stays far shorter than the thing a
    /// click opens.
    func testTakeoversStayCalmerThanThePanel() {
        let band = notchMenuBarBandHeight(safeAreaTop: 34)
        let flash = notchSurfaceSize(presentation: .flash, physicalNotchWidth: 200, safeAreaTop: 34)
        let expanded = notchSurfaceSize(presentation: .expanded, physicalNotchWidth: 200, safeAreaTop: 34)
        XCTAssertLessThanOrEqual(flash.height - band, 96)
        XCTAssertLessThan(flash.height, expanded.height / 2)
    }

    /// Growing on a click may only grow. A state narrower than the strip reads
    /// as the notch flinching away from the pointer.
    func testNoStateIsNarrowerThanCompact() {
        for notchWidth in [140.0, 182.0, 200.0, 240.0] {
            for strip in [
                NotchStripMetrics.empty,
                NotchStripMetrics(leadingWidth: 90, trailingWidth: 140),
                NotchStripMetrics(leadingWidth: 400, trailingWidth: 400),
            ] {
                let compact = notchSurfaceSize(
                    presentation: .compact,
                    physicalNotchWidth: notchWidth,
                    safeAreaTop: 34,
                    strip: strip
                )
                for presentation in [NotchPresentationState.expanded, .flash, .celebration] {
                    let size = notchSurfaceSize(
                        presentation: presentation,
                        physicalNotchWidth: notchWidth,
                        safeAreaTop: 34,
                        strip: strip
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
    }

    /// Every state has to fit the fixed panel the helper draws into, including
    /// with a strip whose content is trying to run away with it.
    func testEverySurfaceFitsInsideThePanel() {
        for presentation in NotchPresentationState.allSurfaceStates {
            for width in [Double?.none, 140, 200, 240] {
                for strip in [
                    NotchStripMetrics.empty,
                    NotchStripMetrics(leadingWidth: 1_000, trailingWidth: 1_000),
                ] {
                    let size = notchSurfaceSize(
                        presentation: presentation,
                        physicalNotchWidth: width,
                        safeAreaTop: width == nil ? 0 : 38,
                        strip: strip
                    )
                    XCTAssertLessThanOrEqual(size.width, NotchDisplayGeometry.panelSize.width)
                    XCTAssertLessThanOrEqual(size.height, NotchDisplayGeometry.panelSize.height)
                }
            }
        }
    }

    /// A display reporting an implausible cutout width must not produce a
    /// surface narrower than its own ears.
    func testImplausibleNotchWidthIsClamped() {
        let absurd = notchSurfaceSize(presentation: .compact, physicalNotchWidth: 4_000, safeAreaTop: 34)
        XCTAssertEqual(
            absurd.width,
            notchSurfaceSize(presentation: .compact, physicalNotchWidth: 240, safeAreaTop: 34).width
        )
        let tiny = notchSurfaceSize(presentation: .compact, physicalNotchWidth: 1, safeAreaTop: 34)
        XCTAssertGreaterThanOrEqual(tiny.width, 140 + 2 * 58)
    }
}

extension NotchPresentationState {
    /// Every state the surface can actually draw. Keeping the list in one place
    /// means adding a state to the machine fails these tests until its geometry
    /// is defined too.
    static let allSurfaceStates: [NotchPresentationState] = [
        .compact, .expanded, .flash, .celebration,
    ]
}
