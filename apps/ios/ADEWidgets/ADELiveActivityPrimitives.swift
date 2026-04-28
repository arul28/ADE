import AppIntents
import SwiftUI
import WidgetKit

/// Reusable SwiftUI primitives for the Live Activity, home widgets, lock-
/// screen accessories, and in-app Attention Drawer.
///
/// Ported from the mockup JSX set under
/// `/tmp/ade-design/extracted/ade-ios-widgets/project/{surfaces,dynamic-island,
/// lock-activity}.jsx`. See `docs/plans/i-made-these-mockups-purrfect-ocean.md`
/// for the surface-by-surface map.
///
/// The file is compiled into both the main app target and the `ADEWidgets`
/// extension, so every public type is usable from either side. Brand colors
/// must be pulled from `ADESharedTheme` — no hex strings should appear here.

// MARK: - BrandDot

/// Circle filled with the provider's brand color, with an inner radial glow
/// and an optional phased halo pulse (used for "this session is active" or
/// "this session is waiting on you").
///
/// Mockup reference: `surfaces.jsx` lines 186–211.
@available(iOS 17.0, *)
public struct BrandDot: View {
    public let slug: String
    public let size: CGFloat
    public let pulse: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(slug: String, size: CGFloat = 12, pulse: Bool = false) {
        self.slug = slug
        self.size = size
        self.pulse = pulse
    }

    public var body: some View {
        let color = ADESharedTheme.brandColor(for: slug)
        ZStack {
            if pulse && !reduceMotion {
                Circle()
                    .fill(color)
                    .frame(width: size, height: size)
                    .phaseAnimator([0, 1]) { circle, phase in
                        circle
                            .scaleEffect(phase == 0 ? 1.0 : 1.4)
                            .opacity(phase == 0 ? 0.35 : 0)
                    } animation: { _ in
                        .easeInOut(duration: 1.4)
                    }
            }
            Circle()
                .fill(color)
                .frame(width: size, height: size)
                .shadow(color: color.opacity(0.4), radius: size * 0.6 * 0.5, x: 0, y: 0)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - StackedBrandDots

/// Horizontal stack of up to 3 brand dots with a 1.5pt black ring around each,
/// using negative spacing so the dots overlap shingle-style.
///
/// Mockup reference: `surfaces.jsx` lines 213–224.
@available(iOS 17.0, *)
public struct StackedBrandDots: View {
    public let slugs: [String]
    public let size: CGFloat

    public init(slugs: [String], size: CGFloat = 12) {
        self.slugs = slugs
        self.size = size
    }

    public var body: some View {
        HStack(spacing: -size * 0.45) {
            ForEach(Array(slugs.prefix(3).enumerated()), id: \.offset) { _, slug in
                BrandDot(slug: slug, size: size)
                    .overlay(
                        Circle()
                            .stroke(Color.black, lineWidth: 1.5)
                    )
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - AttentionKind helpers

/// Typealias so primitives don't leak the nested path everywhere. Mirrors the
/// 5-case enum from `ADESessionAttributes.ContentState.Attention.Kind`.
@available(iOS 17.0, *)
public typealias AttentionKind = ADESessionAttributes.ContentState.Attention.Kind

@available(iOS 17.0, *)
public enum AttentionIcon {
    /// SF Symbol name for an attention kind, matching the mockup's `ATTN` map.
    public static func symbol(for kind: AttentionKind) -> String {
        switch kind {
        case .awaitingInput:   return "bell.badge.fill"
        case .failed:          return "xmark.octagon.fill"
        case .ciFailing:       return "exclamationmark.triangle.fill"
        case .reviewRequested: return "eye.fill"
        case .mergeReady:      return "checkmark.seal.fill"
        }
    }

    /// Semantic tint used on the badge ring, action primary button, etc.
    /// Matches the `STATUS` palette in `surfaces.jsx`.
    public static func tint(for kind: AttentionKind) -> Color {
        switch kind {
        case .awaitingInput:   return ADESharedTheme.warningAmber
        case .failed:          return ADESharedTheme.statusFailed
        case .ciFailing:       return ADESharedTheme.statusFailed
        case .reviewRequested: return ADESharedTheme.warningAmber
        case .mergeReady:      return ADESharedTheme.statusSuccess
        }
    }
}

// MARK: - AttentionBadge

/// Circular glyph for an attention kind: 13% tint background + SF symbol at
/// half the outer size. For `.awaitingInput` a pulsing ring animates outward
/// and the bell wiggles via a custom keyframe animator.
///
/// Mockup reference: `surfaces.jsx` lines 229–253.
@available(iOS 17.0, *)
public struct AttentionBadge: View {
    public let kind: AttentionKind
    public let size: CGFloat
    public let pulse: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(kind: AttentionKind, size: CGFloat = 30, pulse: Bool = true) {
        self.kind = kind
        self.size = size
        self.pulse = pulse
    }

    public var body: some View {
        let color = AttentionIcon.tint(for: kind)
        ZStack {
            Circle()
                .fill(color.opacity(0.13))
                .frame(width: size, height: size)

            if pulse && kind == .awaitingInput && !reduceMotion {
                Circle()
                    .stroke(color, lineWidth: 1.5)
                    .frame(width: size, height: size)
                    .phaseAnimator([0, 1]) { circle, phase in
                        circle
                            .scaleEffect(phase == 0 ? 1.0 : 1.5)
                            .opacity(phase == 0 ? 0.9 : 0)
                    } animation: { _ in
                        .easeOut(duration: 1.6)
                    }
            }

            Image(systemName: AttentionIcon.symbol(for: kind))
                .font(.system(size: size * 0.5, weight: .semibold))
                .foregroundStyle(color)
                .modifier(BellWiggle(active: pulse && kind == .awaitingInput && !reduceMotion))
        }
        .accessibilityHidden(true)
    }
}

/// 2.2s iterating keyframe wiggle for the bell glyph in `.awaitingInput`.
/// Rotation path (from mockup `adeBellWiggle`): 0 → -14° → 12° → -8° → 5° → 0.
@available(iOS 17.0, *)
private struct BellWiggle: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if active {
            content.keyframeAnimator(
                initialValue: 0.0,
                repeating: true
            ) { view, rotation in
                view.rotationEffect(.degrees(rotation))
            } keyframes: { _ in
                KeyframeTrack {
                    LinearKeyframe(0, duration: 1.32)   // 0–60% hold
                    CubicKeyframe(-14, duration: 0.176) // 60→68
                    CubicKeyframe(12,  duration: 0.176) // 68→76
                    CubicKeyframe(-8,  duration: 0.176) // 76→84
                    CubicKeyframe(5,   duration: 0.176) // 84→92
                    CubicKeyframe(0,   duration: 0.176) // 92→100
                }
            }
        } else {
            content
        }
    }
}

// MARK: - Action pill styling

/// Variant describing the visual style of an action pill inside
/// `AttentionActionRow`.
@available(iOS 17.0, *)
public enum ActionPillVariant {
    case primary(tint: Color)   // solid tint fill, black text (bright bg)
    case secondary              // white 10% bg, white text
    case danger                 // rgba(239,68,68,0.15) bg + #F87171 text
}

/// Single pill-shaped action button. Height 32pt, fontSize 12.5, weight 700,
/// 9pt vertical / 14pt horizontal padding, radius 999. Pressed scale 0.96.
///
/// Takes any `AppIntent` so the caller wires approve/deny/reply/etc. without
/// this primitive knowing about intent-specific types.
@available(iOS 17.0, *)
public struct ActionPill<Intent: AppIntent>: View {
    public let label: String
    public let systemImage: String?
    public let variant: ActionPillVariant
    public let intent: Intent

    public init(
        label: String,
        systemImage: String? = nil,
        variant: ActionPillVariant,
        intent: Intent
    ) {
        self.label = label
        self.systemImage = systemImage
        self.variant = variant
        self.intent = intent
    }

    public var body: some View {
        Button(intent: intent) {
            HStack(spacing: 6) {
                if let name = systemImage {
                    Image(systemName: name)
                        .font(.system(size: 11, weight: .bold))
                }
                Text(label)
                    .font(.system(size: 12.5, weight: .bold))
                    .lineLimit(1)
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity)
            .background(background)
            .overlay(
                // Soft top highlight — gives every variant a convex, wet look.
                Capsule(style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [Color.white.opacity(0.22), .clear],
                            startPoint: .top,
                            endPoint: .center
                        )
                    )
                    .allowsHitTesting(false)
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(strokeGradient, lineWidth: 0.75)
            )
            .foregroundStyle(foreground)
            .clipShape(Capsule(style: .continuous))
            .shadow(color: shadowColor, radius: shadowRadius, x: 0, y: 3)
        }
        .buttonStyle(ActionPillButtonStyle())
        .accessibilityLabel(Text(label))
    }

    private var background: some ShapeStyle {
        switch variant {
        case .primary(let tint):
            return AnyShapeStyle(
                LinearGradient(
                    colors: [tint, tint.opacity(0.82)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
        case .secondary:
            return AnyShapeStyle(.ultraThinMaterial)
        case .danger:
            return AnyShapeStyle(
                LinearGradient(
                    colors: [
                        Color(red: 239/255, green: 68/255, blue: 68/255).opacity(0.78),
                        Color(red: 239/255, green: 68/255, blue: 68/255).opacity(0.55),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
        }
    }

    private var strokeGradient: LinearGradient {
        switch variant {
        case .primary(let tint):
            return LinearGradient(
                colors: [tint.opacity(0.55), tint.opacity(0.15)],
                startPoint: .top,
                endPoint: .bottom
            )
        case .secondary:
            return LinearGradient(
                colors: [Color.white.opacity(0.08), Color.white.opacity(0.04)],
                startPoint: .top,
                endPoint: .bottom
            )
        case .danger:
            return LinearGradient(
                colors: [
                    Color(red: 239/255, green: 68/255, blue: 68/255).opacity(0.55),
                    Color(red: 239/255, green: 68/255, blue: 68/255).opacity(0.20),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
    }

    private var shadowColor: Color {
        switch variant {
        case .primary(let tint): return tint.opacity(0.35)
        case .secondary:         return Color.black.opacity(0.30)
        case .danger:            return Color(red: 239/255, green: 68/255, blue: 68/255).opacity(0.25)
        }
    }

    private var shadowRadius: CGFloat {
        switch variant {
        case .primary: return 8
        case .secondary: return 5
        case .danger: return 7
        }
    }

    private var foreground: Color {
        switch variant {
        case .primary:   return Color(red: 0x0C/255, green: 0x0B/255, blue: 0x10/255) // black text
        case .secondary: return Color(red: 0xF0/255, green: 0xF0/255, blue: 0xF2/255)
        case .danger:    return Color(red: 0xF8/255, green: 0x71/255, blue: 0x71/255) // #F87171
        }
    }
}

@available(iOS 17.0, *)
private struct ActionPillButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1.0)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }
}

// MARK: - AttentionActionRow

/// Row of 1–3 `ActionPill` buttons wired to the right `AppIntent` for each
/// attention kind. Layout mirrors `dynamic-island.jsx` lines 187–230.
///
/// When `compact` is true the row skips the leading icons to save horizontal
/// space inside a Dynamic Island expansion.
@available(iOS 17.0, *)
public struct AttentionActionRow: View {
    public let attention: ADESessionAttributes.ContentState.Attention
    public let compact: Bool

    public init(attention: ADESessionAttributes.ContentState.Attention, compact: Bool = false) {
        self.attention = attention
        self.compact = compact
    }

    public var body: some View {
        HStack(spacing: 8) {
            switch attention.kind {
            case .awaitingInput:
                ActionPill(
                    label: "Approve",
                    systemImage: compact ? nil : "checkmark",
                    variant: .primary(tint: ADESharedTheme.statusSuccess),
                    intent: ApproveSessionIntent(
                        sessionId: attention.sessionId ?? "",
                        itemId: attention.itemId ?? ""
                    )
                )
                ActionPill(
                    label: "Deny",
                    systemImage: compact ? nil : "xmark",
                    variant: .danger,
                    intent: DenySessionIntent(
                        sessionId: attention.sessionId ?? "",
                        itemId: attention.itemId ?? ""
                    )
                )
                ActionPill(
                    label: "Reply",
                    systemImage: compact ? nil : "text.bubble",
                    variant: .secondary,
                    intent: ReplySessionIntent(
                        sessionId: attention.sessionId ?? "",
                        text: ""
                    )
                )
            case .failed:
                ActionPill(
                    label: "Open agent",
                    systemImage: compact ? nil : "arrow.right",
                    variant: .primary(tint: ADESharedTheme.brandCursor),
                    intent: openSessionIntent(attention.sessionId)
                )
                ActionPill(
                    label: "Restart",
                    systemImage: compact ? nil : "arrow.uturn.backward",
                    variant: .secondary,
                    intent: RestartSessionIntent(sessionId: attention.sessionId ?? "")
                )
            case .ciFailing:
                ActionPill(
                    label: prLabel("Open", attention.prNumber),
                    systemImage: compact ? nil : "arrow.triangle.branch",
                    variant: .primary(tint: ADESharedTheme.brandCursor),
                    intent: openPrIntent(attention.prNumber)
                )
                ActionPill(
                    label: "Rerun CI",
                    systemImage: compact ? nil : "arrow.uturn.backward",
                    variant: .secondary,
                    intent: RetryCheckIntent(
                        prNumber: attention.prNumber ?? 0,
                        prId: attention.prId ?? ""
                    )
                )
            case .reviewRequested:
                ActionPill(
                    label: prLabel("Review", attention.prNumber),
                    systemImage: compact ? nil : "eye",
                    variant: .primary(tint: ADESharedTheme.brandCursor),
                    intent: openPrIntent(attention.prNumber)
                )
            case .mergeReady:
                ActionPill(
                    label: prLabel("Merge", attention.prNumber),
                    systemImage: compact ? nil : "checkmark.seal",
                    variant: .primary(tint: ADESharedTheme.statusSuccess),
                    intent: openPrIntent(attention.prNumber)
                )
                ActionPill(
                    label: "View",
                    systemImage: compact ? nil : "arrow.right",
                    variant: .secondary,
                    intent: openPrIntent(attention.prNumber)
                )
            }
        }
    }

    private func openSessionIntent(_ sessionId: String?) -> OpenADEDeepLinkIntent {
        // Empty sessionId routes to the workspace root — safer than a broken
        // ade://session/ URL that the router would fail to resolve.
        guard let sessionId, !sessionId.isEmpty else {
            return OpenADEDeepLinkIntent(urlString: "ade://workspace")
        }
        return OpenADEDeepLinkIntent(urlString: "ade://session/\(sessionId)")
    }

    private func openPrIntent(_ prNumber: Int?) -> OpenADEDeepLinkIntent {
        guard let prNumber, prNumber > 0 else {
            return OpenADEDeepLinkIntent(urlString: "ade://workspace")
        }
        return OpenADEDeepLinkIntent(urlString: "ade://pr/\(prNumber)")
    }

    private func prLabel(_ verb: String, _ number: Int?) -> String {
        if let number, number > 0 {
            return "\(verb) #\(number)"
        }
        return "\(verb) PR"
    }
}

/// iOS-17 compatible fallback for `OpenURLIntent` (which is iOS 18+). Sets
/// `openAppWhenRun = true` and forwards the URL via the existing
/// `ADEIntentCommandRegistry` bridge so the main app's deep-link router can
/// handle it when the app is foregrounded.
@available(iOS 17.0, *)
public struct OpenADEDeepLinkIntent: AppIntent {
    public static var title: LocalizedStringResource = "Open"
    public static var description = IntentDescription("Open the linked ADE surface.")
    public static var openAppWhenRun: Bool = true

    @Parameter(title: "URL")
    public var urlString: String

    public init() {}

    public init(urlString: String) {
        self.urlString = urlString
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        await ADEIntentCommandRegistry.dispatch(
            .openPr,
            payload: ["url": urlString]
        )
        return .result()
    }
}

// MARK: - GlanceChip

/// Larger pill used inside the Dynamic Island expanded glance strip: tint
/// capsule at 12% opacity, label + icon with 6pt gap.
/// Mockup reference: `dynamic-island.jsx` lines 278–285.
@available(iOS 17.0, *)
public struct GlanceChip: View {
    public let icon: String
    public let label: String
    public let color: Color

    public init(icon: String, label: String, color: Color) {
        self.icon = icon
        self.label = label
        self.color = color
    }

    public var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
            Text(label)
                .font(.system(size: 11, weight: .semibold).monospacedDigit())
        }
        .foregroundStyle(color)
        .padding(.vertical, 5)
        .padding(.horizontal, 10)
        .background(
            Capsule(style: .continuous).fill(color.opacity(0.14))
        )
        .overlay(
            // Faint top highlight so the chip reads as glass, not a flat tile.
            Capsule(style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color.white.opacity(0.12), .clear],
                        startPoint: .top,
                        endPoint: .center
                    )
                )
                .allowsHitTesting(false)
        )
        .overlay(
            Capsule(style: .continuous)
                .stroke(color.opacity(0.28), lineWidth: 0.5)
        )
    }
}

// MARK: - MiniGlance

/// Tight variant of `GlanceChip` used in the lock-screen live activity header.
/// 2pt vertical / 6pt horizontal padding, fontSize 10 weight 700.
/// Mockup reference: `lock-activity.jsx` lines 111–124.
@available(iOS 17.0, *)
public struct MiniGlance: View {
    public let icon: String
    public let count: Int
    public let color: Color

    public init(icon: String, count: Int, color: Color) {
        self.icon = icon
        self.count = count
        self.color = color
    }

    public var body: some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.system(size: 9, weight: .bold))
            Text("\(count)")
                .font(.system(size: 10, weight: .bold).monospacedDigit())
        }
        .foregroundStyle(color)
        .padding(.vertical, 2)
        .padding(.horizontal, 6)
        .background(
            Capsule(style: .continuous).fill(color.opacity(0.12))
        )
    }
}

// MARK: - AdeMark

/// The ADE app-icon style mark: rounded square with violet top-leading →
/// bottom-trailing gradient, centered black "A" glyph, inset top shadow and
/// outer violet glow.
/// Mockup reference: `lock-activity.jsx` lines 127–141.
@available(iOS 17.0, *)
public struct AdeMark: View {
    public let size: CGFloat

    public init(size: CGFloat = 22) {
        self.size = size
    }

    public var body: some View {
        let gradient = LinearGradient(
            colors: [
                Color(red: 0x8B/255, green: 0x5C/255, blue: 0xF6/255),
                Color(red: 0xA7/255, green: 0x8B/255, blue: 0xFA/255),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
            .fill(gradient)
            .frame(width: size, height: size)
            .overlay(
                Text("A")
                    .font(.system(size: size * 0.48, weight: .black, design: .default))
                    .foregroundStyle(Color(red: 0x0C/255, green: 0x0B/255, blue: 0x10/255))
                    .kerning(-0.5)
            )
            .overlay(
                RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                    .stroke(Color.white.opacity(0.1), lineWidth: 0.5)
            )
            .shadow(color: Color(red: 0x8B/255, green: 0x5C/255, blue: 0xF6/255).opacity(0.4),
                    radius: size * 0.36, x: 0, y: size * 0.09)
            .accessibilityLabel(Text("ADE"))
    }
}

// MARK: - TimerLabel

/// Live-updating `Text(_, style: .timer)` with monospaced digits and a tight
/// letter-spacing. Color is caller-owned (brand tint for focused lane, grey
/// for idle, attention tint for attention states).
@available(iOS 17.0, *)
public struct TimerLabel: View {
    public let startedAt: Date
    public let color: Color
    public let fontSize: CGFloat

    public init(startedAt: Date, color: Color, fontSize: CGFloat = 12) {
        self.startedAt = startedAt
        self.color = color
        self.fontSize = fontSize
    }

    public var body: some View {
        Text(startedAt, style: .timer)
            .font(.system(size: fontSize, weight: .semibold).monospacedDigit())
            .kerning(-0.2)
            .foregroundStyle(color)
    }
}

// MARK: - ProgressBar

/// Brand-tinted progress bar with optional moving shimmer stripe.
/// Background is a white-8% capsule; filled portion uses `color`. Shimmer
/// overlays a 30%-width gradient moving from -40% → 120% on a 2.2s loop.
@available(iOS 17.0, *)
public struct ProgressBar: View {
    public let progress: Double
    public let color: Color
    public let shimmer: Bool
    public let height: CGFloat

    public init(progress: Double, color: Color, shimmer: Bool = false, height: CGFloat = 4) {
        self.progress = progress
        self.color = color
        self.shimmer = shimmer
        self.height = height
    }

    public var body: some View {
        GeometryReader { geo in
            let clamped = max(0, min(1, progress))
            ZStack(alignment: .leading) {
                Capsule(style: .continuous)
                    .fill(Color.white.opacity(0.08))

                Capsule(style: .continuous)
                    .fill(color)
                    .frame(width: geo.size.width * clamped)

                if shimmer {
                    Capsule(style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [.clear, color.opacity(0.6), .clear],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: geo.size.width * 0.3)
                        .phaseAnimator([0, 1]) { stripe, phase in
                            stripe.offset(x: phase == 0
                                ? -geo.size.width * 0.4
                                : geo.size.width * 1.2)
                        } animation: { _ in
                            .easeInOut(duration: 2.2)
                        }
                        .clipShape(Capsule(style: .continuous))
                }
            }
        }
        .frame(height: height)
        .accessibilityValue(Text("\(Int((max(0, min(1, progress))) * 100)) percent"))
    }
}

// MARK: - Previews

#if DEBUG

@available(iOS 17.0, *)
#Preview("BrandDot · slugs × sizes") {
    VStack(spacing: 24) {
        HStack(spacing: 18) {
            BrandDot(slug: "claude", size: 12)
            BrandDot(slug: "codex", size: 12, pulse: true)
            BrandDot(slug: "cursor", size: 12)
        }
        HStack(spacing: 18) {
            BrandDot(slug: "claude", size: 22)
            BrandDot(slug: "codex", size: 22, pulse: true)
            BrandDot(slug: "cursor", size: 22)
        }
        StackedBrandDots(slugs: ["claude", "codex", "cursor"], size: 16)
    }
    .padding(32)
    .background(Color.black)
}

@available(iOS 17.0, *)
#Preview("AttentionBadge · all kinds") {
    HStack(spacing: 18) {
        AttentionBadge(kind: .awaitingInput, size: 36)
        AttentionBadge(kind: .failed, size: 36)
        AttentionBadge(kind: .ciFailing, size: 36)
        AttentionBadge(kind: .reviewRequested, size: 36)
        AttentionBadge(kind: .mergeReady, size: 36)
    }
    .padding(32)
    .background(Color.black)
}

@available(iOS 17.0, *)
#Preview("AttentionActionRow · all kinds") {
    VStack(alignment: .leading, spacing: 12) {
        AttentionActionRow(attention: .init(
            kind: .awaitingInput,
            title: "Approve",
            sessionId: "s1",
            itemId: "i1"
        ))
        AttentionActionRow(attention: .init(
            kind: .failed,
            title: "Failed",
            sessionId: "s1"
        ))
        AttentionActionRow(attention: .init(
            kind: .ciFailing,
            title: "CI",
            prId: "pr-412",
            prNumber: 412
        ))
        AttentionActionRow(attention: .init(
            kind: .reviewRequested,
            title: "Review",
            prNumber: 408
        ))
        AttentionActionRow(attention: .init(
            kind: .mergeReady,
            title: "Merge",
            prNumber: 401
        ))
    }
    .padding(16)
    .background(Color(red: 0x0C/255, green: 0x0B/255, blue: 0x10/255))
}

@available(iOS 17.0, *)
#Preview("GlanceChip · three colors") {
    HStack(spacing: 8) {
        GlanceChip(icon: "exclamationmark.triangle.fill", label: "CI 2", color: ADESharedTheme.statusFailed)
        GlanceChip(icon: "eye.fill",                      label: "Review 1", color: ADESharedTheme.warningAmber)
        GlanceChip(icon: "checkmark.seal.fill",           label: "Ready 1", color: ADESharedTheme.statusSuccess)
    }
    .padding(24)
    .background(Color.black)
}

@available(iOS 17.0, *)
#Preview("AdeMark · two sizes") {
    HStack(spacing: 24) {
        AdeMark(size: 16)
        AdeMark(size: 44)
    }
    .padding(32)
    .background(Color.black)
}

@available(iOS 17.0, *)
#Preview("ProgressBar · shimmer") {
    VStack(spacing: 20) {
        ProgressBar(progress: 0.3, color: ADESharedTheme.brandClaude)
        ProgressBar(progress: 0.68, color: ADESharedTheme.brandCodex, shimmer: true)
        ProgressBar(progress: 1.0, color: ADESharedTheme.statusSuccess)
    }
    .padding(24)
    .frame(width: 320)
    .background(Color.black)
}

@available(iOS 17.0, *)
#Preview("TimerLabel · three colors") {
    VStack(alignment: .leading, spacing: 10) {
        TimerLabel(startedAt: Date().addingTimeInterval(-90),   color: ADESharedTheme.brandClaude)
        TimerLabel(startedAt: Date().addingTimeInterval(-600),  color: ADESharedTheme.statusIdle)
        TimerLabel(startedAt: Date().addingTimeInterval(-1200), color: ADESharedTheme.warningAmber)
    }
    .padding(24)
    .background(Color.black)
}

#endif
