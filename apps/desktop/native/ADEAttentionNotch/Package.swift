// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ADEAttentionNotch",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "ADEAttentionNotchCore",
            targets: ["ADEAttentionNotchCore"]
        ),
        .executable(
            name: "ade-attention-notch",
            targets: ["ADEAttentionNotch"]
        ),
    ],
    targets: [
        .target(
            name: "ADEAttentionNotchCore"
        ),
        .executableTarget(
            name: "ADEAttentionNotch",
            dependencies: ["ADEAttentionNotchCore"],
            resources: [
                .process("Resources"),
            ]
        ),
        .testTarget(
            name: "ADEAttentionNotchCoreTests",
            dependencies: ["ADEAttentionNotchCore", "ADEAttentionNotch"]
        ),
    ]
)
