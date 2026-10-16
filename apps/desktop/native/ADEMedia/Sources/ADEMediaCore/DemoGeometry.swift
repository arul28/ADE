import Foundation

/// Where the camera's viewport lands in the output frame, and where a
/// normalized source point lands with it.
///
/// Pixel coordinates here are top-left origin, y down, in output pixels. The
/// viewport keeps the source's aspect ratio; when the output's differs, the
/// picture is fitted and the rest of the frame is black. A difference under a
/// pixel (an odd source size rounded to an even output) is not worth a black
/// sliver, so there the picture is stretched by that fraction instead.
public struct DemoFrameLayout: Equatable, Sendable {
    public let sourceWidth: Double
    public let sourceHeight: Double
    public let outputWidth: Double
    public let outputHeight: Double
    public let viewport: DemoViewport
    /// Output pixels per source pixel, per axis.
    public let scaleX: Double
    public let scaleY: Double
    /// The output rectangle the viewport fills.
    public let pictureX: Double
    public let pictureY: Double
    public let pictureWidth: Double
    public let pictureHeight: Double

    public init(sourceWidth: Double, sourceHeight: Double, outputWidth: Double, outputHeight: Double, viewport: DemoViewport) {
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
        self.outputWidth = outputWidth
        self.outputHeight = outputHeight
        self.viewport = viewport
        let viewWidth = max(viewport.width * sourceWidth, 1e-9)
        let viewHeight = max(viewport.height * sourceHeight, 1e-9)
        let fit = min(outputWidth / viewWidth, outputHeight / viewHeight)
        var width = viewWidth * fit
        var height = viewHeight * fit
        if abs(width - outputWidth) < 1 { width = outputWidth }
        if abs(height - outputHeight) < 1 { height = outputHeight }
        scaleX = width / viewWidth
        scaleY = height / viewHeight
        pictureWidth = width
        pictureHeight = height
        pictureX = (outputWidth - width) / 2
        pictureY = (outputHeight - height) / 2
    }

    /// True when the picture covers the whole output frame.
    public var fillsOutput: Bool {
        pictureWidth >= outputWidth && pictureHeight >= outputHeight
    }

    /// A normalized source point, in output pixels (top-left origin).
    public func outputPoint(x: Double, y: Double) -> (x: Double, y: Double) {
        (
            pictureX + (x - viewport.x) * sourceWidth * scaleX,
            pictureY + (y - viewport.y) * sourceHeight * scaleY
        )
    }

    /// The output's shorter side, the unit every style size is a fraction of.
    public var shortSide: Double { min(outputWidth, outputHeight) }
}

/// How the overlays look at one output time. Both engines draw the same
/// shapes with the same curves; the numbers here are the shared spec.
public enum DemoOverlayGeometry {
    /// A ring at one moment: centre in output pixels, sizes in output pixels.
    public struct RingState: Equatable, Sendable {
        public var x: Double
        public var y: Double
        public var radius: Double
        public var lineWidth: Double
        public var alpha: Double
    }

    /// The ring started at `ring.t`, at output time `time`, or nil when it is
    /// not on screen. It grows with an ease-out (`1 - (1 - p)²`) from
    /// `ringStartRadius` to `ringEndRadius` and fades linearly to nothing.
    public static func ring(_ ring: DemoRing, at time: Double, style: DemoStyle, layout: DemoFrameLayout) -> RingState? {
        let duration = style.ringDurationSeconds
        let age = time - ring.t
        guard duration > 0, age >= 0, age < duration else { return nil }
        let progress = age / duration
        let inverse = 1 - progress
        let eased = 1 - inverse * inverse
        let side = layout.shortSide
        let radius = (style.ringStartRadius + (style.ringEndRadius - style.ringStartRadius) * eased) * side
        let point = layout.outputPoint(x: ring.x, y: ring.y)
        return RingState(
            x: point.x,
            y: point.y,
            radius: max(radius, 0),
            lineWidth: max(style.ringLineWidth * side, 0),
            alpha: inverse
        )
    }

    /// The pointer polygon with its tip at (`tipX`, `tipY`), `height` pixels tall.
    public static func pointer(tipX: Double, tipY: Double, height: Double) -> [(x: Double, y: Double)] {
        demoPointerPolygon.map { (tipX + $0.x * height, tipY + $0.y * height) }
    }

    /// How long a caption takes to fade in, and to fade out.
    public static let captionFadeSeconds = 0.15

    /// A caption's opacity at `time`: a short fade at each end of its span.
    public static func captionAlpha(_ caption: DemoTextSpan, at time: Double) -> Double {
        guard caption.isActive(at: time) else { return 0 }
        let fade = min(captionFadeSeconds, (caption.end - caption.start) / 2)
        guard fade > 0 else { return 1 }
        let fadeIn = (time - caption.start) / fade
        let fadeOut = (caption.end - time) / fade
        return min(max(min(fadeIn, fadeOut, 1), 0), 1)
    }

    /// `#RRGGBB` (or `#RGB`) as 0..1 components; nil when it is not a colour.
    public static func parseHexColor(_ raw: String) -> (red: Double, green: Double, blue: Double)? {
        var hex = raw.trimmingCharacters(in: .whitespaces)
        if hex.hasPrefix("#") { hex.removeFirst() }
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count == 6 || hex.count == 8, let value = UInt32(hex.prefix(6), radix: 16) else { return nil }
        return (
            Double((value >> 16) & 0xFF) / 255,
            Double((value >> 8) & 0xFF) / 255,
            Double(value & 0xFF) / 255
        )
    }
}
