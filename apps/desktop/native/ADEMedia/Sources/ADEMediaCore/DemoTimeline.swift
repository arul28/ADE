import Foundation

/// Output time → source time, the plan's segments as a function.
///
/// Segments are ordered: output times and source times both increase from one
/// segment to the next, so a renderer that walks output frames in order only
/// ever decodes forward. A source range no segment covers is cut.
///
/// The map is forgiving where the planner can only be off by rounding and
/// strict where the plan is wrong: an overlap of a millisecond is fine, a
/// segment that goes back in source time is refused, because honouring it would
/// need a second decode pass the engines do not have.
public struct DemoTimeMap: Equatable, Sendable {
    /// Rounding slack between neighbouring segments, in seconds.
    public static let tolerance = 0.001

    /// The segments that last some output time. A zero-length segment shows no
    /// frame, so it is dropped here rather than special-cased in every lookup.
    public let segments: [DemoSegment]

    public init(segments input: [DemoSegment]) throws {
        guard !input.isEmpty else { throw DemoPlanError("The plan has no segments.") }
        var previous: DemoSegment?
        for (index, segment) in input.enumerated() {
            let values = [segment.outputStart, segment.outputEnd, segment.sourceStart, segment.sourceEnd]
            guard values.allSatisfy({ $0.isFinite }) else {
                throw DemoPlanError("Segment \(index) has a time that is not a number.")
            }
            guard segment.outputStart >= -Self.tolerance, segment.sourceStart >= -Self.tolerance else {
                throw DemoPlanError("Segment \(index) starts before zero.")
            }
            guard segment.outputEnd >= segment.outputStart - Self.tolerance,
                  segment.sourceEnd >= segment.sourceStart - Self.tolerance
            else {
                throw DemoPlanError("Segment \(index) ends before it starts.")
            }
            if let previous {
                guard segment.outputStart >= previous.outputEnd - Self.tolerance else {
                    throw DemoPlanError("Segment \(index) overlaps the one before it in output time.")
                }
                guard segment.sourceStart >= previous.sourceEnd - Self.tolerance else {
                    throw DemoPlanError("Segment \(index) goes back in source time; segments must move forward.")
                }
            }
            previous = segment
        }
        segments = input.filter { $0.outputEnd - $0.outputStart > 1e-9 }
        guard !segments.isEmpty else { throw DemoPlanError("Every segment of the plan is zero-length.") }
    }

    /// The source time shown at output time `time`.
    ///
    /// Before the first segment the output holds the first segment's first
    /// picture; in a gap between two segments, and after the last one, it holds
    /// the picture the previous segment ended on.
    public func sourceTime(atOutput time: Double) -> Double {
        // The last segment that has started by `time`.
        var low = 0
        var high = segments.count - 1
        var found = -1
        while low <= high {
            let middle = (low + high) / 2
            if segments[middle].outputStart <= time {
                found = middle
                low = middle + 1
            } else {
                high = middle - 1
            }
        }
        guard found >= 0 else { return max(segments[0].sourceStart, 0) }
        let segment = segments[found]
        if time >= segment.outputEnd { return max(segment.sourceEnd, 0) }
        let speed = (segment.sourceEnd - segment.sourceStart) / (segment.outputEnd - segment.outputStart)
        let source = segment.sourceStart + (time - segment.outputStart) * speed
        return max(min(max(source, segment.sourceStart), segment.sourceEnd), 0)
    }
}

/// The output's constant frame clock.
public struct DemoFrameClock: Equatable, Sendable {
    public let fps: Double
    public let frameCount: Int

    /// Frames at `n / fps` for every `n` whose time is before `duration`.
    public init(durationSeconds: Double, fps: Double) throws {
        guard fps.isFinite, fps > 0, fps <= 240 else {
            throw DemoPlanError("The output frame rate \(fps) is not between 0 and 240.")
        }
        guard durationSeconds.isFinite, durationSeconds > 0 else {
            throw DemoPlanError("The plan's output duration must be more than zero seconds.")
        }
        self.fps = fps
        // A duration a hair over a whole frame count is rounding, not a frame.
        frameCount = max(1, Int((durationSeconds * fps - 1e-6).rounded(.up)))
    }

    public func time(ofFrame index: Int) -> Double {
        Double(index) / fps
    }

    public var durationSeconds: Double { Double(frameCount) / fps }
}

// MARK: - Camera

/// The visible part of the source, normalized: x, y (top left), width, height.
public struct DemoViewport: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public static let full = DemoViewport(x: 0, y: 0, width: 1, height: 1)

    /// The viewport a camera at `zoom` centred on (`cx`, `cy`) shows.
    ///
    /// The planner already clamps, but an engine must not show outside the
    /// frame whatever it is given: zoom below 1 (or not a number) is 1, and the
    /// centre is pulled in until the viewport fits.
    public init(zoom: Double, cx: Double, cy: Double) {
        let safeZoom = zoom.isFinite ? max(zoom, 1) : 1
        let size = 1 / safeZoom
        let half = size / 2
        let centerX = cx.isFinite ? min(max(cx, half), 1 - half) : 0.5
        let centerY = cy.isFinite ? min(max(cy, half), 1 - half) : 0.5
        self.init(x: centerX - half, y: centerY - half, width: size, height: size)
    }

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// Keys interpolated linearly, held before the first and after the last.
enum KeyTrack {
    /// The index of the last key at or before `time`, or -1.
    static func lastIndex<Key>(in keys: [Key], atOrBefore time: Double, time keyTime: (Key) -> Double) -> Int {
        var low = 0
        var high = keys.count - 1
        var found = -1
        while low <= high {
            let middle = (low + high) / 2
            if keyTime(keys[middle]) <= time {
                found = middle
                low = middle + 1
            } else {
                high = middle - 1
            }
        }
        return found
    }
}

public struct DemoCameraTrack: Equatable, Sendable {
    public let keys: [DemoCameraKey]

    /// Keys sorted by time; ones with a time that is not a number are dropped.
    public init(keys: [DemoCameraKey]) {
        self.keys = keys.filter { $0.t.isFinite }.sorted { $0.t < $1.t }
    }

    /// The viewport at output time `time`. No keys is the whole frame.
    public func viewport(at time: Double) -> DemoViewport {
        guard let first = keys.first, let last = keys.last else { return .full }
        let index = KeyTrack.lastIndex(in: keys, atOrBefore: time) { $0.t }
        if index < 0 { return DemoViewport(zoom: first.zoom, cx: first.cx, cy: first.cy) }
        if index >= keys.count - 1 { return DemoViewport(zoom: last.zoom, cx: last.cx, cy: last.cy) }
        let from = keys[index]
        let to = keys[index + 1]
        let span = to.t - from.t
        let progress = span > 0 ? (time - from.t) / span : 1
        return DemoViewport(
            zoom: lerp(from.zoom, to.zoom, progress),
            cx: lerp(from.cx, to.cx, progress),
            cy: lerp(from.cy, to.cy, progress)
        )
    }
}

public struct DemoCursorTrack: Equatable, Sendable {
    public let keys: [DemoCursorKey]

    public init(keys: [DemoCursorKey]) {
        self.keys = keys.filter { $0.t.isFinite && $0.x.isFinite && $0.y.isFinite }.sorted { $0.t < $1.t }
    }

    /// The pointer's normalized source position at `time`, or nil while hidden.
    ///
    /// Linear between two visible keys. A visible key followed by a hidden one
    /// holds its position until the hidden key takes over; a hidden key hides
    /// the pointer until the next visible one. Before the first key there is
    /// no pointer; after the last, the last key holds. (The Chromium engine
    /// follows the same rules.)
    public func position(at time: Double) -> (x: Double, y: Double)? {
        let index = KeyTrack.lastIndex(in: keys, atOrBefore: time) { $0.t }
        guard index >= 0 else { return nil }
        let from = keys[index]
        guard from.visible else { return nil }
        guard index + 1 < keys.count, keys[index + 1].visible else {
            return (from.x, from.y)
        }
        let to = keys[index + 1]
        let span = to.t - from.t
        let progress = span > 0 ? (time - from.t) / span : 1
        return (lerp(from.x, to.x, progress), lerp(from.y, to.y, progress))
    }
}

@inline(__always)
func lerp(_ from: Double, _ to: Double, _ progress: Double) -> Double {
    let p = min(max(progress, 0), 1)
    return from + (to - from) * p
}
