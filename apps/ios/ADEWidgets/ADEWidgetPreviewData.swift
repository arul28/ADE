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

    // MARK: - Real ADE data (sampled from local DB at `/Users/arul/ADE/.ade/ade.db`)
    //
    // Captured for previews so the canvas reflects an actual workspace state
    // rather than a hypothetical mockup. Re-run the sqlite query in the
    // accompanying script to refresh.

    static let realCurrentAgents: [AgentSnapshot] = [
        AgentSnapshot(
            sessionId: "64cda258-d3ff-47a2-8c98-7419b200a41e",
            provider: "codex-chat",
            title: "Work Tab Chat Tabs",
            status: "running",
            awaitingInput: false,
            // 2026-04-26 20:03:06 UTC — preview anchors to ~22 min ago.
            lastActivityAt: Date().addingTimeInterval(-22 * 60),
            elapsedSeconds: 22 * 60,
            preview: "All passed.",
            progress: nil,
            phase: nil,
            toolCalls: 0
        ),
    ]

    static let realCurrentPrs: [PrSnapshot] = [
        PrSnapshot(
            id: "d417dde7-ff67-4c1d-86dd-eb877fac55b6",
            number: 206,
            title: "fix(tabs): keep work surface alive across tab reroutes",
            checks: "failing",
            review: "none",
            state: "open",
            mergeReady: false,
            branch: "ade/tab-reroute-tabs-fix-95042dc5"
        ),
        PrSnapshot(
            id: "1601c4c3-3290-4b16-9cbb-4ef466ec20ef",
            number: 205,
            title: "lanes: stabilize URL deep-link useEffect deps",
            checks: "failing",
            review: "none",
            state: "open",
            mergeReady: false,
            branch: "ade/chnaging-lanes-tabs-bugs-1954cea4"
        ),
    ]

    /// Snapshot reflecting the user's *actual* workspace at capture time:
    /// 1 running codex-chat session, 2 open PRs both with failing CI.
    static let realCurrentSnapshot = WorkspaceSnapshot(
        generatedAt: Date(),
        agents: realCurrentAgents,
        prs: realCurrentPrs,
        connection: "connected",
        awaitingInputCount: 0,
        idleCount: 0
    )

    /// Same real workspace, but overlaid with a couple of synthetic counts so
    /// you can preview "what does it look like when something's actually
    /// happening" — 2 chats waiting on you, 1 idle, plus the real failing-CI
    /// PRs from your branch.
    static let realRichSnapshot = WorkspaceSnapshot(
        generatedAt: Date(),
        agents: realCurrentAgents,
        prs: realCurrentPrs,
        connection: "connected",
        awaitingInputCount: 2,
        idleCount: 1
    )

    /// Same real PRs, no running chats — what the surfaces look like when only
    /// PR-side signals are active. Useful for "do the count strips read
    /// correctly when the roster is empty."
    static let realPrsOnlySnapshot = WorkspaceSnapshot(
        generatedAt: Date(),
        agents: [],
        prs: realCurrentPrs,
        connection: "connected",
        awaitingInputCount: 0,
        idleCount: 0
    )

    // MARK: - Real-data Live Activity ContentStates

    static let realCurrentActiveSessions: [ADESessionAttributes.ContentState.ActiveSession] = realCurrentAgents.map { snap in
        .init(
            id: snap.sessionId,
            providerSlug: snap.provider,
            title: snap.title ?? snap.sessionId,
            isAwaitingInput: snap.awaitingInput,
            isFailed: snap.status.lowercased() == "failed",
            startedAt: snap.lastActivityAt.addingTimeInterval(-Double(snap.elapsedSeconds)),
            progress: snap.progress,
            preview: snap.preview
        )
    }

    /// LA ContentState: 1 running codex-chat, no attention, 2 failing PRs.
    static let REAL_CURRENT = ADESessionAttributes.ContentState(
        sessions: realCurrentActiveSessions,
        attention: nil,
        failingCheckCount: 2,
        awaitingReviewCount: 0,
        mergeReadyCount: 0,
        awaitingInputCount: 0,
        idleCount: 0,
        generatedAt: previewNow
    )

    /// LA ContentState: real chat + the imagined "X waiting for input"
    /// attention banner derived from the synthetic count. Lets you see the
    /// CountsStrip + AttentionLockCard with realistic content.
    static let REAL_RICH = ADESessionAttributes.ContentState(
        sessions: realCurrentActiveSessions,
        attention: ADESessionAttributes.ContentState.Attention(
            kind: .awaitingInput,
            title: "2 chats waiting for input",
            subtitle: "Tap to respond"
        ),
        failingCheckCount: 2,
        awaitingReviewCount: 0,
        mergeReadyCount: 0,
        awaitingInputCount: 2,
        idleCount: 1,
        generatedAt: previewNow
    )

    /// LA ContentState: only PR signals, no roster — what the LA looks like
    /// when CI is failing on your open PRs and nothing else is going on.
    static let REAL_PRS_ONLY = ADESessionAttributes.ContentState(
        sessions: [],
        attention: ADESessionAttributes.ContentState.Attention(
            kind: .ciFailing,
            title: "PR #206 · CI failing",
            subtitle: "fix(tabs): keep work surface alive across tab reroutes",
            prId: "d417dde7-ff67-4c1d-86dd-eb877fac55b6",
            prNumber: 206
        ),
        failingCheckCount: 2,
        awaitingReviewCount: 0,
        mergeReadyCount: 0,
        awaitingInputCount: 0,
        idleCount: 0,
        generatedAt: previewNow
    )

    // MARK: - Live Activity ContentState fixtures (mirrors app.jsx)

    /// Anchor used so all "startedAt" offsets stay stable within a preview
    /// session. Not `.now` — previews re-render and we want consistent
    /// relative timestamps across widgets + islands in the same canvas.
    static let previewNow = Date()

    /// Active-only roster (sessions that are *currently producing output*).
    /// Awaiting-input + idle chats live in the counts on ContentState now.
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
        awaitingInputCount: 1,
        idleCount: 2,
        generatedAt: previewNow
    )

    static let STATE_SINGLE = ADESessionAttributes.ContentState(
        sessions: [previewSessions[0]],
        attention: nil,
        failingCheckCount: 0,
        awaitingReviewCount: 0,
        mergeReadyCount: 1,
        awaitingInputCount: 0,
        idleCount: 0,
        generatedAt: previewNow
    )

    static let STATE_IDLE = ADESessionAttributes.ContentState(
        sessions: [],
        attention: nil,
        failingCheckCount: 0,
        awaitingReviewCount: 0,
        mergeReadyCount: 0,
        awaitingInputCount: 0,
        idleCount: 0,
        generatedAt: previewNow
    )

    // MARK: - ATTN_STATES (keyed by attention kind, mirrors app.jsx)

    static let ATTN_STATES: [ADESessionAttributes.ContentState.Attention.Kind: ADESessionAttributes.ContentState] = [
        .awaitingInput: ADESessionAttributes.ContentState(
            sessions: previewSessions,
            attention: ADESessionAttributes.ContentState.Attention(
                kind: .awaitingInput,
                title: "1 chat waiting for input",
                subtitle: "Tap to respond"
            ),
            failingCheckCount: 2,
            awaitingReviewCount: 1,
            mergeReadyCount: 1,
            awaitingInputCount: 1,
            idleCount: 2,
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

// MARK: - Real-data previews
//
// Snapshots sourced from your actual workspace DB (`/Users/arul/ADE/.ade/ade.db`)
// at capture time:
//   • 1 running codex-chat ("Work Tab Chat Tabs")
//   • 2 open PRs both with failing CI (#205, #206)
// These previews pair the real data with three view conditions: real-as-is,
// real + synthetic counts (rich), and PRs-only (no chat).

@available(iOS 17.0, *)
#Preview("REAL · Small · current", as: .systemSmall) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realCurrentSnapshot)
}

@available(iOS 17.0, *)
#Preview("REAL · Small · rich", as: .systemSmall) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realRichSnapshot)
}

@available(iOS 17.0, *)
#Preview("REAL · Small · PRs only", as: .systemSmall) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realPrsOnlySnapshot)
}

@available(iOS 17.0, *)
#Preview("REAL · Medium · agents", as: .systemMedium) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realCurrentSnapshot, variant: .agents)
}

@available(iOS 17.0, *)
#Preview("REAL · Medium · prs", as: .systemMedium) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realCurrentSnapshot, variant: .prs)
}

@available(iOS 17.0, *)
#Preview("REAL · Medium · rich", as: .systemMedium) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realRichSnapshot, variant: .agents)
}

@available(iOS 17.0, *)
#Preview("REAL · Large · current", as: .systemLarge) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realCurrentSnapshot)
}

@available(iOS 17.0, *)
#Preview("REAL · Large · rich", as: .systemLarge) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realRichSnapshot)
}

@available(iOS 17.0, *)
#Preview("REAL · Lock Rect · current", as: .accessoryRectangular) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realCurrentSnapshot)
}

@available(iOS 17.0, *)
#Preview("REAL · Lock Rect · rich", as: .accessoryRectangular) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realRichSnapshot)
}

@available(iOS 17.0, *)
#Preview("REAL · Lock Circular · current", as: .accessoryCircular) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realCurrentSnapshot)
}

@available(iOS 17.0, *)
#Preview("REAL · Lock Inline · current", as: .accessoryInline) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realCurrentSnapshot)
}

@available(iOS 17.0, *)
#Preview("REAL · Lock Inline · rich", as: .accessoryInline) {
    ADELockScreenWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.realRichSnapshot)
}

#endif
