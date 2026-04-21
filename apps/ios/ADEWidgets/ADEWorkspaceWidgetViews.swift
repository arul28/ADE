import SwiftUI
import WidgetKit

// MARK: - Small

/// Smallest Home Screen tile. Focus is tight: one "most relevant" session
/// summary, or a pinned empty-state when nothing is live.
struct WorkspaceSmallView: View {
    let snapshot: WorkspaceSnapshot
    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        let focus = focusAgent()
        return Link(destination: focusURL(for: focus)) {
            VStack(alignment: .leading, spacing: 6) {
                WorkspaceHeaderRow(connection: snapshot.connection, compact: true)

                Spacer(minLength: 0)

                if let agent = focus {
                    HStack(spacing: 6) {
                        brandDot(for: agent.provider)
                        Text(agent.title ?? "Session")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(textPrimary)
                            .lineLimit(1)
                    }
                    Text(agent.preview ?? agent.status.capitalized)
                        .font(.caption2)
                        .foregroundStyle(textSecondary)
                        .lineLimit(2)
                } else {
                    Text("Tap to pin")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(textSecondary)
                    Text("No active sessions yet")
                        .font(.caption2)
                        .foregroundStyle(textSecondary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(12)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(for: focus))
        .accessibilityValue(accessibilityValue(for: focus))
    }

    private func focusAgent() -> AgentSnapshot? {
        snapshot.agents
            .sorted { lhs, rhs in
                // Awaiting input wins, then running, then most recent activity.
                if lhs.awaitingInput != rhs.awaitingInput { return lhs.awaitingInput }
                if lhs.status == "running" && rhs.status != "running" { return true }
                if rhs.status == "running" && lhs.status != "running" { return false }
                return lhs.lastActivityAt > rhs.lastActivityAt
            }
            .first
    }

    private func focusURL(for agent: AgentSnapshot?) -> URL {
        if let agent, let url = URL(string: "ade://session/\(agent.sessionId)") {
            return url
        }
        return URL(string: "ade://workspace") ?? URL(fileURLWithPath: "/")
    }

    private func brandDot(for provider: String) -> some View {
        Circle()
            .fill(renderingMode == .accented ? Color.primary : ADESharedTheme.brandColor(for: provider))
            .frame(width: 8, height: 8)
            .opacity(isLuminanceReduced ? 0.6 : 1)
            .accessibilityHidden(true)
    }

    private var textPrimary: Color {
        renderingMode == .accented ? Color.primary : Color.primary
    }

    private var textSecondary: Color {
        renderingMode == .accented ? Color.primary.opacity(0.7) : Color.secondary
    }

    private func accessibilityLabel(for agent: AgentSnapshot?) -> String {
        agent.map { "Session \($0.title ?? "untitled")" } ?? "No active sessions"
    }

    private func accessibilityValue(for agent: AgentSnapshot?) -> String {
        agent?.preview ?? agent?.status ?? "Tap to pin a session"
    }
}

// MARK: - Medium

struct WorkspaceMediumView: View {
    let snapshot: WorkspaceSnapshot
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WorkspaceHeaderRow(connection: snapshot.connection, compact: false)

            HStack(alignment: .top, spacing: 12) {
                WorkspaceAgentsColumn(agents: Array(snapshot.agents.prefix(3)))
                Divider().opacity(renderingMode == .accented ? 0.3 : 0.5)
                WorkspacePrsColumn(prs: Array(snapshot.prs.prefix(3)))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("ADE workspace")
        .accessibilityValue("\(snapshot.agents.count) sessions, \(snapshot.prs.count) pull requests")
    }
}

// MARK: - Large

struct WorkspaceLargeView: View {
    let snapshot: WorkspaceSnapshot
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            WorkspaceHeaderRow(connection: snapshot.connection, compact: false)

            WorkspaceAgentsColumn(agents: Array(snapshot.agents.prefix(5)))

            Divider().opacity(renderingMode == .accented ? 0.3 : 0.5)

            WorkspacePrsColumn(prs: Array(snapshot.prs.prefix(4)))
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("ADE workspace dashboard")
        .accessibilityValue("\(snapshot.agents.count) sessions, \(snapshot.prs.count) pull requests")
    }
}

// MARK: - Shared building blocks

private struct WorkspaceHeaderRow: View {
    let connection: String
    let compact: Bool

    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(renderingMode == .accented ? .primary : ADESharedTheme.connectionColor(for: connection))
                .frame(width: 8, height: 8)
                .opacity(isLuminanceReduced ? 0.6 : 1)
                .accessibilityHidden(true)
            Text("ADE")
                .font(compact ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
                .foregroundStyle(renderingMode == .accented ? .primary : Color.primary)
                .dynamicTypeSize(.small ... .large)
            Spacer(minLength: 4)
            Text(connection.capitalized)
                .font(compact ? .caption2 : .caption)
                .foregroundStyle(renderingMode == .accented ? .primary : Color.secondary)
                .dynamicTypeSize(.small ... .large)
                .accessibilityLabel("Connection \(connection)")
        }
    }
}

private struct WorkspaceAgentsColumn: View {
    let agents: [AgentSnapshot]
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("AGENTS")
                .font(.caption2.weight(.semibold))
                .tracking(0.8)
                .foregroundStyle(renderingMode == .accented ? .primary : Color.secondary)
                .dynamicTypeSize(.small ... .large)
                .accessibilityAddTraits(.isHeader)

            if agents.isEmpty {
                Text("No sessions")
                    .font(.caption2)
                    .foregroundStyle(renderingMode == .accented ? .primary : Color.secondary)
            } else {
                ForEach(agents) { agent in
                    if let url = URL(string: "ade://session/\(agent.sessionId)") {
                        Link(destination: url) {
                            AgentRow(agent: agent)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(agent.title ?? "Session")
                        .accessibilityValue(rowAccessibilityValue(for: agent))
                    } else {
                        AgentRow(agent: agent)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func rowAccessibilityValue(for agent: AgentSnapshot) -> String {
        if agent.awaitingInput { return "awaiting input" }
        return agent.status
    }
}

private struct WorkspacePrsColumn: View {
    let prs: [PrSnapshot]
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PRS")
                .font(.caption2.weight(.semibold))
                .tracking(0.8)
                .foregroundStyle(renderingMode == .accented ? .primary : Color.secondary)
                .dynamicTypeSize(.small ... .large)
                .accessibilityAddTraits(.isHeader)

            if prs.isEmpty {
                Text("Nothing open")
                    .font(.caption2)
                    .foregroundStyle(renderingMode == .accented ? .primary : Color.secondary)
            } else {
                ForEach(prs) { pr in
                    if let url = URL(string: "ade://pr/\(pr.number)") {
                        Link(destination: url) {
                            PrRow(pr: pr)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("PR \(pr.number) — \(pr.title)")
                        .accessibilityValue("checks \(pr.checks), review \(pr.review)")
                    } else {
                        PrRow(pr: pr)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct AgentRow: View {
    let agent: AgentSnapshot
    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(renderingMode == .accented ? Color.primary : ADESharedTheme.brandColor(for: agent.provider))
                .frame(width: 7, height: 7)
                .opacity(isLuminanceReduced ? 0.6 : 1)
                .accessibilityHidden(true)
            Text(agent.title ?? "Session")
                .font(.caption)
                .foregroundStyle(renderingMode == .accented ? .primary : Color.primary)
                .lineLimit(1)
                .dynamicTypeSize(.small ... .large)
            Spacer(minLength: 4)
            if agent.awaitingInput {
                Image(systemName: "bell.badge.fill")
                    .font(.caption2)
                    .foregroundStyle(renderingMode == .accented ? .primary : ADESharedTheme.statusAttention)
                    .accessibilityHidden(true)
            } else {
                Image(systemName: statusSymbol)
                    .font(.caption2)
                    .foregroundStyle(renderingMode == .accented ? .primary : statusColor)
                    .accessibilityHidden(true)
            }
        }
    }

    private var statusSymbol: String {
        switch agent.status {
        case "running":    return "circle.fill"
        case "failed":     return "xmark.octagon.fill"
        case "completed":  return "checkmark.seal.fill"
        default:           return "pause.circle"
        }
    }

    private var statusColor: Color {
        switch agent.status {
        case "running":    return ADESharedTheme.statusSuccess
        case "failed":     return ADESharedTheme.statusFailed
        case "completed":  return ADESharedTheme.statusSuccess
        default:           return ADESharedTheme.statusIdle
        }
    }
}

private struct PrRow: View {
    let pr: PrSnapshot
    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch")
                .font(.caption2)
                .foregroundStyle(renderingMode == .accented ? .primary : Color.secondary)
                .accessibilityHidden(true)
            Text("#\(pr.number)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(renderingMode == .accented ? .primary : Color.primary)
            Text(pr.title)
                .font(.caption)
                .foregroundStyle(renderingMode == .accented ? .primary : Color.primary)
                .lineLimit(1)
                .dynamicTypeSize(.small ... .large)
            Spacer(minLength: 4)
            Image(systemName: checksSymbol)
                .font(.caption2)
                .foregroundStyle(renderingMode == .accented ? .primary : checksColor)
                .opacity(isLuminanceReduced ? 0.6 : 1)
                .accessibilityHidden(true)
        }
    }

    private var checksSymbol: String {
        switch pr.checks {
        case "passing": return "checkmark.circle"
        case "failing": return "xmark.octagon.fill"
        default:        return "hourglass"
        }
    }

    private var checksColor: Color {
        switch pr.checks {
        case "passing": return ADESharedTheme.statusSuccess
        case "failing": return ADESharedTheme.statusFailed
        default:        return ADESharedTheme.statusIdle
        }
    }
}

