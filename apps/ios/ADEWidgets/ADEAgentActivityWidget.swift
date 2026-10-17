import ActivityKit
import SwiftUI
import WidgetKit

/// The account-wide "agent runs" Live Activity: four column tiles in one row —
/// Needs you, Working, Waiting, Done — each an SF Symbol, a big number and a
/// label in the column's colour. The same four states the Hub, the Activity
/// drawer and the Work board count by. No rows, no pull-request chips, no
/// machine label: the lock screen says how many, and a tap on a tile opens the
/// drawer filtered to that column.
struct ADEAgentActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ADEAgentRunsAttributes.self) { context in
            ActivityColumnsLockScreenView(
                presentation: ActivityColumnsPresentation(
                    state: context.state,
                    attributes: context.attributes,
                    isStale: context.isStale
                )
            )
            .activityBackgroundTint(Color.black.opacity(0.28))
            .activitySystemActionForegroundColor(.primary)
        } dynamicIsland: { context in
            let presentation = ActivityColumnsPresentation(
                state: context.state,
                attributes: context.attributes,
                isStale: context.isStale
            )
            return DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    ActivityColumnTiles(
                        counts: presentation.counts,
                        dimmed: !presentation.assertsCounts,
                        style: .island
                    )
                    // The expanded island's corners are rounder than a banner;
                    // the inset keeps the outer tiles inside the capsule.
                    .padding(.horizontal, 6)
                    .padding(.bottom, 4)
                }
            } compactLeading: {
                ActivityColumnCompactCount(entry: presentation.compactLeading)
            } compactTrailing: {
                ActivityColumnCompactCount(entry: presentation.compactTrailing)
            } minimal: {
                Image(systemName: presentation.compactLeading?.column.systemImage
                    ?? ActivityBoardColumn.working.systemImage)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(presentation.leadTint)
                    .accessibilityLabel(presentation.accessibilitySummary)
            }
            .widgetURL(presentation.destinationURL)
            .keylineTint(presentation.leadTint)
        }
    }
}

// MARK: - Presentation model

struct ActivityColumnsPresentation {
    /// All four columns, zeros included.
    let counts: [ActivityBoardColumn: Int]
    let isStale: Bool
    let ownershipAccepted: Bool
    /// How much this frame may claim, given how old it is. A Live Activity
    /// changes only when a push or the foreground app writes it, so an
    /// hours-old frame must not present its numbers as current.
    let freshness: ActivityWidgetPresentation.Freshness

    var assertsCounts: Bool { ownershipAccepted && freshness.confidence != .untrusted }

    init(state: ADEAgentRunsAttributes.ContentState, attributes: ADEAgentRunsAttributes, isStale: Bool) {
        let accountWide = attributes.isAccountWide
        let ownership = ADESharedContainer.readAccountDeviceOwnershipState()
        let ownershipAccepted = !accountWide
            || adeAccountWideActivityMatchesCurrentOwnership(
                attributesEpoch: attributes.ownershipEpoch,
                contentEpoch: state.ownershipEpoch,
                currentEpoch: ownership?.ownershipEpoch,
                hasCurrentOwner: ownership?.ownerId != nil
            )
        // A frame from a previous account owner shows zeros, never its counts,
        // until the app ends it.
        self.counts = ownershipAccepted
            ? state.resolvedColumns
            : Dictionary(uniqueKeysWithValues: ActivityBoardColumn.allCases.map { ($0, 0) })
        self.ownershipAccepted = ownershipAccepted
        self.isStale = ownershipAccepted && isStale
        self.freshness = ActivityWidgetPresentation.freshness(generatedAt: state.updatedAtDate)
    }

    struct CompactEntry: Equatable {
        let column: ActivityBoardColumn
        let count: Int
    }

    /// Needs you when anything needs you, else Working.
    var compactLeading: CompactEntry? {
        let needsYou = counts[.needsYou, default: 0]
        if needsYou > 0 { return CompactEntry(column: .needsYou, count: needsYou) }
        let working = counts[.working, default: 0]
        return working > 0 ? CompactEntry(column: .working, count: working) : nil
    }

    /// The other of Needs you and Working, when the leading wing showed Needs
    /// you and something is also working. Nothing otherwise.
    var compactTrailing: CompactEntry? {
        guard compactLeading?.column == .needsYou else { return nil }
        let working = counts[.working, default: 0]
        return working > 0 ? CompactEntry(column: .working, count: working) : nil
    }

    var leadTint: Color {
        activityToneColor((compactLeading?.column ?? .working).tone)
    }

    /// The whole frame in words, for VoiceOver on the minimal glyph.
    var accessibilitySummary: String {
        ActivityWidgetPresentation.columnSummary(counts) ?? "No agents working"
    }

    /// The Activity drawer, filtered to the lead column when there is one.
    var destinationURL: URL {
        guard ownershipAccepted, let lead = compactLeading else {
            return ActivityWidgetPresentation.activityURL
        }
        return ActivityWidgetPresentation.activityURL(for: lead.column)
    }
}

// MARK: - Lock screen / banner

private struct ActivityColumnsLockScreenView: View {
    let presentation: ActivityColumnsPresentation

    var body: some View {
        VStack(spacing: 6) {
            ActivityColumnTiles(
                counts: presentation.counts,
                dimmed: !presentation.assertsCounts,
                style: .banner
            )
            if presentation.isStale {
                ActivityColumnsAgeLine(text: "Reconnecting", systemImage: "arrow.triangle.2.circlepath")
            } else if !presentation.ownershipAccepted {
                ActivityColumnsAgeLine(text: "Updating ADE", systemImage: "arrow.triangle.2.circlepath")
            } else if let age = presentation.freshness.label {
                ActivityColumnsAgeLine(text: age, systemImage: "clock")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
    }
}

private struct ActivityColumnsAgeLine: View {
    let text: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.system(size: 9, weight: .semibold))
            Text(text)
                .font(.system(size: 10, weight: .medium))
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

// MARK: - Tiles

/// Four equal tiles in one row, in board order. Shared by the Live Activity
/// banner, the expanded island and the Home Screen widgets so every surface
/// draws the counts the same way.
struct ActivityColumnTiles: View {
    enum Style {
        /// Lock-screen banner: the biggest numbers.
        case banner
        /// Expanded Dynamic Island.
        case island
        /// Home Screen small widget: a two-by-two grid.
        case grid
        /// Home Screen medium widget.
        case widget
    }

    let counts: [ActivityBoardColumn: Int]
    var dimmed = false
    var style: Style = .banner

    var body: some View {
        switch style {
        case .grid:
            VStack(spacing: 6) {
                HStack(spacing: 6) {
                    tile(.needsYou)
                    tile(.working)
                }
                HStack(spacing: 6) {
                    tile(.waiting)
                    tile(.done)
                }
            }
        case .banner, .island, .widget:
            HStack(spacing: style == .island ? 4 : 6) {
                ForEach(ActivityBoardColumn.allCases, id: \.self) { column in
                    tile(column)
                }
            }
        }
    }

    private func tile(_ column: ActivityBoardColumn) -> some View {
        Link(destination: ActivityWidgetPresentation.activityURL(for: column)) {
            ActivityColumnTile(
                column: column,
                count: counts[column, default: 0],
                dimmed: dimmed,
                style: style
            )
        }
    }
}

/// One tile: glyph, big number, label, all in the column colour. A tile with
/// zero dims, so the eye goes to the columns that have something in them.
struct ActivityColumnTile: View {
    let column: ActivityBoardColumn
    let count: Int
    var dimmed = false
    var style: ActivityColumnTiles.Style = .banner

    private var numberSize: CGFloat {
        switch style {
        case .banner: return 26
        case .island: return 22
        case .widget: return 24
        case .grid: return 20
        }
    }

    var body: some View {
        let tint = activityToneColor(column.tone)
        let empty = count == 0
        VStack(spacing: 2) {
            Image(systemName: column.systemImage)
                .font(.system(size: style == .grid ? 11 : 13, weight: .semibold))
            Text("\(min(count, 999))")
                .font(.system(size: numberSize, weight: .semibold, design: .rounded).monospacedDigit())
                .contentTransition(.numericText())
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(column.label)
                .font(.system(size: style == .grid ? 9.5 : 10.5, weight: .medium))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .foregroundStyle(tint)
        .frame(maxWidth: .infinity)
        .padding(.vertical, style == .grid ? 5 : 7)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(tint.opacity(empty ? 0.05 : 0.14))
        )
        .opacity(empty || dimmed ? 0.4 : 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(count) \(column.label)")
    }
}

// MARK: - Island wings

/// One compact wing: the column glyph and its count, or nothing.
private struct ActivityColumnCompactCount: View {
    let entry: ActivityColumnsPresentation.CompactEntry?

    var body: some View {
        if let entry {
            HStack(spacing: 3) {
                Image(systemName: entry.column.systemImage)
                    .font(.system(size: 11, weight: .bold))
                Text("\(min(entry.count, 99))")
                    .font(.system(size: 13, weight: .semibold, design: .rounded).monospacedDigit())
            }
            .foregroundStyle(activityToneColor(entry.column.tone))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(entry.count) \(entry.column.label)")
        }
    }
}

// MARK: - Previews

#if DEBUG
private extension ADEAgentRunsAttributes {
    static var preview: ADEAgentRunsAttributes { .init(machineName: "All machines") }
}

private extension ADEAgentRunsAttributes.ContentState {
    static var busy: Self {
        .init(
            updatedAt: Date().timeIntervalSince1970,
            columns: .init(needsYou: 2, working: 5, waiting: 1, done: 12),
            activeCount: 8,
            runs: []
        )
    }

    static var quiet: Self {
        .init(
            updatedAt: Date().timeIntervalSince1970,
            columns: .init(needsYou: 0, working: 3, waiting: 0, done: 4),
            activeCount: 3,
            runs: []
        )
    }
}

@available(iOS 17.0, *)
#Preview("Agent columns", as: .content, using: ADEAgentRunsAttributes.preview) {
    ADEAgentActivityWidget()
} contentStates: {
    ADEAgentRunsAttributes.ContentState.busy
    ADEAgentRunsAttributes.ContentState.quiet
}
#endif
