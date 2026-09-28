// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ADEMedia",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "ADEMediaCore",
            targets: ["ADEMediaCore"]
        ),
        .executable(
            name: "ade-media",
            targets: ["ADEMedia"]
        ),
    ],
    targets: [
        .target(
            name: "ADEMediaCore"
        ),
        .executableTarget(
            name: "ADEMedia",
            dependencies: ["ADEMediaCore"]
        ),
        .testTarget(
            name: "ADEMediaCoreTests",
            dependencies: ["ADEMediaCore"]
        ),
    ]
)
