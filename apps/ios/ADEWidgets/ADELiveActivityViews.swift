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
        Group {
            if let attention = state.attention {
                let tint = WorkspaceStyle.attentionTint(for: attention)
                Image(systemName: AttentionIcon.symbol(for: attention.kind))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tint)
                    .modifier(BellWiggleCompat(active: !reduceMotion && attention.kind == .awaitingInput))
                    .accessibilityLabel(Text(accessibilityLabel(for: attention)))
            } else if !state.sessions.isEmpty {
                // One or many active sessions — single pulsing green dot, like the
                // desktop session-status indicator.
                ActiveDotMini(
                    color: ADESharedTheme.statusSuccess,
                    pulse: !reduceMotion
                )
                .accessibilityLabel(Text("\(state.sessions.count) running"))
            } else {
                Image(systemName: "sparkles")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ADESharedTheme.statusIdle)
                    .accessibilityLabel(Text("ADE"))
            }
        }
        .frame(maxWidth: 50, maxHeight: 38)
        .dynamicTypeSize(.small ... .large)
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
        Group {
            if let attention = state.attention {
                let tint = WorkspaceStyle.attentionTint(for: attention)
                Text(WorkspaceStyle.shortLabel(for: attention))
                    .font(.system(size: 12, weight: .semibold).monospacedDigit())
                    .kerning(-0.2)
                    .foregroundStyle(tint)
                    .shadow(color: tint.opacity(0.5), radius: 4, x: 0, y: 0)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .minimumScaleFactor(0.85)
                    .frame(maxWidth: 96, alignment: .trailing)
                    .accessibilityLabel(Text(WorkspaceStyle.shortLabel(for: attention)))
            } else if state.sessions.count >= 2 {
                Text("\(state.sessions.count) running")
                    .font(.system(size: 12, weight: .semibold).monospacedDigit())
                    .kerning(-0.2)
                    .foregroundStyle(ADESharedTheme.statusSuccess)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .minimumScaleFactor(0.85)
                    .frame(maxWidth: 96, alignment: .trailing)
            } else if state.sessions.count == 1, let s = state.sessions.first {
                // Single active session — show the chat title compactly.
                Text(s.title.isEmpty ? s.providerSlug : s.title)
                    .font(.system(size: 12, weight: .semibold))
                    .kerning(-0.2)
                    .foregroundStyle(Color(red: 0xF0/255, green: 0xF0/255, blue: 0xF2/255))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .minimumScaleFactor(0.85)
                    .frame(maxWidth: 96, alignment: .trailing)
            } else {
                Image(systemName: "moon.zzz.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ADESharedTheme.statusIdle)
                    .accessibilityLabel(Text("Idle"))
            }
        }
        .frame(maxWidth: 96, maxHeight: 38, alignment: .trailing)
        .dynamicTypeSize(.small ... .large)
    }
}

/// Single small pulsing dot for the Dynamic Island compact leading region.
@available(iOS 16.2, *)
private struct ActiveDotMini: View {
    let color: Color
    let pulse: Bool

    var body: some View {
        ZStack {
            if pulse, #available(iOS 17.0, *) {
                Circle()
                    .fill(color)
                    .frame(width: 10, height: 10)
                    .phaseAnimator([0, 1]) { circle, phase in
                        circle
                            .scaleEffect(phase == 0 ? 1.0 : 1.6)
                            .opacity(phase == 0 ? 0.45 : 0)
                    } animation: { _ in
                        .easeOut(duration: 1.4)
                    }
            }
            Circle()
                .fill(color)
                .frame(width: 10, height: 10)
                .shadow(color: color.opacity(0.55), radius: 3)
        }
        .frame(width: 12, height: 12)
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
        .dynamicTypeSize(.small ... .large)
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
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .foregroundStyle(color)
                .frame(maxWidth: 22)
        } else if !state.sessions.isEmpty {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
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
                let tint = WorkspaceStyle.attentionTint(for: attention)
                Image(systemName: AttentionIcon.symbol(for: attention.kind))
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 28, height: 28)
                    .background(
                        Circle().fill(tint.opacity(0.13))
                    )
            } else if !state.sessions.isEmpty {
                ActiveDotMini(color: ADESharedTheme.statusSuccess, pulse: true)
                    .scaleEffect(1.4)
                    .frame(width: 28, height: 28)
            } else {
                Image(systemName: "sparkles")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(ADESharedTheme.brandCursor)
                    .frame(width: 28, height: 28)
            }
        }
        .frame(maxWidth: 100, alignment: .leading)
        .padding(.leading, 4)
        .dynamicTypeSize(.small ... .large)
    }
}

@available(iOS 16.2, *)
struct WorkspaceExpandedTrailing: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        Group {
            if state.attention != nil {
                EmptyView()
            } else if state.sessions.count >= 2 {
                VStack(alignment: .trailing, spacing: 1) {
                    Text("\(state.sessions.count)")
                        .font(.system(size: 16, weight: .bold).monospacedDigit())
                        .foregroundStyle(ADESharedTheme.statusSuccess)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                    Text("running")
                        .font(.system(size: 9, weight: .semibold))
                        .textCase(.lowercase)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
            } else {
                EmptyView()
            }
        }
        .frame(maxWidth: 90, alignment: .trailing)
        .padding(.trailing, 4)
        .dynamicTypeSize(.small ... .large)
    }
}

@available(iOS 16.2, *)
struct WorkspaceExpandedCenter: View {
    let state: ADESessionAttributes.ContentState
    let attrs: ADESessionAttributes

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let attention = state.attention {
                Text(attention.title)
                    .font(.system(size: 14, weight: .semibold))
                    .kerning(-0.1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .minimumScaleFactor(0.85)
                if let subtitle = attention.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .minimumScaleFactor(0.85)
                }
            } else if let focused = state.focusedSession {
                Text(focused.title.isEmpty ? focused.id : focused.title)
                    .font(.system(size: 14, weight: .semibold))
                    .kerning(-0.1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .minimumScaleFactor(0.85)
                Text(focusedSubtitle(focused))
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .minimumScaleFactor(0.85)
            } else {
                // Coordinator tears the activity down when nothing is
                // active, so this branch is theoretically unreachable.
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
        .dynamicTypeSize(.small ... .large)
    }

    private func focusedSubtitle(_ focused: ADESessionAttributes.ContentState.ActiveSession) -> String {
        let provider = focused.providerSlug.lowercased()
        if let preview = focused.preview, !preview.isEmpty {
            return "\(provider) · \(preview)"
        }
        return "\(provider) · working…"
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
        .dynamicTypeSize(.small ... .large)
    }
}

// MARK: - Lock Screen

/// Edge-to-edge glass card. The system frames the whole thing with the app
/// name + icon already, so we don't repeat them here. Layout: optional
/// attention card → active-sessions roster → counts strip (waiting / idle /
/// PR glance).
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
            LinearGradient(
                colors: [tint.opacity(0.12), .clear],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .allowsHitTesting(false)

            RadialGradient(
                colors: [tint.opacity(0.18), .clear],
                center: UnitPoint(x: 0.08, y: 0.08),
                startRadius: 0,
                endRadius: 220
            )
            .allowsHitTesting(false)

            content
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(.ultraThinMaterial)
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
                .allowsHitTesting(false)
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .dynamicTypeSize(.small ... .accessibility1)
    }

    @ViewBuilder
    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let attention = state.attention {
                AttentionLockCard(attention: attention)
            }
            if !state.sessions.isEmpty {
                VStack(spacing: 8) {
                    ForEach(state.sessions.prefix(state.attention == nil ? 4 : 2)) { session in
                        LockRosterRow(session: session)
                    }
                }
            }
            if hasCounts {
                CountsStrip(state: state)
            }
        }
    }

    private var hasCounts: Bool {
        state.awaitingInputCount > 0
            || state.idleCount > 0
            || state.failingCheckCount > 0
            || state.awaitingReviewCount > 0
            || state.mergeReadyCount > 0
    }
}

// MARK: - Lock-screen building blocks

@available(iOS 16.2, *)
private struct AttentionLockCard: View {
    let attention: ADESessionAttributes.ContentState.Attention

    var body: some View {
        let tint = WorkspaceStyle.attentionTint(for: attention)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: AttentionIcon.symbol(for: attention.kind))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 18, height: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(attention.title)
                        .font(.system(size: 13.5, weight: .semibold))
                        .kerning(-0.1)
                        .lineLimit(1)
                    if let subtitle = attention.subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.system(size: 11, weight: .medium).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            AttentionActionRow(attention: attention, compact: false)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(tint.opacity(0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(tint.opacity(0.25), lineWidth: 0.5)
        )
    }
}

/// Single-line roster entry, modelled after the desktop `SessionCard`. Each
/// row in this list is *actively running* — the SyncService filter guarantees
/// it — so the only state to render is "running" (pulsing green dot) or the
/// rare "failed" terminal state.
@available(iOS 16.2, *)
private struct LockRosterRow: View {
    let session: ADESessionAttributes.ContentState.ActiveSession
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            ActiveDot(failed: session.isFailed, pulse: !reduceMotion && !session.isFailed)
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
            .frame(maxWidth: .infinity, alignment: .leading)
            if session.isFailed {
                Text("failed")
                    .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                    .foregroundStyle(ADESharedTheme.statusFailed)
            }
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

    private var accessibilityLabel: String {
        if session.isFailed {
            return "\(session.providerSlug) on \(session.title), failed"
        }
        return "\(session.providerSlug) on \(session.title), running"
    }
}

/// 8pt status dot. Solid green with a soft phased halo when running, solid red
/// when failed. Mirrors the desktop session-status dot.
@available(iOS 16.2, *)
private struct ActiveDot: View {
    let failed: Bool
    let pulse: Bool

    var body: some View {
        let color: Color = failed ? ADESharedTheme.statusFailed : ADESharedTheme.statusSuccess
        ZStack {
            if pulse, #available(iOS 17.0, *) {
                Circle()
                    .fill(color)
                    .frame(width: 8, height: 8)
                    .phaseAnimator([0, 1]) { circle, phase in
                        circle
                            .scaleEffect(phase == 0 ? 1.0 : 1.7)
                            .opacity(phase == 0 ? 0.45 : 0)
                    } animation: { _ in
                        .easeOut(duration: 1.5)
                    }
            }
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
                .shadow(color: color.opacity(0.55), radius: 3)
        }
        .frame(width: 8, height: 8)
        .accessibilityHidden(true)
    }
}

/// Counts row shown beneath the roster: waiting-for-input + idle chats + the
/// existing PR glance. Kept terse — small all-caps labels with monospaced
/// digits, like the desktop status pills.
@available(iOS 16.2, *)
private struct CountsStrip: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        HStack(spacing: 6) {
            if state.awaitingInputCount > 0 {
                CountChip(
                    icon: "bell.fill",
                    label: chatLabel(state.awaitingInputCount, "waiting"),
                    color: ADESharedTheme.warningAmber
                )
            }
            if state.idleCount > 0 {
                CountChip(
                    icon: "moon.zzz.fill",
                    label: chatLabel(state.idleCount, "idle"),
                    color: ADESharedTheme.statusIdle
                )
            }
            if state.failingCheckCount > 0 {
                CountChip(
                    icon: "exclamationmark.triangle.fill",
                    label: "\(state.failingCheckCount) ci",
                    color: ADESharedTheme.statusFailed
                )
            }
            if state.awaitingReviewCount > 0 {
                CountChip(
                    icon: "eye.fill",
                    label: "\(state.awaitingReviewCount) review",
                    color: ADESharedTheme.warningAmber
                )
            }
            if state.mergeReadyCount > 0 {
                CountChip(
                    icon: "checkmark.seal.fill",
                    label: "\(state.mergeReadyCount) ready",
                    color: ADESharedTheme.statusSuccess
                )
            }
            Spacer(minLength: 0)
        }
    }

    private func chatLabel(_ count: Int, _ verb: String) -> String {
        "\(count) \(verb)"
    }
}

@available(iOS 16.2, *)
private struct CountChip: View {
    let icon: String
    let label: String
    let color: Color

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 9, weight: .bold))
            Text(label)
                .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                .textCase(.lowercase)
        }
        .foregroundStyle(color)
        .padding(.vertical, 3)
        .padding(.horizontal, 7)
        .background(
            Capsule(style: .continuous).fill(color.opacity(0.13))
        )
    }
}

// MARK: - Dynamic Island expanded-bottom building blocks

@available(iOS 16.2, *)
private struct ExpandedRosterStrip: View {
    let sessions: [ADESessionAttributes.ContentState.ActiveSession]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 7) {
            ForEach(sessions) { session in
                HStack(spacing: 10) {
                    ActiveDot(failed: session.isFailed, pulse: !reduceMotion && !session.isFailed)
                    Text(session.title.isEmpty ? session.id : session.title)
                        .font(.system(size: 12, weight: .semibold))
                        .kerning(-0.1)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(session.providerSlug.lowercased())
                        .font(.system(size: 10.5, weight: .medium).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
    }
}

@available(iOS 16.2, *)
private struct FocusedCardBottom: View {
    let session: ADESessionAttributes.ContentState.ActiveSession
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 8) {
            ActiveDot(failed: session.isFailed, pulse: !reduceMotion && !session.isFailed)
            Text(subtitle)
                .font(.system(size: 11, weight: .medium).monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var subtitle: String {
        let provider = session.providerSlug.lowercased()
        if let preview = session.preview, !preview.isEmpty {
            return "\(provider) · \(preview)"
        }
        return "\(provider) · working…"
    }
}

@available(iOS 16.2, *)
private struct ExpandedGlanceStrip: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        // Re-uses the same chips rendered on the Lock Screen so the visual
        // language is identical across surfaces.
        CountsStrip(state: state)
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
