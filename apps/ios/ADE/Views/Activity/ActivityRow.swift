import SwiftUI

/// The one Activity row, in two densities.
///
/// `regular` is the drawer/list row; `compact` is the fixed-width card in the
/// hub's "Live now" strip. Both read every field from `ActivityRowPresentation`
/// and nothing else — no service, no snapshot, no transport — so the drawer,
/// the hub, and the widget cannot describe one session three different ways.
///
/// Colours are resolved here rather than in the presentation so the mapper can
/// stay iOS-17-safe and design-system-free.
enum ActivityRowDensity {
    case regular
    case compact
}

// `activityToneColor` lives in `ADE/Shared/ActivityWidgetPresentation.swift` so
// the widget extension can read the same table; it is not app-only.

struct ActivityRow: View {
    let row: ActivityRowPresentation
    var density: ActivityRowDensity = .regular
    /// Rows belonging to an offline machine recede — the banner above them
    /// carries the explanation, so the rows only need to stop competing.
    var dimmed: Bool = false
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            content
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(dimmed ? 0.55 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(row.isPullRequest ? "Opens the pull request." : "Opens the session.")
    }

    private var accessibilityLabel: String {
        var parts = [row.title, row.phaseLabel, row.scopeLabel]
        if let model = row.modelLabel { parts.append(model) }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder
    private var content: some View {
        switch density {
        case .regular: regularContent
        case .compact: compactContent
        }
    }

    // MARK: - Regular

    private var regularContent: some View {
        HStack(alignment: .top, spacing: 11) {
            ActivityProviderMark(slug: row.providerSlug, size: 26, pulse: row.isActive)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(row.title)
                        .font(.system(.subheadline, design: .rounded).weight(.semibold))
                        .foregroundStyle(ADEColor.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    ActivityStatusLabel(row: row)
                }

                if let note = row.statusNote {
                    Text(note)
                        .font(.system(.caption, design: .rounded))
                        .italic()
                        .foregroundStyle(ADEColor.textSecondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }

                if let progress = row.planProgress, progress.total > 0 {
                    ActivityPlanProgressBar(progress: progress, tone: row.tone)
                }

                metaRow
            }
        }
        .padding(.vertical, 9)
    }

    private var metaRow: some View {
        HStack(spacing: 6) {
            if let lane = row.laneName {
                ActivityLaneChip(name: lane)
            }
            ActivityMachineChip(
                name: row.machineName,
                online: row.machineOnline,
                lastSeenLabel: row.lastSeenLabel()
            )
            if let model = row.modelLabel {
                Text(model)
                    .font(.system(.caption2, design: .rounded))
                    .foregroundStyle(ADEColor.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - Compact

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                ActivityProviderMark(slug: row.providerSlug, size: 18, pulse: row.isActive)
                ActivityStatusLabel(row: row)
                Spacer(minLength: 0)
            }

            Text(row.title)
                .font(.system(.footnote, design: .rounded).weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(row.laneName.map { "\($0) · \(row.machineName)" } ?? row.machineName)
                .font(.system(.caption2, design: .rounded))
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
        }
        .padding(11)
        .frame(width: 208, alignment: .leading)
        .background(ADEColor.cardBackground.opacity(0.62), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(
                    row.prominent
                        ? activityToneColor(row.tone).opacity(0.45)
                        : ADEColor.border.opacity(0.8),
                    lineWidth: 1
                )
        )
    }
}

/// Status dot + phase label + the elapsed ticker, in the tone the phase owns.
struct ActivityStatusLabel: View {
    let row: ActivityRowPresentation
    /// Re-renders once a second only while a row is actually ticking.
    @State private var now = Date()

    var body: some View {
        let tint = activityToneColor(row.tone)
        HStack(spacing: 5) {
            ActivityStatusDot(tone: row.tone, active: row.isActive)
            Text(label)
                .font(.system(.caption2, design: .rounded).weight(.semibold).monospacedDigit())
                .foregroundStyle(tint)
                .lineLimit(1)
                .fixedSize()
        }
        .task(id: row.showsElapsed) {
            guard row.showsElapsed else { return }
            while !Task.isCancelled {
                now = Date()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private var label: String {
        guard let elapsed = row.elapsedLabel(now: now) else { return row.phaseLabel }
        return "\(row.phaseLabel) \(elapsed)"
    }
}

struct ActivityStatusDot: View {
    let tone: ActivityTone
    var active: Bool = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let tint = activityToneColor(tone)
        ZStack {
            if active && !reduceMotion {
                Circle()
                    .fill(tint)
                    .frame(width: 7, height: 7)
                    .phaseAnimator([false, true]) { circle, expanded in
                        circle
                            .scaleEffect(expanded ? 2.1 : 1)
                            .opacity(expanded ? 0 : 0.4)
                    } animation: { _ in
                        .easeOut(duration: 1.5)
                    }
            }
            Circle()
                .fill(tint)
                .frame(width: 7, height: 7)
        }
        .frame(width: 7, height: 7)
        .accessibilityHidden(true)
    }
}

/// Provider logo on its brand-tinted disc. Falls back to the ADE mark's neutral
/// disc when the item carries no provider.
struct ActivityProviderMark: View {
    let slug: String?
    let size: CGFloat
    var pulse: Bool = false

    var body: some View {
        let resolved = slug ?? "ade"
        let color = ADESharedTheme.brandColor(for: resolved)
        Circle()
            .fill(color.opacity(0.16))
            .frame(width: size, height: size)
            .overlay {
                if let assetName = ADESharedTheme.providerAssetName(for: resolved) {
                    Image(assetName)
                        .resizable()
                        .scaledToFit()
                        .frame(width: size * 0.66, height: size * 0.66)
                } else {
                    Image(systemName: "terminal.fill")
                        .font(.system(size: size * 0.46, weight: .semibold))
                        .foregroundStyle(color)
                }
            }
            .overlay(Circle().strokeBorder(color.opacity(0.3), lineWidth: 0.7))
            .accessibilityHidden(true)
    }
}

/// Neutral tower glyph + machine name. Machine identity is deliberately not
/// tinted: amber means "your move" and nothing else, so it can never also mean
/// "this ran somewhere else".
struct ActivityMachineChip: View {
    let name: String
    let online: Bool
    var lastSeenLabel: String?

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: online ? "desktopcomputer" : "wifi.slash")
                .font(.system(size: 8, weight: .semibold))
            Text(lastSeenLabel.map { "\(name) · \($0)" } ?? name)
                .font(.system(.caption2, design: .rounded).weight(.medium))
                .lineLimit(1)
        }
        .foregroundStyle(online ? ADEColor.textSecondary : ADEColor.textMuted)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(ADEColor.surfaceBackground.opacity(online ? 0.7 : 0.45), in: Capsule())
    }
}

struct ActivityLaneChip: View {
    let name: String

    var body: some View {
        Text(name)
            .font(.system(.caption2, design: .rounded).weight(.medium))
            .foregroundStyle(ADEColor.accent)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(ADEColor.accent.opacity(0.12), in: Capsule())
    }
}

/// The plan bar iOS carried in the contract and never rendered: "3 of 7" plus
/// the current step, over a hairline track.
struct ActivityPlanProgressBar: View {
    let progress: AccountAttentionPlanProgress
    let tone: ActivityTone

    private var fraction: Double {
        guard progress.total > 0 else { return 0 }
        return min(1, max(0, Double(progress.completed) / Double(progress.total)))
    }

    var body: some View {
        let tint = activityToneColor(tone)
        VStack(alignment: .leading, spacing: 3) {
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(ADEColor.recessedBackground)
                    Capsule()
                        .fill(tint.opacity(0.75))
                        .frame(width: max(2, geometry.size.width * fraction))
                }
            }
            .frame(height: 3)

            HStack(spacing: 5) {
                Text("\(progress.completed) of \(progress.total)")
                    .font(.system(.caption2, design: .rounded).weight(.semibold).monospacedDigit())
                    .foregroundStyle(ADEColor.textSecondary)
                if let current = progress.current, !current.isEmpty {
                    Text(current)
                        .font(.system(.caption2, design: .rounded))
                        .foregroundStyle(ADEColor.textMuted)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Plan progress: \(progress.completed) of \(progress.total)")
    }
}

/// Inline banner above the rows of a machine that is no longer reachable. The
/// rows below it dim rather than disappear — an offline machine's work still
/// happened, it just cannot be acted on from here.
struct ActivityOfflineMachineBanner: View {
    let machineName: String
    let lastSeenLabel: String?

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ADEColor.textMuted)
            Text(lastSeenLabel.map { "\(machineName) · \($0)" } ?? machineName)
                .font(.system(.caption2, design: .rounded).weight(.semibold))
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            Rectangle()
                .fill(ADEColor.border.opacity(0.55))
                .frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(machineName) is offline. \(lastSeenLabel ?? "")")
    }
}
