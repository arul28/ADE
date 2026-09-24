// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ADEDesktopDriver",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "ADEDesktopDriverCore",
            targets: ["ADEDesktopDriverCore"]
        ),
        .executable(
            name: "ade-desktop-driver",
            targets: ["ADEDesktopDriver"]
        ),
    ],
    targets: [
        .target(
            name: "ADEDesktopDriverCore"
        ),
        .executableTarget(
            name: "ADEDesktopDriver",
            dependencies: ["ADEDesktopDriverCore"]
        ),
        .testTarget(
            name: "ADEDesktopDriverCoreTests",
            dependencies: ["ADEDesktopDriverCore", "ADEDesktopDriver"]
        ),
    ]
)
