import Foundation

/// Four states, and only four.
///
/// `prehover` and `peek` are gone with the mode sprawl they belonged to: hover
/// no longer grows anything, so there is nothing between the strip and the
/// panel, and the one-item peek card a click used to open was a menu with a
/// single entry.
public enum NotchPresentationState: String, Codable, Equatable, Sendable {
    /// The strip. The only resting state, identical in both reveal modes.
    case compact
    /// The full panel, which only ever a click opens.
    case expanded
    /// A timed takeover — the needs-you card and its siblings. Auto-dismisses
    /// by morphing back into its glyph in the strip.
    case flash
    /// A merge, celebrated once and then settled.
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

    public init(
        revealMode: NotchRevealMode = .hover,
        expandedPanelEnabled: Bool = true
    ) {
        self.revealMode = revealMode
        self.expandedPanelEnabled = expandedPanelEnabled
    }

    public init(settings: NotchSettings) {
        self.init(
            revealMode: settings.revealMode,
            expandedPanelEnabled: settings.expandedPanelEnabled
        )
    }

    /// Hover mode reveals the strip the pointer entered; it never grows it.
    /// The bulge that answers the pointer is drawn feedback, not a state, and
    /// runs identically in both modes.
    public var revealsOnHover: Bool { revealMode == .hover }

    /// Whether a click grows the surface here. When the user has turned the
    /// tall panel off, the click routes to ADE instead — a surface that eats
    /// clicks and does nothing is the one outcome no mode may produce.
    public var clickOpensPanel: Bool { expandedPanelEnabled }
}

/// Hover mode contributes no visible chrome while resting. The helper process
/// and interaction state remain alive so a bounded hot zone can reveal it.
///
/// Load-bearing that this is keyed on the *pointer*, not on a second
/// presentation state: the revealed strip has to be the same `compact` rect the
/// pinned mode draws, or the two modes look like two different features again.
public func notchSurfaceIsDormant(
    presentation: NotchPresentationState,
    revealMode: NotchRevealMode,
    pointerInside: Bool
) -> Bool {
    revealMode == .hover && presentation == .compact && !pointerInside
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
    /// Tracked here rather than only in the view model because dormancy — the
    /// one thing hover mode does differently — is a function of it.
    public private(set) var pointerInside = false

    public init() {}

    /// Hover reveals; it never grows. In `always` the strip is already there,
    /// so entering it changes nothing but the bulge the view draws.
    ///
    /// Deliberately takes no policy and no item count: neither mode grows on
    /// hover and an empty strip still reveals, so a parameter here would only
    /// be a promise this function does not keep.
    @discardableResult
    public mutating func pointerEntered() -> UInt64 {
        generation &+= 1
        guard isVisible else { return generation }
        pointerInside = true
        return generation
    }

    @discardableResult
    public mutating func pointerExited() -> UInt64 {
        generation &+= 1
        pointerInside = false
        if isExplicitlyInteractive {
            return generation
        }
        // A takeover owns the surface for its own timer; the pointer leaving is
        // not an answer to it.
        if presentation != .flash && presentation != .celebration {
            presentation = .compact
        }
        return generation
    }

    /// Returns whether the panel actually opened, so a click the policy refuses
    /// to grow can be routed to ADE instead of silently doing nothing.
    @discardableResult
    public mutating func explicitToggle(
        hasItems: Bool,
        policy: NotchPresentationPolicy = .default
    ) -> Bool {
        generation &+= 1
        guard isVisible, hasItems, policy.clickOpensPanel else { return false }
        // A second click closes what the first one opened. A takeover the user
        // clicks through is not "open", so clicking one still latches the panel.
        if presentation == .expanded, isExplicitlyInteractive {
            presentation = .compact
            isExplicitlyInteractive = false
            return false
        }
        presentation = .expanded
        isExplicitlyInteractive = true
        return true
    }

    /// A timed takeover. Unlike the state it replaces this is never gated on a
    /// reveal mode: both modes are about where the strip rests, and an event
    /// that needs you is not a resting state. That is why none of the three
    /// takeover transitions takes a policy — passing one would imply a mode can
    /// suppress the news, which is the behaviour they exist to prevent.
    public mutating func setFlash() {
        generation &+= 1
        guard isVisible, !isExplicitlyInteractive else { return }
        presentation = .flash
    }

    public mutating func setCelebration() {
        generation &+= 1
        guard isVisible, !isExplicitlyInteractive else { return }
        presentation = .celebration
    }

    /// A takeover always settles back to the strip — which, under a pointer in
    /// hover mode, is a strip that stays revealed.
    public mutating func finishTransient(pointerInside: Bool) {
        generation &+= 1
        self.pointerInside = pointerInside
        presentation = .compact
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
            pointerInside = false
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
        if presentation == .expanded, !policy.clickOpensPanel {
            presentation = .compact
            isExplicitlyInteractive = false
            return
        }
        // Switching reveal mode never changes what is drawn: both modes draw
        // the identical strip, and only visibility at rest differs.
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
///
/// Strictly inside the revealed strip's own rect, in both axes. A hot zone that
/// poked out past the strip made the pointer oscillate between "revealed" and
/// "dormant" along that sliver, which reads as the notch flickering at you.
public func notchHoverHotZoneSize(
    physicalNotchWidth: Double?,
    safeAreaTop: Double = 0
) -> NotchSize {
    guard let physicalNotchWidth else {
        return NotchSize(width: 96, height: 30)
    }
    return NotchSize(
        width: clampedNotchWidth(physicalNotchWidth) + 88,
        height: notchMenuBarBandHeight(safeAreaTop: safeAreaTop)
    )
}

/// Guards against a display reporting an implausible cutout width.
private func clampedNotchWidth(_ width: Double) -> Double {
    max(140, min(240, width))
}

/// Smallest and largest an ear may get. The floor keeps the strip from
/// collapsing into the cutout when the account is quiet; the ceiling is what
/// stops a long signal from spreading the surface across the menu bar.
private let notchEarMinimumWidth: Double = 58
private let notchEarMaximumWidth: Double = 150
/// Outer margin plus the gap that keeps content off the hardware cutout.
private let notchEarPadding: Double = 18

/// The width one ear needs for the content it carries.
public func notchCompactEarWidth(_ metrics: NotchStripMetrics) -> Double {
    max(
        notchEarMinimumWidth,
        min(notchEarMaximumWidth, metrics.widest + notchEarPadding)
    )
}

public func notchSurfaceSize(
    presentation: NotchPresentationState,
    physicalNotchWidth: Double?,
    safeAreaTop: Double = 0,
    strip: NotchStripMetrics = .empty
) -> NotchSize {
    let ear = notchCompactEarWidth(strip)

    guard let physicalNotchWidth else {
        // No cutout to sit around: the pill only needs its own content, one gap
        // between the wings, and its horizontal padding.
        let floating = max(
            210,
            min(520, strip.leadingWidth + strip.trailingWidth + 60)
        )
        switch presentation {
        case .compact:
            return NotchSize(width: floating, height: 34)
        case .expanded:
            return NotchSize(width: max(420, floating), height: 452)
        case .flash:
            return NotchSize(width: max(392, floating), height: 92)
        case .celebration:
            return NotchSize(width: max(372, floating), height: 138)
        }
    }

    let notch = clampedNotchWidth(physicalNotchWidth)
    let band = notchMenuBarBandHeight(safeAreaTop: safeAreaTop)
    // Symmetric by construction: the cutout is centered on the display and so
    // is the panel, so the wider wing sets both ears. Content-derived rather
    // than the old flat `notch + 224`, which padded every strip out to the
    // width of the longest label it could ever hold.
    let compactWidth = notch + 2 * ear
    // Every state is at least as wide as compact: growing on a click must never
    // make the surface jump inwards.
    switch presentation {
    case .compact:
        return NotchSize(width: compactWidth, height: band)
    case .expanded:
        return NotchSize(width: max(430, compactWidth), height: band + 452)
    case .flash:
        return NotchSize(width: max(400, compactWidth), height: band + 90)
    case .celebration:
        return NotchSize(width: max(380, compactWidth), height: band + 132)
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
    case .compact:
        return NotchSurfaceCorners(top: 0, bottom: min(12, size.height * 0.34))
    case .expanded, .flash, .celebration:
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
