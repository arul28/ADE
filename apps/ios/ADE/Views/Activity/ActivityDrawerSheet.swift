import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// Account-wide Activity, in two buckets: Sessions and Inbox.
///
/// Sessions is every agent across every signed-in machine, sectioned by the
/// Work board's four columns (Needs you, Working, Waiting, Done) with Done
/// folded away, under the same five chips the Hub uses (All plus the four
/// columns) that both summarise them and filter to one. Inbox is the traffic that wants an
/// acknowledgement — pull requests, CI, and outcomes nobody has looked at.
/// Rows carry a swipe to dismiss or mark seen, and the row itself is the tap
/// target: the per-row "Open" button this sheet used to draw was most of its
/// height spent restating that a list row is tappable.
struct ActivityDrawerSheet: View {
    @EnvironmentObject private var drawer: ActivityDrawerModel
    @EnvironmentObject private var accountService: AccountService
    @EnvironmentObject private var syncService: SyncService
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var bucket: ActivityBucket = .sessions
    /// The row currently waking its machine, so the wait is attached to the
    /// thing that caused it rather than to a modal over the whole sheet.
    @State private var connectingRowId: String?
    @State private var connectFailureRowId: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                bucketPicker
                if bucket == .sessions, !drawer.sessions.isEmpty {
                    HubRosterFilterBar(
                        counts: HubRosterFilter.counts(from: drawer.columnCounts),
                        selection: Binding(
                            get: { HubRosterFilter(column: drawer.stateFilter) },
                            set: { drawer.stateFilter = $0.column }
                        ),
                        accessibilityTitle: "Agent states",
                        accessibilityHintText: "Shows only the sessions in that state."
                    )
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)
                }
                if let message = failureMessage {
                    ActivityErrorBanner(message: message)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }
                content
            }
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            drawer.markAllSeen()
                        } label: {
                            Label("Mark all seen", systemImage: "checkmark.circle")
                        }
                        Button(role: .destructive) {
                            drawer.dismissVisible(in: bucket)
                        } label: {
                            Label("Dismiss \(bucket.title.lowercased())", systemImage: "rectangle.stack.badge.minus")
                        }
                        .disabled(drawer.rows(in: bucket).isEmpty)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Activity actions")
                }
            }
            .adeScreenBackground()
            .adeNavigationGlass()
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationContentInteraction(.scrolls)
        .task {
            await accountService.refreshAttentionSnapshot()
            await accountService.updateAttentionPresence(
                centerVisible: true,
                visibleItemIds: drawer.visibleItemIds
            )
        }
        .onDisappear {
            Task {
                await accountService.updateAttentionPresence(
                    centerVisible: false,
                    visibleItemIds: []
                )
            }
        }
    }

    private var bucketPicker: some View {
        ADEKitSegmented(
            selection: $bucket,
            options: ActivityBucket.allCases.map { (value: $0, title: bucketLabel($0)) }
        )
        .accessibilityLabel("Activity bucket")
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 10)
    }

    private func bucketLabel(_ value: ActivityBucket) -> String {
        let count = drawer.rows(in: value).count
        return count > 0 ? "\(value.title) \(count)" : value.title
    }

    /// The relay is the only thing that can tell us an acknowledgement or a
    /// refresh failed; both used to vanish into an empty `catch`.
    private var failureMessage: String? {
        accountService.attentionAckFailure ?? accountService.attentionRefreshFailure
    }

    @ViewBuilder
    private var content: some View {
        switch bucket {
        case .sessions:
            if drawer.sessions.isEmpty {
                emptyState
            } else if drawer.sessionSections.isEmpty, let filter = drawer.stateFilter {
                // Filtered down to nothing. Distinct from "all clear": the
                // strip above still has a lit chip, and saying so is what
                // stops a blank pane reading as a broken feed.
                filteredEmptyState(filter)
            } else {
                sessionsList
            }
        case .inbox:
            if drawer.inbox.isEmpty {
                emptyState
            } else {
                inboxList
            }
        }
    }

    private var sessionsList: some View {
        List {
            ForEach(drawer.sessionSections) { section in
                Section {
                    ForEach(section.entries) { entry in
                        entryView(entry)
                    }
                } header: {
                    // Suppressed while a filter is on: with one section on
                    // screen and its chip lit in the strip above, a heading
                    // that repeats the same word and the same number is the
                    // third time the reader is told the same thing.
                    if drawer.stateFilter == nil {
                        ActivitySectionHeader(
                            column: section.column,
                            count: section.count,
                            onCollapse: section.column == .done ? {
                                withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) {
                                    drawer.doneExpanded = false
                                }
                            } : nil
                        )
                    }
                }
            }
            if let doneCount = drawer.collapsedDoneCount {
                ActivityCollapsedDoneRow(count: doneCount) {
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) {
                        drawer.doneExpanded = true
                    }
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
            }
            if drawer.itemsTruncated {
                truncationNote
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }

    private var inboxList: some View {
        List {
            ForEach(drawer.inboxEntries) { entry in
                entryView(entry)
            }
            if drawer.itemsTruncated {
                truncationNote
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }

    @ViewBuilder
    private func entryView(_ entry: ActivityListEntry) -> some View {
        switch entry {
        case .offlineMachine(_, let name, let lastSeenLabel):
            ActivityOfflineMachineBanner(machineName: name, lastSeenLabel: lastSeenLabel)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 4, trailing: 16))
        case .row(let row):
            VStack(alignment: .leading, spacing: 8) {
                ActivityRow(
                    row: row,
                    dimmed: !row.machineOnline,
                    connectState: connectState(for: row)
                ) { follow(row) }
                ActivityActionButtons(
                    row: row,
                    markSeen: { drawer.markSeen(row.id) },
                    openSession: { follow(row) }
                )
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 2, trailing: 16))
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(role: .destructive) {
                    drawer.dismiss(row.id)
                } label: {
                    Label("Dismiss", systemImage: "xmark")
                }
                Button {
                    drawer.markSeen(row.id)
                } label: {
                    Label("Mark seen", systemImage: "checkmark")
                }
                .tint(ADEColor.accent)
            }
            // Swipe is not an affordance every input method has. Voice Control,
            // Switch Control, and direct-touch users with limited mobility get
            // the same two actions here.
            .contextMenu {
                Button {
                    drawer.markSeen(row.id)
                } label: {
                    Label("Mark seen", systemImage: "checkmark")
                }
                Button(role: .destructive) {
                    drawer.dismiss(row.id)
                } label: {
                    Label("Dismiss", systemImage: "xmark")
                }
            }
        }
    }

    private var truncationNote: some View {
        Text("Showing the most recent activity. Older rows stay on their machine.")
            .font(.system(size: 11.5))
            .foregroundStyle(ADEColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 20, trailing: 16))
    }

    /// Three genuinely different empty states: nothing to reach, nothing to do,
    /// and nothing new. They used to be one grey placeholder.
    private func filteredEmptyState(_ filter: ActivityBoardColumn) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: filter.systemImage)
                .font(.system(size: 24, weight: .regular))
                .foregroundStyle(activityToneColor(filter.tone))
            Text("Nothing \(filter.label.lowercased())")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ADEColor.textPrimary)
            Button("Show all states") { drawer.stateFilter = nil }
                .buttonStyle(ADEKitButtonStyle())
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    private var emptyState: some View {
        let copy = emptyCopy
        return VStack(spacing: 14) {
            Spacer()
            Image(systemName: copy.symbol)
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(copy.tint)
                .accessibilityHidden(true)
            VStack(spacing: 5) {
                Text(copy.title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                Text(copy.body)
                    .font(.system(size: 13.5))
                    .foregroundStyle(ADEColor.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(copy.title). \(copy.body)")
            if drawer.source == .none {
                Button("Try again") {
                    Task { await accountService.refreshAttentionSnapshot() }
                }
                .buttonStyle(ADEKitButtonStyle())
                .frame(minHeight: 44)
            }
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 32)
        // `.contain`, not `.combine`: combining here swallowed the "Try again"
        // button, which is the only recovery path when the source is unreachable.
        .accessibilityElement(children: .contain)
    }

    private var emptyCopy: (symbol: String, tint: Color, title: String, body: String) {
        if drawer.source == .none {
            return (
                "antenna.radiowaves.left.and.right.slash",
                ADEColor.textMuted,
                "Can't reach your machines",
                "Sign in or reconnect to see what your agents are doing."
            )
        }
        switch bucket {
        case .sessions:
            return (
                "moon.zzz",
                ADEColor.textMuted,
                "All agents idle.",
                "Sessions appear here the moment one starts working."
            )
        case .inbox:
            return (
                "checkmark.seal",
                ADESharedTheme.statusSuccess,
                "Nothing needs you.",
                "Pull requests, checks, and finished runs land here."
            )
        }
    }

    /// Open the row's chat, connecting to its machine first when that machine
    /// is not the one this phone is currently talking to.
    ///
    /// The connect already happened — but *after* the sheet dismissed, inside
    /// the navigation handler, where it is invisible. On a cold remote machine
    /// that reads as a dead tap followed some seconds later by a screen change.
    /// Doing it here keeps the sheet up and says what is happening on the row
    /// itself, so the wait has a cause attached to it.
    ///
    /// `markSeen` fires only once the hand-off actually happens. Acknowledging
    /// on the tap was fine while the tap always navigated, but a cross-machine
    /// open can END at "could not reach" — and marking a question seen when the
    /// reader never got to it drops it out of the needs-you band on every
    /// surface, for a question still waiting. The row that failed to open stays
    /// unread, which is what it is.
    private func follow(_ row: ActivityRowPresentation) {
        guard let url = row.deepLink else { return }
        connectFailureRowId = nil

        guard let machineKey = row.accountMachineKey,
              !syncService.accountMachineIsCurrent(machineKey) else {
            drawer.markSeen(row.id)
            handOff(url)
            return
        }

        connectingRowId = row.id
        Task { @MainActor in
            let reached = await syncService.ensureAccountMachineForNavigation(machineKey)
            connectingRowId = nil
            guard reached else {
                // Leave the sheet up: the row is still the best place to try
                // again, and a dismissed sheet would strand the reader on a
                // screen that never changed.
                connectFailureRowId = row.id
                return
            }
            drawer.markSeen(row.id)
            handOff(url)
        }
    }

    private func connectState(for row: ActivityRowPresentation) -> ActivityRowConnectState {
        if connectingRowId == row.id { return .connecting(row.machineName) }
        if connectFailureRowId == row.id { return .unreachable(row.machineName) }
        return .idle
    }

    private func handOff(_ url: URL) {
        dismiss()
        DispatchQueue.main.asyncAfter(deadline: .now() + (reduceMotion ? 0 : 0.18)) {
            DeepLinkRouter.shared.handle(url)
        }
    }
}

// MARK: - Section header

/// A column heading. Takes the column rather than a hand-written tint, so the
/// heading, the chips above it and the counts on every other surface read the
/// same table. The Done heading carries a control that folds it away again.
private struct ActivitySectionHeader: View {
    let column: ActivityBoardColumn
    let count: Int
    var onCollapse: (() -> Void)?

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: column.systemImage)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(activityToneColor(column.tone))
            Text(column.label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .textCase(nil)
            Text("\(count)")
                .font(.adeMono(11))
                .foregroundStyle(ADEColor.textMuted)
                .contentTransition(.numericText())
            Spacer(minLength: 0)
            if let onCollapse {
                Button(action: onCollapse) {
                    Image(systemName: "chevron.up")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(ADEColor.textMuted)
                        .frame(minWidth: 44, minHeight: 28, alignment: .trailing)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Hide done sessions")
            }
        }
        .padding(.vertical, 2)
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 4, trailing: 16))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(column.label), \(count)")
    }
}

// MARK: - Collapsed Done

/// The folded Done section: "✓ Done 12 ⌄". Done is most of a real account's
/// feed and none of its urgency, so it stays closed until the reader opens it.
private struct ActivityCollapsedDoneRow: View {
    let count: Int
    let expand: () -> Void

    var body: some View {
        Button(action: expand) {
            HStack(spacing: 7) {
                Image(systemName: ActivityBoardColumn.done.systemImage)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(activityToneColor(ActivityBoardColumn.done.tone))
                Text(ActivityBoardColumn.done.label)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                Text("\(count)")
                    .font(.adeMono(11))
                    .foregroundStyle(ADEColor.textMuted)
                Spacer(minLength: 0)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ADEColor.textMuted)
            }
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Done, \(count)")
        .accessibilityHint("Double tap to show them")
    }
}

// MARK: - Error banner

private struct ActivityErrorBanner: View {
    let message: String

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(.caption, design: .rounded).weight(.semibold))
                .foregroundStyle(ADESharedTheme.warningAmber)
                .accessibilityHidden(true)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(ADEColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .background(ADESharedTheme.warningAmber.opacity(0.08), in: RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Error. \(message)")
    }
}

// MARK: - Server-supplied actions

/// Draws the row's own `actions[]` — see
/// `ActivityRowPresentation.visibleActions` for which of them earn a button and
/// why. The rule lives on the presentation rather than here so it can be
/// asserted directly instead of inferred from a rendered view.
struct ActivityActionButtons: View {
    let row: ActivityRowPresentation
    let markSeen: () -> Void
    /// Same handler the row's own tap uses, so the button cannot reach a
    /// different destination — including the cross-machine wake it performs
    /// first.
    let openSession: () -> Void

    var body: some View {
        if row.visibleActions.isEmpty {
            EmptyView()
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons }
                VStack(spacing: 8) { buttons }
            }
            .padding(.bottom, 4)
        }
    }

    @ViewBuilder
    private var buttons: some View {
        ForEach(row.visibleActions, id: \.id) { action in
            actionButton(action)
        }
    }

    @ViewBuilder
    private func actionButton(_ action: AccountAttentionAction) -> some View {
        switch action.kind {
        case .approve:
            Button(intent: ApproveSessionIntent(
                sessionId: row.sessionId ?? "",
                itemId: row.pendingItemId ?? ""
            )) {
                ActivityActionLabel(action.label, systemImage: "checkmark", variant: .primary(ADEColor.success))
            }
            .buttonStyle(.plain)
            .simultaneousGesture(TapGesture().onEnded(markSeen))

        case .deny:
            Button(intent: DenySessionIntent(
                sessionId: row.sessionId ?? "",
                itemId: row.pendingItemId ?? ""
            )) {
                ActivityActionLabel(action.label, systemImage: "xmark", variant: .danger)
            }
            .buttonStyle(.plain)
            .simultaneousGesture(TapGesture().onEnded(markSeen))

        case .restart:
            Button(intent: RestartSessionIntent(sessionId: row.sessionId ?? "")) {
                ActivityActionLabel(action.label, systemImage: "arrow.uturn.backward", variant: .secondary)
            }
            .buttonStyle(.plain)
            .simultaneousGesture(TapGesture().onEnded(markSeen))

        case .rerunChecks:
            Button(intent: RetryCheckIntent(
                prNumber: row.prNumber ?? 0,
                prId: row.actionPayloadString(action, key: "prId") ?? ""
            )) {
                ActivityActionLabel(action.label, systemImage: "arrow.clockwise", variant: .secondary)
            }
            .buttonStyle(.plain)
            .simultaneousGesture(TapGesture().onEnded(markSeen))

        // Label comes from the wire ("Answer"), not from a second vocabulary
        // invented here: the host already names this action for every surface
        // in `attentionItemBuilder`, and a button that disagrees with the push
        // that raised it is the drift this contract exists to prevent.
        case .answer:
            Button(action: openSession) {
                ActivityActionLabel(
                    action.label,
                    systemImage: "arrowshape.turn.up.left",
                    variant: .primary(activityToneColor(.amber))
                )
            }
            .buttonStyle(.plain)

        // Unreachable: `visibleActions` admits the four inline intents above
        // plus `.answer`. Everything else is navigation, and navigation is the
        // row.
        case .open, .markSeen, .dismiss, .unrecognized:
            EmptyView()
        }
    }
}

private extension ActivityRowPresentation {
    func actionPayloadString(_ action: AccountAttentionAction, key: String) -> String? {
        guard case .string(let value)? = action.payload?[key] else { return nil }
        return value
    }
}

private enum ActivityActionVariant {
    case primary(Color)
    case secondary
    case danger

    var foreground: Color {
        switch self {
        case .primary(let tint): return tint
        case .secondary: return ADEColor.textPrimary
        case .danger: return ADEColor.danger
        }
    }

    var background: Color {
        switch self {
        case .primary(let tint): return tint.opacity(0.13)
        case .secondary: return ADEKit.track
        case .danger: return ADEColor.danger.opacity(0.11)
        }
    }
}

private struct ActivityActionLabel: View {
    let title: String
    let systemImage: String
    let variant: ActivityActionVariant

    init(_ title: String, systemImage: String, variant: ActivityActionVariant) {
        self.title = title
        self.systemImage = systemImage
        self.variant = variant
    }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .semibold))
                .accessibilityHidden(true)
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.76)
        }
        .foregroundStyle(variant.foreground)
        .frame(maxWidth: .infinity, minHeight: 40)
        .padding(.horizontal, 10)
        .background(variant.background, in: Capsule(style: .continuous))
        .contentShape(Capsule(style: .continuous))
    }
}

// MARK: - Fixture screens (DEBUG)

#if DEBUG
/// Fixture data for the Activity fixture screens (`-adePreviewScreen
/// activity-hub | activity-drawer | chat-connecting | live-activity`). Lets a
/// simulator with no sign-in and no machine show the four-state surfaces.
enum ActivityPreviewData {
  static let now = Date()

  static func iso(minutesAgo: Double) -> String {
    ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutesAgo * 60))
  }

  static let project = MobileProjectSummary(
    id: "preview-ade",
    displayName: "ADE",
    rootPath: "/Users/arul/Projects/ADE",
    laneCount: 3,
    isAvailable: true,
    isCached: true
  )

  static let lanes = [
    RemoteRosterLane(id: "lane-main", name: "Primary", color: "#7C8CFF"),
    RemoteRosterLane(id: "lane-sync", name: "sync-retry", color: "#3FB37F", prWaitingReason: "ci"),
    RemoteRosterLane(id: "lane-docs", name: "docs-refresh", color: "#E7A23A"),
  ]

  static func chat(
    _ id: String,
    lane: String,
    title: String,
    status: RemoteRosterChatStatus,
    minutesAgo: Double,
    awaiting: Bool? = nil,
    snoozedUntil: String? = nil
  ) -> RemoteRosterChat {
    var chat = RemoteRosterChat(
      id: id, laneId: lane, chatSessionId: nil, title: title, provider: "claude",
      model: "claude-opus-5-5", toolType: "claude-chat", status: status,
      awaitingInput: awaiting, pinned: nil, archived: nil,
      lastActivityAt: iso(minutesAgo: minutesAgo), preview: nil
    )
    chat.snoozedUntil = snoozedUntil
    return chat
  }

  static let roster = RemoteRosterProject(
    projectId: "preview-ade",
    rootPath: "/Users/arul/Projects/ADE",
    displayName: "ADE",
    booted: true,
    runningCount: 2,
    attentionCount: 1,
    lanes: lanes,
    chats: [
      chat("c1", lane: "lane-main", title: "Should I force-push the rebase?", status: .awaiting, minutesAgo: 2, awaiting: true),
      chat("c2", lane: "lane-main", title: "Credential store hardening", status: .failed, minutesAgo: 9),
      chat("c3", lane: "lane-main", title: "Explore sync transport", status: .running, minutesAgo: 1),
      chat("c4", lane: "lane-sync", title: "Fix the sync retry", status: .running, minutesAgo: 3),
      chat("c5", lane: "lane-docs", title: "Rewrite the pairing guide", status: .idle, minutesAgo: 30,
           snoozedUntil: ISO8601DateFormatter().string(from: now.addingTimeInterval(3_600))),
      chat("c6", lane: "lane-docs", title: "Release notes for 1.4", status: .idle, minutesAgo: 120),
      chat("c7", lane: "lane-main", title: "Widget freshness tag", status: .ended, minutesAgo: 600),
    ]
  )

  static let machine = AccountAttentionMachine(
    machineKey: "studio", accountMachineKey: nil, name: "Arul's Mac Studio", online: true, lastSeenAt: now
  )

  static func item(
    _ id: String,
    title: String,
    phase: AccountAttentionPhase,
    tier: String? = nil,
    column: String? = nil,
    reason: String? = nil,
    minutesAgo: Double
  ) -> AccountAttentionItem {
    let at = now.addingTimeInterval(-minutesAgo * 60)
    return AccountAttentionItem(
      id: "agent:studio:\(id)", revision: 1, fingerprint: id, kind: .agent,
      eventKind: phase == .needsYou ? .agentNeedsYou : phase == .failed ? .agentFailed : .agentRunning,
      phase: phase, activityTier: tier, boardColumn: column, waitingReason: reason,
      statusSince: at, machine: machine,
      project: AccountAttentionProject(projectId: "preview-ade", name: "ADE"),
      laneName: "Primary", provider: "claude", model: "claude-opus-5-5",
      title: title, preview: "", privacyPreview: "An ADE agent", destination: .session(sessionId: id, itemId: nil, eventId: nil),
      occurredAt: at, updatedAt: at
    )
  }

  static let snapshot = AccountAttentionSnapshot(
    revision: 1,
    generatedAt: now,
    machines: [machine],
    items: [
      item("c1", title: "Should I force-push the rebase?", phase: .needsYou, column: "needs_you", minutesAgo: 2),
      item("c2", title: "Credential store hardening", phase: .failed, column: "needs_you", minutesAgo: 9),
      item("c3", title: "Explore sync transport", phase: .running, column: "working", minutesAgo: 1),
      item("c4", title: "Fix the sync retry", phase: .running, column: "waiting", reason: "ci", minutesAgo: 3),
      item("c5", title: "Rewrite the pairing guide", phase: .stale, tier: "idle", column: "waiting", reason: "snoozed", minutesAgo: 30),
      item("c6", title: "Release notes for 1.4", phase: .completed, tier: "idle", column: "done", minutesAgo: 120),
      item("c7", title: "Widget freshness tag", phase: .completed, tier: "idle", column: "done", minutesAgo: 600),
    ]
  )
}

/// The Hub's five chips over a fixture project, filtering live.
struct ActivityHubPreviewHost: View {
  @State private var filter: HubRosterFilter = .all
  @State private var collapsedLaneKeys: Set<String> = []
  @State private var toast: ADEToastMessage?

  private var presentation: HubProjectPresentation {
    buildHubProjectPresentation(
      project: ActivityPreviewData.project,
      roster: ActivityPreviewData.roster,
      isActive: true,
      isSwitching: false
    )
  }

  var body: some View {
    let all = presentation
    VStack(spacing: 0) {
      HubRosterFilterBar(
        counts: Dictionary(uniqueKeysWithValues: HubRosterFilter.allCases.map {
          ($0, hubRosterFilterCount([all], filter: $0))
        }),
        selection: $filter
      )
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
      ScrollView {
        if let shown = hubProjectPresentation(all, matching: filter) {
          HubProjectCard(
            presentation: shown,
            isCollapsed: false,
            collapsedLaneKeysSnapshot: collapsedLaneKeys,
            collapsedLaneKeys: $collapsedLaneKeys,
            allowsCollapse: false,
            onToggleCollapse: {}, onOpenProject: {}, onOpenChat: { _, _ in },
            onViewLaneInWork: { _ in }, onViewLaneInLanes: { _ in },
            onArchiveChat: { _ in }, onDeleteChat: { _ in }, onForget: {}
          )
          .padding(.horizontal, 16)
        } else {
          HubRosterFilterEmptyState(filter: filter)
        }
      }
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .adeToast($toast)
    .task {
      guard ProcessInfo.processInfo.arguments.contains("-adePreviewHubNotice") else { return }
      try? await Task.sleep(nanoseconds: 600_000_000)
      toast = ADEToastMessage(text: "Arul's Mac Studio is offline.", kind: .info)
    }
  }
}

/// The real Activity drawer over a fixture account snapshot.
struct ActivityDrawerPreviewHost: View {
  @StateObject private var drawer = ActivityDrawerModel(
    defaults: UserDefaults(suiteName: "ade.preview.activity") ?? .standard
  )

  var body: some View {
    ADEColor.pageBackground.ignoresSafeArea()
      .sheet(isPresented: .constant(true)) {
        ActivityDrawerSheet()
          .environmentObject(drawer)
      }
      .onAppear {
        drawer.rebuild(from: ActivityPreviewData.snapshot)
      }
  }
}

/// The chat frame a restored chat shows while it connects.
struct ChatConnectingPreviewHost: View {
  var body: some View {
    NavigationStack {
      WorkChatConnectingFrame(machineName: "Arul's Mac Studio")
        .workSessionNavigationChrome(
          mode: .pushedDetail,
          title: "Fix the sync retry",
          subtitle: "Arul's Mac Studio"
        ) { EmptyView() }
    }
  }
}

/// Starts a local Live Activity with fixture column counts, and writes the
/// fixture feed for the widgets, so the lock screen, the Dynamic Island and the
/// widgets can be screenshotted. Machine-scoped so the widget
/// renders it without an account; `LiveActivityService` does not run in
/// fixture mode, so nothing ends it.
struct LiveActivityPreviewHost: View {
  @State private var status = "Starting the Live Activity…"

  var body: some View {
    Text(status)
      .font(.headline)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .task {
        // The widgets read the same fixture feed from the App Group.
        ADESharedContainer.writeAttentionSnapshot(ActivityPreviewData.snapshot)
        WidgetCenter.shared.reloadAllTimelines()
        for activity in Activity<ADEAgentRunsAttributes>.activities {
          await activity.end(nil, dismissalPolicy: .immediate)
        }
        let state = ADEAgentRunsAttributes.ContentState(
          updatedAt: Date().timeIntervalSince1970,
          columns: .init(needsYou: 2, working: 5, waiting: 1, done: 12),
          activeCount: 8,
          runs: []
        )
        do {
          _ = try Activity.request(
            attributes: ADEAgentRunsAttributes(machineName: "Preview", accountWide: false),
            content: ActivityContent(state: state, staleDate: nil)
          )
          status = "Live Activity started: 2 need you · 5 working · 1 waiting · 12 done"
        } catch {
          status = "Live Activity failed: \(error.localizedDescription)"
        }
      }
  }
}
#endif
