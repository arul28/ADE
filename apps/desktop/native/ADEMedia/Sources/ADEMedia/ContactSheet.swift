import ADEMediaCore
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// `ade-media contact-sheet`: the frames of a finished video at the request's
/// times, tiled into one PNG, so an agent can check its own demo at a glance.
///
/// Each tile is the frame shown at that exact time (AVAssetImageGenerator with
/// no tolerance), `tileWidth` wide and as tall as the video's aspect makes it
/// (rounded). Tiles run left to right, top to bottom, `min(columns, times)` per
/// row, 6 px apart with no outer margin, on `#202020`. A time past the end
/// shows the last frame; a negative one shows the first. The PNG is written
/// beside `output` and renamed onto it, so `output` is never half a file.
enum ContactSheet {
    static let gap = 6
    static let maxTimes = 1000
    static let maxSide = 16384

    static func make(_ request: DemoContactSheetRequest) async throws -> DemoContactSheetResult {
        guard !request.times.isEmpty, request.times.count <= maxTimes, request.times.allSatisfy(\.isFinite) else {
            throw MediaError("A contact sheet needs between 1 and \(maxTimes) times, each a number of seconds.")
        }
        guard request.columns >= 1 else { throw MediaError("A contact sheet needs at least one column.") }
        guard request.tileWidth >= 16, request.tileWidth <= 4096 else {
            throw MediaError("A contact sheet's tile width must be 16 to 4096 px, not \(request.tileWidth).")
        }

        let source = try await MediaSource.open(path: request.input)
        let tileWidth = request.tileWidth
        let tileHeight = max(1, Int((Double(tileWidth) * Double(source.displayHeight) / Double(source.displayWidth)).rounded()))
        let columns = min(request.columns, request.times.count)
        let rows = (request.times.count + columns - 1) / columns
        let sheetWidth = columns * tileWidth + (columns - 1) * gap
        let sheetHeight = rows * tileHeight + (rows - 1) * gap
        guard sheetWidth <= maxSide, sheetHeight <= maxSide else {
            throw MediaError("The contact sheet would be \(sheetWidth)×\(sheetHeight) px; the most is \(maxSide) a side. Use fewer times or a smaller tile.")
        }

        // Times count from the track's first frame, as in every demo plan.
        let (timeRange, minFrameDuration) = try await source.track.load(.timeRange, .minFrameDuration)
        let start = timeRange.start.isNumeric ? timeRange.start : .zero
        let frameDuration = minFrameDuration.isNumeric && minFrameDuration > .zero ? minFrameDuration : CMTime(value: 1, timescale: 30)
        var end = source.endTime.isNumeric ? source.endTime : timeRange.end
        if !end.isNumeric { end = start }
        let lastFrame = CMTimeMaximum(start, CMTimeSubtract(end, frameDuration))

        let exact = AVAssetImageGenerator(asset: source.asset)
        exact.appliesPreferredTrackTransform = true
        exact.requestedTimeToleranceBefore = .zero
        exact.requestedTimeToleranceAfter = .zero
        exact.maximumSize = CGSize(width: tileWidth, height: tileHeight)
        // For the last frame, and for a time the exact one cannot decode: the
        // nearest frame at or before it.
        let lenient = AVAssetImageGenerator(asset: source.asset)
        lenient.appliesPreferredTrackTransform = true
        lenient.requestedTimeToleranceBefore = .positiveInfinity
        lenient.requestedTimeToleranceAfter = .zero
        lenient.maximumSize = exact.maximumSize

        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: sheetWidth,
            height: sheetHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            throw MediaError("Could not allocate a \(sheetWidth)×\(sheetHeight) contact sheet.")
        }
        context.setFillColor(CGColor(srgbRed: 0x20 / 255.0, green: 0x20 / 255.0, blue: 0x20 / 255.0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: sheetWidth, height: sheetHeight))
        context.interpolationQuality = .high

        for (index, seconds) in request.times.enumerated() {
            let wanted = CMTimeAdd(start, CMTime(seconds: max(seconds, 0), preferredTimescale: 90_000))
            let pastEnd = wanted >= lastFrame
            let time = pastEnd ? lastFrame : wanted
            let image: CGImage
            do {
                image = try await (pastEnd ? lenient : exact).image(at: time).image
            } catch {
                do {
                    image = try await lenient.image(at: time).image
                } catch {
                    throw MediaError.describing(error, context: "Could not read the frame at \(seconds) s of \(source.url.lastPathComponent)")
                }
            }
            let column = index % columns
            let row = index / columns
            // CoreGraphics is y-up: row 0 is the top one.
            let x = column * (tileWidth + gap)
            let y = sheetHeight - tileHeight - row * (tileHeight + gap)
            context.draw(image, in: CGRect(x: x, y: y, width: tileWidth, height: tileHeight))
        }

        guard let sheet = context.makeImage() else { throw MediaError("Could not finish the contact sheet.") }
        try writePNG(sheet, to: URL(fileURLWithPath: request.output))
        return DemoContactSheetResult(width: sheetWidth, height: sheetHeight)
    }

    private static func writePNG(_ image: CGImage, to target: URL) throws {
        let directory = target.deletingLastPathComponent()
        let partial = directory.appendingPathComponent(".\(target.lastPathComponent).\(getpid()).partial.png")
        try? FileManager.default.removeItem(at: partial)
        PartialOutput.register(partial)
        defer {
            PartialOutput.removeIfAny()
            PartialOutput.clear()
        }
        guard let destination = CGImageDestinationCreateWithURL(partial as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw MediaError("Could not create the contact sheet at \(target.path); does its folder exist?")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw MediaError("Could not write the contact sheet to \(target.path).")
        }
        if rename(partial.path, target.path) != 0 {
            throw MediaError("Could not move the contact sheet to \(target.path): \(String(cString: strerror(errno)))")
        }
    }
}
