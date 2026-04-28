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
        // Awaiting-input is now a count, not a per-agent flag — surface as a
        // generic deep link to the workspace approvals view via PR fallback.
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
        let running = snapshot.runningAgents
        let isRunning = !running.isEmpty
        let secondary = secondaryLine()
        let progress = averageProgress(running: running)

        return ZStack {
            AccessoryWidgetBackground()
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Image(systemName: isRunning ? "circle.dotted" : "moon.zzz")
                        .font(.system(size: 11, weight: .semibold))
                        .widgetAccentable()
                    Text(summary)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let secondary {
                    Text(secondary)
                        .font(.system(size: 11, weight: .regular))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if isRunning {
                    ProgressView(value: progress)
                        .progressViewStyle(.linear)
                        .tint(.primary)
                        .frame(height: 3)
                        .widgetAccentable()
                }
            }
            .padding(.horizontal, 2)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .opacity(isLuminanceReduced ? 0.85 : 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("ADE workspace")
        .accessibilityValue(summary)
    }

    private func secondaryLine() -> String? {
        let openPrs = snapshot.prs.filter { $0.state == "open" }.count
        var parts: [String] = []
        if snapshot.awaitingInputCount > 0 {
            parts.append("\(snapshot.awaitingInputCount) waiting")
        }
        if openPrs > 0 {
            parts.append("\(openPrs) PR\(openPrs == 1 ? "" : "s")")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func averageProgress(running: [AgentSnapshot]) -> Double {
        guard !running.isEmpty else { return 0 }
        let sum = running.reduce(0.0) { $0 + ($1.progress ?? 0) }
        return min(1, max(0, sum / Double(running.count)))
    }
}

// MARK: - Circular

struct LockScreenCircularView: View {
    let snapshot: WorkspaceSnapshot
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        let active = snapshot.runningAgents.count
        let waiting = snapshot.awaitingInputCount

        return Group {
            if active > 0 {
                Gauge(value: Double(active), in: 0...Double(max(active, 1))) {
                    EmptyView()
                } currentValueLabel: {
                    VStack(spacing: -1) {
                        Text("\(active)")
                            .font(.system(size: active >= 10 ? 16 : 20, weight: .black))
                            .kerning(-0.5)
                            .minimumScaleFactor(0.7)
                            .lineLimit(1)
                        Text("RUN")
                            .font(.system(size: 8).monospaced())
                            .tracking(0.3)
                    }
                }
                .gaugeStyle(.accessoryCircular)
            } else if waiting > 0 {
                Gauge(value: 1, in: 0...1) {
                    EmptyView()
                } currentValueLabel: {
                    VStack(spacing: -1) {
                        Text("\(waiting)")
                            .font(.system(size: waiting >= 10 ? 16 : 20, weight: .black))
                            .kerning(-0.5)
                            .minimumScaleFactor(0.7)
                            .lineLimit(1)
                        Text("WAIT")
                            .font(.system(size: 8).monospaced())
                            .tracking(0.3)
                    }
                }
                .gaugeStyle(.accessoryCircular)
            } else {
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: "moon.zzz")
                        .font(.system(size: 18, weight: .semibold))
                }
            }
        }
        .widgetAccentable()
        .opacity(isLuminanceReduced ? 0.85 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("ADE workspace")
        .accessibilityValue(active > 0 ? "\(active) running" : (waiting > 0 ? "\(waiting) waiting" : "idle"))
    }
}

// MARK: - Inline

struct LockScreenInlineView: View {
    let snapshot: WorkspaceSnapshot

    var body: some View {
        let summary = ADESharedContainer.inlineSummary(for: snapshot)
        Text(summary)
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
