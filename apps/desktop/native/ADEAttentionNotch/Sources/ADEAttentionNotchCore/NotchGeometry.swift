import Foundation

public struct NotchRect: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var maxX: Double { x + width }
    public var maxY: Double { y + height }
    public var midX: Double { x + width / 2 }
}

public struct NotchDisplayGeometry: Equatable, Sendable {
    /// The transparent host every surface state is drawn into, top-aligned.
    /// Sized for the tallest state (the scrollable expanded panel at 440pt of
    /// surface below the menu-bar band) with room to spare, so growing a state
    /// never needs a second window. Verified against a 13" MacBook's 1440×900
    /// by `NotchGeometryTests.testExpandedSurfaceFitsUnderA13InchMenuBar`.
    public static let panelSize = NotchSize(width: 760, height: 640)

    public let displayId: UInt32
    public let frame: NotchRect
    public let visibleFrame: NotchRect
    public let safeAreaTop: Double
    public let auxiliaryLeft: NotchRect?
    public let auxiliaryRight: NotchRect?
    public let isBuiltIn: Bool

    public init(
        displayId: UInt32,
        frame: NotchRect,
        visibleFrame: NotchRect,
        safeAreaTop: Double,
        auxiliaryLeft: NotchRect?,
        auxiliaryRight: NotchRect?,
        isBuiltIn: Bool
    ) {
        self.displayId = displayId
        self.frame = frame
        self.visibleFrame = visibleFrame
        self.safeAreaTop = safeAreaTop
        self.auxiliaryLeft = auxiliaryLeft
        self.auxiliaryRight = auxiliaryRight
        self.isBuiltIn = isBuiltIn
    }

    public var hasPhysicalNotch: Bool {
        guard isBuiltIn, safeAreaTop >= 22 else { return false }
        guard let auxiliaryLeft, let auxiliaryRight else { return false }
        return auxiliaryRight.x - auxiliaryLeft.maxX >= 80
    }

    public var physicalNotchWidth: Double? {
        guard hasPhysicalNotch, let auxiliaryLeft, let auxiliaryRight else { return nil }
        return auxiliaryRight.x - auxiliaryLeft.maxX
    }

    public var panelFrame: NotchRect {
        let x = frame.x + (frame.width - Self.panelSize.width) / 2
        let anchorY = hasPhysicalNotch
            ? frame.maxY
            : min(frame.maxY - 4, visibleFrame.maxY - 6)
        return NotchRect(
            x: x,
            y: anchorY - Self.panelSize.height,
            width: Self.panelSize.width,
            height: Self.panelSize.height
        )
    }
}

/// The physical cutout is itself the resting surface. A Mac without one uses
/// the status item as its resting surface and only creates visible panel chrome
/// after a hover, click, or allowed transient changes the presentation.
public func notchPanelShouldShow(
    surfaceEnabled: Bool,
    hasPhysicalNotch: Bool,
    presentation: NotchPresentationState
) -> Bool {
    surfaceEnabled && (hasPhysicalNotch || presentation != .compact)
}

/// Positions the transparent hosting panel so its visible surface is directly
/// beneath the menu-bar item. The surface center is clamped (instead of the
/// much wider transparent panel) so expanded content cannot run off either
/// display edge, while the panel's top always remains below the menu bar.
public func menuBarAnchoredPanelFrame(
    statusItemFrame: NotchRect,
    displayFrame: NotchRect,
    surfaceSize: NotchSize,
    panelSize: NotchSize = NotchDisplayGeometry.panelSize,
    edgeMargin: Double = 8,
    menuBarGap: Double = 4
) -> NotchRect {
    let halfSurfaceWidth = min(surfaceSize.width, displayFrame.width) / 2
    let minimumCenter = displayFrame.x + edgeMargin + halfSurfaceWidth
    let maximumCenter = displayFrame.maxX - edgeMargin - halfSurfaceWidth
    let unclampedCenter = statusItemFrame.midX
    let centerX = minimumCenter <= maximumCenter
        ? min(max(unclampedCenter, minimumCenter), maximumCenter)
        : displayFrame.midX
    let top = min(statusItemFrame.y - menuBarGap, displayFrame.maxY - menuBarGap)

    return NotchRect(
        x: centerX - panelSize.width / 2,
        y: top - panelSize.height,
        width: panelSize.width,
        height: panelSize.height
    )
}
