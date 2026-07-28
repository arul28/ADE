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
}

public struct NotchDisplayGeometry: Equatable, Sendable {
    public static let panelSize = NotchSize(width: 720, height: 460)

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
