import Foundation

// The demo-video contract, as JSON the `ade-media` binary reads and writes.
//
// The source of truth is `apps/desktop/src/shared/demoVideo/demoContract.ts`.
// These types mirror it field for field; a field added there has to be added
// here, or a plan that uses it renders without it. Times are seconds, points
// and rectangles are normalized 0..1 unless a comment says otherwise.

/// A rectangle in normalized source coordinates: x, y, width, height.
public typealias DemoRect = [Double]

/// How an engine measures change. Both engines use the same numbers, so the
/// planner's thresholds mean the same thing on every OS. The desktop passes
/// the contract's numbers (`DEMO_ANALYSIS_*` in `demoContract.ts`) on the
/// command line, so the two engines cannot drift apart; these defaults match.
public enum DemoAnalysisRules {
    /// Longest side of the greyscale thumbnail each frame is reduced to.
    public private(set) static var thumbnailLongSide = 256
    /// A thumbnail pixel changed when it moved by more than this (0..255).
    public private(set) static var pixelDelta = 24
    /// Frames closer than this to the last analysed one may be skipped.
    public private(set) static var minIntervalSeconds = 1.0 / 30

    /// Set once, before the analysis starts. Values out of range are ignored.
    public static func configure(thumbnailLongSide: Int?, pixelDelta: Int?, minIntervalSeconds: Double?) {
        if let side = thumbnailLongSide, side >= 16, side <= 4096 { self.thumbnailLongSide = side }
        if let delta = pixelDelta, delta >= 0, delta <= 255 { self.pixelDelta = delta }
        if let interval = minIntervalSeconds, interval >= 0, interval <= 1 { self.minIntervalSeconds = interval }
    }
}

/// The pointer, in pointer units: (0,0) is the tip, the shape is 1 unit tall.
public let demoPointerPolygon: [(x: Double, y: Double)] = [
    (0, 0),
    (0, 0.78),
    (0.2, 0.6),
    (0.33, 0.9),
    (0.45, 0.85),
    (0.32, 0.56),
    (0.56, 0.56),
]

/// The pointer's outline width, in pointer units.
public let demoPointerStrokeUnits = 0.06

// MARK: - Analysis

public struct DemoAnalysisFrame: Codable, Equatable, Sendable {
    public var t: Double
    public var changed: Double
    public var box: DemoRect?

    public init(t: Double, changed: Double, box: DemoRect? = nil) {
        self.t = t
        self.changed = changed
        self.box = box
    }
}

public struct DemoAnalysis: Codable, Equatable, Sendable {
    public var version: Int = 1
    public var width: Int
    public var height: Int
    public var durationSeconds: Double
    public var frames: [DemoAnalysisFrame]

    public init(width: Int, height: Int, durationSeconds: Double, frames: [DemoAnalysisFrame]) {
        self.width = width
        self.height = height
        self.durationSeconds = durationSeconds
        self.frames = frames
    }
}

// MARK: - Plan

public struct DemoSegment: Codable, Equatable, Sendable {
    public var outputStart: Double
    public var outputEnd: Double
    public var sourceStart: Double
    public var sourceEnd: Double

    public init(outputStart: Double, outputEnd: Double, sourceStart: Double, sourceEnd: Double) {
        self.outputStart = outputStart
        self.outputEnd = outputEnd
        self.sourceStart = sourceStart
        self.sourceEnd = sourceEnd
    }
}

public struct DemoCameraKey: Codable, Equatable, Sendable {
    public var t: Double
    public var zoom: Double
    public var cx: Double
    public var cy: Double

    public init(t: Double, zoom: Double, cx: Double, cy: Double) {
        self.t = t
        self.zoom = zoom
        self.cx = cx
        self.cy = cy
    }
}

public struct DemoCursorKey: Codable, Equatable, Sendable {
    public var t: Double
    public var x: Double
    public var y: Double
    public var visible: Bool

    public init(t: Double, x: Double, y: Double, visible: Bool) {
        self.t = t
        self.x = x
        self.y = y
        self.visible = visible
    }
}

public struct DemoRing: Codable, Equatable, Sendable {
    public var t: Double
    public var x: Double
    public var y: Double

    public init(t: Double, x: Double, y: Double) {
        self.t = t
        self.x = x
        self.y = y
    }
}

/// A caption or a badge: text shown from `start` to `end`, output time.
public struct DemoTextSpan: Codable, Equatable, Sendable {
    public var start: Double
    public var end: Double
    public var text: String

    public init(start: Double, end: Double, text: String) {
        self.start = start
        self.end = end
        self.text = text
    }

    public func isActive(at time: Double) -> Bool {
        time >= start && time < end
    }
}

public struct DemoStyle: Codable, Equatable, Sendable {
    public var accent: String
    public var ringDurationSeconds: Double
    public var ringStartRadius: Double
    public var ringEndRadius: Double
    public var ringLineWidth: Double
    public var pointerHeight: Double
    public var captionFontSize: Double
    public var captionMargin: Double
    public var badgeFontSize: Double
}

public struct DemoOutput: Codable, Equatable, Sendable {
    public var width: Int
    public var height: Int
    public var fps: Double
    public var bitrate: Double
    public var keyframeIntervalSeconds: Double
}

public struct DemoPlanSource: Codable, Equatable, Sendable {
    public var width: Int
    public var height: Int
}

public struct DemoPlan: Codable, Equatable, Sendable {
    public var version: Int
    public var source: DemoPlanSource
    public var output: DemoOutput
    public var durationSeconds: Double
    public var segments: [DemoSegment]
    public var camera: [DemoCameraKey]
    public var cursor: [DemoCursorKey]
    public var rings: [DemoRing]
    public var captions: [DemoTextSpan]
    public var badges: [DemoTextSpan]
    public var style: DemoStyle
}

public struct DemoRenderRequest: Codable, Equatable, Sendable {
    public var input: String
    public var output: String
    public var plan: DemoPlan
}

public struct DemoRenderResult: Codable, Equatable, Sendable {
    public var bytes: Int
    public var durationSeconds: Double
    public var frames: Int

    public init(bytes: Int, durationSeconds: Double, frames: Int) {
        self.bytes = bytes
        self.durationSeconds = durationSeconds
        self.frames = frames
    }
}

/// A plan the renderer refuses, with a message a person can act on.
public struct DemoPlanError: Error, Equatable, CustomStringConvertible {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}
