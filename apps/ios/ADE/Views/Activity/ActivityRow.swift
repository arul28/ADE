import SwiftUI

/// The one Activity row.
///
/// The drawer list used to invent its own anatomy. It now uses the Work
/// session card: lane on the first line with the status slot hard against the
/// trailing edge, title on the second, last line underneath. Every field
/// comes from `ActivityRowPresentation` so the drawer and the widget cannot
/// describe one session two ways.
///
/// Colours are resolved here rather than in the presentation so the mapper can
/// stay iOS-17-safe and design-system-free.
// `activityToneColor` lives in `ADE/Shared/ActivityWidgetPresentation.swift` so
// the widget extension can read the same table; it is not app-only.

/// Whether this row is currently waking its machine, and what to say if it
/// could not.
///
/// Cross-machine open used to connect only AFTER the drawer dismissed, inside
/// the navigation handler — so on a cold remote machine the tap looked dead for
/// several seconds and then the screen changed for no visible reason. The wait
/// is unavoidable; hiding it was not.
enum ActivityRowConnectState: Equatable {
    case idle
    case connecting(String)
    case unreachable(String)
}

struct ActivityRow: View {
    let row: ActivityRowPresentation
    /// Rows belonging to an offline machine recede — the banner above them
    /// carries the explanation, so the rows only need to stop competing.
    var dimmed: Bool = false
    var connectState: ActivityRowConnectState = .idle
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            regularContent
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(dimmed ? 0.55 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(row.isPullRequest ? "Opens the pull request." : "Opens the session.")
    }

    private var connectAccessibilitySuffix: String? {
        switch connectState {
        case .idle: return nil
        case .connecting(let machine): return "connecting to \(machine)"
        case .unreachable(let machine): return "could not reach \(machine)"
        }
    }

    /// Everything the row shows visually, in words. The offline state is carried
    /// only by `dimmed`'s opacity and the plan bar/status note are dropped by
    /// `.combine`'s label override, so without them VoiceOver hears strictly
    /// less than a sighted reader sees.
    private var accessibilityLabel: String {
        var parts = [row.title, row.phaseLabel, row.scopeLabel]
        // The provider left `scopeLine` wherever the mark could take over that
        // line, and a logo is not readable — so it is spoken here instead and
        // VoiceOver still hears which agent this is.
        //
        // `row.providerName` is nil on a pull-request row, which is the same
        // gate `row.providerMark` applies. The two used to be gated
        // separately and only the visual half was: a PR row showed no mark and
        // still SPOKE "GitHub", so VoiceOver heard a provider the screen never
        // claimed. One rule on the presentation now decides both.
        if let provider = row.providerName {
            parts.append(provider)
        }
        if let connect = connectAccessibilitySuffix { parts.append(connect) }
        if let note = row.statusDetail { parts.append(note) }
        if let progress = row.planProgress, progress.total > 0 {
            parts.append("step \(progress.completed) of \(progress.total)")
        }
        if let model = row.modelLabel { parts.append(model) }
        parts.append(row.machineOnline ? "machine online" : "machine offline")
        return parts.joined(separator: ", ")
    }

    // MARK: - Regular

    /// A Work session card, not a bespoke Activity row.
    ///
    /// This surface used to invent its own anatomy: a big tinted state disc on
    /// the leading edge, a headline, and a meta line that restated the state in
    /// words. Stacked under a state section header, inside a state filter, that
    /// meant one session announced "working" four times — the filter chip, the
    /// section heading, the leading disc, and the trailing label — in a list
    /// where nothing else was competing for the space.
    ///
    /// The Work tab already solved this: lane on the first line with the ONE
    /// status slot hard against the trailing edge, title on the second, last
    /// line underneath. Same three lines here, and the same
    /// `WorkSessionRowStatusSlot` instance rather than a lookalike, so the two
    /// lists cannot drift into describing one session two ways. The leading
    /// disc is gone: the slot is where state lives.
    private var regularContent: some View {
        VStack(alignment: .leading, spacing: 3) {
            lineOne
            lineTwo
            lineThree
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            ADEColor.surfaceBackground.opacity(0.6),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }

    /// Lane, then the floor, then the status slot.
    ///
    /// The same layout contract the Work card documents: exactly one child is
    /// flexible (the floor label's frame) and everything else is `.fixedSize()`,
    /// which is what guarantees the status slot never truncates and never
    /// degrades to a bare glyph no matter how long the lane name is.
    private var lineOne: some View {
        HStack(spacing: 5) {
            if let lane = row.laneName, !lane.isEmpty {
                HStack(spacing: 3) {
                    WorkLaneLogoMark(color: ADEColor.accent, laneIcon: nil, size: 11)
                    Text(lane)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(ADEColor.accent)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Text(row.machineName)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(ADEColor.textMuted)
                .fixedSize()
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 4)
            WorkSessionRowStatusSlot(
                label: row.phaseLabel,
                tone: row.tone,
                glyph: row.glyph,
                showsElapsed: row.showsElapsed,
                elapsedSince: row.showsElapsed ? row.elapsedSince : nil,
                needsYou: row.stateGroup == .needsYou
            )
        }
    }

    private var lineTwo: some View {
        Text(row.title)
            .font(.system(.subheadline, design: .rounded).weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The last line: where this is running and what it is doing, or — mid-tap —
    /// what the connect is doing, with the provider mark hard against the
    /// trailing edge. The connect line REPLACES the scope text rather than
    /// sitting beneath it, so the row cannot grow under the finger that just
    /// touched it.
    ///
    /// The mark matches the one the Work session card puts on its own third
    /// line, at the same opacity — one branded glyph instead of the provider's
    /// name in words, which is what used to lead `scopeLine`.
    ///
    /// `row.providerMark` decides whether there is one, and it and
    /// `row.providerName` read one family table (`ADESharedTheme`), so the
    /// glyph and the VoiceOver word cannot disagree about which providers this
    /// build knows, and neither appears on a pull-request row.
    ///
    /// A provider with no mark of its own renders nothing HERE — but it is not
    /// silent: `scopeLine` keeps leading with its name in that case, so the row
    /// always identifies what is running one way or the other. A generic
    /// terminal glyph standing in for Gemini would be a claim about what is
    /// running, not an omission.
    @ViewBuilder
    private var lineThree: some View {
        HStack(spacing: 6) {
            switch connectState {
            case .idle:
                Text(row.scopeLine)
                    .font(.caption2)
                    .foregroundStyle(ADEColor.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            case .connecting(let machine):
                ActivityRowConnectLine(
                    text: "Connecting to \(machine)…",
                    tint: ADEColor.accent,
                    showsSpinner: true
                )
            case .unreachable(let machine):
                ActivityRowConnectLine(
                    text: "Could not reach \(machine). Tap to retry.",
                    tint: activityToneColor(.amber),
                    showsSpinner: false
                )
            }

            if let assetName = row.providerMark {
                Image(assetName)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 14, height: 14)
                    .opacity(0.75)
                    .fixedSize()
                    // The row's combined label names the provider in words; a
                    // nested image element would make VoiceOver say it twice.
                    .accessibilityHidden(true)
            }
        }

        if let progress = row.planProgress, progress.total > 0 {
            ActivityPlanProgressBar(progress: progress, tone: row.tone)
                .padding(.top, 3)
        }
    }
}

/// The one-line stand-in for the scope line while a machine is being woken.
///
/// Replaces that line rather than sitting under it, so the row cannot grow
/// under the finger that just tapped it and reflow the list mid-gesture.
private struct ActivityRowConnectLine: View {
    let text: String
    let tint: Color
    let showsSpinner: Bool

    var body: some View {
        HStack(spacing: 5) {
            if showsSpinner {
                ProgressView()
                    .controlSize(.mini)
                    .tint(tint)
            } else {
                Image(systemName: "exclamationmark.circle")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(tint)
            }
            Text(text)
                .font(.caption2)
                .foregroundStyle(tint)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        // The row's combined label already carries this; a nested element would
        // make VoiceOver read the machine name twice.
        .accessibilityHidden(true)
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
