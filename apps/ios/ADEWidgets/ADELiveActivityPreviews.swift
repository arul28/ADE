// Previews for the Workspace Live Activity regions. Lives only in the
// ADEWidgets extension target so it can reach ADEWidgetPreviewData fixtures.

#if DEBUG
import SwiftUI
import ActivityKit
import WidgetKit

@available(iOS 17.0, *)
private struct CompactRow: View {
    let title: String
    let state: ADESessionAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 10, weight: .bold).monospacedDigit())
                .foregroundStyle(.secondary)
            HStack(spacing: 16) {
                HStack {
                    WorkspaceCompactLeading(state: state)
                    Spacer()
                    WorkspaceCompactTrailing(state: state)
                }
                .padding(.horizontal, 16)
                .frame(width: 148, height: 38)
                .background(Capsule().fill(Color.black))

                WorkspaceMinimalGlyph(state: state)
            }
        }
    }
}

@available(iOS 17.0, *)
#Preview("Compact · 8 states") {
    ScrollView {
        VStack(alignment: .leading, spacing: 14) {
            CompactRow(title: "IDLE", state: ADEWidgetPreviewData.STATE_IDLE)
            CompactRow(title: "SINGLE", state: ADEWidgetPreviewData.STATE_SINGLE)
            CompactRow(title: "MULTI", state: ADEWidgetPreviewData.STATE_MULTI)
            CompactRow(title: "ATTN · awaitingInput",
                       state: ADEWidgetPreviewData.ATTN_STATES[.awaitingInput]!)
            CompactRow(title: "ATTN · failed",
                       state: ADEWidgetPreviewData.ATTN_STATES[.failed]!)
            CompactRow(title: "ATTN · ciFailing",
                       state: ADEWidgetPreviewData.ATTN_STATES[.ciFailing]!)
            CompactRow(title: "ATTN · reviewRequested",
                       state: ADEWidgetPreviewData.ATTN_STATES[.reviewRequested]!)
            CompactRow(title: "ATTN · mergeReady",
                       state: ADEWidgetPreviewData.ATTN_STATES[.mergeReady]!)
        }
        .padding(20)
    }
    .background(Color(red: 0x0C/255, green: 0x0B/255, blue: 0x10/255))
}

@available(iOS 17.0, *)
private struct ExpandedCard: View {
    let title: String
    let state: ADESessionAttributes.ContentState
    let attrs: ADESessionAttributes

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 10, weight: .bold).monospacedDigit())
                .foregroundStyle(.secondary)
            VStack(spacing: 10) {
                HStack(alignment: .top, spacing: 14) {
                    WorkspaceExpandedLeading(state: state)
                        .frame(width: 48)
                    WorkspaceExpandedCenter(state: state, attrs: attrs)
                    WorkspaceExpandedTrailing(state: state)
                        .frame(width: 56)
                }
                WorkspaceExpandedBottom(state: state)
            }
            .padding(18)
            .frame(width: 374)
            .background(RoundedRectangle(cornerRadius: 44).fill(Color.black))
        }
    }
}

@available(iOS 17.0, *)
#Preview("Expanded · 4 states") {
    let attrs = ADESessionAttributes(workspaceName: "default")
    ScrollView {
        VStack(alignment: .leading, spacing: 16) {
            ExpandedCard(title: "IDLE",
                         state: ADEWidgetPreviewData.STATE_IDLE, attrs: attrs)
            ExpandedCard(title: "SINGLE",
                         state: ADEWidgetPreviewData.STATE_SINGLE, attrs: attrs)
            ExpandedCard(title: "MULTI",
                         state: ADEWidgetPreviewData.STATE_MULTI, attrs: attrs)
            ExpandedCard(title: "ATTN · awaitingInput",
                         state: ADEWidgetPreviewData.ATTN_STATES[.awaitingInput]!,
                         attrs: attrs)
        }
        .padding(20)
    }
    .background(Color(red: 0x0C/255, green: 0x0B/255, blue: 0x10/255))
}

@available(iOS 17.0, *)
#Preview("Lock Screen · 4 states") {
    let attrs = ADESessionAttributes(workspaceName: "default")
    ScrollView {
        VStack(spacing: 14) {
            WorkspaceLockScreenPresentation(
                state: ADEWidgetPreviewData.STATE_MULTI, attrs: attrs)
            WorkspaceLockScreenPresentation(
                state: ADEWidgetPreviewData.STATE_SINGLE, attrs: attrs)
            WorkspaceLockScreenPresentation(
                state: ADEWidgetPreviewData.ATTN_STATES[.awaitingInput]!, attrs: attrs)
            WorkspaceLockScreenPresentation(
                state: ADEWidgetPreviewData.ATTN_STATES[.ciFailing]!, attrs: attrs)
        }
        .padding(20)
    }
    .background(
        LinearGradient(
            colors: [
                Color(red: 0x1A/255, green: 0x13/255, blue: 0x30/255),
                Color(red: 0x0C/255, green: 0x0B/255, blue: 0x10/255)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    )
}

// MARK: - Activity-level previews
//
// These render the *whole* Live Activity through Apple's `as: .content` and
// `as: .dynamicIsland(...)` preview macros so the canvas mimics what iOS
// actually shows on Lock Screen + Dynamic Island. Open this file in Xcode,
// `⌥⌘↩` to show the canvas, and use the chip row at the bottom of each
// preview to flip between presentations.

@available(iOS 17.0, *)
private let _activityPreviewAttrs = ADESessionAttributes(workspaceName: "ADE")

@available(iOS 17.0, *)
#Preview("LA · Lock Screen · Multi/Single/Idle", as: .content, using: _activityPreviewAttrs) {
    ADELiveActivity()
} contentStates: {
    ADEWidgetPreviewData.STATE_MULTI
    ADEWidgetPreviewData.STATE_SINGLE
    ADEWidgetPreviewData.STATE_IDLE
}

@available(iOS 17.0, *)
#Preview("LA · Lock Screen · Attention", as: .content, using: _activityPreviewAttrs) {
    ADELiveActivity()
} contentStates: {
    ADEWidgetPreviewData.ATTN_STATES[.awaitingInput]!
    ADEWidgetPreviewData.ATTN_STATES[.failed]!
    ADEWidgetPreviewData.ATTN_STATES[.ciFailing]!
    ADEWidgetPreviewData.ATTN_STATES[.reviewRequested]!
    ADEWidgetPreviewData.ATTN_STATES[.mergeReady]!
}

@available(iOS 17.0, *)
#Preview("LA · Dynamic Island · Compact", as: .dynamicIsland(.compact), using: _activityPreviewAttrs) {
    ADELiveActivity()
} contentStates: {
    ADEWidgetPreviewData.STATE_MULTI
    ADEWidgetPreviewData.STATE_SINGLE
    ADEWidgetPreviewData.STATE_IDLE
    ADEWidgetPreviewData.ATTN_STATES[.awaitingInput]!
    ADEWidgetPreviewData.ATTN_STATES[.failed]!
    ADEWidgetPreviewData.ATTN_STATES[.ciFailing]!
    ADEWidgetPreviewData.ATTN_STATES[.reviewRequested]!
    ADEWidgetPreviewData.ATTN_STATES[.mergeReady]!
}

@available(iOS 17.0, *)
#Preview("LA · Dynamic Island · Expanded", as: .dynamicIsland(.expanded), using: _activityPreviewAttrs) {
    ADELiveActivity()
} contentStates: {
    ADEWidgetPreviewData.STATE_MULTI
    ADEWidgetPreviewData.STATE_SINGLE
    ADEWidgetPreviewData.STATE_IDLE
    ADEWidgetPreviewData.ATTN_STATES[.awaitingInput]!
    ADEWidgetPreviewData.ATTN_STATES[.failed]!
    ADEWidgetPreviewData.ATTN_STATES[.ciFailing]!
    ADEWidgetPreviewData.ATTN_STATES[.reviewRequested]!
    ADEWidgetPreviewData.ATTN_STATES[.mergeReady]!
}

@available(iOS 17.0, *)
#Preview("LA · Dynamic Island · Minimal", as: .dynamicIsland(.minimal), using: _activityPreviewAttrs) {
    ADELiveActivity()
} contentStates: {
    ADEWidgetPreviewData.STATE_MULTI
    ADEWidgetPreviewData.STATE_SINGLE
    ADEWidgetPreviewData.ATTN_STATES[.awaitingInput]!
    ADEWidgetPreviewData.ATTN_STATES[.failed]!
}

// MARK: - Real-data Live Activity previews
//
// Sourced from your real workspace DB: 1 running codex-chat, 2 failing-CI PRs.
// Three flavors per region:
//   • CURRENT — exactly what the LA looks like right now
//   • RICH — same chat + synthetic awaiting/idle counts overlay so you can see
//            the AttentionLockCard + CountsStrip with realistic content
//   • PRs ONLY — no chat running, just CI-failing PRs

@available(iOS 17.0, *)
#Preview("REAL · LA Lock Screen", as: .content, using: _activityPreviewAttrs) {
    ADELiveActivity()
} contentStates: {
    ADEWidgetPreviewData.REAL_CURRENT
    ADEWidgetPreviewData.REAL_RICH
    ADEWidgetPreviewData.REAL_PRS_ONLY
}

@available(iOS 17.0, *)
#Preview("REAL · DI Compact", as: .dynamicIsland(.compact), using: _activityPreviewAttrs) {
    ADELiveActivity()
} contentStates: {
    ADEWidgetPreviewData.REAL_CURRENT
    ADEWidgetPreviewData.REAL_RICH
    ADEWidgetPreviewData.REAL_PRS_ONLY
}

@available(iOS 17.0, *)
#Preview("REAL · DI Expanded", as: .dynamicIsland(.expanded), using: _activityPreviewAttrs) {
    ADELiveActivity()
} contentStates: {
    ADEWidgetPreviewData.REAL_CURRENT
    ADEWidgetPreviewData.REAL_RICH
    ADEWidgetPreviewData.REAL_PRS_ONLY
}

@available(iOS 17.0, *)
#Preview("REAL · DI Minimal", as: .dynamicIsland(.minimal), using: _activityPreviewAttrs) {
    ADELiveActivity()
} contentStates: {
    ADEWidgetPreviewData.REAL_CURRENT
    ADEWidgetPreviewData.REAL_RICH
}

#endif
