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

    /// The refusal for a background point off the lane's display.
    ///
    /// Points are global, and a lane's display usually sits far from (0,0),
    /// so a point read off the screenshot is off the display. The refusal
    /// names the display's global range, and the global point a display-local
    /// one most likely meant, so the caller can fix the call without guessing.
    public static func offDisplayRefusal(point: CGPoint, display: DisplayPlacement) -> String {
        let frame = display.frame
        let left = Int(frame.minX.rounded()), right = Int(frame.maxX.rounded())
        let top = Int(frame.minY.rounded()), bottom = Int(frame.maxY.rounded())
        var message = "(\(Int(point.x)), \(Int(point.y))) is not on this lane's display, which is x \(left)..\(right), y \(top)..\(bottom) in global points; background input only reaches the lane's own windows."
        let looksLocal = point.x >= 0 && point.y >= 0
            && point.x < display.width && point.y < display.height
            && (left != 0 || top != 0)
        if looksLocal {
            let global = toGlobal(point: point, display: display)
            message += " Points are global, not screenshot pixels: (\(Int(point.x)), \(Int(point.y))) on this display is (\(Int(global.x)), \(Int(global.y))); or pass --local."
        }
        return message
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
                guard obstacles.allSatisfy({ !pointerCanCross(placement.frame, $0) }) else {
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

    /// The real displays a pointer cannot reach from the main display without
    /// crossing something else, by index into `realDisplayFrames`.
    ///
    /// The pointer only crosses a shared edge, so two real displays are
    /// neighbours when they share one (or overlap, as a mirror set does); a
    /// corner contact does not count. A display outside the main display's
    /// group is cut off: the person can reach it only through a lane display,
    /// which the pointer fence keeps them out of. That is the AirPlay trap:
    /// macOS puts a newly connected display beside a lane display, or restores
    /// an arrangement it remembered with one.
    public static func cutOffRealDisplays(realDisplayFrames: [CGRect], mainIndex: Int) -> [Int] {
        guard realDisplayFrames.indices.contains(mainIndex) else { return [] }
        let reached = connectedGroup(from: mainIndex, frames: realDisplayFrames)
        return realDisplayFrames.indices.filter { !reached.contains($0) }
    }

    /// The real display frames with every cut-off group moved flush against
    /// the main display's group, so each one shares an edge with a real
    /// display again. The same order as the input; a frame that did not need
    /// to move is returned unchanged. Nil when a cut-off group fits nowhere.
    ///
    /// A group keeps its own internal arrangement and moves as one. It goes to
    /// the side of a reachable display it was already on, keeping its offset
    /// along that edge where it can, and always overlapping at least half of
    /// the shorter of the two edges so the crossing is easy to hit. It never
    /// lands on an obstacle: another ADE helper's lane display, which that
    /// helper does not re-plan on this one's say-so. Integral frames give
    /// integral moves, which is what the window server takes.
    public static func reconnectedRealDisplayFrames(
        realDisplayFrames: [CGRect],
        mainIndex: Int,
        obstacleDisplayFrames: [CGRect] = []
    ) -> [CGRect]? {
        guard realDisplayFrames.indices.contains(mainIndex) else { return nil }
        var frames = realDisplayFrames
        var reached = connectedGroup(from: mainIndex, frames: frames)

        while reached.count < frames.count {
            guard let start = frames.indices.first(where: { !reached.contains($0) }) else { break }
            let group = connectedGroup(from: start, frames: frames)
            let groupBox = group.map { frames[$0] }.reduce(CGRect.null) { $0.union($1) }
            let anchors = reached.sorted {
                let lhs = squaredGap(frames[$0], groupBox)
                let rhs = squaredGap(frames[$1], groupBox)
                return lhs != rhs ? lhs < rhs : $0 < $1
            }
            var shift: CGVector?
            search: for anchor in anchors {
                for side in sidesFacing(groupBox, from: frames[anchor]) {
                    let offset = flushOffset(moving: groupBox, against: frames[anchor], side: side)
                    let fits = group.allSatisfy { index in
                        let moved = frames[index].offsetBy(dx: offset.dx, dy: offset.dy)
                        return reached.allSatisfy { !overlapsWithArea(moved, frames[$0]) }
                            && obstacleDisplayFrames.allSatisfy { !overlapsWithArea(moved, $0) }
                    }
                    if fits {
                        shift = offset
                        break search
                    }
                }
            }
            guard let shift else { return nil }
            for index in group {
                frames[index] = frames[index].offsetBy(dx: shift.dx, dy: shift.dy)
            }
            reached = connectedGroup(from: mainIndex, frames: frames)
            guard group.isSubset(of: reached) else { return nil }
        }
        return frames
    }

    /// The lane displays the pointer fence must let a person cross, by index
    /// into `laneDisplayFrames`: each one that shares an edge with a cut-off
    /// real display, and every lane display joined to those by shared edges.
    /// Empty whenever every real display is reachable, which is the normal
    /// case once the placement pass has run.
    public static func laneDisplaysOnRouteToCutOffRealDisplays(
        realDisplayFrames: [CGRect],
        mainIndex: Int,
        laneDisplayFrames: [CGRect]
    ) -> Set<Int> {
        let cutOff = cutOffRealDisplays(realDisplayFrames: realDisplayFrames, mainIndex: mainIndex)
        guard !cutOff.isEmpty else { return [] }
        var route = Set(laneDisplayFrames.indices.filter { lane in
            cutOff.contains { pointerCanCross(laneDisplayFrames[lane], realDisplayFrames[$0]) }
        })
        var queue = Array(route)
        while let current = queue.popLast() {
            for next in laneDisplayFrames.indices where !route.contains(next)
                && pointerCanCross(laneDisplayFrames[current], laneDisplayFrames[next]) {
                route.insert(next)
                queue.append(next)
            }
        }
        return route
    }

    private enum Side { case left, right, above, below }

    private static func connectedGroup(from start: Int, frames: [CGRect]) -> Set<Int> {
        var reached: Set<Int> = [start]
        var queue = [start]
        while let current = queue.popLast() {
            for next in frames.indices where !reached.contains(next)
                && pointerCanCross(frames[current], frames[next]) {
                reached.insert(next)
                queue.append(next)
            }
        }
        return reached
    }

    /// The sides of `anchor` to try for `box`, the side it already lies on first.
    private static func sidesFacing(_ box: CGRect, from anchor: CGRect) -> [Side] {
        let dx = box.midX - anchor.midX
        let dy = box.midY - anchor.midY
        let horizontal: [Side] = dx >= 0 ? [.right, .left] : [.left, .right]
        let vertical: [Side] = dy >= 0 ? [.below, .above] : [.above, .below]
        return abs(dx) >= abs(dy) ? horizontal + vertical : vertical + horizontal
    }

    private static func flushOffset(moving box: CGRect, against anchor: CGRect, side: Side) -> CGVector {
        switch side {
        case .left, .right:
            let x = side == .right ? anchor.maxX : anchor.minX - box.width
            let y = clampedAlong(box.minY, length: box.height, edgeStart: anchor.minY, edgeLength: anchor.height)
            return CGVector(dx: x - box.minX, dy: y - box.minY)
        case .above, .below:
            let y = side == .below ? anchor.maxY : anchor.minY - box.height
            let x = clampedAlong(box.minX, length: box.width, edgeStart: anchor.minX, edgeLength: anchor.width)
            return CGVector(dx: x - box.minX, dy: y - box.minY)
        }
    }

    /// Keeps `start` where it is when the span already overlaps the edge by
    /// half the shorter length, otherwise slides it just far enough.
    private static func clampedAlong(
        _ start: CGFloat,
        length: CGFloat,
        edgeStart: CGFloat,
        edgeLength: CGFloat
    ) -> CGFloat {
        let overlap = (min(length, edgeLength) / 2).rounded(.up)
        let lowest = edgeStart - length + overlap
        let highest = edgeStart + edgeLength - overlap
        return min(max(start, lowest), highest)
    }

    private static func overlapsWithArea(_ first: CGRect, _ second: CGRect) -> Bool {
        let overlapWidth = min(first.maxX, second.maxX) - max(first.minX, second.minX)
        let overlapHeight = min(first.maxY, second.maxY) - max(first.minY, second.minY)
        return overlapWidth > 0 && overlapHeight > 0
    }

    private static func squaredGap(_ first: CGRect, _ second: CGRect) -> CGFloat {
        let dx = max(0, max(first.minX, second.minX) - min(first.maxX, second.maxX))
        let dy = max(0, max(first.minY, second.minY) - min(first.maxY, second.maxY))
        return dx * dx + dy * dy
    }

    /// True when a person's pointer can move between the two rects: they share
    /// an edge of positive length, or overlap (a mirror set). A corner contact
    /// is not a route: only a hard diagonal push crosses it. So lane displays
    /// may touch real ones at a corner, and a real display touching the
    /// others only at a corner counts as cut off.
    public static func pointerCanCross(_ first: CGRect, _ second: CGRect) -> Bool {
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
