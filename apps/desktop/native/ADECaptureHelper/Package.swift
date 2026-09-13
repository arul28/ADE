// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ADECaptureHelper",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "ADECaptureHelperCore",
            targets: ["ADECaptureHelperCore"]
        ),
        .executable(
            name: "ade-capture-helper",
            targets: ["ADECaptureHelper"]
        ),
    ],
    targets: [
        .target(
            name: "ADECaptureHelperCore"
        ),
        .executableTarget(
            name: "ADECaptureHelper",
            dependencies: ["ADECaptureHelperCore"]
        ),
        .testTarget(
            name: "ADECaptureHelperCoreTests",
            dependencies: ["ADECaptureHelperCore"]
        ),
    ]
)
