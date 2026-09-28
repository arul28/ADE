import ADEMediaCore
import CoreVideo
import Foundation

/// `ade-media analyze`: measures how much each frame of a raw recording
/// changed, by the rules in `DemoAnalysisRules`.
enum Analyzer {
    /// The decoder is asked for this many source pixels per thumbnail pixel
    /// along each side. The box average over a 4×4 block of a hardware-scaled
    /// frame is close to one over the full frame, at a sixteenth of the reads.
    static let decodeOversample = 4

    static func analyze(path: String) async throws -> DemoAnalysis {
        let source = try await MediaSource.open(path: path)
        // Thumbnail size in the stored orientation; it is turned upright after.
        let thumb = DemoThumbnail.size(forSourceWidth: source.naturalWidth, height: source.naturalHeight)
        let decodeWidth = min(source.naturalWidth, thumb.width * decodeOversample)
        let decodeHeight = min(source.naturalHeight, thumb.height * decodeOversample)
        let scaled = decodeWidth < source.naturalWidth || decodeHeight < source.naturalHeight
        try source.startReading(scaledTo: scaled ? (decodeWidth, decodeHeight) : nil)
        defer { source.cancel() }

        let orientation = source.orientation
        func thumbnail(_ frame: DecodedFrame) -> DemoThumbnail? {
            let buffer = frame.buffer
            guard
                CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA,
                CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess
            else { return nil }
            defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
            guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
            let height = CVPixelBufferGetHeight(buffer)
            let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
            return DemoThumbnail.boxAverage(
                bgra: UnsafeRawBufferPointer(start: base, count: bytesPerRow * height),
                sourceWidth: CVPixelBufferGetWidth(buffer),
                sourceHeight: height,
                bytesPerRow: bytesPerRow,
                width: thumb.width,
                height: thumb.height
            )?.oriented(a: orientation.a, b: orientation.b, c: orientation.c, d: orientation.d)
        }

        var accumulator = DemoAnalysisAccumulator()
        // The newest frame skipped for being too close to the last analysed
        // one. If the file ends on it, it is analysed then, so the last
        // picture's change is never lost.
        var pending: DecodedFrame?
        var decoded = 0
        while let frame = try source.nextFrame() {
            decoded += 1
            if accumulator.shouldAnalyse(at: frame.time) {
                pending = nil
                guard let image = thumbnail(frame) else {
                    throw MediaError("Frame \(decoded) of \(source.url.lastPathComponent) could not be read as BGRA.")
                }
                accumulator.add(at: frame.time, thumbnail: image)
            } else {
                pending = frame
            }
        }
        if let pending, let image = thumbnail(pending) {
            accumulator.add(at: pending.time, thumbnail: image)
        }
        guard decoded > 0 else {
            throw MediaError("The input has no decodable video frames: \(source.url.lastPathComponent)")
        }
        return DemoAnalysis(
            width: source.displayWidth,
            height: source.displayHeight,
            durationSeconds: (source.durationSeconds * 100_000).rounded() / 100_000,
            frames: accumulator.frames
        )
    }
}
