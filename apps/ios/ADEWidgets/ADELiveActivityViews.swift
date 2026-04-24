import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// MARK: - Shared styling helpers

@available(iOS 16.2, *)
enum WorkspaceStyle {
    /// Subtle background tint pulled from the most important signal: the
    /// attention (if any) or the focused agent. Kept at low alpha so the
    /// system's own Lock Screen material still reads cleanly underneath.
    static func lockBackgroundTint(for state: ADESessionAttributes.ContentState) -> Color {
        let base: Color
        if let attention = state.attention {
            base = attentionTint(for: attention)
        } else if let focused = state.focusedSession {
            base = ADESharedTheme.brandColor(for: focused.providerSlug)
        } else {
            base = ADESharedTheme.statusIdle
        }
        return base.opacity(0.12)
    }

    /// Keyline tint for the Dynamic Island pill.
    static func keylineTint(for state: ADESessionAttributes.ContentState) -> Color {
        if let attention = state.attention {
            return attentionTint(for: attention)
        }
        if let focused = state.focusedSession {
            return ADESharedTheme.brandColor(for: focused.providerSlug)
        }
        return ADESharedTheme.statusIdle
    }

    /// Where tapping the whole Live Activity pill should go.
    static func primaryDeepLink(for state: ADESessionAttributes.ContentState) -> String {
        if let attention = state.attention {
            if let sessionId = attention.sessionId { return "ade://session/\(sessionId)" }
            if let pr = attention.prNumber { return "ade://pr/\(pr)" }
        }
        if let focused = state.focusedSession { return "ade://session/\(focused.id)" }
        return "ade://workspace"
    }

    static func attentionTint(for attention: ADESessionAttributes.ContentState.Attention) -> Color {
        if attention.kind == .awaitingInput,
           let slug = attention.providerSlug {
            return ADESharedTheme.brandColor(for: slug)
        }
        return AttentionIcon.tint(for: attention.kind)
    }

    /// Short label for the compact-trailing chip when an attention is active.
    static func shortLabel(for attention: ADESessionAttributes.ContentState.Attention) -> String {
        switch attention.kind {
        case .awaitingInput:   return "Approve"
        case .failed:          return "Failed"
        case .ciFailing:
            if let pr = attention.prNumber { return "CI #\(pr)" }
            return "CI fail"
        case .reviewRequested:
            if let pr = attention.prNumber { return "Review #\(pr)" }
            return "Review"
        case .mergeReady:
            if let pr = attention.prNumber { return "Merge #\(pr)" }
            return "Merge"
        }
    }
}

// MARK: - Compact / minimal (Dynamic Island, always visible)

/// Leading chip. Attention present → attention glyph; multi-agent → stacked
/// brand dots; single agent → pulsing brand dot; idle → sparkles.
/// Mockup ref: `dynamic-island.jsx` lines 34-51.
@available(iOS 16.2, *)
struct WorkspaceCompactLeading: View {
    let state: ADESessionAttributes.ContentState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let attention = state.attention {
            let tint = WorkspaceStyle.attentionTint(for: attention)
            Image(systemName: AttentionIcon.symbol(for: attention.kind))
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
                .modifier(BellWiggleCompat(active: !reduceMotion && attention.kind == .awaitingInput))
                .accessibilityLabel(Text(accessibilityLabel(for: attention)))
        } else if state.sessions.count >= 2 {
            StackedBrandDots(
                slugs: state.sessions.prefix(3).map(\.providerSlug),
                size: 11
            )
            .accessibilityLabel(Text("\(state.sessions.count) agents running"))
        } else if state.sessions.count == 1, let s = state.sessions.first {
            BrandDot(slug: s.providerSlug, size: 12, pulse: !reduceMotion && !s.isFailed)
                .accessibilityLabel(Text("\(s.providerSlug) is working on \(s.title)"))
        } else {
            Image(systemName: "sparkles")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(ADESharedTheme.statusIdle)
                .accessibilityLabel(Text("ADE"))
        }
    }

    private func accessibilityLabel(for a: ADESessionAttributes.ContentState.Attention) -> String {
        switch a.kind {
        case .awaitingInput: return "Approval needed: \(a.title)"
        case .failed: return "Failed: \(a.title)"
        case .ciFailing: return "CI failing on \(a.title)"
        case .reviewRequested: return "Review requested on \(a.title)"
        case .mergeReady: return "Merge ready: \(a.title)"
        }
    }
}

/// Trailing chip. Attention → short label in attention color, mono 12pt
/// weight 600, maxWidth 78. Multi-agent → "N agents". Single → brand-tinted
/// TimerLabel. Idle → `moon.zzz.fill`. Mockup ref: `dynamic-island.jsx` 54-64.
@available(iOS 16.2, *)
struct WorkspaceCompactTrailing: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        if let attention = state.attention {
            let tint = WorkspaceStyle.attentionTint(for: attention)
            Text(WorkspaceStyle.shortLabel(for: attention))
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                .kerning(-0.2)
                .foregroundStyle(tint)
                .shadow(color: tint.opacity(0.5), radius: 4, x: 0, y: 0)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 96, alignment: .trailing)
                .accessibilityLabel(Text(WorkspaceStyle.shortLabel(for: attention)))
        } else if state.sessions.count >= 2 {
            Text("\(state.sessions.count) agents")
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                .kerning(-0.2)
                .foregroundStyle(Color(red: 0xF0/255, green: 0xF0/255, blue: 0xF2/255))
                .lineLimit(1)
                .frame(maxWidth: 96, alignment: .trailing)
        } else if state.sessions.count == 1, let s = state.sessions.first {
            TimerLabel(
                startedAt: s.startedAt,
                color: ADESharedTheme.brandColor(for: s.providerSlug)
            )
            .lineLimit(1)
            .frame(maxWidth: 78, alignment: .trailing)
        } else {
            Image(systemName: "moon.zzz.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(ADESharedTheme.statusIdle)
                .accessibilityLabel(Text("Idle"))
        }
    }
}

/// Minimal presentation — single 28pt circle with 2px brand/attention-color
/// border over black background. Mockup ref: `dynamic-island.jsx` 70-89.
@available(iOS 16.2, *)
struct WorkspaceMinimalGlyph: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        let color: Color = {
            if let attention = state.attention {
                return WorkspaceStyle.attentionTint(for: attention)
            }
            if state.sessions.count >= 2 {
                return ADESharedTheme.statusAttention
            }
            if let only = state.sessions.first {
                return ADESharedTheme.brandColor(for: only.providerSlug)
            }
            return ADESharedTheme.statusIdle
        }()

        ZStack {
            // Outer soft color glow — keeps the minimal region feeling alive
            // at small sizes without spending the Live Activity animation
            // budget on a continuous pulse.
            Circle()
                .fill(color.opacity(0.45))
                .frame(width: 34, height: 34)
                .blur(radius: 6)

            Circle()
                .fill(Color.black)
                .frame(width: 28, height: 28)

            // Inner tinted radial wash top-left.
            Circle()
                .fill(
                    RadialGradient(
                        colors: [color.opacity(0.35), .clear],
                        center: UnitPoint(x: 0.25, y: 0.2),
                        startRadius: 0,
                        endRadius: 22
                    )
                )
                .frame(width: 28, height: 28)

            // Gradient ring (bright tint at top → darker tint at bottom).
            Circle()
                .strokeBorder(
                    LinearGradient(
                        colors: [color, color.opacity(0.5)],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 1.75
                )
                .frame(width: 28, height: 28)

            inner(color: color)
        }
        .frame(width: 28, height: 28)
        .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder
    private func inner(color: Color) -> some View {
        if let attention = state.attention {
            Image(systemName: AttentionIcon.symbol(for: attention.kind))
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(color)
        } else if state.sessions.count >= 2 {
            Text("\(state.sessions.count)")
                .font(.system(size: 11, weight: .bold).monospacedDigit())
                .foregroundStyle(color)
        } else if let only = state.sessions.first {
            BrandDot(slug: only.providerSlug, size: 10, pulse: false)
        } else {
            Image(systemName: "sparkles")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(color)
        }
    }

    private var accessibilityLabel: Text {
        if let attention = state.attention {
            return Text(attention.title)
        }
        if state.sessions.count >= 2 {
            return Text("\(state.sessions.count) agents")
        }
        if let only = state.sessions.first {
            return Text("\(only.providerSlug) on \(only.title)")
        }
        return Text("ADE")
    }
}

// MARK: - Expanded regions (Dynamic Island long-press)

@available(iOS 16.2, *)
struct WorkspaceExpandedLeading: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        Group {
            if let attention = state.attention {
                AttentionBadge(kind: attention.kind, size: 36)
            } else if let focused = state.focusedSession {
                BrandDot(slug: focused.providerSlug, size: 24, pulse: !focused.isFailed)
            } else {
                Image(systemName: "sparkles")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(ADESharedTheme.brandCursor)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 4)
    }
}

@available(iOS 16.2, *)
struct WorkspaceExpandedTrailing: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        Group {
            if state.attention != nil {
                // Attention occupies the bottom action row; trailing stays
                // empty so the header doesn't feel doubled up.
                EmptyView()
            } else if state.sessions.count >= 2 {
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(state.sessions.count)")
                        .font(.system(size: 20, weight: .bold).monospacedDigit())
                        .foregroundStyle(ADESharedTheme.statusAttention)
                    Text("AGENTS")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
            } else if let focused = state.focusedSession, state.sessions.count == 1 {
                TimerLabel(
                    startedAt: focused.startedAt,
                    color: ADESharedTheme.brandColor(for: focused.providerSlug),
                    fontSize: 14
                )
            } else {
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.trailing, 4)
    }
}

@available(iOS 16.2, *)
struct WorkspaceExpandedCenter: View {
    let state: ADESessionAttributes.ContentState
    let attrs: ADESessionAttributes

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let attention = state.attention {
                Text(attention.title)
                    .font(.system(size: 15, weight: .bold))
                    .kerning(-0.2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                if let subtitle = attention.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } else if let focused = state.focusedSession {
                Text(focused.title.isEmpty ? focused.id : focused.title)
                    .font(.system(size: 15, weight: .bold))
                    .kerning(-0.2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                if let preview = focused.preview, !preview.isEmpty {
                    Text("\(focused.providerSlug.capitalized) · \(preview)")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else {
                    Text(focused.providerSlug.capitalized)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } else {
                Text("ADE · No active agents")
                    .font(.system(size: 15, weight: .bold))
                    .kerning(-0.2)
                Text(attrs.workspaceName)
                    .font(.system(size: 12, weight: .medium).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }
}

@available(iOS 16.2, *)
struct WorkspaceExpandedBottom: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        Group {
            if let attention = state.attention {
                AttentionActionRow(attention: attention, compact: true)
            } else if state.sessions.count >= 2 {
                ExpandedRosterStrip(sessions: Array(state.sessions.prefix(3)))
            } else if let focused = state.focusedSession, state.sessions.count == 1 {
                FocusedCardBottom(session: focused)
            } else {
                ExpandedGlanceStrip(state: state)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 4)
    }
}

// MARK: - Lock Screen

/// 358pt glass card via `.ultraThinMaterial`; MiniGlance trio header;
/// attention card (conditional) + roster rows (≤3 with attention, ≤4 without).
/// Mockup ref: `lock-activity.jsx` 5-85.
@available(iOS 16.2, *)
struct WorkspaceLockScreenPresentation: View {
    let state: ADESessionAttributes.ContentState
    let attrs: ADESessionAttributes

    private var tint: Color {
        if let attention = state.attention {
            return WorkspaceStyle.attentionTint(for: attention)
        }
        if let focused = state.focusedSession {
            return ADESharedTheme.brandColor(for: focused.providerSlug)
        }
        return ADESharedTheme.brandCursor
    }

    var body: some View {
        ZStack {
            // Ambient tint wash (135° gradient from tint@14% → transparent).
            LinearGradient(
                colors: [tint.opacity(0.14), .clear],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .allowsHitTesting(false)

            // Soft radial bloom in the top-left corner in the tint color.
            RadialGradient(
                colors: [tint.opacity(0.22), .clear],
                center: UnitPoint(x: 0.08, y: 0.08),
                startRadius: 0,
                endRadius: 220
            )
            .allowsHitTesting(false)

            VStack(alignment: .leading, spacing: 10) {
                header
                content
            }
            .padding(14)
        }
        .background(.ultraThinMaterial)
        .overlay(
            // Soft top-to-bottom white highlight — gives the glass its "wet" feel.
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color.white.opacity(0.08), .clear],
                        startPoint: .top,
                        endPoint: .center
                    )
                )
                .allowsHitTesting(false)
        )
        .overlay(
            // 1pt inner highlight (white top → fade).
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [Color.white.opacity(0.18), Color.white.opacity(0.02)],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 1
                )
                .allowsHitTesting(false)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Color.white.opacity(0.12), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .shadow(color: Color.black.opacity(0.40), radius: 18, x: 0, y: 6)
        .frame(maxWidth: 358)
        // Lock Screen Live Activities live in a fixed-height card — clamp
        // Dynamic Type so accessibility sizes don't overflow the chrome.
        // iOS still renders legibly; users at larger sizes can tap through
        // to the in-app Attention Drawer for the full-size presentation.
        .dynamicTypeSize(.small ... .accessibility1)
    }

    private var header: some View {
        HStack(spacing: 7) {
            AdeMark(size: 16)
            Text("ADE")
                .font(.system(size: 13, weight: .bold))
                .kerning(-0.1)
            Text("· \(attrs.workspaceName)")
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 8)
            MiniGlanceStrip(state: state)
        }
    }

    @ViewBuilder
    private var content: some View {
        if let attention = state.attention {
            AttentionLockCard(attention: attention)
            if !state.sessions.isEmpty {
                Divider().opacity(0.25)
                VStack(spacing: 9) {
                    ForEach(state.sessions.prefix(2)) { session in
                        LockRosterRow(session: session)
                    }
                }
                .padding(.top, 1)
            }
        } else if !state.sessions.isEmpty {
            VStack(spacing: 9) {
                ForEach(state.sessions.prefix(3)) { session in
                    LockRosterRow(session: session)
                }
            }
        } else {
            Text("Nothing active right now.")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Lock-screen building blocks

@available(iOS 16.2, *)
private struct MiniGlanceStrip: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        HStack(spacing: 5) {
            if state.failingCheckCount > 0 {
                MiniGlance(
                    icon: "exclamationmark.triangle.fill",
                    count: state.failingCheckCount,
                    color: ADESharedTheme.statusFailed
                )
            }
            if state.awaitingReviewCount > 0 {
                MiniGlance(
                    icon: "eye.fill",
                    count: state.awaitingReviewCount,
                    color: ADESharedTheme.warningAmber
                )
            }
            if state.mergeReadyCount > 0 {
                MiniGlance(
                    icon: "checkmark.seal.fill",
                    count: state.mergeReadyCount,
                    color: ADESharedTheme.statusSuccess
                )
            }
        }
    }
}

@available(iOS 16.2, *)
private struct AttentionLockCard: View {
    let attention: ADESessionAttributes.ContentState.Attention

    var body: some View {
        let tint = WorkspaceStyle.attentionTint(for: attention)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                AttentionBadge(kind: attention.kind, size: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text(attention.title)
                        .font(.system(size: 14, weight: .bold))
                        .kerning(-0.2)
                        .lineLimit(2)
                    if let subtitle = attention.subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            AttentionActionRow(attention: attention, compact: false)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(tint.opacity(0.16))
        )
        .background(
            // Soft tint bloom in the top-left of the attention card.
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(
                    RadialGradient(
                        colors: [tint.opacity(0.28), .clear],
                        center: UnitPoint(x: 0.05, y: 0.1),
                        startRadius: 0,
                        endRadius: 160
                    )
                )
        )
        .overlay(
            // Top white highlight to lift the tint-tile off the glass behind.
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color.white.opacity(0.10), .clear],
                        startPoint: .top,
                        endPoint: .center
                    )
                )
                .allowsHitTesting(false)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [tint.opacity(0.55), tint.opacity(0.15)],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 0.75
                )
        )
        .shadow(color: tint.opacity(0.40), radius: 10, x: 0, y: 4)
    }
}

@available(iOS 16.2, *)
private struct LockRosterRow: View {
    let session: ADESessionAttributes.ContentState.ActiveSession

    var body: some View {
        HStack(spacing: 12) {
            BrandDot(slug: session.providerSlug, size: 12, pulse: session.isAwaitingInput)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title.isEmpty ? session.id : session.title)
                    .font(.system(size: 13.5, weight: .semibold))
                    .kerning(-0.1)
                    .lineLimit(1)
                Text(subtitleText)
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            trailingStatus
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(accessibilityLabel))
    }

    private var subtitleText: String {
        let providerName = session.providerSlug.lowercased()
        if let preview = session.preview, !preview.isEmpty {
            return "\(providerName) · \(preview)"
        }
        return "\(providerName) · working…"
    }

    @ViewBuilder
    private var trailingStatus: some View {
        if session.isFailed {
            Text("failed")
                .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                .foregroundStyle(ADESharedTheme.statusFailed)
        } else if session.isAwaitingInput {
            Text("waiting")
                .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                .foregroundStyle(ADESharedTheme.warningAmber)
        } else {
            TimerLabel(
                startedAt: session.startedAt,
                color: ADESharedTheme.statusIdle,
                fontSize: 10.5
            )
        }
    }

    private var accessibilityLabel: String {
        if session.isAwaitingInput {
            return "\(session.providerSlug) on \(session.title), awaiting input"
        }
        if session.isFailed {
            return "\(session.providerSlug) on \(session.title), failed"
        }
        return "\(session.providerSlug) on \(session.title), running"
    }
}

// MARK: - Dynamic Island expanded-bottom building blocks

@available(iOS 16.2, *)
private struct ExpandedRosterStrip: View {
    let sessions: [ADESessionAttributes.ContentState.ActiveSession]

    var body: some View {
        VStack(spacing: 7) {
            ForEach(sessions) { session in
                HStack(spacing: 10) {
                    BrandDot(slug: session.providerSlug, size: 10, pulse: session.isAwaitingInput)
                    Text(session.title.isEmpty ? session.id : session.title)
                        .font(.system(size: 12, weight: .semibold))
                        .kerning(-0.1)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    trailing(for: session)
                }
            }
        }
    }

    @ViewBuilder
    private func trailing(for session: ADESessionAttributes.ContentState.ActiveSession) -> some View {
        if session.isFailed {
            Text("failed")
                .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                .foregroundStyle(ADESharedTheme.statusFailed)
        } else if session.isAwaitingInput {
            Text("waiting")
                .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                .foregroundStyle(ADESharedTheme.warningAmber)
        } else {
            TimerLabel(
                startedAt: session.startedAt,
                color: ADESharedTheme.statusIdle,
                fontSize: 10.5
            )
        }
    }
}

@available(iOS 16.2, *)
private struct FocusedCardBottom: View {
    let session: ADESessionAttributes.ContentState.ActiveSession

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ProgressBar(
                progress: session.progress ?? 0.62,
                color: ADESharedTheme.brandColor(for: session.providerSlug),
                shimmer: !session.isFailed,
                height: 4
            )

            HStack {
                Text(session.preview ?? "running")
                    .font(.system(size: 10.5, weight: .medium).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                TimerLabel(
                    startedAt: session.startedAt,
                    color: ADESharedTheme.statusIdle,
                    fontSize: 10.5
                )
            }
        }
    }
}

@available(iOS 16.2, *)
private struct ExpandedGlanceStrip: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        HStack(spacing: 8) {
            if state.failingCheckCount > 0 {
                GlanceChip(
                    icon: "exclamationmark.triangle.fill",
                    label: "CI \(state.failingCheckCount)",
                    color: ADESharedTheme.statusFailed
                )
            }
            if state.awaitingReviewCount > 0 {
                GlanceChip(
                    icon: "eye.fill",
                    label: "Review \(state.awaitingReviewCount)",
                    color: ADESharedTheme.warningAmber
                )
            }
            if state.mergeReadyCount > 0 {
                GlanceChip(
                    icon: "checkmark.seal.fill",
                    label: "Ready \(state.mergeReadyCount)",
                    color: ADESharedTheme.statusSuccess
                )
            }
            if state.pendingPrCount == 0 {
                Text("Nothing pending")
                    .font(.system(size: 11, weight: .semibold).monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Bell wiggle compat (compact glyph)

/// Mirrors `ADELiveActivityPrimitives.BellWiggle` but exposed here so the
/// non-primitive compact glyph (which is a plain Image, not AttentionBadge)
/// can reuse the same 2.2s keyframe track on iOS 17+. iOS 16 falls through.
@available(iOS 16.2, *)
private struct BellWiggleCompat: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if active, #available(iOS 17.0, *) {
            content.keyframeAnimator(
                initialValue: 0.0,
                repeating: true
            ) { view, rotation in
                view.rotationEffect(.degrees(rotation))
            } keyframes: { _ in
                KeyframeTrack {
                    LinearKeyframe(0, duration: 1.32)
                    CubicKeyframe(-14, duration: 0.176)
                    CubicKeyframe(12, duration: 0.176)
                    CubicKeyframe(-8, duration: 0.176)
                    CubicKeyframe(5, duration: 0.176)
                    CubicKeyframe(0, duration: 0.176)
                }
            }
        } else {
            content
        }
    }
}

// Previews for WorkspaceCompact/Expanded/LockScreen views live in
// ADELiveActivityPreviews.swift (widgets extension target only) so they can
// reference ADEWidgetPreviewData without forcing that fixture file into the
// main app target.
