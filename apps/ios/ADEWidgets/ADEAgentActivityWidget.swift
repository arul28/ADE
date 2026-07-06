import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// Live Activity surface for the "agent runs" activity. Lock-screen / banner
/// presentation plus Dynamic Island. Visual language matches
/// `ADELockScreenWidget`: phase-tinted status glyphs, tight typography, calm
/// restraint — no chrome that doesn't carry state.
struct ADEAgentActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ADEAgentRunsAttributes.self) { context in
            AgentRunsLockScreenView(
                presentation: AgentRunsPresentation(
                    state: context.state,
                    attributes: context.attributes,
                    isStale: context.isStale
                )
            )
            .activityBackgroundTint(Color.black.opacity(0.28))
            .activitySystemActionForegroundColor(.primary)
        } dynamicIsland: { context in
            let presentation = AgentRunsPresentation(
                state: context.state,
                attributes: context.attributes,
                isStale: context.isStale
            )
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: presentation.primary?.resolvedPhase.symbol ?? "circle.dotted")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(presentation.tint)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    AgentRunsCountBadge(presentation: presentation)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(presentation.runs.prefix(2)) { run in
                            AgentRunRow(run: run, compact: true)
                        }
                        if presentation.isStale {
                            AgentRunsStaleHint()
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let machine = presentation.machineFooter {
                        Text(machine)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            } compactLeading: {
                Image(systemName: presentation.primary?.resolvedPhase.symbol ?? "circle.dotted")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(presentation.tint)
            } compactTrailing: {
                if presentation.waitingCount > 0 {
                    Image(systemName: "bell.badge.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(ADESharedTheme.warningAmber)
                } else {
                    Text("\(presentation.activeCount)")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(presentation.tint)
                }
            } minimal: {
                Image(systemName: presentation.waitingCount > 0 ? "bell.fill" : "circle.fill")
                    .font(.system(size: presentation.waitingCount > 0 ? 12 : 9, weight: .bold))
                    .foregroundStyle(presentation.tint)
            }
            .widgetURL(presentation.destinationURL)
            .keylineTint(presentation.tint)
        }
    }
}

// MARK: - Presentation model

struct AgentRunsPresentation {
    let runs: [ADEAgentRunsAttributes.Run]
    let activeCount: Int
    let waitingCount: Int
    let primary: ADEAgentRunsAttributes.Run?
    let isStale: Bool
    let machineName: String

    init(state: ADEAgentRunsAttributes.ContentState, attributes: ADEAgentRunsAttributes, isStale: Bool) {
        // Attention-needing runs float to the top of the glance.
        let sorted = state.runs.sorted { lhs, rhs in
            let l = lhs.resolvedPhase.needsAttention ? 0 : 1
            let r = rhs.resolvedPhase.needsAttention ? 0 : 1
            return l < r
        }
        self.runs = Array(sorted.prefix(3))
        self.activeCount = max(state.activeCount, state.runs.count)
        self.waitingCount = state.runs.filter { $0.resolvedPhase.needsAttention }.count
        self.primary = sorted.first
        self.isStale = isStale || state.runs.contains { $0.resolvedPhase == .stale }
        self.machineName = attributes.machineName
    }

    /// Tint of the glance — attention amber wins, otherwise the primary run's
    /// phase color, dimmed toward idle when stale.
    var tint: Color {
        if isStale { return ADESharedTheme.statusIdle }
        if waitingCount > 0 { return ADESharedTheme.warningAmber }
        return primary?.resolvedPhase.tint ?? ADESharedTheme.statusIdle
    }

    /// Footer only earns its space when there's more than one run or a machine
    /// name worth showing.
    var machineFooter: String? {
        let trimmed = machineName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if activeCount > runs.count {
            return "\(trimmed) · \(activeCount) running"
        }
        return trimmed
    }

    var destinationURL: URL {
        let workspace = URL(string: "ade://workspace") ?? URL(fileURLWithPath: "/")
        let target = runs.first(where: { $0.resolvedPhase.needsAttention }) ?? primary
        guard let id = target?.id.trimmingCharacters(in: .whitespacesAndNewlines),
              !id.isEmpty else { return workspace }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        guard let encoded = id.addingPercentEncoding(withAllowedCharacters: allowed),
              let url = URL(string: "ade://session/\(encoded)") else {
            return workspace
        }
        return url
    }
}

// MARK: - Lock screen / banner

private struct AgentRunsLockScreenView: View {
    let presentation: AgentRunsPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: presentation.waitingCount > 0 ? "bell.badge.fill" : "circle.dotted")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(presentation.tint)
                Text(headline)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Spacer(minLength: 0)
                if let footer = presentation.machineFooter {
                    Text(footer)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            if presentation.runs.isEmpty {
                Text("No active runs")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(presentation.runs) { run in
                        AgentRunRow(run: run, compact: false)
                    }
                }
            }

            if presentation.isStale {
                AgentRunsStaleHint()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var headline: String {
        if presentation.waitingCount > 0 {
            return presentation.waitingCount == 1 ? "1 run needs you" : "\(presentation.waitingCount) runs need you"
        }
        let count = presentation.activeCount
        return count == 1 ? "1 agent running" : "\(count) agents running"
    }
}

// MARK: - Shared row

private struct AgentRunRow: View {
    let run: ADEAgentRunsAttributes.Run
    let compact: Bool

    private var phase: AgentRunPhase { run.resolvedPhase }

    /// Inline Approve / Deny only earns space on the full lock-screen row for a
    /// run actually blocked on approval — and only when the host supplied the
    /// pending `itemId` (older hosts omit it; a button dispatching an empty
    /// item id could not target the approval, so the row stays tap-to-open).
    /// The Dynamic Island (`compact`) stays glance-only.
    private var showsApprovalActions: Bool {
        !compact && phase == .waitingForApproval && !(run.itemId ?? "").isEmpty
    }

    var body: some View {
        Group {
            if showsApprovalActions {
                VStack(alignment: .leading, spacing: 7) {
                    rowContent
                    approvalActions
                }
            } else {
                rowContent
            }
        }
        .padding(.vertical, phase.needsAttention && !compact ? 3 : 0)
        .padding(.horizontal, phase.needsAttention && !compact ? 6 : 0)
        .background(
            phase.needsAttention && !compact
                ? RoundedRectangle(cornerRadius: 7, style: .continuous).fill(phase.tint.opacity(0.14))
                : nil
        )
    }

    private var rowContent: some View {
        HStack(spacing: 8) {
            Image(systemName: phase.symbol)
                .font(.system(size: compact ? 10 : 11, weight: .semibold))
                .foregroundStyle(phase.tint)
                .frame(width: 14, alignment: .center)

            VStack(alignment: .leading, spacing: 1) {
                Text(run.title)
                    .font(.system(size: compact ? 11 : 12.5, weight: .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                if let subtitle = subtitle {
                    Text(subtitle)
                        .font(.system(size: compact ? 9 : 10, weight: .regular))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
            }

            Spacer(minLength: 4)

            Text(phase.label)
                .font(.system(size: compact ? 9 : 9.5, weight: .semibold))
                .foregroundStyle(phase.needsAttention ? phase.tint : .secondary)
                .lineLimit(1)
        }
    }

    /// Approve / Deny capsules, aligned under the title (past the status glyph).
    /// Approve carries the phase amber; Deny stays neutral so the destructive
    /// choice never reads as the primary one.
    private var approvalActions: some View {
        HStack(spacing: 8) {
            Button(intent: ApproveSessionIntent(sessionId: run.id, itemId: run.itemId ?? "")) {
                approvalLabel("Approve", systemImage: "checkmark", tint: phase.tint)
            }
            .buttonStyle(.plain)

            Button(intent: DenySessionIntent(sessionId: run.id, itemId: run.itemId ?? "")) {
                approvalLabel("Deny", systemImage: "xmark", tint: .secondary)
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)
        }
        .padding(.leading, 22)
    }

    private func approvalLabel(_ title: String, systemImage: String, tint: Color) -> some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.system(size: 10, weight: .semibold))
            Text(title)
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(tint.opacity(0.16), in: Capsule(style: .continuous))
        .overlay(Capsule(style: .continuous).stroke(tint.opacity(0.30), lineWidth: 0.6))
    }

    /// Prefer the host-supplied detail line; fall back to "lane · model".
    private var subtitle: String? {
        let detail = run.detail?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let detail, !detail.isEmpty { return detail }
        return run.subtitle
    }
}

private struct AgentRunsCountBadge: View {
    let presentation: AgentRunsPresentation

    var body: some View {
        if presentation.waitingCount > 0 {
            Label("\(presentation.waitingCount)", systemImage: "bell.badge.fill")
                .font(.system(size: 12, weight: .semibold))
                .labelStyle(.titleAndIcon)
                .foregroundStyle(ADESharedTheme.warningAmber)
        } else {
            Text("\(presentation.activeCount)")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(presentation.tint)
        }
    }
}

private struct AgentRunsStaleHint: View {
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 9, weight: .semibold))
            Text("Reconnecting")
                .font(.system(size: 10, weight: .medium))
        }
        .foregroundStyle(.secondary)
        .opacity(0.85)
    }
}

// MARK: - Previews

#if DEBUG
private extension ADEAgentRunsAttributes {
    static var preview: ADEAgentRunsAttributes { .init(machineName: "Arul's MacBook Pro") }
}

private extension ADEAgentRunsAttributes.ContentState {
    static var running: Self {
        .init(
            updatedAt: Date().timeIntervalSince1970,
            activeCount: 2,
            runs: [
                .init(id: "a", title: "Refactor sync transport", phase: "running", model: "gpt-5-codex", lane: "Primary", detail: "editing SyncService.swift"),
                .init(id: "b", title: "Audit pairing", phase: "running", model: "claude-sonnet-4-6", lane: "feat/pair"),
            ]
        )
    }

    static var waiting: Self {
        .init(
            updatedAt: Date().timeIntervalSince1970,
            activeCount: 3,
            runs: [
                .init(id: "c", title: "Release checklist", phase: "waiting_for_approval", model: "claude", lane: "Primary", detail: "approve git push", itemId: "item_release_push"),
                .init(id: "a", title: "Refactor sync transport", phase: "running", model: "gpt-5-codex", lane: "Primary"),
            ]
        )
    }
}

@available(iOS 17.0, *)
#Preview("Agent runs · running", as: .content, using: ADEAgentRunsAttributes.preview) {
    ADEAgentActivityWidget()
} contentStates: {
    ADEAgentRunsAttributes.ContentState.running
    ADEAgentRunsAttributes.ContentState.waiting
}
#endif
