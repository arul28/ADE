// swift-tools-version: 5.9

import PackageDescription

/// ADE's simulator helper.
///
/// Same shape as `native/ADECaptureHelper`: a testable `…Core` library holding
/// everything that can be exercised without a booted device, and a thin
/// executable that owns stdio and the run loop.
///
/// Tools version stays at 5.9 — matching ADECaptureHelper — which also pins the
/// language mode to Swift 5. That is load-bearing for the vendored capture/HID
/// code: it reaches into CoreSimulator and SimulatorKit through KVC and
/// `objc_msgSend`, which full Swift 6 concurrency checking rejects.
let package = Package(
    name: "ADESimHelper",
    // macOS 14, not 13 as ADECaptureHelper targets. The vendored capture and
    // HID actors adopt `DispatchSerialQueue` as a custom actor executor, and
    // `DispatchSerialQueue.init(label:qos:)` is 14.0+. This is not a limit ADE
    // feels: Xcode 15.3+ already requires macOS 14 to run the simulators this
    // helper drives.
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "ADESimHelperCore",
            targets: ["ADESimHelperCore"]
        ),
        .executable(
            name: "ade-sim-helper",
            targets: ["ADESimHelper"]
        ),
    ],
    targets: [
        .target(
            name: "ADESimHelperCore",
            // Provenance files live beside the code they describe so a reader
            // who opens the vendored directory cannot miss the licence. SwiftPM
            // treats unknown files in a source directory as an error, so they
            // are excluded explicitly rather than moved somewhere less obvious.
            exclude: [
                "Vendor/serve-sim/LICENSE",
                "Vendor/serve-sim/NOTICE",
                "Vendor/serve-sim/VENDORED.md",
            ]
        ),
        .executableTarget(
            name: "ADESimHelper",
            dependencies: ["ADESimHelperCore"]
        ),
        .testTarget(
            name: "ADESimHelperCoreTests",
            dependencies: ["ADESimHelperCore"]
        ),
    ]
)
