import Foundation

public enum NotchPresentationState: String, Codable, Equatable, Sendable {
    case compact
    case prehover
    case peek
    case expanded
    case attention
    case celebration
}

public struct NotchSize: Equatable, Sendable {
    public let width: Double
    public let height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

public struct NotchInteractionState: Equatable, Sendable {
    public private(set) var presentation: NotchPresentationState = .compact
    public private(set) var generation: UInt64 = 0
    public private(set) var selectedIndex: Int = 0
    public private(set) var isVisible = true
    public private(set) var isExplicitlyInteractive = false

    public init() {}

    @discardableResult
    public mutating func pointerEntered(hasItems: Bool) -> UInt64 {
        generation &+= 1
        guard isVisible, hasItems, presentation != .celebration else { return generation }
        if presentation == .compact {
            presentation = .prehover
        }
        return generation
    }

    public mutating func applyPeek(generation token: UInt64, pointerInside: Bool) {
        guard token == generation, pointerInside, isVisible, presentation == .prehover else { return }
        presentation = .peek
    }

    @discardableResult
    public mutating func pointerExited() -> UInt64 {
        generation &+= 1
        if isExplicitlyInteractive {
            return generation
        }
        if presentation != .attention && presentation != .celebration {
            presentation = .compact
        }
        return generation
    }

    public mutating func explicitToggle(hasItems: Bool) {
        generation &+= 1
        guard isVisible, hasItems else { return }
        if presentation == .expanded {
            presentation = .compact
            isExplicitlyInteractive = false
        } else {
            presentation = .expanded
            isExplicitlyInteractive = true
        }
    }

    public mutating func setAttention() {
        generation &+= 1
        guard isVisible else { return }
        presentation = .attention
    }

    public mutating func setCelebration() {
        generation &+= 1
        guard isVisible else { return }
        presentation = .celebration
    }

    public mutating func finishTransient(pointerInside: Bool) {
        generation &+= 1
        presentation = pointerInside ? .peek : .compact
    }

    public mutating func navigate(delta: Int, itemCount: Int) {
        guard itemCount > 0 else {
            selectedIndex = 0
            return
        }
        selectedIndex = (selectedIndex + delta % itemCount + itemCount) % itemCount
    }

    public mutating func select(index: Int, itemCount: Int) {
        guard itemCount > 0 else {
            selectedIndex = 0
            return
        }
        selectedIndex = min(max(0, index), itemCount - 1)
    }

    public mutating func clampSelection(itemCount: Int) {
        selectedIndex = itemCount == 0 ? 0 : min(selectedIndex, itemCount - 1)
    }

    public mutating func setVisible(_ visible: Bool) {
        generation &+= 1
        isVisible = visible
        if !visible {
            presentation = .compact
            isExplicitlyInteractive = false
        }
    }

    public mutating func dismissExplicitInteraction() {
        generation &+= 1
        isExplicitlyInteractive = false
        presentation = .compact
    }

}

private let phasePriorities: [String: Int] = [
    "needs_you": 0,
    "failed": 1,
    "checks_failing": 1,
    "changes_requested": 1,
    "review_requested": 2,
    "merge_ready": 2,
    "blocked": 2,
    "starting": 3,
    "running": 3,
    "open": 4,
    "stale": 4,
    "completed": 5,
    "merged": 5,
    "closed": 6,
]

public func sortedAttentionItems(_ items: [AttentionItem]) -> [AttentionItem] {
    items
        .filter { $0.dismissedAt == nil }
        .sorted { left, right in
            let leftPriority = phasePriorities[left.phase] ?? 99
            let rightPriority = phasePriorities[right.phase] ?? 99
            if leftPriority != rightPriority { return leftPriority < rightPriority }
            if left.updatedAt != right.updatedAt { return left.updatedAt > right.updatedAt }
            return left.id < right.id
        }
}

public func notchSurfaceSize(
    presentation: NotchPresentationState,
    physicalNotchWidth: Double?,
    safeAreaTop: Double = 0
) -> NotchSize {
    guard let physicalNotchWidth else {
        switch presentation {
        case .compact: return NotchSize(width: 260, height: 38)
        case .prehover: return NotchSize(width: 276, height: 43)
        case .peek: return NotchSize(width: 320, height: 82)
        case .expanded: return NotchSize(width: 414, height: 284)
        case .attention: return NotchSize(width: 352, height: 136)
        case .celebration: return NotchSize(width: 372, height: 180)
        }
    }

    let base = max(150, min(230, physicalNotchWidth))
    let reservedTop = max(0, min(64, safeAreaTop))
    switch presentation {
    case .compact:
        return NotchSize(width: max(388, base + 208), height: max(38, reservedTop))
    case .prehover:
        return NotchSize(width: max(400, base + 220), height: max(44, reservedTop + 8))
    case .peek:
        return NotchSize(width: max(404, base + 224), height: 82 + reservedTop)
    case .expanded:
        return NotchSize(width: 414, height: 284 + reservedTop)
    case .attention:
        return NotchSize(width: max(390, base + 210), height: 136 + reservedTop)
    case .celebration:
        return NotchSize(width: max(392, base + 212), height: 180 + reservedTop)
    }
}

public func attentionElapsedLabel(since value: String, now: Date = Date()) -> String {
    guard let date = parseAttentionDate(value) else { return "now" }
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    if seconds < 5 { return "now" }
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3_600 { return "\(seconds / 60)m" }
    return "\(seconds / 3_600)h \(seconds % 3_600 / 60)m"
}

public func parseAttentionDate(_ value: String) -> Date? {
    if let date = attentionISO8601WithFractionalSeconds.date(from: value) {
        return date
    }
    return attentionISO8601.date(from: value)
}

private let attentionISO8601WithFractionalSeconds: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

private let attentionISO8601: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()
