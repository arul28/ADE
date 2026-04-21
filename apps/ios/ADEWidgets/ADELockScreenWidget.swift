import SwiftUI
import WidgetKit

/// Lock Screen / StandBy "accessory" widgets. Three families are supported:
/// rectangular (one line + stat), circular (count ring), inline (short string).
///
/// Shares the workspace snapshot reader with `ADEWorkspaceWidget`, but renders
/// a compact glance suitable for always-on / luminance-reduced contexts.
struct ADELockScreenWidget: Widget {
    static let kind = "ADELockScreenWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: Self.kind,
            provider: ADEWorkspaceTimelineProvider()
        ) { entry in
            LockScreenWidgetEntryView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("ADE Glance")
        .description("Sessions awaiting input, on your Lock Screen.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}

struct LockScreenWidgetEntryView: View {
    let entry: ADEWorkspaceEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        // Accessory widgets do not support tapping individual rows the way
        // home-screen widgets do; instead the system opens the widget's
        // `widgetURL` when the user taps the glyph. We link to the first
        // awaiting-input session if one exists, otherwise to the workspace.
        let destination: URL = {
            if let awaiting = entry.snapshot.agents.first(where: { $0.awaitingInput }) {
                return URL(string: "ade://session/\(awaiting.sessionId)") ?? URL(string: "ade://workspace")!
            }
            return URL(string: "ade://workspace")!
        }()

        return Group {
            switch family {
            case .accessoryRectangular: LockScreenRectangularView(snapshot: entry.snapshot)
            case .accessoryCircular:    LockScreenCircularView(snapshot: entry.snapshot)
            case .accessoryInline:      LockScreenInlineView(snapshot: entry.snapshot)
            default:                    LockScreenInlineView(snapshot: entry.snapshot)
            }
        }
        .widgetURL(destination)
    }
}

// MARK: - Rectangular

struct LockScreenRectangularView: View {
    let snapshot: WorkspaceSnapshot
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        let awaiting = snapshot.agents.filter(\.awaitingInput).count
        let running = snapshot.agents.filter { $0.status == "running" }.count

        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: "bell.badge.fill")
                    .font(.caption2)
                    .accessibilityHidden(true)
                Text("ADE")
                    .font(.caption.weight(.semibold))
                    .dynamicTypeSize(.small ... .large)
            }
            Text("\(awaiting) awaiting · \(running) running")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .dynamicTypeSize(.small ... .large)
                .opacity(isLuminanceReduced ? 0.7 : 1)
            if let focus = snapshot.agents.first(where: { $0.awaitingInput }) {
                Text(focus.title ?? "Session")
                    .font(.caption2.weight(.medium))
                    .lineLimit(1)
                    .dynamicTypeSize(.small ... .large)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("ADE")
        .accessibilityValue("\(awaiting) sessions awaiting input, \(running) running")
    }
}

// MARK: - Circular

struct LockScreenCircularView: View {
    let snapshot: WorkspaceSnapshot
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        let awaiting = snapshot.agents.filter(\.awaitingInput).count
        return ZStack {
            Circle()
                .strokeBorder(.tint.opacity(isLuminanceReduced ? 0.35 : 0.6), lineWidth: 2)
            VStack(spacing: 0) {
                Image(systemName: "bell.badge")
                    .font(.caption2)
                    .accessibilityHidden(true)
                Text("\(awaiting)")
                    .font(.headline.monospacedDigit())
                    .dynamicTypeSize(.small ... .large)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("ADE sessions awaiting input")
        .accessibilityValue("\(awaiting)")
    }
}

// MARK: - Inline

struct LockScreenInlineView: View {
    let snapshot: WorkspaceSnapshot

    var body: some View {
        let awaiting = snapshot.agents.filter(\.awaitingInput).count
        Label {
            Text(awaiting == 0 ? "ADE idle" : "ADE · \(awaiting) awaiting")
                .dynamicTypeSize(.small ... .large)
        } icon: {
            Image(systemName: awaiting == 0 ? "moon.stars" : "bell.badge.fill")
                .accessibilityHidden(true)
        }
        .accessibilityLabel(awaiting == 0 ? "ADE idle" : "ADE")
        .accessibilityValue(awaiting == 0 ? "no sessions awaiting input" : "\(awaiting) sessions awaiting input")
    }
}
