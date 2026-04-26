import SwiftUI
import WidgetKit

// MARK: - Shared palette

/// Pixel-level constants lifted from `widgets.jsx` — kept scoped to this
/// translation unit so the surrounding app's `ADESharedTheme` stays the single
/// source of truth for semantic tokens while still letting the widgets match
/// the dark mockup frame exactly.
private enum WorkspaceWidgetPalette {
    static let gradientStart = Color(red: 0x1A / 255.0, green: 0x18 / 255.0, blue: 0x30 / 255.0) // #1A1830
    static let gradientEnd   = Color(red: 0x0C / 255.0, green: 0x0B / 255.0, blue: 0x10 / 255.0) // #0C0B10
    static let textPrimary   = Color(red: 0xF0 / 255.0, green: 0xF0 / 255.0, blue: 0xF2 / 255.0) // #F0F0F2
    static let textSecondary = Color(red: 0x90 / 255.0, green: 0x8F / 255.0, blue: 0xA0 / 255.0) // #908FA0
    static let textTertiary  = Color(red: 0xA8 / 255.0, green: 0xA8 / 255.0, blue: 0xB4 / 255.0) // #A8A8B4
    static let textQuaternary = Color(red: 0x6B / 255.0, green: 0x6A / 255.0, blue: 0x7A / 255.0) // #6B6A7A
    static let statusFailed  = Color(red: 0xF8 / 255.0, green: 0x71 / 255.0, blue: 0x71 / 255.0) // #F87171
    static let statusWaiting = Color(red: 0xFB / 255.0, green: 0xBF / 255.0, blue: 0x24 / 255.0) // #FBBF24
    static let statusReady   = Color(red: 0x4A / 255.0, green: 0xDE / 255.0, blue: 0x80 / 255.0) // #4ADE80
    static let dotViolet     = Color(red: 0xA7 / 255.0, green: 0x8B / 255.0, blue: 0xFA / 255.0) // #A78BFA
}

/// 22pt radius, violet-tinted dark gradient + 1px dot grid, 0.5pt hairline.
/// Accented rendering mode (tinted stacks) falls back to a flat neutral so the
/// system tint controls color.
struct WorkspaceWidgetBackground: View {
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        ZStack {
            if renderingMode == .accented {
                Color.clear
            } else {
                // Black ink base — #070609, per the finalized widget spec.
                Color(red: 0x07 / 255.0, green: 0x06 / 255.0, blue: 0x09 / 255.0)
                // Ambient violet bloom in the top-left — the signature PRs glow.
                RadialGradient(
                    colors: [WorkspaceWidgetPalette.dotViolet.opacity(0.38), .clear],
                    center: UnitPoint(x: 0.1, y: -0.05),
                    startRadius: 0,
                    endRadius: 320
                )
                .allowsHitTesting(false)
                // Secondary pink-ish bloom in the bottom-right for depth.
                RadialGradient(
                    colors: [
                        Color(red: 0xF4 / 255, green: 0x72 / 255, blue: 0xB6 / 255).opacity(0.18),
                        .clear,
                    ],
                    center: UnitPoint(x: 1.05, y: 1.05),
                    startRadius: 0,
                    endRadius: 260
                )
                .allowsHitTesting(false)
                Canvas { context, size in
                    let spacing: CGFloat = 12
                    let dotSize: CGFloat = 1
                    let dotColor = Color.white.opacity(0.04)
                    var y: CGFloat = 0
                    while y < size.height {
                        var x: CGFloat = 0
                        while x < size.width {
                            let rect = CGRect(x: x, y: y, width: dotSize, height: dotSize)
                            context.fill(Path(ellipseIn: rect), with: .color(dotColor))
                            x += spacing
                        }
                        y += spacing
                    }
                }
                .allowsHitTesting(false)
                // Top white highlight band — LinearGradient 0.06 → clear, top to ~25%.
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [Color.white.opacity(0.06), .clear],
                            startPoint: .top,
                            endPoint: UnitPoint(x: 0.5, y: 0.25)
                        )
                    )
                    .allowsHitTesting(false)
            }
            // 1pt inner highlight ring.
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [Color.white.opacity(0.14), Color.white.opacity(0.02)],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 1
                )
                .allowsHitTesting(false)
            // Outer 1pt stroke — crisp rim separating the tile from its neighbor.
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
        }
    }
}

// MARK: - Small

/// Single-session focus tile. Wraps the entire tile as a Link to the session
/// deep URL so the whole widget is one tap target.
struct WorkspaceSmallView: View {
    let snapshot: WorkspaceSnapshot
    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        let focus = focusAgent()
        let destination = focusURL(for: focus)
        let accented = renderingMode == .accented

        return Link(destination: destination) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: 0) {
                    SmallStatusDot(running: focus != nil)
                    Spacer()
                    Text(smallStatusLabel(for: focus, snapshot: snapshot).lowercased())
                        .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                        .tracking(0.2)
                        .foregroundStyle(accented ? Color.primary : WorkspaceWidgetPalette.textSecondary)
                }

                Spacer(minLength: 12)

                Text(smallTitle(focus: focus, snapshot: snapshot))
                    .font(.system(size: 13.5, weight: .semibold))
                    .kerning(-0.1)
                    .foregroundStyle(accented ? Color.primary : WorkspaceWidgetPalette.textPrimary)
                    .lineLimit(2)
                    .minimumScaleFactor(0.9)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Spacer(minLength: 0)

                if let agent = focus {
                    Text(smallSubline(for: agent))
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                        .foregroundStyle(accented ? Color.primary.opacity(0.7) : WorkspaceWidgetPalette.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if let summary = smallSummaryLine(snapshot: snapshot) {
                    Text(summary)
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                        .foregroundStyle(accented ? Color.primary.opacity(0.7) : WorkspaceWidgetPalette.textSecondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .opacity(isLuminanceReduced ? 0.75 : 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(for: focus))
        .accessibilityValue(accessibilityValue(for: focus))
    }

    private func focusAgent() -> AgentSnapshot? {
        snapshot.runningAgents
            .sorted { lhs, rhs in lhs.lastActivityAt > rhs.lastActivityAt }
            .first
    }

    private func focusURL(for agent: AgentSnapshot?) -> URL {
        if let agent, let url = URL(string: "ade://session/\(agent.sessionId)") {
            return url
        }
        return URL(string: "ade://workspace") ?? URL(fileURLWithPath: "/")
    }

    private func smallStatusLabel(for agent: AgentSnapshot?, snapshot: WorkspaceSnapshot) -> String {
        if agent != nil { return "running" }
        if snapshot.awaitingInputCount > 0 { return "waiting" }
        if snapshot.idleCount > 0 { return "idle" }
        return "quiet"
    }

    private func smallSubline(for agent: AgentSnapshot) -> String {
        let preview = agent.preview?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let preview, !preview.isEmpty {
            return "\(agent.provider.lowercased()) · \(preview)"
        }
        return agent.provider.lowercased()
    }

    private func smallTitle(focus: AgentSnapshot?, snapshot: WorkspaceSnapshot) -> String {
        if let focus { return focus.title ?? "Working" }
        if snapshot.awaitingInputCount > 0 {
            return snapshot.awaitingInputCount == 1
                ? "1 chat waiting"
                : "\(snapshot.awaitingInputCount) chats waiting"
        }
        if snapshot.idleCount > 0 {
            return snapshot.idleCount == 1
                ? "1 chat idle"
                : "\(snapshot.idleCount) chats idle"
        }
        return "ADE"
    }

    private func smallSummaryLine(snapshot: WorkspaceSnapshot) -> String? {
        var parts: [String] = []
        if snapshot.awaitingInputCount > 0 {
            parts.append("\(snapshot.awaitingInputCount) waiting")
        }
        if snapshot.idleCount > 0 {
            parts.append("\(snapshot.idleCount) idle")
        }
        let openPrs = snapshot.prs.filter { $0.state == "open" }.count
        if openPrs > 0 {
            parts.append("\(openPrs) prs")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func accessibilityLabel(for agent: AgentSnapshot?) -> String {
        agent.map { "Agent \($0.title ?? "untitled")" } ?? "No agents running"
    }

    private func accessibilityValue(for agent: AgentSnapshot?) -> String {
        agent?.preview ?? agent?.status ?? "Tap to open ADE"
    }
}

/// 10pt status dot for the small home widget. Solid green when something is
/// running, dim grey when nothing is active.
private struct SmallStatusDot: View {
    let running: Bool

    var body: some View {
        let color: Color = running
            ? WorkspaceWidgetPalette.statusReady
            : WorkspaceWidgetPalette.textQuaternary
        Circle()
            .fill(color)
            .frame(width: 10, height: 10)
            .shadow(color: color.opacity(running ? 0.55 : 0), radius: 3)
            .accessibilityHidden(true)
    }
}

// MARK: - Medium

struct WorkspaceMediumView: View {
    let snapshot: WorkspaceSnapshot
    let variant: WidgetVariantOption
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        let accented = renderingMode == .accented
        VStack(alignment: .leading, spacing: 10) {
            WorkspaceSectionHeader(
                title: variant == .agents ? "Running" : "Pull requests",
                trailing: variant == .agents
                    ? agentsTrailing
                    : "\(openPrsCount) open",
                accented: accented
            )

            if variant == .agents {
                WorkspaceAgentsList(
                    agents: Array(snapshot.runningAgents.prefix(3)),
                    emptyMessage: emptyAgentsMessage,
                    accented: accented
                )
            } else {
                WorkspacePrsList(
                    prs: Array(openPrs.prefix(3)),
                    emptyMessage: "no open prs",
                    accented: accented
                )
            }

            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("ADE workspace")
        .accessibilityValue("\(snapshot.runningAgents.count) running, \(openPrsCount) open pull requests")
    }

    private var agentsTrailing: String {
        let running = snapshot.runningAgents.count
        if running == 0 {
            if snapshot.awaitingInputCount > 0 { return "\(snapshot.awaitingInputCount) waiting" }
            if snapshot.idleCount > 0 { return "\(snapshot.idleCount) idle" }
            return "0 running"
        }
        return "\(running) running"
    }

    private var emptyAgentsMessage: String {
        if snapshot.awaitingInputCount > 0 {
            return "\(snapshot.awaitingInputCount) waiting for input"
        }
        if snapshot.idleCount > 0 {
            return "\(snapshot.idleCount) idle"
        }
        return "no chats running"
    }

    private var runningCount: Int {
        snapshot.runningAgents.count
    }

    private var openPrsCount: Int {
        openPrs.count
    }

    private var openPrs: [PrSnapshot] {
        snapshot.prs.filter { $0.state == "open" }
    }
}

// MARK: - Large

struct WorkspaceLargeView: View {
    let snapshot: WorkspaceSnapshot
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        let accented = renderingMode == .accented
        VStack(alignment: .leading, spacing: 0) {
            LargeHeader(connection: snapshot.connection, accented: accented)
                .padding(.bottom, 14)

            if snapshot.runningAgents.isEmpty && openPrs.isEmpty
                && snapshot.awaitingInputCount == 0 && snapshot.idleCount == 0 {
                WorkspaceIdleState(accented: accented, snapshot: snapshot)
            } else {
                SectionDivider(
                    title: "Agents · \(snapshot.runningAgents.count)",
                    trailing: largeChatsTrailing,
                    accented: accented
                )
                .padding(.bottom, 8)
                WorkspaceAgentsList(
                    agents: Array(snapshot.runningAgents.prefix(3)),
                    emptyMessage: emptyAgentsMessage,
                    accented: accented
                )
                .padding(.bottom, 14)

                Rectangle()
                    .fill(Color.white.opacity(0.08))
                    .frame(height: 0.5)
                    .padding(.bottom, 12)

                SectionDivider(
                    title: "Pull requests · \(openPrsCount)",
                    trailing: prsTrailing,
                    accented: accented
                )
                .padding(.bottom, 8)
                WorkspacePrsList(
                    prs: Array(openPrs.prefix(3)),
                    emptyMessage: "no open prs",
                    accented: accented
                )
            }

            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("ADE workspace dashboard")
        .accessibilityValue("\(snapshot.runningAgents.count) running, \(openPrsCount) open pull requests")
    }

    private var largeChatsTrailing: String {
        var bits: [String] = []
        if snapshot.awaitingInputCount > 0 { bits.append("\(snapshot.awaitingInputCount) waiting") }
        if snapshot.idleCount > 0 { bits.append("\(snapshot.idleCount) idle") }
        if snapshot.connection.lowercased() == "disconnected" { bits.append("offline") }
        return bits.isEmpty ? "" : bits.joined(separator: " · ")
    }

    private var prsTrailing: String {
        if snapshot.connection.lowercased() == "disconnected" { return "offline" }
        let failing = snapshot.prs.filter { $0.checks == "failing" }.count
        if failing > 0 { return "\(failing) failing" }
        let ready = snapshot.prs.filter { $0.mergeReady && $0.checks == "passing" && $0.review == "approved" }.count
        if ready > 0 { return "\(ready) ready" }
        return ""
    }

    private var emptyAgentsMessage: String {
        if snapshot.awaitingInputCount > 0 {
            return "\(snapshot.awaitingInputCount) waiting for input"
        }
        if snapshot.idleCount > 0 {
            return "\(snapshot.idleCount) idle"
        }
        return "no chats running"
    }

    private var runningCount: Int {
        snapshot.runningAgents.count
    }

    private var openPrsCount: Int {
        openPrs.count
    }

    private var openPrs: [PrSnapshot] {
        snapshot.prs.filter { $0.state == "open" }
    }
}

// MARK: - Idle state

private struct WorkspaceIdleState: View {
    let accented: Bool
    var snapshot: WorkspaceSnapshot? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Spacer(minLength: 0)
            HStack(spacing: 8) {
                Circle()
                    .fill(accented ? Color.primary.opacity(0.5) : WorkspaceWidgetPalette.textQuaternary)
                    .frame(width: 8, height: 8)
                Text(idleTitle)
                    .font(.system(size: 13.5, weight: .semibold))
                    .kerning(-0.1)
                    .lineLimit(1)
                    .foregroundStyle(accented ? Color.primary : WorkspaceWidgetPalette.textPrimary)
            }
            if let summary = idleSummary {
                Text(summary)
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .foregroundStyle(
                        accented ? Color.primary.opacity(0.7) : WorkspaceWidgetPalette.textSecondary
                    )
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var idleTitle: String {
        guard let snapshot else { return "ADE · idle" }
        if snapshot.awaitingInputCount > 0 || snapshot.idleCount > 0 {
            return "ADE · standby"
        }
        return "ADE · idle"
    }

    private var idleSummary: String? {
        guard let snapshot else { return nil }
        var parts: [String] = []
        if snapshot.awaitingInputCount > 0 {
            parts.append("\(snapshot.awaitingInputCount) waiting")
        }
        if snapshot.idleCount > 0 {
            parts.append("\(snapshot.idleCount) idle")
        }
        let openPrs = snapshot.prs.filter { $0.state == "open" }.count
        if openPrs > 0 {
            parts.append("\(openPrs) prs")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// MARK: - Large header

private struct LargeHeader: View {
    let connection: String
    let accented: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            AdeMark(size: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text("Workspace")
                    .font(.system(size: 13.5, weight: .semibold))
                    .kerning(-0.1)
                    .lineLimit(1)
                    .foregroundStyle(accented ? Color.primary : WorkspaceWidgetPalette.textPrimary)
                Text(connectionSubtitle)
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .lineLimit(1)
                    .foregroundStyle(accented ? Color.primary.opacity(0.7) : WorkspaceWidgetPalette.textSecondary)
            }
            Spacer()
            if !accented {
                Circle()
                    .fill(ADESharedTheme.connectionColor(for: connection))
                    .frame(width: 6, height: 6)
                    .shadow(color: ADESharedTheme.connectionColor(for: connection).opacity(0.6), radius: 3)
            } else {
                Circle()
                    .fill(Color.primary)
                    .frame(width: 6, height: 6)
            }
        }
    }

    private var connectionSubtitle: String {
        switch connection.lowercased() {
        case "connected":    return "linked"
        case "syncing":      return "syncing"
        case "disconnected": return "offline"
        default:             return connection.lowercased()
        }
    }
}

// MARK: - Section header building blocks

private struct WorkspaceSectionHeader: View {
    let title: String
    let trailing: String
    let accented: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            AdeMark(size: 14)
            Text(title)
                .font(.system(size: 13.5, weight: .semibold))
                .kerning(-0.1)
                .lineLimit(1)
                .foregroundStyle(accented ? Color.primary : WorkspaceWidgetPalette.textPrimary)
            Spacer(minLength: 6)
            Text(trailing.lowercased())
                .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                .tracking(0.2)
                .lineLimit(1)
                .foregroundStyle(accented ? Color.primary.opacity(0.7) : WorkspaceWidgetPalette.textSecondary)
        }
    }
}

private struct SectionDivider: View {
    let title: String
    let trailing: String
    let accented: Bool

    var body: some View {
        HStack {
            Text(title)
                .font(.system(size: 10, weight: .semibold).monospaced())
                .tracking(0.4)
                .textCase(.uppercase)
                .foregroundStyle(accented ? Color.primary : WorkspaceWidgetPalette.textSecondary)
            Spacer()
            Text(trailing)
                .font(.system(size: 10).monospaced())
                .tracking(0.4)
                .textCase(.uppercase)
                .foregroundStyle(accented ? Color.primary.opacity(0.6) : WorkspaceWidgetPalette.textQuaternary)
        }
    }
}

// MARK: - Roster + PR rows

private struct WorkspaceAgentsList: View {
    let agents: [AgentSnapshot]
    let emptyMessage: String
    let accented: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if agents.isEmpty {
                Text(emptyMessage)
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .lineLimit(1)
                    .foregroundStyle(accented ? Color.primary.opacity(0.7) : WorkspaceWidgetPalette.textSecondary)
            } else {
                ForEach(agents) { agent in
                    if let url = URL(string: "ade://session/\(agent.sessionId)") {
                        Link(destination: url) {
                            WidgetRosterRow(agent: agent, accented: accented)
                        }
                    } else {
                        WidgetRosterRow(agent: agent, accented: accented)
                    }
                }
            }
        }
    }
}

private struct WorkspacePrsList: View {
    let prs: [PrSnapshot]
    let emptyMessage: String
    let accented: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if prs.isEmpty {
                Text(emptyMessage)
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .lineLimit(1)
                    .foregroundStyle(accented ? Color.primary.opacity(0.7) : WorkspaceWidgetPalette.textSecondary)
            } else {
                ForEach(prs) { pr in
                    if let url = URL(string: "ade://pr/\(pr.number)") {
                        Link(destination: url) {
                            WidgetPrRow(pr: pr, accented: accented)
                        }
                    } else {
                        WidgetPrRow(pr: pr, accented: accented)
                    }
                }
            }
        }
    }
}

private struct WidgetRosterRow: View {
    let agent: AgentSnapshot
    let accented: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Circle()
                .fill(rowDotColor)
                .frame(width: 8, height: 8)
                .shadow(color: rowDotColor.opacity(0.55), radius: 3)
            VStack(alignment: .leading, spacing: 1) {
                Text(agent.title ?? "Chat")
                    .font(.system(size: 13.5, weight: .semibold))
                    .kerning(-0.1)
                    .lineLimit(1)
                    .foregroundStyle(accented ? Color.primary : WorkspaceWidgetPalette.textPrimary)
                Text(subline)
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .lineLimit(1)
                    .foregroundStyle(accented ? Color.primary.opacity(0.7) : WorkspaceWidgetPalette.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var rowDotColor: Color {
        accented ? Color.primary : WorkspaceWidgetPalette.statusReady
    }

    private var subline: String {
        let preview = agent.preview?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let preview, !preview.isEmpty {
            return "\(agent.provider.lowercased()) · \(preview)"
        }
        return agent.provider.lowercased()
    }
}

private struct WidgetPrRow: View {
    let pr: PrSnapshot
    let accented: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: iconName)
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 14, height: 10, alignment: .center)
                .foregroundStyle(accented ? Color.primary : tint)
            VStack(alignment: .leading, spacing: 1) {
                Text(pr.title)
                    .font(.system(size: 13.5, weight: .semibold))
                    .kerning(-0.1)
                    .lineLimit(1)
                    .foregroundStyle(accented ? Color.primary : WorkspaceWidgetPalette.textPrimary)
                Text("#\(pr.number) · \(branchLabel)")
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .lineLimit(1)
                    .foregroundStyle(accented ? Color.primary.opacity(0.7) : WorkspaceWidgetPalette.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(shortLabel.lowercased())
                .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                .tracking(0.2)
                .foregroundStyle(accented ? Color.primary : tint)
        }
    }

    private enum PrFacet { case ciFailing, review, ready, open }

    private var facet: PrFacet {
        if pr.checks == "failing" { return .ciFailing }
        if pr.mergeReady && pr.checks == "passing" && pr.review == "approved" { return .ready }
        if pr.review == "pending" || pr.review == "changes_requested" { return .review }
        return .open
    }

    private var iconName: String {
        switch facet {
        case .ciFailing: return "exclamationmark.triangle.fill"
        case .review:    return "eye.fill"
        case .ready:     return "checkmark.seal.fill"
        case .open:      return "arrow.triangle.branch"
        }
    }

    private var tint: Color {
        switch facet {
        case .ciFailing: return WorkspaceWidgetPalette.statusFailed
        case .review:    return WorkspaceWidgetPalette.statusWaiting
        case .ready:     return WorkspaceWidgetPalette.statusReady
        case .open:      return WorkspaceWidgetPalette.textSecondary
        }
    }

    private var shortLabel: String {
        switch facet {
        case .ciFailing: return "CI"
        case .review:    return "review"
        case .ready:     return "ready"
        case .open:      return pr.checks == "passing" ? "ok" : pr.checks
        }
    }

    private var branchLabel: String {
        if let branch = pr.branch, !branch.isEmpty {
            return branch
        }
        switch pr.state {
        case "merged": return "merged"
        case "closed": return "closed"
        default:       return "open"
        }
    }
}

// MARK: - Previews

#if DEBUG

@available(iOS 17.0, *)
#Preview("Workspace · Small · populated", as: .systemSmall) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot, variant: .agents)
}

@available(iOS 17.0, *)
#Preview("Workspace · Small · empty", as: .systemSmall) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.emptySnapshot, variant: .agents)
}

@available(iOS 17.0, *)
#Preview("Workspace · Medium · agents", as: .systemMedium) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot, variant: .agents)
}

@available(iOS 17.0, *)
#Preview("Workspace · Medium · prs", as: .systemMedium) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot, variant: .prs)
}

@available(iOS 17.0, *)
#Preview("Workspace · Large", as: .systemLarge) {
    ADEWorkspaceWidget()
} timeline: {
    ADEWorkspaceEntry(date: .now, snapshot: ADEWidgetPreviewData.populatedSnapshot, variant: .agents)
}

#endif
