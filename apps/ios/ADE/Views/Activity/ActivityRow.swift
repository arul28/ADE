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
    /// The compact card is a fixed width so the strip scrolls predictably; it
    /// still has to grow with the text inside it or the title clips at AX sizes.
    @ScaledMetric(relativeTo: .footnote) private var compactCardWidth: CGFloat = 208

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

    /// Everything the row shows visually, in words. The offline state is carried
    /// only by `dimmed`'s opacity and the plan bar/status note are dropped by
    /// `.combine`'s label override, so without them VoiceOver hears strictly
    /// less than a sighted reader sees.
    private var accessibilityLabel: String {
        var parts = [row.title, row.phaseLabel, row.scopeLabel]
        if let note = row.statusNote { parts.append(note) }
        if let progress = row.planProgress, progress.total > 0 {
            parts.append("step \(progress.completed) of \(progress.total)")
        }
        if let model = row.modelLabel { parts.append(model) }
        parts.append(row.machineOnline ? "machine online" : "machine offline")
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
            ActivityStateMark(
                glyph: row.glyph,
                tone: row.tone,
                size: 26,
                pulse: row.isActive
            )

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(row.title)
                        .font(.system(.subheadline, design: .rounded).weight(.semibold))
                        .foregroundStyle(ADEColor.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
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
            ActivityModelChip(slug: row.providerSlug, model: row.modelLabel)
            Spacer(minLength: 0)
        }
    }

    // MARK: - Compact

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                ActivityStateMark(
                    glyph: row.glyph,
                    tone: row.tone,
                    size: 18,
                    pulse: row.isActive
                )
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
        .frame(minHeight: 44)
        .frame(width: compactCardWidth, alignment: .leading)
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

/// Phase label + the elapsed ticker, in the tone the phase owns.
///
/// There is no status dot any more: the row's leading `ActivityStateMark`
/// already carries the state in that tone, and a coloured dot next to a
/// coloured state glyph said the same thing twice — less clearly the second
/// time.
struct ActivityStatusLabel: View {
    let row: ActivityRowPresentation
    /// Re-renders once a second only while a row is actually ticking.
    @State private var now = Date()

    var body: some View {
        Text(label)
            .font(.system(.caption2, design: .rounded).weight(.semibold).monospacedDigit())
            .foregroundStyle(activityToneColor(row.tone))
            .lineLimit(1)
            .fixedSize()
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

/// The row's leading mark: the *state* glyph on a tone-tinted disc, pulsing
/// while the work is live on a reachable machine.
///
/// This was the provider logo. A drawer of Claude sessions rendered a column of
/// identical marks that told the reader nothing, while the fact that actually
/// differed between the rows — which of five states each was in — was left to a
/// small word at the far right. Provider is metadata now, and lives in the meta
/// row beside the lane and the machine.
struct ActivityStateMark: View {
    let glyph: ActivityGlyph?
    let tone: ActivityTone
    let size: CGFloat
    var pulse: Bool = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let color = activityToneColor(tone)
        ZStack {
            if pulse && !reduceMotion {
                Circle()
                    .stroke(color.opacity(0.55), lineWidth: 1)
                    .frame(width: size, height: size)
                    .phaseAnimator([false, true]) { ring, expanded in
                        ring
                            .scaleEffect(expanded ? 1.35 : 1)
                            .opacity(expanded ? 0 : 0.7)
                    } animation: { _ in
                        .easeOut(duration: 1.6)
                    }
            }
            Circle()
                .fill(color.opacity(0.16))
                .frame(width: size, height: size)
                .overlay {
                    Image(systemName: glyph?.systemImage ?? "circle.fill")
                        .font(.system(size: size * 0.46, weight: .semibold))
                        .foregroundStyle(color)
                }
                .overlay(Circle().strokeBorder(color.opacity(0.32), lineWidth: 0.7))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Who ran it, at meta-row scale: the provider's brand mark beside the model
/// id. One chip rather than two, because "Claude" and "claude-opus-5" side by
/// side spend two chips saying one thing.
///
/// Never the primary identity of a row — that is the state, and it lives in the
/// `ActivityStateMark` at the leading edge.
struct ActivityModelChip: View {
    let slug: String?
    let model: String?

    var body: some View {
        if let label = model ?? slug.flatMap({ ADESharedTheme.providerDisplayName(for: $0) }) {
            let color = ADESharedTheme.brandColor(for: slug ?? "ade")
            HStack(spacing: 4) {
                if let slug, let assetName = ADESharedTheme.providerAssetName(for: slug) {
                    Image(assetName)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 10, height: 10)
                } else {
                    Circle()
                        .fill(color)
                        .frame(width: 5, height: 5)
                }
                Text(label)
                    .font(.system(.caption2, design: .rounded).weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(color.opacity(0.1), in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
        }
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
                .font(.system(.caption2, design: .rounded).weight(.semibold))
                .accessibilityHidden(true)
            Text(lastSeenLabel.map { "\(name) · \($0)" } ?? name)
                .font(.system(.caption2, design: .rounded).weight(.medium))
                .lineLimit(1)
        }
        .foregroundStyle(online ? ADEColor.textSecondary : ADEColor.textMuted)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(ADEColor.surfaceBackground.opacity(online ? 0.7 : 0.45), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            [name, online ? "online" : "offline", lastSeenLabel.map { "last seen \($0)" }]
                .compactMap { $0 }
                .joined(separator: ", ")
        )
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
        .accessibilityLabel(
            "Plan progress: \(progress.completed) of \(progress.total)"
                + (progress.current.flatMap { $0.isEmpty ? nil : ", \($0)" } ?? "")
        )
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
                .font(.system(.caption2, design: .rounded).weight(.semibold))
                .foregroundStyle(ADEColor.textMuted)
                .accessibilityHidden(true)
            Text(lastSeenLabel.map { "\(machineName) · \($0)" } ?? machineName)
                .font(.system(.caption2, design: .rounded).weight(.semibold))
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            Rectangle()
                .fill(ADEColor.border.opacity(0.55))
                .frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            lastSeenLabel.map { "\(machineName) is offline. Last seen \($0)." }
                ?? "\(machineName) is offline."
        )
    }
}
