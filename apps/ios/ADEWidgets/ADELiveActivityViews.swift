import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// MARK: - Shared styling helpers

@available(iOS 16.2, *)
enum WorkspaceStyle {
    /// Subtle background tint pulled from the most important signal: the
    /// attention (if any) or the focused session. Kept at low alpha so the
    /// system's own Lock Screen material still reads cleanly underneath.
    static func lockBackgroundTint(for state: ADESessionAttributes.ContentState) -> Color {
        let base: Color
        if let attention = state.attention {
            switch attention.kind {
            case .awaitingInput:
                base = attention.providerSlug.flatMap(ADESharedTheme.brandColor(for:)) ?? ADESharedTheme.statusAttention
            case .failed, .ciFailing:
                base = ADESharedTheme.statusFailed
            case .reviewRequested:
                base = ADESharedTheme.statusAttention
            case .mergeReady:
                base = ADESharedTheme.statusSuccess
            }
        } else if let focused = state.focusedSession {
            base = ADESharedTheme.brandColor(for: focused.providerSlug)
        } else {
            base = ADESharedTheme.statusIdle
        }
        return base.opacity(0.12)
    }

    /// Keyline tint for the Dynamic Island pill — stays bolder than the
    /// lock-screen background since it sits on the true-black hardware.
    static func keylineTint(for state: ADESessionAttributes.ContentState) -> Color {
        if let attention = state.attention {
            switch attention.kind {
            case .awaitingInput:
                return attention.providerSlug.flatMap(ADESharedTheme.brandColor(for:)) ?? ADESharedTheme.statusAttention
            case .failed, .ciFailing:
                return ADESharedTheme.statusFailed
            case .reviewRequested:
                return ADESharedTheme.statusAttention
            case .mergeReady:
                return ADESharedTheme.statusSuccess
            }
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

    /// SF Symbol that matches an attention kind. Chosen to be semantic and
    /// glyph-only (works in the minimal presentation which is an icon).
    static func icon(for kind: ADESessionAttributes.ContentState.Attention.Kind) -> String {
        switch kind {
        case .awaitingInput: return "bell.badge.fill"
        case .failed: return "xmark.octagon.fill"
        case .ciFailing: return "exclamationmark.triangle.fill"
        case .reviewRequested: return "eye.fill"
        case .mergeReady: return "checkmark.seal.fill"
        }
    }

    static func color(for kind: ADESessionAttributes.ContentState.Attention.Kind) -> Color {
        switch kind {
        case .awaitingInput: return ADESharedTheme.statusAttention
        case .failed, .ciFailing: return ADESharedTheme.statusFailed
        case .reviewRequested: return ADESharedTheme.statusAttention
        case .mergeReady: return ADESharedTheme.statusSuccess
        }
    }
}

// MARK: - Compact / minimal (Dynamic Island, always visible)

/// Leading chip: adapts to whatever single signal is most important.
/// - Attention present: SF symbol tinted by kind (pulsing for awaiting-input).
/// - Single session: brand dot with a soft variable-colour effect.
/// - Multi-session: stack of up to 3 brand dots.
@available(iOS 16.2, *)
struct WorkspaceCompactLeading: View {
    let state: ADESessionAttributes.ContentState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let attention = state.attention {
            Image(systemName: WorkspaceStyle.icon(for: attention.kind))
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(WorkspaceStyle.color(for: attention.kind))
                .symbolEffectIfAvailable(pulse: !reduceMotion && attention.kind == .awaitingInput)
                .accessibilityLabel(Text(accessibilityLabel(for: attention)))
        } else if state.sessions.count == 1, let s = state.sessions.first {
            BrandDot(providerSlug: s.providerSlug, size: 14, pulse: !reduceMotion && !s.isFailed)
                .accessibilityLabel(Text("\(s.providerSlug) is working on \(s.title)"))
        } else if !state.sessions.isEmpty {
            StackedBrandDots(slugs: state.sessions.prefix(3).map(\.providerSlug))
                .accessibilityLabel(Text("\(state.sessions.count) chats running"))
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

/// Trailing chip: mirrors compact-leading's state hierarchy but always
/// carries a short piece of *text* information so the pair tells a story.
@available(iOS 16.2, *)
struct WorkspaceCompactTrailing: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        if let attention = state.attention {
            Text(trailingText(for: attention))
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(WorkspaceStyle.color(for: attention.kind))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .accessibilityLabel(Text(trailingText(for: attention)))
        } else if state.sessions.count == 1, let s = state.sessions.first {
            Text(s.startedAt, style: .timer)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(.primary)
                .monospacedDigit()
                .lineLimit(1)
        } else if !state.sessions.isEmpty {
            Text("\(state.sessions.count) chats")
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(.primary)
                .lineLimit(1)
        } else {
            Image(systemName: "moon.zzz.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(ADESharedTheme.statusIdle)
                .accessibilityLabel(Text("Idle"))
        }
    }

    private func trailingText(for a: ADESessionAttributes.ContentState.Attention) -> String {
        switch a.kind {
        case .awaitingInput: return "Approve"
        case .failed: return "Failed"
        case .ciFailing:
            if let pr = a.prNumber { return "CI #\(pr)" }
            return "CI fail"
        case .reviewRequested:
            if let pr = a.prNumber { return "Review #\(pr)" }
            return "Review"
        case .mergeReady:
            if let pr = a.prNumber { return "Merge #\(pr)" }
            return "Merge"
        }
    }
}

/// Minimal presentation — single glyph when the island is shared with
/// another app's activity. Bell badge if attention, count of chats
/// otherwise, app-mark when idle.
@available(iOS 16.2, *)
struct WorkspaceMinimalGlyph: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        if let attention = state.attention {
            Image(systemName: WorkspaceStyle.icon(for: attention.kind))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(WorkspaceStyle.color(for: attention.kind))
                .accessibilityLabel(Text(attention.title))
        } else if state.sessions.count >= 2 {
            ZStack {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ADESharedTheme.statusAttention)
                Text("\(state.sessions.count)")
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundStyle(.black.opacity(0.75))
            }
            .accessibilityLabel(Text("\(state.sessions.count) chats"))
        } else if let only = state.sessions.first {
            BrandDot(providerSlug: only.providerSlug, size: 12, pulse: false)
        } else {
            Image(systemName: "sparkles")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(ADESharedTheme.statusIdle)
        }
    }
}

// MARK: - Expanded regions (Dynamic Island long-press)

@available(iOS 16.2, *)
struct WorkspaceExpandedLeading: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        Group {
            if let attention = state.attention {
                AttentionBadge(attention: attention)
            } else if let focused = state.focusedSession {
                BrandDot(providerSlug: focused.providerSlug, size: 22, pulse: true)
            } else {
                Image(systemName: "sparkles")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(ADESharedTheme.statusIdle)
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
                // When attention is present, trailing is intentionally blank —
                // the action buttons live in the bottom region and compete
                // visually if doubled up here.
                EmptyView()
            } else if state.sessions.count == 1, let s = state.sessions.first {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(s.startedAt, style: .timer)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                    Text("elapsed")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                }
            } else if state.sessions.count >= 2 {
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(state.sessions.count)")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .monospacedDigit()
                    Text("chats")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                }
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
        VStack(alignment: .leading, spacing: 2) {
            if let attention = state.attention {
                Text(attention.title)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                if let subtitle = attention.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } else if let focused = state.focusedSession {
                Text(focused.title.isEmpty ? focused.id : focused.title)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                if let preview = focused.preview, !preview.isEmpty {
                    Text(preview)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else {
                    Text("\(focused.providerSlug.capitalized) is working…")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } else {
                Text(attrs.workspaceName)
                    .font(.system(size: 14, weight: .semibold))
                Text("No active chats")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
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
        if let attention = state.attention {
            AttentionActionRow(attention: attention)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 4)
        } else if state.sessions.count >= 2 {
            RosterStrip(sessions: Array(state.sessions.prefix(4)))
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 4)
        } else {
            WorkspaceGlanceRow(state: state)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
        }
    }
}

// MARK: - Lock Screen

@available(iOS 16.2, *)
struct WorkspaceLockScreenPresentation: View {
    let state: ADESessionAttributes.ContentState
    let attrs: ADESessionAttributes

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header: app mark + workspace name + right-aligned glance counts
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(ADESharedTheme.statusAttention)
                Text("ADE")
                    .font(.system(size: 13, weight: .bold))
                Text("·")
                    .foregroundStyle(.secondary)
                Text(attrs.workspaceName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                WorkspaceGlanceRow(state: state)
            }

            if let attention = state.attention {
                AttentionCard(attention: attention)
                if !state.sessions.isEmpty {
                    Divider().opacity(0.25)
                    VStack(spacing: 5) {
                        ForEach(state.sessions.prefix(3)) { session in
                            RosterRow(session: session, density: .lockScreen)
                        }
                    }
                }
            } else if let focused = state.focusedSession, state.sessions.count == 1 {
                FocusedSessionCard(session: focused)
            } else if !state.sessions.isEmpty {
                VStack(spacing: 6) {
                    ForEach(state.sessions.prefix(4)) { session in
                        RosterRow(session: session, density: .lockScreen)
                    }
                }
            } else {
                Text("Nothing active right now.")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
    }
}

// MARK: - Composable building blocks

@available(iOS 16.2, *)
struct BrandDot: View {
    let providerSlug: String
    var size: CGFloat = 12
    var pulse: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .fill(ADESharedTheme.brandColor(for: providerSlug))
            .frame(width: size, height: size)
            .overlay(
                Circle()
                    .stroke(.white.opacity(0.2), lineWidth: max(1, size / 12))
            )
            .accessibilityHidden(true)
    }
}

@available(iOS 16.2, *)
struct StackedBrandDots: View {
    let slugs: [String]
    var body: some View {
        HStack(spacing: -6) {
            ForEach(Array(slugs.enumerated()), id: \.offset) { _, slug in
                Circle()
                    .fill(ADESharedTheme.brandColor(for: slug))
                    .frame(width: 14, height: 14)
                    .overlay(Circle().stroke(Color.black, lineWidth: 1.5))
            }
        }
        .accessibilityHidden(true)
    }
}

@available(iOS 16.2, *)
struct AttentionBadge: View {
    let attention: ADESessionAttributes.ContentState.Attention
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Circle()
                .fill(WorkspaceStyle.color(for: attention.kind).opacity(0.18))
                .frame(width: 30, height: 30)
            Image(systemName: WorkspaceStyle.icon(for: attention.kind))
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(WorkspaceStyle.color(for: attention.kind))
                .symbolEffectIfAvailable(
                    pulse: !reduceMotion && attention.kind == .awaitingInput
                )
        }
        .accessibilityLabel(Text(attention.title))
    }
}

@available(iOS 16.2, *)
struct AttentionCard: View {
    let attention: ADESessionAttributes.ContentState.Attention

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AttentionBadge(attention: attention)
            VStack(alignment: .leading, spacing: 2) {
                Text(attention.title)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(2)
                if let subtitle = attention.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                AttentionActionRow(attention: attention)
                    .padding(.top, 4)
            }
            Spacer(minLength: 0)
        }
    }
}

@available(iOS 16.2, *)
struct AttentionActionRow: View {
    let attention: ADESessionAttributes.ContentState.Attention

    var body: some View {
        HStack(spacing: 6) {
            switch attention.kind {
            case .awaitingInput:
                if let sessionId = attention.sessionId {
                    ActionChip(
                        label: "Approve",
                        systemImage: "checkmark",
                        tint: ADESharedTheme.statusSuccess,
                        intent: ApproveSessionIntent(sessionId: sessionId, itemId: attention.itemId ?? "")
                    )
                    ActionChip(
                        label: "Deny",
                        systemImage: "xmark",
                        tint: ADESharedTheme.statusFailed,
                        intent: DenySessionIntent(sessionId: sessionId, itemId: attention.itemId ?? "")
                    )
                }
            case .failed:
                if let sessionId = attention.sessionId {
                    ActionChip(
                        label: "Retry",
                        systemImage: "arrow.clockwise",
                        tint: ADESharedTheme.statusAttention,
                        intent: ApproveSessionIntent(sessionId: sessionId, itemId: attention.itemId ?? "")
                    )
                }
            case .ciFailing:
                if let prId = attention.prId, let prNumber = attention.prNumber {
                    ActionChip(
                        label: "Re-run",
                        systemImage: "arrow.clockwise",
                        tint: ADESharedTheme.statusAttention,
                        intent: RetryCheckIntent(prNumber: prNumber, prId: prId)
                    )
                }
            case .reviewRequested, .mergeReady:
                Text("Tap to open")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
            }
        }
    }
}

@available(iOS 16.2, *)
struct ActionChip<Intent: AppIntent>: View {
    let label: String
    let systemImage: String
    let tint: Color
    let intent: Intent

    var body: some View {
        Button(intent: intent) {
            HStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.system(size: 10, weight: .bold))
                Text(label)
                    .font(.system(size: 11, weight: .semibold))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule(style: .continuous)
                    .fill(tint.opacity(0.18))
            )
            .overlay(
                Capsule(style: .continuous)
                    .stroke(tint.opacity(0.35), lineWidth: 0.5)
            )
            .foregroundStyle(tint)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }
}

@available(iOS 16.2, *)
enum RosterDensity {
    case island      // horizontal strip inside Dynamic Island expansion
    case lockScreen  // taller rows on the Lock Screen
}

@available(iOS 16.2, *)
struct RosterRow: View {
    let session: ADESessionAttributes.ContentState.ActiveSession
    let density: RosterDensity

    var body: some View {
        HStack(spacing: 8) {
            BrandDot(
                providerSlug: session.providerSlug,
                size: density == .island ? 8 : 12,
                pulse: !session.isFailed
            )
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title.isEmpty ? session.id : session.title)
                    .font(.system(size: density == .island ? 11 : 12, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                if density == .lockScreen, let preview = session.preview, !preview.isEmpty {
                    Text(preview)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            statusBadge
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(accessibilityLabel))
    }

    @ViewBuilder
    private var statusBadge: some View {
        if session.isAwaitingInput {
            Label("approve", systemImage: "bell.badge.fill")
                .labelStyle(.iconOnly)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(ADESharedTheme.statusAttention)
        } else if session.isFailed {
            Image(systemName: "xmark.octagon.fill")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ADESharedTheme.statusFailed)
        } else {
            Text(session.startedAt, style: .timer)
                .font(.system(size: 10, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .lineLimit(1)
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

@available(iOS 16.2, *)
struct RosterStrip: View {
    let sessions: [ADESessionAttributes.ContentState.ActiveSession]

    var body: some View {
        VStack(spacing: 4) {
            ForEach(sessions) { session in
                RosterRow(session: session, density: .island)
            }
        }
    }
}

@available(iOS 16.2, *)
struct FocusedSessionCard: View {
    let session: ADESessionAttributes.ContentState.ActiveSession

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            BrandDot(providerSlug: session.providerSlug, size: 22, pulse: !session.isFailed)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title.isEmpty ? session.id : session.title)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                if let preview = session.preview, !preview.isEmpty {
                    Text(preview)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                } else {
                    Text("\(session.providerSlug.capitalized) is working…")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 10) {
                    if let p = session.progress {
                        ProgressView(value: min(max(p, 0), 1))
                            .progressViewStyle(.linear)
                            .tint(ADESharedTheme.brandColor(for: session.providerSlug))
                            .frame(width: 90)
                    }
                    Text(session.startedAt, style: .timer)
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
    }
}

/// Tiny row of PR-state counts. Hidden when everything is zero.
@available(iOS 16.2, *)
struct WorkspaceGlanceRow: View {
    let state: ADESessionAttributes.ContentState

    var body: some View {
        if state.pendingPrCount > 0 {
            HStack(spacing: 6) {
                if state.failingCheckCount > 0 {
                    GlanceChip(
                        systemImage: "exclamationmark.triangle.fill",
                        tint: ADESharedTheme.statusFailed,
                        value: state.failingCheckCount,
                        label: "CI"
                    )
                }
                if state.awaitingReviewCount > 0 {
                    GlanceChip(
                        systemImage: "eye.fill",
                        tint: ADESharedTheme.statusAttention,
                        value: state.awaitingReviewCount,
                        label: "review"
                    )
                }
                if state.mergeReadyCount > 0 {
                    GlanceChip(
                        systemImage: "checkmark.seal.fill",
                        tint: ADESharedTheme.statusSuccess,
                        value: state.mergeReadyCount,
                        label: "merge"
                    )
                }
            }
        }
    }
}

@available(iOS 16.2, *)
struct GlanceChip: View {
    let systemImage: String
    let tint: Color
    let value: Int
    let label: String

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage)
                .font(.system(size: 9, weight: .bold))
            Text("\(value)")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .monospacedDigit()
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(
            Capsule(style: .continuous).fill(tint.opacity(0.14))
        )
        .accessibilityLabel(Text("\(value) \(label)"))
    }
}

// MARK: - Symbol-effect compatibility shim

/// `.symbolEffect(.pulse)` and `.variableColor` are iOS 17+. These helpers
/// no-op gracefully on 16.2/16.3 so the Activity still compiles and renders
/// without the animation.
@available(iOS 16.2, *)
extension View {
    @ViewBuilder
    func symbolEffectIfAvailable(pulse: Bool = false) -> some View {
        if #available(iOS 17.0, *), pulse {
            self.symbolEffect(.pulse, options: .repeating)
        } else {
            self
        }
    }
}
