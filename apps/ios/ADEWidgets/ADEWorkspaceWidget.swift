import SwiftUI
import WidgetKit

/// Home Screen widget that surfaces the ADE workspace dashboard: currently
/// running agents, PRs awaiting attention, and a summary connection dot.
///
/// Reads the latest `WorkspaceSnapshot` from the App Group
/// (`ADESharedContainer.readWorkspaceSnapshot()`) each time the system asks
/// for a timeline entry. The main app triggers
/// `WidgetCenter.shared.reloadAllTimelines()` after every snapshot write, so
/// the timeline itself only needs a coarse refresh policy.
struct ADEWorkspaceWidget: Widget {
    static let kind = "ADEWorkspaceWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: Self.kind,
            provider: ADEWorkspaceTimelineProvider()
        ) { entry in
            WorkspaceWidgetEntryView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("ADE Workspace")
        .description("See running sessions and PRs at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Timeline provider

struct ADEWorkspaceEntry: TimelineEntry {
    let date: Date
    let snapshot: WorkspaceSnapshot
}

struct ADEWorkspaceTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> ADEWorkspaceEntry {
        ADEWorkspaceEntry(date: Date(), snapshot: .empty)
    }

    func getSnapshot(in context: Context, completion: @escaping (ADEWorkspaceEntry) -> Void) {
        let snapshot = ADESharedContainer.readWorkspaceSnapshot() ?? .empty
        completion(ADEWorkspaceEntry(date: Date(), snapshot: snapshot))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ADEWorkspaceEntry>) -> Void) {
        let now = Date()
        let snapshot = ADESharedContainer.readWorkspaceSnapshot() ?? .empty
        let entry = ADEWorkspaceEntry(date: now, snapshot: snapshot)
        let nextRefresh = now.addingTimeInterval(60)
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }
}

// MARK: - Entry view dispatch

struct WorkspaceWidgetEntryView: View {
    let entry: ADEWorkspaceEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .systemSmall:
            WorkspaceSmallView(snapshot: entry.snapshot)
        case .systemMedium:
            WorkspaceMediumView(snapshot: entry.snapshot)
        case .systemLarge:
            WorkspaceLargeView(snapshot: entry.snapshot)
        default:
            WorkspaceSmallView(snapshot: entry.snapshot)
        }
    }
}
