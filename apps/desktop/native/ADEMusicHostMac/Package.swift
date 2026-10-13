// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ADEMusicHostMac",
    platforms: [
        .macOS(.v12),
    ],
    products: [
        .executable(
            name: "ade-music-host",
            targets: ["ADEMusicHost"]
        ),
    ],
    targets: [
        .executableTarget(
            name: "ADEMusicHost"
        ),
    ]
)
