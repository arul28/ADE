import SwiftUI
import WidgetKit

/// Lock Screen / StandBy "accessory" widgets. Three families are supported:
/// rectangular (one line + progress), circular (agent count ring), inline
/// (short string). Each maps to a different mockup in
/// `/tmp/ade-design/extracted/ade-ios-widgets/project/widgets.jsx`
/// (lines 183–251).
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
        .description("Agents running and PRs needing attention, on your Lock Screen.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}

struct LockScreenWidgetEntryView: View {
    let entry: ADEWorkspaceEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let destination = destinationURL

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

    private var destinationURL: URL {
        if let awaiting = entry.snapshot.agents.first(where: \.awaitingInput),
           let url = URL(string: "ade://session/\(awaiting.sessionId)") {
            return url
        }

        let openPrs = entry.snapshot.prs.filter { $0.state == "open" }
        if let focusPr = openPrs.first(where: { $0.checks == "failing" })
            ?? openPrs.first(where: { $0.review == "changes_requested" || $0.review == "pending" })
            ?? openPrs.first(where: { $0.mergeReady }),
           let url = URL(string: "ade://pr/\(focusPr.number)") {
            return url
        }

        return URL(string: "ade://workspace") ?? URL(fileURLWithPath: "/")
    }
}

// MARK: - Rectangular

struct LockScreenRectangularView: View {
    let snapshot: WorkspaceSnapshot
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        let summary = ADESharedContainer.inlineSummary(for: snapshot)
        let progress = averageProgress()

        return ZStack {
            AccessoryWidgetBackground()
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    AdeMark(size: 13)
                    Text("Workspace")
                        .font(.system(size: 12, weight: .bold))
                        .lineLimit(1)
                }
                Text(summary)
                    .font(.system(size: 12, weight: .semibold).monospaced())
                    .kerning(-0.2)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ProgressView(value: progress)
                    .progressViewStyle(.linear)
                    .tint(.primary)
                    .frame(height: 4)
                    .widgetAccentable()
            }
            .padding(.horizontal, 2)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .opacity(isLuminanceReduced ? 0.85 : 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("ADE workspace")
        .accessibilityValue(summary)
    }

    private func averageProgress() -> Double {
        let active = snapshot.agents.filter { $0.status == "running" || $0.awaitingInput }
        guard !active.isEmpty else { return 0 }
        let sum = active.reduce(0.0) { $0 + ($1.progress ?? 0) }
        return min(1, max(0, sum / Double(active.count)))
    }
}

// MARK: - Circular

struct LockScreenCircularView: View {
    let snapshot: WorkspaceSnapshot
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        let active = snapshot.agents.filter { $0.status == "running" || $0.awaitingInput }.count
        let total = max(active, max(1, snapshot.agents.count))

        return Gauge(value: Double(active), in: 0...Double(total)) {
            EmptyView()
        } currentValueLabel: {
            VStack(spacing: 0) {
                Text("\(active)")
                    .font(.system(size: 20, weight: .black))
                    .kerning(-0.5)
                Text("AGENTS")
                    .font(.system(size: 8.5).monospaced())
                    .tracking(0.2)
                    .textCase(.uppercase)
            }
        }
        .gaugeStyle(.accessoryCircular)
        .widgetAccentable()
        .opacity(isLuminanceReduced ? 0.85 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("ADE active agents")
        .accessibilityValue("\(active) of \(total)")
    }
}

// MARK: - Inline

struct LockScreenInlineView: View {
    let snapshot: WorkspaceSnapshot

    var body: some View {
        let summary = ADESharedContainer.inlineSummary(for: snapshot)
        Label {
            Text(summary)
                .dynamicTypeSize(.small ... .large)
        } icon: {
            Image(systemName: "sparkles")
                .accessibilityHidden(true)
        }
        .accessibilityLabel("ADE")
        .accessibilityValue(summary)
    }
}

// MARK: - Previews

#if DEBUG

@available(iOS 17.0, *)
#Preview("Lock · Rectangular · populated", as: .accessoryRectangular) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot)
}

@available(iOS 17.0, *)
#Preview("Lock · Rectangular · empty", as: .accessoryRectangular) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.emptySnapshot)
}

@available(iOS 17.0, *)
#Preview("Lock · Circular", as: .accessoryCircular) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot)
}

@available(iOS 17.0, *)
#Preview("Lock · Inline · populated", as: .accessoryInline) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot)
}

@available(iOS 17.0, *)
#Preview("Lock · Inline · idle", as: .accessoryInline) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.emptySnapshot)
}

#endif
