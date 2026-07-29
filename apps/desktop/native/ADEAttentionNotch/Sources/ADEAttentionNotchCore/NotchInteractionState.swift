import Foundation

public enum NotchPresentationState: String, Codable, Equatable, Sendable {
    case compact
    case prehover
    case peek
    case expanded
    case attention
    case celebration
}

/// How far the surface is allowed to grow, derived from `NotchSettings` so the
/// interaction machine never has to know about the whole settings payload.
///
/// The default is the shipped behaviour, which is also what every call site
/// gets when it does not pass a policy — an older caller cannot change how the
/// surface behaves just by not knowing about this type.
public struct NotchPresentationPolicy: Equatable, Sendable {
    public let revealMode: NotchRevealMode
    public let expandedPanelEnabled: Bool

    public static let `default` = NotchPresentationPolicy()

    public init(revealMode: NotchRevealMode = .hover, expandedPanelEnabled: Bool = true) {
        self.revealMode = revealMode
        self.expandedPanelEnabled = expandedPanelEnabled
    }

    public init(settings: NotchSettings) {
        self.init(
            revealMode: settings.revealMode,
            expandedPanelEnabled: settings.expandedPanelEnabled
        )
    }

    /// Only hover mode lets the pointer alone open the peek.
    public var allowsHoverReveal: Bool { revealMode == .hover }

    /// All three user-selectable modes are manual. In particular, "Reveal on
    /// hover" is literal: a needs-you update may change notification/status
    /// state, but it cannot make the hidden surface appear by itself.
    public var allowsAutomaticReveal: Bool { false }

    /// Compact mode never grows past a short peek. Other modes may open the
    /// tall panel unless the user disabled it globally.
    public var clickPresentation: NotchPresentationState {
        revealMode == .minimal || !expandedPanelEnabled ? .peek : .expanded
    }
}

/// Hover mode contributes no visible chrome while resting. The helper process
/// and interaction state remain alive so a bounded hot zone can reveal it.
public func notchSurfaceIsDormant(
    presentation: NotchPresentationState,
    revealMode: NotchRevealMode
) -> Bool {
    revealMode == .hover && presentation == .compact
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
    public mutating func pointerEntered(
        hasItems: Bool,
        policy: NotchPresentationPolicy = .default
    ) -> UInt64 {
        generation &+= 1
        guard policy.allowsHoverReveal, isVisible, hasItems, presentation != .celebration else {
            return generation
        }
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

    public mutating func explicitToggle(
        hasItems: Bool,
        policy: NotchPresentationPolicy = .default
    ) {
        generation &+= 1
        guard isVisible, hasItems else { return }
        let opened = policy.clickPresentation
        // A second click closes what the first one opened. A peek the pointer
        // opened is not "open", so clicking through a hover still latches.
        if presentation == opened, isExplicitlyInteractive {
            presentation = .compact
            isExplicitlyInteractive = false
        } else {
            presentation = opened
            isExplicitlyInteractive = true
        }
    }

    public mutating func setAttention(policy: NotchPresentationPolicy = .default) {
        generation &+= 1
        guard isVisible, policy.allowsAutomaticReveal else { return }
        presentation = .attention
    }

    public mutating func setCelebration(policy: NotchPresentationPolicy = .default) {
        generation &+= 1
        guard isVisible, policy.allowsAutomaticReveal else { return }
        presentation = .celebration
    }

    public mutating func finishTransient(
        pointerInside: Bool,
        policy: NotchPresentationPolicy = .default
    ) {
        generation &+= 1
        // Settling under a pointer that is not allowed to reveal anything has
        // to land on compact, not on the peek hover never opened.
        presentation = (pointerInside && policy.allowsHoverReveal) ? .peek : .compact
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

    /// Brings whatever is already on screen in line with a policy the user just
    /// changed. Turning the tall panel off while it is open has to close it —
    /// otherwise the setting appears not to work until the next interaction.
    public mutating func applyPolicy(_ policy: NotchPresentationPolicy) {
        generation &+= 1
        if isExplicitlyInteractive {
            // The user opened this themselves; only a now-forbidden size is
            // corrected, and it steps down rather than vanishing under them.
            if presentation == .expanded, policy.clickPresentation != .expanded {
                presentation = policy.clickPresentation
            }
            return
        }
        switch presentation {
        case .compact, .expanded:
            presentation = .compact
        case .prehover, .peek:
            if !policy.allowsHoverReveal { presentation = .compact }
        case .attention, .celebration:
            if !policy.allowsAutomaticReveal { presentation = .compact }
        }
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

/// Height of the menu-bar band the hardware notch lives in. The surface's top
/// `band` points sit *inside* that strip, so compact ends exactly on the
/// hardware notch's bottom edge and expanded content starts just below it.
public func notchMenuBarBandHeight(safeAreaTop: Double) -> Double {
    max(24, min(48, safeAreaTop))
}

/// Invisible but bounded target used only while hover mode is dormant.
/// Physical displays get 44pt on each side of the cutout, enough to enter
/// deliberately without covering the whole menu bar. Floating fallback
/// surfaces primarily use their real status-item frame and retain this small
/// centered target as a safety net.
public func notchHoverHotZoneSize(
    physicalNotchWidth: Double?,
    safeAreaTop: Double = 0
) -> NotchSize {
    guard let physicalNotchWidth else {
        return NotchSize(width: 96, height: 34)
    }
    return NotchSize(
        width: clampedNotchWidth(physicalNotchWidth) + 88,
        height: notchMenuBarBandHeight(safeAreaTop: safeAreaTop) + 8
    )
}

/// Guards against a display reporting an implausible cutout width.
private func clampedNotchWidth(_ width: Double) -> Double {
    max(140, min(240, width))
}

public func notchSurfaceSize(
    presentation: NotchPresentationState,
    physicalNotchWidth: Double?,
    safeAreaTop: Double = 0
) -> NotchSize {
    guard let physicalNotchWidth else {
        switch presentation {
        case .compact: return NotchSize(width: 272, height: 34)
        case .prehover: return NotchSize(width: 282, height: 38)
        case .peek: return NotchSize(width: 316, height: 76)
        case .expanded: return NotchSize(width: 396, height: 232)
        case .attention: return NotchSize(width: 336, height: 130)
        case .celebration: return NotchSize(width: 352, height: 150)
        }
    }

    let notch = clampedNotchWidth(physicalNotchWidth)
    let band = notchMenuBarBandHeight(safeAreaTop: safeAreaTop)
    // Each compact ear gets ~105pt beside the cutout: enough to hold the
    // longest phase label with its elapsed time ("Checks failing  22m") without
    // truncating, and no wider.
    let compactWidth = max(364, notch + 224)
    // Every state is at least as wide as compact: growing into a hover or a
    // click must never make the surface jump inwards.
    switch presentation {
    case .compact:
        return NotchSize(width: compactWidth, height: band)
    case .prehover:
        return NotchSize(width: compactWidth + 10, height: band + 6)
    case .peek:
        return NotchSize(width: compactWidth + 10, height: band + 62)
    case .expanded:
        return NotchSize(width: max(400, compactWidth + 10), height: band + 232)
    case .attention:
        return NotchSize(width: max(384, compactWidth + 10), height: band + 126)
    case .celebration:
        return NotchSize(width: max(376, compactWidth), height: band + 124)
    }
}

/// Corner radii for the surface outline.
///
/// With a physical notch the top edge is flush with the top of the display and
/// square, so the surface's black merges into the hardware cutout and reads as
/// one wider notch. Rounding the top, or starting the ears below the display
/// edge, is what makes the cutout look bitten out of a floating slab.
public struct NotchSurfaceCorners: Equatable, Sendable {
    public let top: Double
    public let bottom: Double

    public init(top: Double, bottom: Double) {
        self.top = top
        self.bottom = bottom
    }
}

public func notchSurfaceCorners(
    presentation: NotchPresentationState,
    hasPhysicalNotch: Bool,
    size: NotchSize
) -> NotchSurfaceCorners {
    guard hasPhysicalNotch else {
        // Free-floating pill under the menu bar: --radius-xl, capsule when short.
        let radius = min(16, size.height / 2)
        return NotchSurfaceCorners(top: radius, bottom: radius)
    }
    switch presentation {
    case .compact, .prehover:
        return NotchSurfaceCorners(top: 0, bottom: min(12, size.height * 0.34))
    case .peek, .expanded, .attention, .celebration:
        return NotchSurfaceCorners(top: 0, bottom: 20)
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
