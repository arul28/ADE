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
        AppIntentConfiguration(
            kind: Self.kind,
            intent: WorkspaceWidgetVariantIntent.self,
            provider: ADEWorkspaceIntentTimelineProvider()
        ) { entry in
            WorkspaceWidgetEntryView(entry: entry)
                .containerBackground(for: .widget) {
                    WorkspaceWidgetBackground()
                }
        }
        .configurationDisplayName("ADE Workspace")
        .description("See running agents and PRs at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Timeline entry + provider

struct ADEWorkspaceEntry: TimelineEntry {
    let date: Date
    let snapshot: WorkspaceSnapshot
    let variant: WidgetVariantOption

    init(date: Date, snapshot: WorkspaceSnapshot, variant: WidgetVariantOption = .agents) {
        self.date = date
        self.snapshot = snapshot
        self.variant = variant
    }
}

/// Legacy `TimelineProvider` kept for the lock-screen widget (which still uses
/// `StaticConfiguration`). The home widget uses the `AppIntent` variant below.
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

/// AppIntent-driven provider used by the home-screen workspace widget so the
/// user can flip between the "agents" and "pull requests" medium faces via the
/// widget-edit sheet.
@available(iOS 17.0, *)
struct ADEWorkspaceIntentTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ADEWorkspaceEntry {
        ADEWorkspaceEntry(date: Date(), snapshot: .empty, variant: .agents)
    }

    func snapshot(for configuration: WorkspaceWidgetVariantIntent, in context: Context) async -> ADEWorkspaceEntry {
        let snap = ADESharedContainer.readWorkspaceSnapshot() ?? .empty
        return ADEWorkspaceEntry(date: Date(), snapshot: snap, variant: configuration.variant)
    }

    func timeline(for configuration: WorkspaceWidgetVariantIntent, in context: Context) async -> Timeline<ADEWorkspaceEntry> {
        let now = Date()
        let snap = ADESharedContainer.readWorkspaceSnapshot() ?? .empty
        let entry = ADEWorkspaceEntry(date: now, snapshot: snap, variant: configuration.variant)
        return Timeline(entries: [entry], policy: .after(now.addingTimeInterval(60)))
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
            WorkspaceMediumView(snapshot: entry.snapshot, variant: entry.variant)
        case .systemLarge:
            WorkspaceLargeView(snapshot: entry.snapshot)
        default:
            WorkspaceSmallView(snapshot: entry.snapshot)
        }
    }
}
