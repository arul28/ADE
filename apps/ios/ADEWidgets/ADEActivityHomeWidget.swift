import SwiftUI
import WidgetKit

// The home-screen half of `ADELockScreenWidget`: the systemSmall / systemMedium
// / systemLarge families. They render the unified row design — state glyph in
// the phase's tone, title, phase word — with per-row deep links, an "N more"
// tail and one events line, which is a different job from the accessory
// families' single fact and single tap target.

/// Everything the home-screen families render, resolved once so the layouts
/// stay layout-only.
struct ActivityHomeModel {
    /// Nonzero state buckets, in display order. Empty on the machine-local
    /// fallback path, which has no per-item feed.
    let groups: [ActivityWidgetPresentation.GroupCount]
    let rows: [ActivityWidgetPresentation.CompactLine]
    /// Agent rows the visible ones left off.
    let moreCount: Int
    let signal: ActivityWidgetPresentation.EventSignal?
    let freshness: ActivityWidgetPresentation.Freshness?
    let destination: URL
    let hideDetails: Bool
    /// Set when there is no account feed at all — the layouts then show the
    /// single-focus status rather than an empty row list.
    let fallback: LockScreenPriorityStatus?

    /// How many rows each family fits at the heights below. Medium runs
    /// single-line rows; large runs two-line rows with the scope underneath.
    /// Large is 6 rather than the 8 it could cram in — the last two would lose
    /// their scope line, and a row that cannot say which machine it is on is
    /// not worth its height. Not yet measured at every Dynamic Type size.
    static func rowCapacity(for family: WidgetFamily) -> Int {
        switch family {
        case .systemSmall: return 2
        case .systemLarge: return 6
        default: return 3
        }
    }

    init(
        entry: ADEStatusEntry,
        account: AccountAttentionSnapshot?,
        fallback: LockScreenPriorityStatus,
        family: WidgetFamily
    ) {
        self.hideDetails = entry.hideDetails
        self.freshness = entry.freshness
        guard let account else {
            groups = []
            rows = []
            moreCount = 0
            signal = nil
            destination = fallback.destinationURL
            self.fallback = fallback
            return
        }
        let limit = Self.rowCapacity(for: family)
        groups = ActivityWidgetPresentation.groupCounts(for: account.items, now: entry.date)
        rows = ActivityWidgetPresentation.compactLines(
            for: account.items,
            limit: limit,
            hideDetails: entry.hideDetails,
            now: entry.date
        )
        moreCount = ActivityWidgetPresentation.overflowCount(
            for: account.items,
            limit: limit,
            now: entry.date
        )
        signal = ActivityWidgetPresentation.eventSignal(
            for: account.items,
            hideDetails: entry.hideDetails,
            now: entry.date
        )
        destination = ActivityWidgetPresentation.deepLink(for: account.items, now: entry.date)
        self.fallback = nil
    }

    var totalAgents: Int { rows.count + moreCount }

    /// The bucket the headline speaks for: your move if anything is, else
    /// whatever is loudest.
    var leadGroup: ActivityWidgetPresentation.GroupCount? { groups.first }

    var isEmpty: Bool { rows.isEmpty && signal == nil }
}

struct ActivityHomeWidgetView: View {
    let model: ActivityHomeModel
    let family: WidgetFamily

    var body: some View {
        Group {
            if let fallback = model.fallback {
                ActivityHomeFallbackView(status: fallback, family: family)
                    .widgetURL(model.destination)
            } else if family == .systemSmall {
                ActivityHomeSmallView(model: model)
                    .widgetURL(model.destination)
            } else {
                ActivityHomeListView(model: model, family: family)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Medium and large. Header strip, rows, then one footer bar.
///
/// The footer carries both tails — the events signal on the left, "N more" on
/// the right — rather than spending a whole row on each. On a medium widget
/// that row is the difference between three legible rows and three clipped
/// ones, and the two tails are the same sentence anyway: *here is what else
/// there is*.
private struct ActivityHomeListView: View {
    let model: ActivityHomeModel
    let family: WidgetFamily

    private var isLarge: Bool { family == .systemLarge }

    var body: some View {
        VStack(alignment: .leading, spacing: isLarge ? 9 : 6) {
            ActivityHomeHeader(model: model, compact: !isLarge)

            if model.rows.isEmpty {
                ActivityHomeAllClear(freshness: model.freshness)
                    .frame(maxHeight: .infinity)
            } else {
                VStack(alignment: .leading, spacing: isLarge ? 7 : 5) {
                    ForEach(model.rows) { row in
                        ActivityHomeRowLink(row: row) {
                            ActivityHomeRow(row: row, showsScope: isLarge)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }

            if model.signal != nil || model.moreCount > 0 {
                ActivityHomeFooter(signal: model.signal, moreCount: model.moreCount)
            }
        }
        .padding(.horizontal, 2)
        .padding(.vertical, 1)
    }
}

/// The state strip: one glyph and one count per nonzero bucket, plus the age
/// when the snapshot is behind. This is the headline — five short facts instead
/// of one number that has to stand for whichever thing sorted first.
private struct ActivityHomeHeader: View {
    let model: ActivityHomeModel
    let compact: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: compact ? 9 : 11) {
            if model.groups.isEmpty {
                Text("ADE")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            ForEach(model.groups) { entry in
                HStack(spacing: 3) {
                    Image(systemName: entry.group.glyph.systemImage)
                        .font(.system(size: compact ? 10 : 11, weight: .semibold))
                        .foregroundStyle(activityToneColor(entry.group.tone))
                    Text("\(entry.count)")
                        .font(.system(
                            size: compact ? 12 : 13,
                            weight: .bold,
                            design: .rounded
                        ).monospacedDigit())
                        .foregroundStyle(activityToneColor(entry.group.tone))
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(entry.count) \(entry.group.label)")
            }
            Spacer(minLength: 4)
            if let label = model.freshness?.label {
                ActivityHomeStalenessTag(
                    label: label,
                    untrusted: model.freshness?.confidence == .untrusted
                )
            }
        }
    }
}

/// Says the age out loud rather than letting confident numbers imply currency.
/// Past the untrusted threshold it also stops looking like part of the data.
private struct ActivityHomeStalenessTag: View {
    let label: String
    let untrusted: Bool

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: untrusted ? "wifi.exclamationmark" : "clock.arrow.circlepath")
                .font(.system(size: 8.5, weight: .semibold))
            Text(label)
                .font(.system(size: 9.5, weight: .semibold, design: .rounded))
                .lineLimit(1)
                .fixedSize()
        }
        .foregroundStyle(untrusted ? ADESharedTheme.statusIdle : .secondary)
        .padding(.horizontal, untrusted ? 5 : 0)
        .padding(.vertical, untrusted ? 2 : 0)
        .background(
            untrusted
                ? Capsule().fill(ADESharedTheme.statusIdle.opacity(0.14))
                : nil
        )
        .accessibilityLabel(untrusted ? "Not synced. \(label)" : label)
    }
}

/// One row: state glyph in the phase's tone, title, phase word. The provider
/// logo is gone — three Claude marks in a column said nothing, while five
/// distinct glyphs say which of five states each row is in.
private struct ActivityHomeRow: View {
    let row: ActivityWidgetPresentation.CompactLine
    let showsScope: Bool

    private var tint: Color { activityToneColor(row.tone) }

    var body: some View {
        HStack(alignment: showsScope ? .top : .center, spacing: 8) {
            Image(systemName: row.glyph?.systemImage ?? "circle.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 13)
                .padding(.top, showsScope ? 1.5 : 0)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text(row.title)
                    .font(.system(.footnote, design: .rounded).weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                if showsScope, let scope = row.scope {
                    Text(scope)
                        .font(.system(size: 10, design: .rounded))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
            }

            Spacer(minLength: 5)

            Text(row.phaseLabel)
                .font(.system(size: 10, weight: .bold, design: .rounded))
                // Colour is reserved for states that want a human. Work in
                // flight recedes so the rows that matter carry the eye.
                .foregroundStyle(row.prominent ? tint : Color.secondary)
                .lineLimit(1)
                .fixedSize()
                .padding(.top, showsScope ? 1 : 0)
        }
        .padding(.vertical, row.prominent ? 3 : 0)
        .padding(.horizontal, row.prominent ? 6 : 0)
        .background(
            row.prominent
                ? RoundedRectangle(cornerRadius: 7, style: .continuous).fill(tint.opacity(0.13))
                : nil
        )
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            [row.title, row.phaseLabel, row.scope]
                .compactMap { $0 }
                .joined(separator: ", ")
        )
        .accessibilityHint("Opens this chat in ADE.")
    }
}

/// Per-row tap target (#20). Rows without a resolvable destination fall through
/// to the widget-level link rather than becoming dead buttons.
private struct ActivityHomeRowLink<Content: View>: View {
    let row: ActivityWidgetPresentation.CompactLine
    @ViewBuilder let content: () -> Content

    var body: some View {
        if let url = row.url {
            Link(destination: url) { content() }
        } else {
            content()
        }
    }
}

/// The tail bar: the events line (#21) on the left, the row overflow on the
/// right. Two independent tap targets sharing one hairline-separated row.
///
/// They share a row because on a medium widget that row is the difference
/// between three legible rows and three clipped ones — and the two tails are
/// the same sentence anyway: *here is what else there is*.
///
/// The events line is the mirror of the notch's right-wing signal slot: PR/CI
/// traffic compressed into one sentence *inside* the agents widget, rather than
/// a second widget or a row of its own. A PR rendered as a row is how "3
/// agents" came to mean "1 agent and 2 pull requests".
private struct ActivityHomeFooter: View {
    let signal: ActivityWidgetPresentation.EventSignal?
    let moreCount: Int

    var body: some View {
        HStack(spacing: 8) {
            if let signal {
                Link(destination: signal.url ?? ActivityWidgetPresentation.activityURL) {
                    HStack(spacing: 5) {
                        Image(systemName: signal.glyph?.systemImage ?? "arrow.triangle.pull")
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundStyle(activityToneColor(signal.tone))
                            .accessibilityHidden(true)
                        Text(signal.label)
                            .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                        if signal.moreCount > 0 {
                            Text("+\(signal.moreCount)")
                                .font(.system(size: 10, weight: .bold, design: .rounded).monospacedDigit())
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .accessibilityLabel(
                    signal.moreCount > 0
                        ? "\(signal.label), and \(signal.moreCount) more events"
                        : signal.label
                )
            }

            Spacer(minLength: 4)

            if moreCount > 0 {
                Link(destination: ActivityWidgetPresentation.activityURL) {
                    HStack(spacing: 3) {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 9, weight: .bold))
                            .accessibilityHidden(true)
                        Text(moreCount == 1 ? "1 more" : "\(moreCount) more")
                            .font(.system(size: 10.5, weight: .semibold, design: .rounded).monospacedDigit())
                            .lineLimit(1)
                            .fixedSize()
                    }
                    .foregroundStyle(.secondary)
                    .contentShape(Rectangle())
                }
                .accessibilityLabel(moreCount == 1 ? "1 more agent" : "\(moreCount) more agents")
                .accessibilityHint("Opens Activity in ADE.")
            }
        }
        .padding(.top, 5)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(.quaternary)
                .frame(height: 0.5)
        }
    }
}

private struct ActivityHomeAllClear: View {
    let freshness: ActivityWidgetPresentation.Freshness?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(freshness?.confidence == .untrusted ? "No recent activity" : "All clear")
                .font(.system(.footnote, design: .rounded).weight(.semibold))
                .foregroundStyle(.secondary)
            Text(
                freshness?.confidence == .untrusted
                    ? "ADE hasn't heard from your machines."
                    : "Nothing is waiting on you."
            )
            .font(.system(size: 10.5, design: .rounded))
            .foregroundStyle(.tertiary)
            .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Small: one bucket said loudly, the top row named underneath, the rest of the
/// buckets compressed into a footer strip.
private struct ActivityHomeSmallView: View {
    let model: ActivityHomeModel

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let lead = model.leadGroup {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: lead.group.glyph.systemImage)
                        .font(.system(size: 15, weight: .semibold))
                    Text("\(lead.count)")
                        .font(.system(size: 26, weight: .bold, design: .rounded).monospacedDigit())
                    Spacer(minLength: 0)
                }
                .foregroundStyle(activityToneColor(lead.group.tone))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(lead.count) \(lead.group.label)")

                Text(lead.group.label)
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)
                    .padding(.top, -5)
            } else {
                Text("All clear")
                    .font(.system(.subheadline, design: .rounded).weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            if let top = model.rows.first {
                Text(top.title)
                    .font(.system(size: 11.5, design: .rounded).weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Spacer(minLength: 0)

            HStack(spacing: 8) {
                ForEach(model.groups.dropFirst().prefix(3)) { entry in
                    HStack(spacing: 2) {
                        Image(systemName: entry.group.glyph.systemImage)
                            .font(.system(size: 8.5, weight: .semibold))
                        Text("\(entry.count)")
                            .font(.system(size: 10, weight: .bold, design: .rounded).monospacedDigit())
                    }
                    .foregroundStyle(activityToneColor(entry.group.tone))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(entry.count) \(entry.group.label)")
                }
                Spacer(minLength: 0)
                if let signal = model.signal {
                    Image(systemName: signal.glyph?.systemImage ?? "arrow.triangle.pull")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(activityToneColor(signal.tone))
                        .accessibilityLabel(signal.label)
                }
            }

            if let label = model.freshness?.label {
                ActivityHomeStalenessTag(
                    label: label,
                    untrusted: model.freshness?.confidence == .untrusted
                )
            }
        }
        .padding(.horizontal, 2)
    }
}

/// No account feed yet (fresh install, signed out, or the relay has never
/// answered). Shows the machine-local focus rather than an empty list.
private struct ActivityHomeFallbackView: View {
    let status: LockScreenPriorityStatus
    let family: WidgetFamily

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                ZStack {
                    Circle().fill(status.tint.opacity(0.16))
                    Image(systemName: status.symbol)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(status.tint)
                }
                .frame(width: 28, height: 28)
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 1) {
                    Text(status.title)
                        .font(.system(.footnote, design: .rounded).weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text(status.detail)
                        .font(.system(size: 10.5, design: .rounded))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }

            if family != .systemSmall, !status.metrics.isEmpty {
                HStack(spacing: 9) {
                    ForEach(status.metrics.prefix(3)) { metric in
                        Label(metric.label, systemImage: metric.symbol)
                            .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                            .labelStyle(.titleAndIcon)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(status.title). \(status.detail)")
    }
}

// MARK: - Previews

#if DEBUG

private enum ActivityHomePreviewData {
    static let now = Date()

    static func machine(
        _ key: String,
        _ name: String,
        online: Bool = true
    ) -> AccountAttentionMachine {
        AccountAttentionMachine(
            machineKey: key,
            accountMachineKey: key,
            name: name,
            online: online,
            lastSeenAt: now
        )
    }

    static func agent(
        _ id: String,
        _ title: String,
        _ phase: AccountAttentionPhase,
        project: String = "ADE",
        machineName: String = "Studio Mac",
        minutesAgo: Double = 1,
        chatActivityMode: AccountChatActivityMode? = nil
    ) -> AccountAttentionItem {
        let at = now.addingTimeInterval(-minutesAgo * 60)
        return AccountAttentionItem(
            id: id,
            revision: 1,
            fingerprint: "\(id):1",
            kind: .agent,
            eventKind: .agentRunning,
            phase: phase,
            chatActivityMode: chatActivityMode,
            statusSince: at,
            machine: machine("studio", machineName),
            project: AccountAttentionProject(projectId: "ade", name: project),
            laneName: "activity-revamp",
            provider: "claude",
            model: "claude-opus-5",
            title: title,
            preview: "",
            privacyPreview: "Agent activity",
            destination: .session(sessionId: id, itemId: nil, eventId: nil),
            occurredAt: at,
            updatedAt: at
        )
    }

    static func pr(
        _ id: String,
        _ number: Int,
        _ phase: AccountAttentionPhase
    ) -> AccountAttentionItem {
        AccountAttentionItem(
            id: id,
            revision: 1,
            fingerprint: "\(id):1",
            kind: .pullRequest,
            eventKind: .prChecksFailing,
            phase: phase,
            machine: machine("studio", "Studio Mac"),
            project: AccountAttentionProject(projectId: "ade", name: "ADE"),
            title: "Widget freshness",
            preview: "",
            privacyPreview: "Pull request update",
            destination: .pullRequest(
                prId: id,
                repoOwner: "arul",
                repoName: "ade",
                number: number,
                tab: "checks",
                eventId: nil
            ),
            occurredAt: now,
            updatedAt: now
        )
    }

    static func snapshot(
        _ items: [AccountAttentionItem],
        generatedAt: Date = now
    ) -> AccountAttentionSnapshot {
        AccountAttentionSnapshot(
            revision: 1,
            generatedAt: generatedAt,
            machines: [machine("studio", "Studio Mac")],
            items: items
        )
    }

    static let busy = snapshot([
        agent("s1", "Approve the release push", .needsYou),
        agent("s2", "Refactor sync transport", .running),
        // Planning is a running turn carrying `chatActivityMode`, not a phase.
        agent("s3", "Audit pairing", .running, minutesAgo: 4, chatActivityMode: .planning),
        agent("s4", "Ship mobile status", .completed, minutesAgo: 9),
        agent("s5", "Fix flaky shard", .failed, minutesAgo: 14),
        agent("s6", "Port notch design", .running, project: "ade-web", minutesAgo: 3),
        agent("s7", "Rewrite roster builder", .running, minutesAgo: 6),
        agent("s8", "Bump relay deps", .completed, minutesAgo: 22),
        pr("pr1", 1038, .checksFailing),
        pr("pr2", 1039, .reviewRequested),
    ])

    static let quiet = snapshot([
        agent("s1", "Refactor sync transport", .running),
        pr("pr1", 1038, .mergeReady),
    ])

    static let clear = snapshot([])

    /// The case this whole pass exists for: a real snapshot the phone last
    /// heard about four hours ago.
    static let stale = snapshot(
        [
            agent("s1", "Approve the release push", .needsYou, minutesAgo: 240),
            agent("s2", "Refactor sync transport", .running, minutesAgo: 245),
        ],
        generatedAt: now.addingTimeInterval(-4 * 3600)
    )

    static func entry(_ snapshot: AccountAttentionSnapshot) -> ADEStatusEntry {
        ADEStatusEntry(
            date: now,
            snapshot: .empty,
            attentionSnapshot: snapshot,
            snapshotFetchedAt: snapshot.generatedAt
        )
    }
}

@available(iOS 17.0, *)
#Preview("Home · medium", as: .systemMedium) {
    ADELockScreenWidget()
} timeline: {
    ActivityHomePreviewData.entry(ActivityHomePreviewData.busy)
    ActivityHomePreviewData.entry(ActivityHomePreviewData.quiet)
    ActivityHomePreviewData.entry(ActivityHomePreviewData.stale)
    ActivityHomePreviewData.entry(ActivityHomePreviewData.clear)
}

@available(iOS 17.0, *)
#Preview("Home · large", as: .systemLarge) {
    ADELockScreenWidget()
} timeline: {
    ActivityHomePreviewData.entry(ActivityHomePreviewData.busy)
    ActivityHomePreviewData.entry(ActivityHomePreviewData.stale)
}

@available(iOS 17.0, *)
#Preview("Home · small", as: .systemSmall) {
    ADELockScreenWidget()
} timeline: {
    ActivityHomePreviewData.entry(ActivityHomePreviewData.busy)
    ActivityHomePreviewData.entry(ActivityHomePreviewData.clear)
}

@available(iOS 17.0, *)
#Preview("Lock · account rows", as: .accessoryRectangular) {
    ADELockScreenWidget()
} timeline: {
    ActivityHomePreviewData.entry(ActivityHomePreviewData.busy)
    ActivityHomePreviewData.entry(ActivityHomePreviewData.stale)
}

#endif
