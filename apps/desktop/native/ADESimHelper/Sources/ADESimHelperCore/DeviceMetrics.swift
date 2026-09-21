import Foundation
import CoreGraphics

/// What a simulator's screen is, in both units ADE cares about.
///
/// The wire speaks device points; the vendored `HIDInjector` speaks 0..1
/// fractions of the screen (it ignores the `screenWidth`/`screenHeight`
/// arguments it takes, which is easy to misread as "pixels"). The framebuffer
/// is in pixels. Keeping all three in one value means the normalisation happens
/// in exactly one place instead of at every call site.
public struct DeviceMetrics: Equatable, Sendable {
    public var pointWidth: Double
    public var pointHeight: Double
    public var scale: Double

    public init(pointWidth: Double, pointHeight: Double, scale: Double) {
        self.pointWidth = pointWidth
        self.pointHeight = pointHeight
        self.scale = scale
    }

    public var pixelWidth: Int { Int((pointWidth * scale).rounded()) }
    public var pixelHeight: Int { Int((pointHeight * scale).rounded()) }

    /// A device point as the fraction of the screen the HID layer wants.
    ///
    /// Clamped, not rejected: a drag that runs a few points off the edge is a
    /// real gesture, and an out-of-range fraction makes the simulator drop the
    /// whole touch rather than treat it as an edge swipe.
    public func normalize(_ point: DevicePoint) -> CGPoint {
        CGPoint(
            x: min(max(point.x / max(pointWidth, 1), 0), 1),
            y: min(max(point.y / max(pointHeight, 1), 0), 1)
        )
    }

    /// Derive metrics from a framebuffer size when CoreSimulator would not say.
    ///
    /// The scale is a guess, so the points it reports are a guess too — but a
    /// consistent one, and `capture-started` reports the pixel size alongside
    /// so ADE can tell.
    public static func fromPixels(width: Int, height: Int, assumedScale: Double) -> DeviceMetrics {
        let scale = assumedScale > 0 ? assumedScale : 1
        return DeviceMetrics(
            pointWidth: Double(width) / scale,
            pointHeight: Double(height) / scale,
            scale: scale
        )
    }
}
