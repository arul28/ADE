import Foundation

/// Where a recording's frames land in the MP4 when dead time is cut.
///
/// A port of the Apple simulator helper's `IdleGapCompressor`
/// (`ADESimHelper/Sources/ADESimHelperCore/IdleGapCompressor.swift`). The two
/// packages share no code, so the rules are copied, not imported; keep them in
/// step.
///
/// An agent that is thinking, or retrying a click that does nothing, leaves the
/// lane's display still for minutes. Written at wall-clock time, that is a file
/// of frozen frames. This type decides how much of each still stretch the file
/// keeps.
///
/// The rules:
///
/// - Activity is a new picture (see `ScreenChange`). Anything else is idle.
/// - An idle stretch no longer than `threshold` plays in full.
/// - A longer one keeps `keptHold` of the still and cuts the rest: every later
///   frame moves back by the cut.
/// - Output times strictly increase, at least `minimumStep` apart. The step is
///   well under a frame interval but several units of the MP4's 1/600 s
///   timescale, so rounding can never make two frames share a time.
///
/// The cut is decided late. While a still lasts, nobody knows whether it will
/// pass the threshold. So after `keptHold` of stillness the recorder writes
/// nothing (`isHolding`), and the last frame written stands in for the still.
/// When activity resumes, the stretch's length decides whether any of it is
/// cut.
///
/// All times are seconds since the recording's first frame. Pure and
/// value-typed, so the timing is testable without AVFoundation or a display.
public struct IdleGapCompressor: Equatable, Sendable {
    /// A still shorter than this is part of the story: a window settling, a
    /// person reading a result. Longer is dead time.
    public static let defaultThreshold: TimeInterval = 2.0
    /// How much of a cut still stays in the file, so a viewer sees the pause
    /// happen instead of a jump cut.
    public static let defaultKeptHold: TimeInterval = 0.75

    /// False means wall-clock time, as before idle cutting existed.
    public let enabled: Bool
    public let threshold: TimeInterval
    public let keptHold: TimeInterval
    public let minimumStep: TimeInterval

    /// Seconds cut so far, not counting a still that is still going on.
    public private(set) var cut: TimeInterval = 0
    /// The newest activity, in input time. The first frame counts as activity.
    public private(set) var lastActivity: TimeInterval = 0
    /// The newest output time handed out, or nil before the first frame.
    public private(set) var lastPresentation: TimeInterval?
    /// Set by `finalFrameTime`, so the last picture stays on screen a moment.
    public private(set) var minimumEnd: TimeInterval = 0

    public init(
        enabled: Bool = true,
        threshold: TimeInterval = IdleGapCompressor.defaultThreshold,
        keptHold: TimeInterval = IdleGapCompressor.defaultKeptHold,
        minimumStep: TimeInterval = 1.0 / 240
    ) {
        self.enabled = enabled
        self.threshold = max(threshold, 0)
        // A kept hold longer than the threshold would make a cut add time.
        self.keptHold = min(max(keptHold, 0), max(threshold, 0))
        self.minimumStep = max(minimumStep, 1.0 / 300)
    }

    /// Something happened at `time`: a new picture.
    ///
    /// If it ends a still longer than the threshold, the still is cut down to
    /// `keptHold` here, so the frame written next lands right after the hold.
    public mutating func noteActivity(at time: TimeInterval) {
        guard time > lastActivity else { return }
        if enabled {
            let still = time - lastActivity
            if still > threshold { cut += still - keptHold }
        }
        lastActivity = time
    }

    /// True while the recorder should write nothing because a still has
    /// already been shown for `keptHold`.
    public func isHolding(at time: TimeInterval) -> Bool {
        enabled && time - lastActivity > keptHold
    }

    /// The output time for a frame captured at `time`, or nil while holding.
    public mutating func presentationTime(at time: TimeInterval) -> TimeInterval? {
        guard !isHolding(at: time) else { return nil }
        var output = max(time - cut, 0)
        if let last = lastPresentation { output = max(output, last + minimumStep) }
        lastPresentation = output
        return output
    }

    /// Where the file ends if the recording stops at `time`.
    ///
    /// A still that runs to the end is treated like any other: past the
    /// threshold it keeps `keptHold`, so the video neither ends on a long
    /// freeze nor stops dead on the last change.
    public func endTime(at time: TimeInterval) -> TimeInterval {
        var end = time - cut
        if enabled {
            let still = time - lastActivity
            if still > threshold { end -= still - keptHold }
        }
        if let last = lastPresentation { end = max(end, last + minimumStep) }
        return max(end, minimumEnd, 0)
    }

    /// The output time for one last frame written at stop while holding.
    ///
    /// A picture that changed too little to count as activity (a clock tick,
    /// a small label) during the final still would otherwise never reach the
    /// file. It goes where the kept hold ends, and the file runs on for half a
    /// hold more, so it is on screen for a moment rather than a single frame.
    public mutating func finalFrameTime(at time: TimeInterval) -> TimeInterval {
        var output = endTime(at: time)
        if let last = lastPresentation { output = max(output, last + minimumStep) }
        lastPresentation = output
        minimumEnd = output + keptHold / 2
        return output
    }
}

/// Whether a new picture is activity, or only a blinking caret.
///
/// ScreenCaptureKit already filters a fully still display: it delivers a frame
/// only when something on the display was redrawn. What it cannot filter is a
/// display that is still apart from a text caret blinking twice a second, or
/// the menu-bar clock. Those change a handful of pixels in a small grey
/// thumbnail; a new window, a page load or a scroll changes far more.
///
/// The comparison is against the picture at the last significant change, not
/// the previous frame, so many small changes that add up (a progress bar)
/// still count. The thresholds are the Apple helper's.
public enum ScreenChange {
    /// Longest side of the thumbnail compared, in pixels. At about a seventh
    /// of a 1920-point display, a caret is a few pixels and a line of text is
    /// dozens.
    public static let thumbnailSide = 256
    /// Grey-level difference, out of 255, below which a pixel counts as the same.
    public static let pixelDelta = 24
    /// How many pixels must change for the picture to count as new.
    public static let minimumChangedPixels = 24
    public static let minimumChangedFraction = 0.001
    /// Source samples averaged along each side of a thumbnail pixel. Sixteen
    /// reads per pixel keep a 1920×1080 frame well under a millisecond, where
    /// reading every source pixel costs several.
    public static let samplesPerSide = 4

    /// A small greyscale picture, row-major, one byte per pixel.
    public struct Thumbnail: Equatable, Sendable {
        public var width: Int
        public var height: Int
        public var luma: [UInt8]

        public init(width: Int, height: Int, luma: [UInt8]) {
            self.width = width
            self.height = height
            self.luma = luma
        }
    }

    /// True when `current` differs from `reference` by more than noise.
    /// A size change (a display resized mid-recording) always counts.
    public static func isSignificant(reference: Thumbnail, current: Thumbnail) -> Bool {
        guard
            reference.width == current.width,
            reference.height == current.height,
            reference.luma.count == current.luma.count,
            !current.luma.isEmpty
        else { return true }

        let needed = max(minimumChangedPixels, Int(Double(current.luma.count) * minimumChangedFraction))
        var changed = 0
        for index in current.luma.indices {
            let delta = Int(current.luma[index]) - Int(reference.luma[index])
            if delta > pixelDelta || delta < -pixelDelta {
                changed += 1
                if changed >= needed { return true }
            }
        }
        return false
    }

    /// A small greyscale copy of a 32-bit BGRA frame, the format the recording
    /// asks ScreenCaptureKit for.
    ///
    /// Each thumbnail pixel averages a `samplesPerSide`² grid spread across the
    /// source cell it covers, so a thin caret moves a cell's grey level about
    /// as much as it would in a real downscale, without reading every pixel.
    /// Nil for a frame too small or a buffer too short to be one.
    public static func thumbnail(
        bgra bytes: UnsafeRawBufferPointer,
        width: Int,
        height: Int,
        bytesPerRow: Int
    ) -> Thumbnail? {
        guard
            width > 0,
            height > 0,
            bytesPerRow >= width * 4,
            bytes.count >= bytesPerRow * (height - 1) + width * 4
        else { return nil }

        let longest = max(width, height)
        let outWidth = longest <= thumbnailSide ? width : max(1, width * thumbnailSide / longest)
        let outHeight = longest <= thumbnailSide ? height : max(1, height * thumbnailSide / longest)
        // Sample offsets inside each cell, as fractions of the cell.
        let fractions = (0..<samplesPerSide).map { (Double($0) + 0.5) / Double(samplesPerSide) }
        var columns: [[Int]] = []
        columns.reserveCapacity(outWidth)
        for x in 0..<outWidth {
            let cell = Double(width) / Double(outWidth)
            columns.append(fractions.map { min(width - 1, Int((Double(x) + $0) * cell)) * 4 })
        }
        var luma = [UInt8](repeating: 0, count: outWidth * outHeight)
        for y in 0..<outHeight {
            let cell = Double(height) / Double(outHeight)
            let rows = fractions.map { min(height - 1, Int((Double(y) + $0) * cell)) * bytesPerRow }
            for x in 0..<outWidth {
                var sum = 0
                for row in rows {
                    for column in columns[x] {
                        let offset = row + column
                        // BT.709 weights in 8-bit fixed point; bytes are B, G, R, A.
                        sum += 19 * Int(bytes[offset]) + 183 * Int(bytes[offset + 1]) + 54 * Int(bytes[offset + 2])
                    }
                }
                luma[y * outWidth + x] = UInt8(min(255, sum / (256 * rows.count * columns[x].count)))
            }
        }
        return Thumbnail(width: outWidth, height: outHeight, luma: luma)
    }
}

/// The per-frame idle-cut decision for one Mac Desktop recording.
///
/// The Apple helper paces frames itself and re-reads the latest picture on
/// every tick. This driver instead writes what ScreenCaptureKit delivers, and
/// that is one frame per redraw and nothing while the display is still. So the
/// decision is made per delivered frame: classify it, then write it at the
/// time `IdleGapCompressor` gives, or skip it while holding. A skipped frame is
/// still the newest picture, so the recorder keeps it for `finish`.
public struct RecordingIdleCut: Equatable, Sendable {
    public private(set) var compressor: IdleGapCompressor
    /// The picture at the last significant change.
    public private(set) var reference: ScreenChange.Thumbnail?

    public init(enabled: Bool) {
        compressor = IdleGapCompressor(enabled: enabled)
    }

    public var enabled: Bool { compressor.enabled }

    /// The output time for a frame captured `elapsed` seconds after the first
    /// one, or nil when the recorder should skip it.
    ///
    /// `thumbnail` is only asked for with the cut on. A frame whose thumbnail
    /// cannot be made counts as a change: cutting real activity is worse than
    /// keeping a still.
    public mutating func place(
        frameAt elapsed: TimeInterval,
        thumbnail: () -> ScreenChange.Thumbnail?
    ) -> TimeInterval? {
        if compressor.enabled {
            guard let current = thumbnail() else {
                compressor.noteActivity(at: elapsed)
                return compressor.presentationTime(at: elapsed)
            }
            if let reference, !ScreenChange.isSignificant(reference: reference, current: current) {
                return compressor.presentationTime(at: elapsed)
            }
            reference = current
            compressor.noteActivity(at: elapsed)
        }
        return compressor.presentationTime(at: elapsed)
    }

    /// Where the file ends when the recording stops `wall` seconds after its
    /// first frame, and the output time for the newest skipped frame if one is
    /// waiting (`pendingFrame`) and should close the file.
    ///
    /// The skipped frame changed too little to count as activity (a clock
    /// tick, a caret), but it is what the display showed at the stop, so the
    /// video ends on it, as the Apple helper's does.
    public mutating func finish(
        at wall: TimeInterval,
        pendingFrame: Bool
    ) -> (finalFrame: TimeInterval?, end: TimeInterval) {
        var finalFrame: TimeInterval?
        if pendingFrame, compressor.isHolding(at: wall) {
            finalFrame = compressor.finalFrameTime(at: wall)
        }
        return (finalFrame, compressor.endTime(at: wall))
    }
}
