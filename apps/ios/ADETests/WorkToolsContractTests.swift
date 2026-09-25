import UIKit
import XCTest
@testable import ADE

/// Wire + gating contract for the read-only Work tools pane.
///
/// The phone mirrors a surface it cannot drive, so the only things that can
/// break silently are the two seams it does not compile against: the JSON the
/// daemon's `workTools.*` commands emit
/// (`apps/desktop/src/shared/types/workTools.ts`), and the handshake that
/// decides whether the lane tool chips are polled at all
/// (`apps/desktop/src/shared/syncMobileCompatibility.ts`).
final class WorkToolsContractTests: XCTestCase {

  // MARK: - Wire decoding

  func testLaneStateDecodesTheFullPayloadIncludingFieldsThePhoneIgnores() throws {
    // Byte-for-byte the shape `workToolsStateService.getLaneState` returns,
    // plus a field from a newer host. `activeToolUpdatedAt` / `capturedAt` /
    // `activeTabId` / `byteLength` are deliberately not modelled on the phone;
    // this asserts their presence cannot break the decode.
    let data = Data(#"""
    {
      "laneId": "lane-1",
      "activeTool": "browser",
      "activeToolUpdatedAt": "2026-09-07T10:00:00.000Z",
      "browser": {
        "activeTabId": "tab-2",
        "tabs": [
          {
            "id": "tab-1",
            "title": "ADE",
            "url": "https://ade-app.dev",
            "ownerChatSessionId": "chat-9",
            "recording": true,
            "active": false,
            "handoffReason": null
          },
          {
            "id": "tab-2",
            "title": null,
            "url": null,
            "ownerChatSessionId": null,
            "recording": false,
            "active": true,
            "handoffReason": "Sign in to GitHub"
          }
        ],
        "latestObservation": {
          "path": "/p/.ade/cache/browser-observations/c/tab-2/obs.png",
          "capturedAt": "2026-09-07T10:00:01.000Z",
          "caption": "GitHub · Sign in"
        }
      },
      "browserUnavailable": null,
      "appControl": {
        "appName": "Ghost",
        "status": "attached",
        "driver": "cdp",
        "latestObservation": null
      },
      "capturedAt": "2026-09-07T10:00:02.000Z",
      "somethingANewerDesktopAdded": { "enabled": true }
    }
    """#.utf8)

    let state = try JSONDecoder().decode(WorkToolsLaneState.self, from: data)

    XCTAssertEqual(state.laneId, "lane-1")
    XCTAssertEqual(state.activeTool, "browser")
    XCTAssertNil(state.browserUnavailable)
    let tabs = try XCTUnwrap(state.browser?.tabs)
    XCTAssertEqual(tabs.map(\.id), ["tab-1", "tab-2"])
    XCTAssertTrue(tabs[0].recording)
    XCTAssertFalse(tabs[0].active)
    XCTAssertNil(tabs[0].handoffReason)
    XCTAssertNil(tabs[1].title)
    XCTAssertTrue(tabs[1].active)
    // The read-only handoff line is the whole reason a stalled lane is
    // explicable from a phone; losing this field would make it look hung.
    XCTAssertEqual(tabs[1].handoffReason, "Sign in to GitHub")
    XCTAssertEqual(
      state.browser?.latestObservation?.path,
      "/p/.ade/cache/browser-observations/c/tab-2/obs.png")
    XCTAssertEqual(state.browser?.latestObservation?.caption, "GitHub · Sign in")
    XCTAssertEqual(state.appControl?.appName, "Ghost")
    XCTAssertEqual(state.appControl?.driver, "cdp")
    XCTAssertNil(state.appControl?.latestObservation)
  }

  func testLaneStateDecodesTheAbsentBrowserCaseTheDaemonEmitsMostOften() throws {
    // No desktop attached is an ordinary state, not an error: `browser` is null
    // and `browserUnavailable` carries the reason.
    let data = Data(#"""
    {
      "laneId": "lane-1",
      "activeTool": null,
      "activeToolUpdatedAt": null,
      "browser": null,
      "browserUnavailable": "desktop_not_attached",
      "appControl": null,
      "capturedAt": "2026-09-07T10:00:02.000Z"
    }
    """#.utf8)

    let state = try JSONDecoder().decode(WorkToolsLaneState.self, from: data)
    XCTAssertNil(state.activeTool)
    XCTAssertNil(state.browser)
    XCTAssertNil(state.appControl)
    XCTAssertEqual(state.browserUnavailable, "desktop_not_attached")
  }

  func testLaneStateDecodesOpenToolsAndAgentBrowserPresenceWhenPresentOrAbsent() throws {
    let populatedData = Data(#"""
    {
      "laneId": "lane-1",
      "activeTool": "browser",
      "openTools": ["terminal", "browser", "git"],
      "browser": null,
      "browserUnavailable": "browser_pane_not_opened",
      "agentBrowserPresence": [
        { "chatSessionId": "chat-7", "tabId": "tab-2" }
      ],
      "appControl": null
    }
    """#.utf8)

    let populated = try JSONDecoder().decode(WorkToolsLaneState.self, from: populatedData)
    XCTAssertEqual(populated.openTools, ["terminal", "browser", "git"])
    XCTAssertEqual(
      populated.agentBrowserPresence,
      [WorkToolsAgentBrowserPresence(chatSessionId: "chat-7", tabId: "tab-2")]
    )

    let legacyData = Data(#"""
    {
      "laneId": "lane-1",
      "activeTool": null,
      "browser": null,
      "browserUnavailable": "desktop_not_attached",
      "appControl": null
    }
    """#.utf8)

    let legacy = try JSONDecoder().decode(WorkToolsLaneState.self, from: legacyData)
    XCTAssertNil(legacy.openTools)
    XCTAssertNil(legacy.agentBrowserPresence)
  }

  func testObservationPreviewDecodesWithoutTheByteLengthThePhoneIgnores() throws {
    let data = Data(#"""
    { "dataUrl": "data:image/png;base64,AAAA", "mimeType": "image/png", "byteLength": 3 }
    """#.utf8)
    let preview = try JSONDecoder().decode(WorkToolsObservationPreview.self, from: data)
    XCTAssertEqual(preview.mimeType, "image/png")
    XCTAssertTrue(preview.dataUrl.hasPrefix("data:image/png;base64,"))
  }

  // MARK: - Unavailable reasons

  func testEveryUnavailableReasonHasItsOwnSentenceAndUnknownOnesFallBack() {
    // These five strings are `WorkToolsUnavailableReason` in
    // apps/desktop/src/shared/types/workTools.ts, and the sentences must stay
    // byte-identical to `workToolsUnavailableMessage` there — the Swift switch
    // cannot import it, so only this test holds the two wordings together.
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage("desktop_not_attached"),
      "The browser runs in ADE Desktop. Open ADE on your Mac to see its tabs.")
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage("desktop_not_attached_for_project"),
      "ADE Desktop doesn't have this project open. Open it on your Mac to see its tabs.")
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage("browser_pane_not_opened"),
      "Open the Browser tool on the desktop to see tabs here.")
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage("unsupported"),
      "The browser isn't available on this machine.")
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage("error"),
      "Couldn't read the browser's state.")

    // The three narrow reasons must not collapse into the default: each one
    // sends the user somewhere different.
    let distinct = Set([
      workToolsBrowserUnavailableMessage("desktop_not_attached"),
      workToolsBrowserUnavailableMessage("desktop_not_attached_for_project"),
      workToolsBrowserUnavailableMessage("browser_pane_not_opened"),
      workToolsBrowserUnavailableMessage("unsupported"),
      workToolsBrowserUnavailableMessage("error"),
    ])
    XCTAssertEqual(distinct.count, 5)

    // A reason a newer desktop invents, and an absent one, both degrade to the
    // common case rather than rendering nothing or inventing a diagnosis.
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage("some_future_reason"),
      workToolsBrowserUnavailableMessage("desktop_not_attached"))
    XCTAssertEqual(
      workToolsBrowserUnavailableMessage(nil),
      workToolsBrowserUnavailableMessage("desktop_not_attached"))
  }

  func testMalformedFramePayloadsProduceNoImageRatherThanACrash() {
    XCTAssertNil(WorkToolsSheet.decodeDataUrl("https://example.com/shot.png"))
    XCTAssertNil(WorkToolsSheet.decodeDataUrl("data:image/png;base64"))
    XCTAssertNil(WorkToolsSheet.decodeDataUrl(""))
    XCTAssertNotNil(WorkToolsSheet.decodeDataUrl("data:image/png;base64,QUJD"))
  }

  // MARK: - Frame slot

  func testFrameSlotDegradesInsteadOfSpinningWhenTheHostCannotSendBytes() {
    let path = "/p/.ade/cache/browser-observations/c/tab-2/obs.png"

    // Nothing captured: the card says so, whatever the host supports.
    XCTAssertEqual(
      workToolsFrameState(
        observationPath: nil,
        loadedFramePath: nil,
        unreadableFramePath: nil,
        supportsObservationPreview: true),
      .empty)
    XCTAssertEqual(
      workToolsFrameState(
        observationPath: nil,
        loadedFramePath: nil,
        unreadableFramePath: nil,
        supportsObservationPreview: false),
      .empty)

    // The regression this exists for: `workTools.getLaneState` without
    // `workTools.readObservationPreview` names a frame the phone can never
    // fetch, and the card used to spin on it forever.
    XCTAssertEqual(
      workToolsFrameState(
        observationPath: path,
        loadedFramePath: nil,
        unreadableFramePath: nil,
        supportsObservationPreview: false),
      .unavailable(workToolsFramesUnsupportedMessage))

    // Supported and not yet answered: a spinner is correct here.
    XCTAssertEqual(
      workToolsFrameState(
        observationPath: path,
        loadedFramePath: nil,
        unreadableFramePath: nil,
        supportsObservationPreview: true),
      .loading)

    // The host answered "no bytes" for this path — a deleted, oversized or
    // non-image frame. Retrying every 3s would spin forever.
    XCTAssertEqual(
      workToolsFrameState(
        observationPath: path,
        loadedFramePath: nil,
        unreadableFramePath: path,
        supportsObservationPreview: true),
      .unavailable(workToolsFrameUnreadableMessage))

    // A verdict about the PREVIOUS frame says nothing about the new one.
    XCTAssertEqual(
      workToolsFrameState(
        observationPath: path,
        loadedFramePath: nil,
        unreadableFramePath: "/p/.ade/cache/browser-observations/c/tab-1/old.png",
        supportsObservationPreview: true),
      .loading)

    // Held image, and it is this observation's.
    XCTAssertEqual(
      workToolsFrameState(
        observationPath: path,
        loadedFramePath: path,
        unreadableFramePath: nil,
        supportsObservationPreview: true),
      .image)

    // The desktop captured a newer frame: the old image must not stand in for
    // it, so the card goes back to loading rather than showing a stale shot.
    XCTAssertEqual(
      workToolsFrameState(
        observationPath: path,
        loadedFramePath: "/p/.ade/cache/browser-observations/c/tab-1/old.png",
        unreadableFramePath: nil,
        supportsObservationPreview: true),
      .loading)

    // The three sentences are distinct, so a user can tell "nothing was
    // captured" from "this Mac can't send it" from "this one failed".
    XCTAssertNotEqual(workToolsFramesUnsupportedMessage, workToolsFrameUnreadableMessage)
  }

  // MARK: - Lane tool chips

  /// A status whose device is the lane's own unless `laneDeviceUdid` says otherwise.
  private static func device(
    _ name: String?,
    udid: String = "UDID-1",
    family: String = "iphone",
    state: String? = "Booted",
    laneDeviceUdid: String? = "UDID-1"
  ) -> AppleDeviceStatus {
    AppleDeviceStatus(
      laneId: "lane-1",
      device: AppleDeviceStatusDevice(udid: udid, name: name, family: family, state: state),
      stream: AppleDeviceStatusStream(running: false),
      laneDevice: laneDeviceUdid.map { AppleDeviceStatusLaneDevice(udid: $0) }
    )
  }

  private static func tabs(_ count: Int) -> WorkToolsBrowserState {
    WorkToolsBrowserState(tabs: (0..<count).map {
      WorkToolsBrowserTab(id: "t\($0)", recording: false, active: $0 == 0)
    })
  }

  func testNothingGoingOnMeansNoChips() {
    XCTAssertEqual(workToolChips(state: nil, appleDevice: nil), [])
    XCTAssertEqual(workToolChips(state: WorkToolsLaneState(laneId: "lane-1"), appleDevice: nil), [])
  }

  func testRunningSimulatorIsOneChipNamedForTheDevice() {
    // The owner's case: the Mac's window is not on this lane's Tools pane, so
    // the pane state has nothing to say, but the simulator is up.
    XCTAssertEqual(
      workToolChips(state: WorkToolsLaneState(laneId: "lane-1"), appleDevice: Self.device("iPhone 16 Pro")),
      [WorkToolChip(kind: .simulator(name: "iPhone 16 Pro", family: "iphone"))])
    XCTAssertEqual(
      workToolChips(state: nil, appleDevice: Self.device("iPad Air", family: "ipad")),
      [WorkToolChip(kind: .simulator(name: "iPad Air", family: "ipad"))])
  }

  func testOffOrAbsentSimulatorHasNoChip() {
    XCTAssertEqual(workToolChips(state: nil, appleDevice: Self.device("iPhone 16 Pro", state: "Shutdown")), [])
    XCTAssertEqual(workToolChips(state: nil, appleDevice: Self.device("iPhone 16 Pro", state: nil)), [])
    XCTAssertEqual(workToolChips(state: nil, appleDevice: AppleDeviceStatus(unavailable: "no_device")), [])
  }

  func testABootedDeviceTheLaneDoesNotOwnHasNoChip() {
    // A lane with no device: the host reports any booted iPhone on the Mac.
    XCTAssertEqual(workToolChips(state: nil, appleDevice: Self.device("iPhone 17 Pro", laneDeviceUdid: nil)), [])
    // The lane owns a device, but the one shown is another.
    XCTAssertEqual(
      workToolChips(state: nil, appleDevice: Self.device("iPhone 17 Pro", udid: "OTHER", laneDeviceUdid: "UDID-1")),
      [])
    // An older host that sends no laneDevice shows none either.
    var older = Self.device("iPhone 16 Pro")
    older.laneDevice = nil
    XCTAssertNil(appleDeviceRunningName(older))
  }

  func testBrowserTabsAreOneChipWithTheCount() {
    XCTAssertEqual(
      workToolChips(state: WorkToolsLaneState(laneId: "lane-1", browser: Self.tabs(1)), appleDevice: nil),
      [WorkToolChip(kind: .browser(tabCount: 1, agentUsing: false))])
    XCTAssertEqual(
      workToolChips(state: WorkToolsLaneState(laneId: "lane-1", browser: Self.tabs(3)), appleDevice: nil),
      [WorkToolChip(kind: .browser(tabCount: 3, agentUsing: false))])
    XCTAssertEqual(
      workToolChips(state: WorkToolsLaneState(laneId: "lane-1", browser: Self.tabs(0)), appleDevice: nil),
      [])
    // The label comes from the tab count, so the two cannot disagree.
    XCTAssertEqual(
      [0, 1, 3].map { WorkToolChip(kind: .browser(tabCount: $0, agentUsing: false)).label },
      ["Browser", "1 tab", "3 tabs"])
  }

  func testAgentOnTheBrowserMarksTheBrowserChipAndSurfacesItWithoutTabs() {
    let presence = [WorkToolsAgentBrowserPresence(chatSessionId: "chat-1")]
    XCTAssertEqual(
      workToolChips(
        state: WorkToolsLaneState(laneId: "lane-1", browser: Self.tabs(2), agentBrowserPresence: presence),
        appleDevice: nil),
      [WorkToolChip(kind: .browser(tabCount: 2, agentUsing: true))])
    XCTAssertEqual(
      workToolChips(state: WorkToolsLaneState(laneId: "lane-1", agentBrowserPresence: presence), appleDevice: nil),
      [WorkToolChip(kind: .browser(tabCount: 0, agentUsing: true))])
    XCTAssertFalse(workToolsAgentIsUsingBrowser(nil))
  }

  func testChipAccessibilityTextComesFromTheChipData() {
    XCTAssertEqual(
      workToolChipAccessibilityText(WorkToolChip(kind: .browser(tabCount: 0, agentUsing: true))),
      "Browser on your Mac. An agent is using the browser. Tap for details.")
    XCTAssertEqual(
      workToolChipAccessibilityText(WorkToolChip(kind: .browser(tabCount: 2, agentUsing: false))),
      "Browser on your Mac, 2 tabs. Tap for details.")
    XCTAssertEqual(
      workToolChipAccessibilityText(WorkToolChip(kind: .simulator(name: "iPhone 16 Pro", family: "iphone"))),
      "iPhone 16 Pro running on your Mac. Tap to watch.")
  }

  func testAppControlIsAChipNamedForTheApp() {
    let state = WorkToolsLaneState(
      laneId: "lane-1",
      appControl: WorkToolsAppControlState(appName: "Ghost", status: "attached", driver: "cdp"))
    XCTAssertEqual(workToolChips(state: state, appleDevice: nil), [WorkToolChip(kind: .appControl(appName: "Ghost"))])
  }

  func testTheMacsActiveToolAloneIsNotAChip() {
    // "Apple active" is a fact about the Mac's window, not something to open.
    for tool in ["ios", "browser", "git", "app-control"] {
      XCTAssertEqual(
        workToolChips(state: WorkToolsLaneState(laneId: "lane-1", activeTool: tool, openTools: [tool]), appleDevice: nil),
        [], tool)
    }
  }

  func testChipsAreOrderedSimulatorBrowserAppControl() {
    let state = WorkToolsLaneState(
      laneId: "lane-1",
      activeTool: "ios",
      browser: Self.tabs(2),
      appControl: WorkToolsAppControlState(appName: "Ghost", status: "attached", driver: "cdp"))
    XCTAssertEqual(
      workToolChips(state: state, appleDevice: Self.device("iPhone 16 Pro")).map(\.id),
      ["simulator", "browser", "app-control"])
  }

  func testRunningDeviceIsNamedPlainly() {
    // A live stream counts as up even when simctl's state did not come through.
    var streaming = Self.device("iPad Air", family: "ipad", state: nil)
    streaming.stream = AppleDeviceStatusStream(running: true)
    XCTAssertEqual(appleDeviceRunningName(streaming), "iPad Air")
    // State is simctl's word; match it without caring about case.
    XCTAssertEqual(appleDeviceRunningName(Self.device("iPhone 16 Pro", state: "booted")), "iPhone 16 Pro")
    // The host fills a missing name with the udid; the family stands in.
    XCTAssertEqual(appleDeviceRunningName(Self.device("UDID-1", udid: "UDID-1")), "iPhone")
    XCTAssertEqual(appleDeviceRunningName(Self.device(nil)), "iPhone")
    XCTAssertEqual(appleDeviceRunningName(Self.device("  ")), "iPhone")
    XCTAssertNil(appleDeviceRunningName(nil))
  }

  func testSimulatorChipShowsTheModelWithoutTheFamilyWord() {
    XCTAssertEqual(appleDeviceChipModelName("iPhone 16 Pro"), "16 Pro")
    XCTAssertEqual(appleDeviceChipModelName("iPhone 17"), "17")
    XCTAssertEqual(appleDeviceChipModelName("iPad Air (M2)"), "Air (M2)")
    XCTAssertEqual(appleDeviceChipModelName("iPhone"), "iPhone")
    XCTAssertEqual(appleDeviceChipModelName("iPhoneX"), "iPhoneX")
    XCTAssertEqual(appleDeviceChipModelName("Simulator"), "Simulator")
    let chip = WorkToolChip(kind: .simulator(name: "iPhone 16 Pro", family: "iphone"))
    XCTAssertEqual(chip.displayLabel, "16 Pro")
    XCTAssertEqual(chip.label, "iPhone 16 Pro")
    XCTAssertEqual(WorkToolChip(kind: .appControl(appName: "iPhone Mirroring")).displayLabel, "App")
  }

  private static func macDesktop(
    supported: Bool = true,
    display: Bool = true,
    stream: WorkToolsMacDesktopStream? = nil,
    leaseHolder: String? = nil
  ) -> WorkToolsMacDesktopState {
    WorkToolsMacDesktopState(
      supported: supported,
      display: display
        ? WorkToolsMacDesktopDisplay(name: "ADE · fix-header", width: 2560, height: 1440, mode: "virtual")
        : nil,
      lease: leaseHolder.map { WorkToolsMacDesktopLease(holder: $0, holderLabel: "Fix the header") },
      stream: stream
    )
  }

  func testMacDesktopIsAChipOnlyWhileTheLaneHasADisplay() {
    let chip = WorkToolChip(kind: .macDesktop(streamLive: false, agentDriving: false))
    XCTAssertEqual(
      workToolChips(state: WorkToolsLaneState(laneId: "lane-1", macDesktop: Self.macDesktop()), appleDevice: nil),
      [chip])
    XCTAssertEqual(chip.id, "mac-desktop")
    XCTAssertEqual(chip.label, "macOS")
    XCTAssertEqual(chip.displayLabel, "macOS")
    XCTAssertEqual(chip.kind.symbolName, "desktopcomputer")
    // No display yet, a host that cannot hold one, or no service at all.
    XCTAssertNil(macDesktopToolChip(Self.macDesktop(display: false)))
    XCTAssertNil(macDesktopToolChip(Self.macDesktop(supported: false)))
    XCTAssertNil(macDesktopToolChip(nil))
  }

  func testAFailedPollKeepsTheLastLaneStateSoTheChipsStay() {
    let last = WorkToolsLaneState(laneId: "lane-1", macDesktop: Self.macDesktop())
    let fresh = WorkToolsLaneState(laneId: "lane-1", macDesktop: Self.macDesktop(display: false))
    // A read that timed out while the Mac was busy keeps the macOS chip.
    let kept = workToolsStateAfterRead(fetched: nil, previous: last, supported: true)
    XCTAssertEqual(kept, last)
    XCTAssertEqual(workToolChips(state: kept, appleDevice: nil).map(\.id), ["mac-desktop"])
    // A real answer always wins, including one that says the display is gone.
    XCTAssertEqual(workToolsStateAfterRead(fetched: fresh, previous: last, supported: true), fresh)
    // A host that does not advertise the read has no state to keep.
    XCTAssertNil(workToolsStateAfterRead(fetched: nil, previous: last, supported: false))
    XCTAssertNil(workToolsStateAfterRead(fetched: nil, previous: nil, supported: true))
  }

  func testMacDesktopChipIsLiveOnlyAtFullRateAndMarksAnAgentDriving() {
    func kind(_ state: WorkToolsMacDesktopState) -> WorkToolChipKind? { macDesktopToolChip(state)?.kind }
    XCTAssertEqual(
      kind(Self.macDesktop(stream: WorkToolsMacDesktopStream(running: true, idle: false))),
      .macDesktop(streamLive: true, agentDriving: false))
    XCTAssertEqual(
      kind(Self.macDesktop(stream: WorkToolsMacDesktopStream(running: true, idle: true))),
      .macDesktop(streamLive: false, agentDriving: false))
    XCTAssertEqual(
      kind(Self.macDesktop(stream: WorkToolsMacDesktopStream(running: false, idle: false))),
      .macDesktop(streamLive: false, agentDriving: false))
    XCTAssertEqual(kind(Self.macDesktop(leaseHolder: "agent")), .macDesktop(streamLive: false, agentDriving: true))
    XCTAssertEqual(kind(Self.macDesktop(leaseHolder: "user")), .macDesktop(streamLive: false, agentDriving: false))
    XCTAssertEqual(
      workToolChipAccessibilityText(WorkToolChip(kind: .macDesktop(streamLive: true, agentDriving: true))),
      "This lane's macOS desktop, live. An agent is driving it. Tap to watch.")
  }

  func testChipsAreOrderedWithTheTwoWatchableScreensFirst() {
    let state = WorkToolsLaneState(
      laneId: "lane-1",
      browser: Self.tabs(2),
      appControl: WorkToolsAppControlState(appName: "Ghost", status: "attached", driver: "cdp"),
      macDesktop: Self.macDesktop())
    XCTAssertEqual(
      workToolChips(state: state, appleDevice: Self.device("iPhone 16 Pro")).map(\.id),
      ["simulator", "mac-desktop", "browser", "app-control"])
  }

  // MARK: - Mac Desktop viewer

  func testViewerRibbonSaysWhoIsDrivingAndThisPhonesControlWins() {
    let agent = WorkToolsMacDesktopLease(holder: "agent", holderLabel: "Fix the header")
    let user = WorkToolsMacDesktopLease(holder: "user", holderLabel: "You")
    XCTAssertEqual(
      macDesktopViewerRibbon(controlling: false, lease: agent, displayName: "ADE · fix-header"),
      "Watching · agent driving · ADE · fix-header")
    // The snapshot lags a take by up to one poll; the phone's own control wins.
    XCTAssertEqual(
      macDesktopViewerRibbon(controlling: true, lease: agent, displayName: "ADE · fix-header"),
      "Watching · you have control · ADE · fix-header")
    XCTAssertEqual(
      macDesktopViewerRibbon(controlling: false, lease: user, displayName: nil),
      "Watching · someone else has control")
    XCTAssertEqual(macDesktopViewerRibbon(controlling: false, lease: nil, displayName: "  "), "Watching")
  }

  func testViewerOverlayOffersReconnectOnlyWhenTheStreamIsDown() {
    XCTAssertNil(macDesktopViewerOverlay(phase: .live, hasFrame: true, hostError: nil))
    XCTAssertEqual(
      macDesktopViewerOverlay(phase: .connecting, hasFrame: false, hostError: nil),
      MacDesktopViewerOverlay(message: "Connecting to the Mac…", busy: true, offersReconnect: false))
    XCTAssertEqual(
      macDesktopViewerOverlay(phase: .connecting, hasFrame: true, hostError: nil)?.message,
      "Reconnecting…")
    XCTAssertEqual(
      macDesktopViewerOverlay(phase: .ended(reason: "stopped", message: nil), hasFrame: true, hostError: nil),
      MacDesktopViewerOverlay(message: "The stream stopped.", busy: false, offersReconnect: true))
    // The Mac knows why its encoder quit; that beats the generic sentence.
    XCTAssertEqual(
      macDesktopViewerOverlay(
        phase: .ended(reason: "stopped", message: nil),
        hasFrame: false,
        hostError: "Screen Recording was revoked.")?.message,
      "Screen Recording was revoked.")
    XCTAssertEqual(
      macDesktopViewerOverlay(phase: .ended(reason: "display_destroyed", message: nil), hasFrame: false, hostError: nil)?
        .message,
      "This lane's desktop closed.")
    XCTAssertEqual(
      macDesktopViewerOverlay(phase: .failed("Nope"), hasFrame: false, hostError: nil),
      MacDesktopViewerOverlay(message: "Nope", busy: false, offersReconnect: true))
  }

  func testOffCardSaysOffAndOnlyPointsAtTheMacWhenThePhoneCannotStart() {
    XCTAssertEqual(
      macDesktopOffCardMessage(starting: false, error: nil, canStart: true),
      "The macOS desktop is off.")
    XCTAssertEqual(
      macDesktopOffCardMessage(starting: false, error: nil, canStart: false),
      "The macOS desktop is off. Start it in ADE on your Mac.")
    XCTAssertEqual(
      macDesktopOffCardMessage(starting: true, error: "Old", canStart: true),
      "Starting the macOS desktop…")
    XCTAssertEqual(
      macDesktopOffCardMessage(starting: false, error: "The macOS desktop is taking too long to start.", canStart: true),
      "The macOS desktop is taking too long to start.")
    XCTAssertEqual(
      macDesktopOffCardMessage(starting: false, error: "  ", canStart: true),
      "The macOS desktop is off.")
  }

  func testMacDesktopErrorCodesBecomePlainPhoneText() {
    XCTAssertEqual(
      macDesktopVisibleMessage("MAC_DESKTOP_NO_WINDOW: The lane has no windows."),
      "No windows are open on this desktop yet.")
    XCTAssertEqual(
      macDesktopVisibleMessage("lane_stopping: Lane lane-1 is stopping."),
      "This lane is stopping. Try again when it is ready.")
    // A newer code stays useful without leaking its machine-readable prefix.
    XCTAssertEqual(
      macDesktopVisibleMessage("MAC_DESKTOP_DRIVER_UNAVAILABLE: The helper is not running."),
      "The helper is not running.")
    XCTAssertEqual(
      macDesktopVisibleMessage("MAC_DESKTOP_NO_WINDOW"),
      "No windows are open on this desktop yet.")
    let separatelyCoded = NSError(
      domain: "ADE",
      code: 17,
      userInfo: [NSLocalizedDescriptionKey: "Lane is stopping.", "ADEErrorCode": "lane_stopping"])
    XCTAssertEqual(
      macDesktopVisibleMessage(for: separatelyCoded),
      "This lane is stopping. Try again when it is ready.")
    XCTAssertEqual(
      macDesktopOffCardMessage(
        starting: false,
        error: "MAC_DESKTOP_NO_WINDOW: no window",
        canStart: true),
      "No windows are open on this desktop yet.")
    XCTAssertEqual(
      macDesktopViewerOverlay(
        phase: .failed("lane_stopping: lane is stopping"),
        hasFrame: false,
        hostError: nil)?.message,
      "This lane is stopping. Try again when it is ready.")
    XCTAssertEqual(
      macDesktopViewerOverlay(
        phase: .ended(reason: "error", message: "MAC_DESKTOP_NO_WINDOW: no window"),
        hasFrame: false,
        hostError: nil)?.message,
      "No windows are open on this desktop yet.")
    XCTAssertEqual(
      macDesktopViewerOverlay(
        phase: .ended(reason: "error", message: nil),
        hasFrame: false,
        hostError: "MAC_DESKTOP_NO_WINDOW: no window")?.message,
      "No windows are open on this desktop yet.")
  }

  // MARK: - Viewer zoom

  private static let zoomFrame = CGSize(width: 400, height: 250)

  func testZoomScaleStaysBetweenOneAndFour() {
    XCTAssertEqual(MacDesktopZoom.clampScale(0.5), 1)
    XCTAssertEqual(MacDesktopZoom.clampScale(2), 2)
    XCTAssertEqual(MacDesktopZoom.clampScale(10), 4)
    XCTAssertEqual(MacDesktopZoom.clampScale(.infinity), 1)
    let center = CGPoint(x: 200, y: 125)
    let big = MacDesktopZoom.identity.magnified(by: 9, around: center, in: Self.zoomFrame)
    XCTAssertEqual(big.scale, 4)
    let small = big.magnified(by: 0.01, around: center, in: Self.zoomFrame)
    XCTAssertEqual(small, .identity)
  }

  func testPinchKeepsThePointUnderTheFingers() {
    let finger = CGPoint(x: 300, y: 100)
    let zoom = MacDesktopZoom.identity.magnified(by: 2, around: finger, in: Self.zoomFrame)
    // The content point under the finger maps back to the same screen point.
    let contentX = 200 + (finger.x - 200)
    let contentY = 125 + (finger.y - 125)
    XCTAssertEqual(200 + (contentX - 200) * zoom.scale + zoom.offset.width, finger.x, accuracy: 0.001)
    XCTAssertEqual(125 + (contentY - 125) * zoom.scale + zoom.offset.height, finger.y, accuracy: 0.001)
  }

  func testPanMovesOnlyAZoomedPictureAndStopsAtTheEdge() {
    XCTAssertEqual(
      MacDesktopZoom.identity.panned(by: CGSize(width: 50, height: 50), in: Self.zoomFrame),
      .identity)
    let zoomed = MacDesktopZoom(scale: 2, offset: .zero)
    let moved = zoomed.panned(by: CGSize(width: 30, height: -20), in: Self.zoomFrame)
    XCTAssertEqual(moved.offset, CGSize(width: 30, height: -20))
    // At 2x the picture can move half a frame each way and no more.
    let far = zoomed.panned(by: CGSize(width: 5_000, height: -5_000), in: Self.zoomFrame)
    XCTAssertEqual(far.offset, CGSize(width: 200, height: -125))
  }

  func testLandscapeViewportClampsPanAndSettlePullsARubberBandBack() {
    let picture = CGSize(width: 400, height: 250)
    let viewport = CGSize(width: 800, height: 200)
    // Wider than the zoomed picture: that axis stays centered.
    XCTAssertEqual(
      MacDesktopZoom.clampOffset(CGSize(width: 40, height: 80), scale: 1, in: picture, viewport: viewport),
      CGSize(width: 0, height: 25))
    let pastWidth = MacDesktopZoom.rubberBand(80, limit: 0)
    let pastHeight = MacDesktopZoom.rubberBand(80, limit: 25)
    XCTAssertGreaterThan(pastWidth, 0)
    XCTAssertLessThan(pastWidth, 80)
    XCTAssertGreaterThan(pastHeight, 25)
    XCTAssertLessThan(pastHeight, 80)
    let stretched = MacDesktopZoom(scale: 1, offset: CGSize(width: pastWidth, height: pastHeight))
    XCTAssertEqual(stretched.settled(in: picture, viewport: viewport).offset, CGSize(width: 0, height: 25))
  }

  func testDoubleTapTogglesBetweenOneAndTwoAndAHalfAtTheTap() {
    let tap = CGPoint(x: 250, y: 125)
    let zoomed = MacDesktopZoom.identity.toggled(at: tap, in: Self.zoomFrame)
    XCTAssertEqual(zoomed.scale, 2.5)
    XCTAssertEqual(zoomed.offset.width, -75, accuracy: 0.001)
    XCTAssertEqual(zoomed.offset.height, 0, accuracy: 0.001)
    XCTAssertEqual(zoomed.toggled(at: tap, in: Self.zoomFrame), .identity)
    // A tap in a corner zooms toward it, as far as the edge allows.
    let corner = MacDesktopZoom.identity.toggled(at: .zero, in: Self.zoomFrame)
    XCTAssertEqual(corner.offset, CGSize(width: 300, height: 187.5))
    // A frame that has not been measured yet does not zoom.
    XCTAssertEqual(MacDesktopZoom.identity.toggled(at: tap, in: .zero), .identity)
  }

  // MARK: - Viewer orientation

  func testTakeControlForcesLandscapeAndReturnRestoresPortrait() {
    var orientation = MacDesktopViewerOrientation()
    orientation.openedIn = .portrait
    XCTAssertEqual(orientation.beginControl(current: .portrait), .landscape)
    XCTAssertTrue(orientation.locksLandscape)
    // A second begin (a re-render) asks for nothing new.
    XCTAssertNil(orientation.beginControl(current: .landscapeRight))
    // Rotate is off while control holds landscape.
    XCTAssertNil(orientation.toggleRotation(current: .landscapeRight))
    XCTAssertEqual(orientation.endControl(), .portrait)
    XCTAssertFalse(orientation.locksLandscape)
    XCTAssertNil(orientation.endControl())
  }

  func testTakeControlFromLandscapeStaysOnThatSide() {
    var orientation = MacDesktopViewerOrientation()
    XCTAssertNil(orientation.beginControl(current: .landscapeLeft))
    XCTAssertTrue(orientation.locksLandscape)
    XCTAssertNil(orientation.endControl())
    XCTAssertFalse(orientation.locksLandscape)
    // Nothing was turned by the viewer, so closing leaves the phone alone.
    XCTAssertNil(orientation.close())
  }

  func testRotateTogglesAndCloseUndoesOnlyTheViewersOwnTurn() {
    var untouched = MacDesktopViewerOrientation()
    XCTAssertNil(untouched.close())

    var orientation = MacDesktopViewerOrientation()
    orientation.openedIn = .portrait
    XCTAssertEqual(orientation.toggleRotation(current: .portrait), .landscape)
    XCTAssertEqual(orientation.toggleRotation(current: .landscapeRight), .portrait)
    XCTAssertEqual(orientation.toggleRotation(current: .portrait), .landscape)
    XCTAssertEqual(orientation.close(), .portrait)
    XCTAssertNil(orientation.close())
  }

  func testClosingDuringControlDropsTheLockAndTurnsBack() {
    var orientation = MacDesktopViewerOrientation()
    orientation.openedIn = .portrait
    XCTAssertEqual(orientation.beginControl(current: .portrait), .landscape)
    XCTAssertEqual(orientation.close(), .portrait)
    XCTAssertFalse(orientation.locksLandscape)
  }

  func testOrientationMaskNamesOneOrientation() {
    XCTAssertEqual(macDesktopOrientationMask(.portrait), .portrait)
    XCTAssertEqual(macDesktopOrientationMask(.landscapeLeft), .landscapeLeft)
    XCTAssertEqual(macDesktopOrientationMask(.landscapeRight), .landscapeRight)
    XCTAssertEqual(macDesktopOrientationMask(.portraitUpsideDown), .portraitUpsideDown)
    XCTAssertEqual(macDesktopOrientationMask(.unknown), .portrait)
  }

  // MARK: - Handshake gating

  @MainActor
  func testLegacyHostWithoutMobileCompatibilityConnectsAndSimplyHidesTheToolsRow() throws {
    // The oldest brain shape the phone still has to talk to: a command list
    // with none of the workTools actions and no `mobileCompatibility` block at
    // all. It must connect — a missing compatibility report is not a handshake
    // failure — and the lane tool chips must gate themselves off rather than poll an
    // action the host never advertised.
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "legacy-host", "deviceName": "Old Mac"],
        "features": [
          "commandRouting": ["actions": [
            Self.descriptor("work.listSessions"),
            Self.descriptor("chat.listSessions"),
          ]] as [String: Any],
        ] as [String: Any],
      ])

      XCTAssertEqual(service.connectionState, .connected)
      XCTAssertEqual(service.hostCompatibilityMode, .limited)
      XCTAssertEqual(service.hostCompatibilityMissingActions, ["mobileCompatibility"])
      XCTAssertFalse(service.supportsWorkToolsState)
      XCTAssertFalse(service.supportsWorkToolsObservationPreview)
      XCTAssertFalse(service.supportsMacDesktopStream)
      XCTAssertFalse(service.supportsMacDesktopControl)
      XCTAssertFalse(service.supportsMacDesktopStart)
    }
  }

  @MainActor
  func testUnsupportedWorkToolsReadsFailLocallyInsteadOfGoingOnTheWire() async throws {
    try await withServiceAsync { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "legacy-host", "deviceName": "Old Mac"],
        "features": [
          "commandRouting": ["actions": [Self.descriptor("work.listSessions")]] as [String: Any],
        ] as [String: Any],
      ])
      XCTAssertFalse(service.supportsWorkToolsState)

      // Gated locally: no transport is configured here, so a request that
      // reached `sendCommand` would fail for the wrong reason. The explicit
      // `unsupported_action` code is what proves the guard ran first.
      do {
        _ = try await service.fetchWorkToolsLaneState(laneId: "lane-1")
        XCTFail("An unadvertised workTools.getLaneState must not be attempted.")
      } catch {
        XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "unsupported_action")
      }
      do {
        _ = try await service.readWorkToolsObservationPreview(path: "/tmp/a.png")
        XCTFail("An unadvertised workTools.readObservationPreview must not be attempted.")
      } catch {
        XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "unsupported_action")
      }
    }
  }

  @MainActor
  func testHostAdvertisingWorkToolsOptionallyStaysFullyCompatible() throws {
    // `workTools.*` are OPTIONAL actions in syncMobileCompatibility.ts, so a
    // host that reports `full` while advertising them must stay `full` — an
    // additive read-only pane must never flip a phone into limited mode.
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "new-host", "deviceName": "Mac Studio"],
        "features": [
          "commandRouting": ["actions": [
            Self.descriptor("work.listSessions"),
            Self.descriptor("workTools.getLaneState"),
            Self.descriptor("workTools.readObservationPreview"),
          ]] as [String: Any],
          "mobileCompatibility": ["mode": "full", "missingActions": [String]()] as [String: Any],
        ] as [String: Any],
      ])

      XCTAssertEqual(service.hostCompatibilityMode, .full)
      XCTAssertTrue(service.hostCompatibilityMissingActions.isEmpty)
      XCTAssertTrue(service.supportsWorkToolsState)
      XCTAssertTrue(service.supportsWorkToolsObservationPreview)
      // Read-only everywhere: a viewer device sees the pane like anyone else.
      XCTAssertTrue(service.supportsViewerRemoteAction("workTools.getLaneState"))
    }
  }

  @MainActor
  func testStateActionAloneDoesNotUnlockFrameFetching() throws {
    // The two commands are registered together today, but the sheet fetches
    // bytes on a 3s timer — so it feature-detects the preview separately rather
    // than inferring it from the state read.
    try withService { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "partial-host", "deviceName": "Mac"],
        "features": [
          "commandRouting": ["actions": [Self.descriptor("workTools.getLaneState")]] as [String: Any],
          "mobileCompatibility": ["mode": "full", "missingActions": [String]()] as [String: Any],
        ] as [String: Any],
      ])
      XCTAssertTrue(service.supportsWorkToolsState)
      XCTAssertFalse(service.supportsWorkToolsObservationPreview)
    }
  }

  // MARK: - Helpers

  private static func descriptor(_ action: String) -> [String: Any] {
    ["action": action, "policy": ["viewerAllowed": true] as [String: Any]]
  }

  func testLaneStateDecodesTheMacDesktopSliceAndIgnoresFieldsThePhoneCannotUse() throws {
    // Byte-for-byte the shape `workToolsStateService` sends for a lane holding a
    // desktop, including the fields the phone deliberately does not decode
    // (`permissions`, `hostIsLocal`, window frames, the observation id).
    let data = Data(#"""
    {
      "laneId": "lane-1",
      "activeTool": "mac-desktop",
      "openTools": ["mac-desktop"],
      "browser": null,
      "browserUnavailable": "desktop_not_attached",
      "appControl": null,
      "macDesktop": {
        "supported": true,
        "display": {
          "laneId": "lane-1",
          "displayId": 7,
          "name": "ADE · fix-header",
          "mode": "virtual",
          "width": 2560,
          "height": 1440,
          "scale": 2,
          "origin": { "x": 0, "y": 0 },
          "createdAt": "2026-09-16T10:00:00.000Z",
          "windowCount": 1,
          "lastActivityAt": "2026-09-16T10:01:00.000Z"
        },
        "windows": [
          {
            "id": 11,
            "pid": 42,
            "appName": "Safari",
            "bundleId": "com.apple.Safari",
            "title": "Example",
            "frame": { "x": 0, "y": 0, "width": 800, "height": 600 },
            "laneId": "lane-1",
            "origin": "ade_launched",
            "onDisplayId": 7,
            "minimized": false,
            "singleInstance": false
          }
        ],
        "lease": {
          "laneId": "lane-1",
          "holder": "agent",
          "holderId": "chat-7",
          "holderLabel": "Fix the header",
          "grantedAt": "2026-09-16T10:00:00.000Z",
          "expiresAt": "2026-09-16T10:01:00.000Z"
        },
        "stream": {
          "running": true,
          "idle": false,
          "fps": 30,
          "bitrateKbps": 2000,
          "lastError": null
        },
        "permissions": { "screenRecording": "granted", "accessibility": "granted" },
        "lastObservation": {
          "id": "obs-1",
          "capturedAt": "2026-09-16T10:01:00.000Z",
          "caption": "click · Sign in",
          "screenshotPath": "/p/.ade/cache/mac-desktop-observations/lane-1/obs-1.png",
          "truncatedReason": "stalled",
          "stalledApps": ["Safari"]
        },
        "hostIsLocal": true,
        "recording": { "running": true, "startedAt": "2026-09-16T10:00:30.000Z" }
      },
      "capturedAt": "2026-09-16T10:01:01.000Z"
    }
    """#.utf8)

    let state = try JSONDecoder().decode(WorkToolsLaneState.self, from: data)
    let macDesktop = try XCTUnwrap(state.macDesktop)
    XCTAssertTrue(macDesktop.supported)
    XCTAssertEqual(macDesktop.display?.name, "ADE · fix-header")
    XCTAssertEqual(macDesktop.display?.width, 2560)
    XCTAssertEqual(macDesktop.display?.mode, "virtual")
    XCTAssertEqual(macDesktop.display?.origin, MacDesktopPoint(x: 0, y: 0))
    XCTAssertEqual(macDesktop.windows?.map(\.appName), ["Safari"])
    XCTAssertEqual(macDesktop.windows?.first?.id, 11)
    XCTAssertEqual(macDesktop.stream?.running, true)
    XCTAssertEqual(macDesktop.stream?.idle, false)
    XCTAssertEqual(macDesktop.stream?.fps, 30)
    XCTAssertEqual(macDesktop.stream?.bitrateKbps, 2000)
    XCTAssertNil(macDesktop.stream?.lastError)
    XCTAssertEqual(
      macDesktop.recording,
      WorkToolsMacDesktopRecording(running: true, startedAt: "2026-09-16T10:00:30.000Z"))
    XCTAssertEqual(
      macDesktop.lastObservation?.screenshotPath,
      "/p/.ade/cache/mac-desktop-observations/lane-1/obs-1.png")
    XCTAssertEqual(macDesktop.lastObservation?.truncatedReason, "stalled")
    XCTAssertEqual(macDesktop.lastObservation?.stalledApps, ["Safari"])
    XCTAssertEqual(macDesktopLeaseLine(macDesktop.lease), "Agent driving · Fix the header")
  }

  func testLaneStateWithoutMacDesktopHidesTheToolRatherThanFailingToDecode() throws {
    // Every host built before this feature, and every non-Mac host, omits the
    // key. A missing slice must read as absence, not as a decode failure that
    // would blank the whole sheet.
    let data = Data(#"""
    {
      "laneId": "lane-1",
      "activeTool": null,
      "browser": null,
      "browserUnavailable": "desktop_not_attached",
      "appControl": null
    }
    """#.utf8)
    XCTAssertNil(try JSONDecoder().decode(WorkToolsLaneState.self, from: data).macDesktop)

    // A Mac that has the service but cannot hold a display says so explicitly.
    let unsupported = Data(#"""
    {
      "laneId": "lane-1",
      "activeTool": null,
      "browser": null,
      "browserUnavailable": "desktop_not_attached",
      "appControl": null,
      "macDesktop": {
        "supported": false,
        "display": null,
        "windows": [],
        "lease": null,
        "stream": null,
        "permissions": { "screenRecording": "unknown", "accessibility": "unknown" },
        "lastObservation": null,
        "hostIsLocal": false
      }
    }
    """#.utf8)
    let state = try JSONDecoder().decode(WorkToolsLaneState.self, from: unsupported)
    XCTAssertEqual(state.macDesktop?.supported, false)
    XCTAssertNil(state.macDesktop?.display)
    // An older host sends no recording key at all; that reads as "not recording".
    XCTAssertNil(state.macDesktop?.recording)
    XCTAssertEqual(macDesktopLeaseLine(nil), "Nobody has taken control.")
  }

  @MainActor
  private func withService(_ body: (SyncService) throws -> Void) throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }
    try body(service)
  }

  @MainActor
  private func withServiceAsync(_ body: (SyncService) async throws -> Void) async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }
    try await body(service)
  }

  func testSimulatorChipSymbolFollowsTheDeviceFamily() {
    XCTAssertEqual(WorkToolChipKind.simulator(name: "Apple Watch Ultra", family: "watch").symbolName, "applewatch")
    XCTAssertEqual(WorkToolChipKind.simulator(name: "iPad Pro", family: "ipad").symbolName, "ipad")
    XCTAssertEqual(WorkToolChipKind.simulator(name: "iPhone 17", family: "iphone").symbolName, "iphone")
    XCTAssertEqual(WorkToolChipKind.simulator(name: "iPhone 17", family: nil).symbolName, "iphone")
    XCTAssertEqual(WorkToolChipKind.browser(tabCount: 2, agentUsing: false).symbolName, "globe")
    XCTAssertEqual(WorkToolChipKind.appControl(appName: "Safari").symbolName, "macwindow")
  }
}
