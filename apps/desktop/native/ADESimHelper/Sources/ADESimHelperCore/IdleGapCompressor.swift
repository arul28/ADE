import Foundation

/// Where a recording's frames land in the MP4 when dead time is cut.
///
/// An agent that is thinking, or retrying a gesture that does nothing, leaves
/// the screen still for minutes. Written at wall-clock time, that is a file of
/// frozen frames: one live session ran 3:17 for about a minute of anything
/// happening. This type decides how much of each still stretch the file keeps.
///
/// The rules:
///
/// - Activity is a new picture (see `ScreenChange`) or an input overlay (a tap
///   ring, a typing badge). Anything else is idle.
/// - An idle stretch no longer than `threshold` plays in full.
/// - A longer one keeps `keptHold` of the still and cuts the rest: every later
///   frame moves back by the cut.
/// - Output times strictly increase, at least `minimumStep` apart. The step is
///   well under a frame interval but several units of the MP4's 1/600 s
///   timescale, so rounding can never make two frames share a time.
///
/// The cut is decided late. While a still lasts, nobody knows whether it will
/// pass the threshold. So after `keptHold` of stillness the recorder writes
/// nothing (`isHolding`), and the last frame written stands in for the still —
/// it is the same picture, so the file loses nothing. When activity resumes,
/// the stretch's length decides whether any of it is cut.
///
/// All times are seconds since the recording's first frame. Pure and
/// value-typed, so the timing is testable without AVFoundation or a device.
public struct IdleGapCompressor: Equatable, Sendable {
    /// A still shorter than this is part of the story: a screen settling, a
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

    /// Something happened at `time`: a new picture or an overlay event.
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

    /// The output time for a frame composited at `time`, or nil while holding.
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
/// Exact byte equality of the JPEG already catches a fully still screen (the
/// capture layer re-sends the same picture at its idle floor, and the encoder
/// is deterministic). What it cannot catch is a screen that is still apart from
/// a text caret blinking twice a second, or a status-bar clock. Those change
/// a handful of pixels in a small grey thumbnail; a tap highlight, a new
/// label or a scroll changes far more.
///
/// The comparison is against the picture at the last significant change, not
/// the previous frame, so many small changes that add up (a progress bar)
/// still count.
public enum ScreenChange {
    /// Longest side of the thumbnail compared, in pixels. At about a tenth of
    /// an iPhone's framebuffer, a caret is a few pixels and a line of text is
    /// dozens.
    public static let thumbnailSide = 256
    /// Grey-level difference, out of 255, below which a pixel counts as the same.
    public static let pixelDelta = 24
    /// How many pixels must change for the picture to count as new.
    public static let minimumChangedPixels = 24
    public static let minimumChangedFraction = 0.001

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
    /// A size change (rotation, another device) always counts.
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
}
