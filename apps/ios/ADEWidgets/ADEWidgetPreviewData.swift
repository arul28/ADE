import SwiftUI
import WidgetKit

/// Fixture data for SwiftUI previews. Never referenced from production entry
/// points — the `#Preview` macros below are only compiled when Xcode renders
/// the canvas.
///
/// The `previewSessions` / `previewPrs` / `STATE_*` / `ATTN_STATES` fixtures
/// mirror the mockup canvas at `/tmp/ade-design/extracted/ade-ios-widgets/
/// project/app.jsx` so the widget + Live Activity previews match the design
/// source 1:1.
enum ADEWidgetPreviewData {
    // MARK: - AgentSnapshot / PrSnapshot roster previews

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

    // MARK: - Live Activity ContentState fixtures (mirrors app.jsx)

    /// Anchor used so all "startedAt" offsets stay stable within a preview
    /// session. Not `.now` — previews re-render and we want consistent
    /// relative timestamps across widgets + islands in the same canvas.
    static let previewNow = Date()

    /// 4-session roster from `app.jsx` `SESSIONS` — claude / codex /
    /// cursor / opencode. Awaiting-input lives on s2.
    static let previewSessions: [ADESessionAttributes.ContentState.ActiveSession] = [
        ADESessionAttributes.ContentState.ActiveSession(
            id: "s1",
            providerSlug: "claude",
            title: "fix/billing-reconcile",
            isAwaitingInput: false,
            isFailed: false,
            startedAt: previewNow.addingTimeInterval(-22 * 60),
            progress: 0.68,
            preview: "Running unit tests · src/billing/*"
        ),
        ADESessionAttributes.ContentState.ActiveSession(
            id: "s2",
            providerSlug: "codex",
            title: "auth-refactor",
            isAwaitingInput: true,
            isFailed: false,
            startedAt: previewNow.addingTimeInterval(-8 * 60),
            progress: 0.34,
            preview: "Needs approval · DETACH PARTITION sessions_2025_q3"
        ),
        ADESessionAttributes.ContentState.ActiveSession(
            id: "s3",
            providerSlug: "cursor",
            title: "rate-limiter",
            isAwaitingInput: false,
            isFailed: false,
            startedAt: previewNow.addingTimeInterval(-45 * 60),
            progress: 0.91,
            preview: "8 files changed, +428 −112"
        ),
        ADESessionAttributes.ContentState.ActiveSession(
            id: "s4",
            providerSlug: "opencode",
            title: "ws-heartbeat",
            isAwaitingInput: false,
            isFailed: false,
            startedAt: previewNow.addingTimeInterval(-3 * 60),
            progress: 0.12,
            preview: "Reading protocol spec · 3 / 42 sources"
        ),
    ]

    /// 3-PR fixture from `app.jsx` `PRS`: one ciFailing, one review, one
    /// merge-ready. PrSnapshot's `checks`/`review`/`mergeReady` are the
    /// existing roster shape used by home widgets.
    static let previewPrs: [PrSnapshot] = [
        PrSnapshot(id: "pr-412", number: 412, title: "Refactor auth token pipeline",  checks: "failing", review: "pending",            state: "open", mergeReady: false, branch: "feat/auth-refactor"),
        PrSnapshot(id: "pr-408", number: 408, title: "Billing Decimal reconciliation", checks: "pending", review: "pending",            state: "open", mergeReady: false, branch: "fix/billing-reconcile"),
        PrSnapshot(id: "pr-401", number: 401, title: "Sidebar a11y: focus rings",      checks: "passing", review: "approved",           state: "open", mergeReady: true,  branch: "feat/sidebar-a11y"),
    ]

    // MARK: - ContentState constants (STATE_MULTI / STATE_SINGLE / STATE_IDLE)

    static let STATE_MULTI = ADESessionAttributes.ContentState(
        sessions: previewSessions,
        attention: nil,
        failingCheckCount: 2,
        awaitingReviewCount: 1,
        mergeReadyCount: 1,
        generatedAt: previewNow
    )

    static let STATE_SINGLE = ADESessionAttributes.ContentState(
        sessions: [previewSessions[0]],
        attention: nil,
        failingCheckCount: 0,
        awaitingReviewCount: 0,
        mergeReadyCount: 1,
        generatedAt: previewNow
    )

    static let STATE_IDLE = ADESessionAttributes.ContentState(
        sessions: [],
        attention: nil,
        failingCheckCount: 0,
        awaitingReviewCount: 0,
        mergeReadyCount: 0,
        generatedAt: previewNow
    )

    // MARK: - ATTN_STATES (keyed by attention kind, mirrors app.jsx)

    static let ATTN_STATES: [ADESessionAttributes.ContentState.Attention.Kind: ADESessionAttributes.ContentState] = [
        .awaitingInput: ADESessionAttributes.ContentState(
            sessions: previewSessions,
            attention: ADESessionAttributes.ContentState.Attention(
                kind: .awaitingInput,
                title: "Codex · auth-refactor",
                subtitle: "3 file writes + 1 destructive SQL need approval",
                providerSlug: "codex",
                sessionId: "s2"
            ),
            failingCheckCount: 2,
            awaitingReviewCount: 1,
            mergeReadyCount: 1,
            generatedAt: previewNow
        ),
        .failed: ADESessionAttributes.ContentState(
            sessions: previewSessions,
            attention: ADESessionAttributes.ContentState.Attention(
                kind: .failed,
                title: "Claude · fix/billing-reconcile",
                subtitle: "Agent failed at step 12/18",
                providerSlug: "claude",
                sessionId: "s1"
            ),
            failingCheckCount: 2,
            awaitingReviewCount: 1,
            mergeReadyCount: 1,
            generatedAt: previewNow
        ),
        .ciFailing: ADESessionAttributes.ContentState(
            sessions: previewSessions,
            attention: ADESessionAttributes.ContentState.Attention(
                kind: .ciFailing,
                title: "PR #412 · CI failing",
                subtitle: "unit + integration · feat/auth-refactor",
                prNumber: 412
            ),
            failingCheckCount: 2,
            awaitingReviewCount: 1,
            mergeReadyCount: 1,
            generatedAt: previewNow
        ),
        .reviewRequested: ADESessionAttributes.ContentState(
            sessions: previewSessions,
            attention: ADESessionAttributes.ContentState.Attention(
                kind: .reviewRequested,
                title: "PR #408 · review requested",
                subtitle: "@arul on fix/billing-reconcile",
                prNumber: 408
            ),
            failingCheckCount: 2,
            awaitingReviewCount: 1,
            mergeReadyCount: 1,
            generatedAt: previewNow
        ),
        .mergeReady: ADESessionAttributes.ContentState(
            sessions: previewSessions,
            attention: ADESessionAttributes.ContentState.Attention(
                kind: .mergeReady,
                title: "PR #401 · ready to merge",
                subtitle: "2 approvals · all checks pass",
                prNumber: 401
            ),
            failingCheckCount: 2,
            awaitingReviewCount: 1,
            mergeReadyCount: 1,
            generatedAt: previewNow
        ),
    ]
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
