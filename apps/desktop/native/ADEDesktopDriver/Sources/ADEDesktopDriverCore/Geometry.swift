/// Points, frames, and the one plane everything is reported in.
///
/// A lane display sits somewhere on the global screen plane — CoreGraphics puts
/// the main display's top-left at (0, 0) and lets every other display take an
/// origin beside it. Elements, windows and pointer positions all travel over the
/// wire in that global plane, deliberately: the stream a viewer looks at is a
/// crop of one display, and if elements were reported in display-local points
/// the caller would need a second space and a conversion it has no reason to get
/// right.
///
/// So this file owns the global/local conversion, both ways, the Cocoa→Quartz
/// flip the restore-cursor path needs, and the arithmetic for the fallback that
/// has to put windows somewhere nobody can see.
///
/// No AppKit. `CGPoint`/`CGRect` are CoreGraphics value types and need no window
/// server, which is what lets the fallback origin be tested at all.

import CoreGraphics
import Foundation

/// Where a display is and how big it is, in global points.
public struct DisplayPlacement: Equatable, Sendable {
    public let origin: CGPoint
    public let width: CGFloat
    public let height: CGFloat
    /// Backing scale factor. 2 for a HiDPI display. Points, not pixels, are
    /// what every other field here is in.
    public let scale: CGFloat

    public init(origin: CGPoint, width: CGFloat, height: CGFloat, scale: CGFloat) {
        self.origin = origin
        self.width = width
        self.height = height
        self.scale = scale
    }

    public var frame: CGRect {
        CGRect(x: origin.x, y: origin.y, width: width, height: height)
    }

    public var pixelWidth: Int { Int((width * scale).rounded()) }
    public var pixelHeight: Int { Int((height * scale).rounded()) }
}

public enum Geometry {
    /// How far past the main display's visible frame the offscreen fallback
    /// parks a window.
    ///
    /// Not zero: a window whose left edge sits exactly on `maxX` still shows its
    /// shadow, and a resize handle can be dragged back into view by accident.
    public static let offscreenGap: CGFloat = 64

    // -----------------------------------------------------------------------
    // Display-local <-> global
    // -----------------------------------------------------------------------

    public static func toGlobal(point: CGPoint, display: DisplayPlacement) -> CGPoint {
        CGPoint(x: display.origin.x + point.x, y: display.origin.y + point.y)
    }

    public static func toLocal(point: CGPoint, display: DisplayPlacement) -> CGPoint {
        CGPoint(x: point.x - display.origin.x, y: point.y - display.origin.y)
    }

    public static func toGlobal(frame: CGRect, display: DisplayPlacement) -> CGRect {
        CGRect(
            origin: toGlobal(point: frame.origin, display: display),
            size: frame.size
        )
    }

    public static func toLocal(frame: CGRect, display: DisplayPlacement) -> CGRect {
        CGRect(
            origin: toLocal(point: frame.origin, display: display),
            size: frame.size
        )
    }

    /// Point-to-pixel, for turning a global point into a coordinate inside a
    /// captured frame of that display.
    public static func toPixel(point: CGPoint, display: DisplayPlacement) -> CGPoint {
        let local = toLocal(point: point, display: display)
        return CGPoint(x: local.x * display.scale, y: local.y * display.scale)
    }

    /// The nearest point inside `frame`, for a real event that must not land
    /// on a display this lane does not own.
    ///
    /// Clamping rather than refusing, because the caller is a person dragging a
    /// mouse across a pane: their pointer leaves the picture constantly, and a
    /// refusal per stray pixel would be a stream of errors describing normal
    /// behaviour. What must never happen is the event landing on the user's own
    /// screen, and a clamped point cannot.
    ///
    /// The far edges are inset by a point. `CGRect.maxX` is the first
    /// coordinate of whatever display sits to the right, so a pointer parked
    /// exactly there is a pointer on the neighbour — which on the common layout
    /// is the user's desk.
    public static func clamp(point: CGPoint, to frame: CGRect) -> CGPoint {
        guard frame.width > 0, frame.height > 0 else { return frame.origin }
        let maxX = max(frame.minX, frame.maxX - 1)
        let maxY = max(frame.minY, frame.maxY - 1)
        return CGPoint(
            x: min(max(point.x, frame.minX), maxX),
            y: min(max(point.y, frame.minY), maxY)
        )
    }

    /// Places lane displays in a diagonal chain from an exposed real-screen
    /// corner. The input order is the chain order, usually display creation
    /// order, and the returned placements preserve each display's measured size
    /// and scale.
    ///
    /// Quartz keeps displays that touch at one point, but rejects a gap. It
    /// also lets a pointer cross a shared edge like an ordinary screen edge.
    /// Starting at the lowest, leftmost safe corner puts the chain outside the
    /// real-display union and leaves only a diagonal corner path between it and
    /// the user's screens.
    public static func cornerChainPlacements(
        realDisplayFrames: [CGRect],
        laneDisplayTemplates: [DisplayPlacement],
        obstacleDisplayFrames: [CGRect] = [],
        requiresIntegralOrigins: Bool = false
    ) -> [DisplayPlacement]? {
        let realFrames = realDisplayFrames.filter { $0.width > 0 && $0.height > 0 }
        let obstacles = (realFrames + obstacleDisplayFrames).filter { $0.width > 0 && $0.height > 0 }
        guard !realFrames.isEmpty,
              !laneDisplayTemplates.isEmpty,
              laneDisplayTemplates.allSatisfy({ $0.width > 0 && $0.height > 0 })
        else { return nil }

        let anchors = realFrames.flatMap { frame in
            [
                CornerAnchor(point: CGPoint(x: frame.minX, y: frame.minY), xDirection: -1, yDirection: -1),
                CornerAnchor(point: CGPoint(x: frame.maxX, y: frame.minY), xDirection: 1, yDirection: -1),
                CornerAnchor(point: CGPoint(x: frame.minX, y: frame.maxY), xDirection: -1, yDirection: 1),
                CornerAnchor(point: CGPoint(x: frame.maxX, y: frame.maxY), xDirection: 1, yDirection: 1),
            ]
        }.sorted {
            if $0.point.y != $1.point.y { return $0.point.y > $1.point.y }
            if $0.point.x != $1.point.x { return $0.point.x < $1.point.x }
            if $0.xDirection != $1.xDirection { return $0.xDirection < $1.xDirection }
            return $0.yDirection < $1.yDirection
        }

        for anchor in anchors {
            var edge = anchor.point
            var planned: [DisplayPlacement] = []
            var isSafe = true

            for template in laneDisplayTemplates {
                let x = anchor.xDirection < 0 ? edge.x - template.width : edge.x
                let y = anchor.yDirection < 0 ? edge.y - template.height : edge.y
                guard !requiresIntegralOrigins || (x == x.rounded() && y == y.rounded()) else {
                    isSafe = false
                    break
                }
                let placement = DisplayPlacement(
                    origin: CGPoint(x: x, y: y),
                    width: template.width,
                    height: template.height,
                    scale: template.scale
                )
                guard obstacles.allSatisfy({ !overlapsOrSharesEdge(placement.frame, $0) }) else {
                    isSafe = false
                    break
                }
                planned.append(placement)
                edge = CGPoint(
                    x: edge.x + CGFloat(anchor.xDirection) * template.width,
                    y: edge.y + CGFloat(anchor.yDirection) * template.height
                )
            }

            if isSafe, planned.count == laneDisplayTemplates.count { return planned }
        }
        return nil
    }

    private struct CornerAnchor {
        let point: CGPoint
        let xDirection: Int
        let yDirection: Int
    }

    /// A corner contact is safe; positive-area overlap and any shared edge are
    /// rejected because macOS and the pointer treat both as connected screens.
    private static func overlapsOrSharesEdge(_ first: CGRect, _ second: CGRect) -> Bool {
        let overlapWidth = min(first.maxX, second.maxX) - max(first.minX, second.minX)
        let overlapHeight = min(first.maxY, second.maxY) - max(first.minY, second.minY)
        return overlapWidth >= 0 && overlapHeight >= 0 && (overlapWidth > 0 || overlapHeight > 0)
    }

    /// Cocoa `NSEvent.mouseLocation` is bottom-left of the primary display.
    /// Quartz / `CGEvent` / `CGWarpMouseCursorPosition` is top-left of the
    /// primary. Same x; y flips against the primary's height.
    public static func quartzPoint(fromCocoa cocoa: CGPoint, primaryHeight: CGFloat) -> CGPoint {
        CGPoint(x: cocoa.x, y: primaryHeight - cocoa.y)
    }

    public static func center(of frame: CGRect) -> CGPoint {
        CGPoint(x: frame.midX, y: frame.midY)
    }

    /// True when no part of `frame` overlaps `displayFrame`. What "this window
    /// wandered off its display" means, and the trigger for a re-park.
    public static func isFullyOutside(_ frame: CGRect, of displayFrame: CGRect) -> Bool {
        !frame.intersects(displayFrame)
    }

    /// True when the frame is not wholly inside the display. A window the user
    /// nudged half off still counts as escaped.
    public static func isEscaping(_ frame: CGRect, of displayFrame: CGRect) -> Bool {
        !displayFrame.contains(frame)
    }

    // -----------------------------------------------------------------------
    // The offscreen-region fallback
    // -----------------------------------------------------------------------

    /// Where a lane's windows go when no virtual display could be created.
    ///
    /// Right of the main display's visible frame, past the gap. Reported as
    /// `offscreen-region` rather than dressed up as `virtual`: the windows are
    /// genuinely reachable by a determined user, and a caller that thinks it has
    /// a private screen when it does not will happily type a password onto the
    /// user's desk.
    public static func offscreenOrigin(
        mainVisibleFrame: CGRect,
        gap: CGFloat = Geometry.offscreenGap
    ) -> CGPoint {
        CGPoint(x: mainVisibleFrame.maxX + gap, y: mainVisibleFrame.minY)
    }

    public static func offscreenPlacement(
        mainVisibleFrame: CGRect,
        width: CGFloat,
        height: CGFloat,
        scale: CGFloat,
        gap: CGFloat = Geometry.offscreenGap
    ) -> DisplayPlacement {
        DisplayPlacement(
            origin: offscreenOrigin(mainVisibleFrame: mainVisibleFrame, gap: gap),
            width: width,
            height: height,
            scale: scale
        )
    }

    /// Lays windows out on a placement in a light cascade so that a lane with
    /// several windows does not stack them all on one pixel.
    public static func cascadeFrame(
        index: Int,
        size: CGSize,
        display: DisplayPlacement,
        step: CGFloat = 32
    ) -> CGRect {
        let slot = CGFloat(max(0, index))
        let maxOffsetX = max(0, display.width - size.width)
        let maxOffsetY = max(0, display.height - size.height)
        let offsetX = min(slot * step, maxOffsetX)
        let offsetY = min(slot * step, maxOffsetY)
        return CGRect(
            x: display.origin.x + offsetX,
            y: display.origin.y + offsetY,
            width: size.width,
            height: size.height
        )
    }
}
