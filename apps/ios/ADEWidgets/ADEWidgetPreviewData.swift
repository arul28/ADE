import SwiftUI
import WidgetKit

/// Fixture data for SwiftUI previews. Never referenced from production entry
/// points — the `#Preview` macros below are only compiled when Xcode renders
/// the canvas.
enum ADEWidgetPreviewData {
    static let sampleAgents: [AgentSnapshot] = [
        AgentSnapshot(
            sessionId: "s-1",
            provider: "claude",
            title: "auth-refactor",
            status: "running",
            awaitingInput: false,
            lastActivityAt: Date(),
            elapsedSeconds: 1284,
            preview: "Wrote 4 files, running tests…",
            progress: 0.58,
            phase: "development",
            toolCalls: 17
        ),
        AgentSnapshot(
            sessionId: "s-2",
            provider: "codex",
            title: "settings-bug",
            status: "running",
            awaitingInput: true,
            lastActivityAt: Date().addingTimeInterval(-60),
            elapsedSeconds: 240,
            preview: "Approve? Deleting cached build dir",
            progress: nil,
            phase: "development",
            toolCalls: 3
        ),
        AgentSnapshot(
            sessionId: "s-3",
            provider: "cursor",
            title: "docs-pass",
            status: "completed",
            awaitingInput: false,
            lastActivityAt: Date().addingTimeInterval(-3600),
            elapsedSeconds: 1800,
            preview: "Finished — 6 docs updated",
            progress: 1.0,
            phase: "pr",
            toolCalls: 22
        ),
    ]

    static let samplePrs: [PrSnapshot] = [
        PrSnapshot(id: "pr-164", number: 164, title: "Unify host connection status", checks: "passing", review: "approved", state: "open", mergeReady: true),
        PrSnapshot(id: "pr-165", number: 165, title: "Mobile droid follow-ups", checks: "failing", review: "pending", state: "open", mergeReady: false),
        PrSnapshot(id: "pr-166", number: 166, title: "Fix PR detail race", checks: "pending", review: "changes_requested", state: "open", mergeReady: false),
    ]

    static let populatedSnapshot = WorkspaceSnapshot(
        generatedAt: Date(),
        agents: sampleAgents,
        prs: samplePrs,
        connection: "connected"
    )

    static let emptySnapshot = WorkspaceSnapshot.empty
}

#if DEBUG

@available(iOS 17.0, *)
#Preview("Workspace · Small", as: .systemSmall) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot)
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.emptySnapshot)
}

@available(iOS 17.0, *)
#Preview("Workspace · Medium", as: .systemMedium) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot)
}

@available(iOS 17.0, *)
#Preview("Workspace · Large", as: .systemLarge) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot)
}

@available(iOS 17.0, *)
#Preview("Lock · Rectangular", as: .accessoryRectangular) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot)
}

@available(iOS 17.0, *)
#Preview("Lock · Circular", as: .accessoryCircular) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot)
}

@available(iOS 17.0, *)
#Preview("Lock · Inline", as: .accessoryInline) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot)
}

#endif
