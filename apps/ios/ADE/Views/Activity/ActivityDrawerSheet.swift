import AppIntents
import SwiftUI

/// Account-wide Activity, in two buckets: Sessions and Inbox.
///
/// Sessions is every agent across every signed-in machine, sectioned by the
/// six canonical states in priority order, with a glyph strip above that both
/// summarises them and filters to one. Inbox is the traffic that wants an
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
                if bucket == .sessions, !drawer.stripCounts.isEmpty {
                    ActivityStateStrip(
                        counts: drawer.stripCounts,
                        selection: drawer.stateFilter,
                        onSelect: { group in
                            withAnimation(reduceMotion ? nil : .snappy(duration: 0.18)) {
                                drawer.stateFilter = drawer.stateFilter == group ? nil : group
                            }
                        }
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
        Picker("Activity bucket", selection: $bucket) {
            ForEach(ActivityBucket.allCases, id: \.self) { value in
                Text(bucketLabel(value)).tag(value)
            }
        }
        .pickerStyle(.segmented)
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
                        ActivitySectionHeader(group: section.group, count: section.count)
                    }
                }
            }
            if let resting = drawer.restingSummary {
                ActivityRestingSummaryRow(counts: resting) {
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) {
                        drawer.restingExpanded = true
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
            .font(.system(.caption2, design: .rounded))
            .foregroundStyle(ADEColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 20, trailing: 16))
    }

    /// Three genuinely different empty states: nothing to reach, nothing to do,
    /// and nothing new. They used to be one grey placeholder.
    private func filteredEmptyState(_ filter: ActivityStateGroup) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: filter.glyph.systemImage)
                .font(.system(.title, design: .rounded))
                .foregroundStyle(activityToneColor(filter.tone).opacity(0.7))
            Text("Nothing \(filter.label.lowercased())")
                .font(.system(.subheadline, design: .rounded).weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
            Button("Show all states") { drawer.stateFilter = nil }
                .font(.system(.footnote, design: .rounded).weight(.medium))
                .foregroundStyle(ADEColor.accent)
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
                .font(.system(.largeTitle, design: .rounded).weight(.regular))
                .foregroundStyle(copy.tint)
                .accessibilityHidden(true)
            VStack(spacing: 5) {
                Text(copy.title)
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                Text(copy.body)
                    .font(.system(.subheadline, design: .rounded))
                    .foregroundStyle(ADEColor.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(copy.title). \(copy.body)")
            if drawer.source == .none {
                Button {
                    Task { await accountService.refreshAttentionSnapshot() }
                } label: {
                    Text("Try again")
                        .font(.system(.footnote, design: .rounded).weight(.semibold))
                        .foregroundStyle(ADEColor.accent)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                        .background(ADEColor.accent.opacity(0.14), in: Capsule())
                        .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
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

/// A state heading. Takes the group rather than a hand-written tint, so the
/// heading, the strip above it and the glyph on every row beneath it are all
/// reading the same table.
private struct ActivitySectionHeader: View {
    let group: ActivityStateGroup
    let count: Int

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: group.glyph.systemImage)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(activityToneColor(group.tone))
            Text(group.label)
                .font(.system(.subheadline, design: .rounded).weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .textCase(nil)
            Text("\(count)")
                .font(.system(.caption, design: .rounded).weight(.semibold).monospacedDigit())
                .foregroundStyle(activityToneColor(group.tone))
                .contentTransition(.numericText())
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 4, trailing: 16))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(group.label), \(count)")
    }
}

// MARK: - State strip

/// The six-state summary, which is also the filter.
///
/// One control doing both jobs is the point: a separate row of filter chips
/// would repeat the same six words and counts directly beneath the same six
/// glyphs, in a sheet whose whole problem was that it was too tall. Tapping a
/// lit glyph clears the filter.
///
/// Single-select on purpose — see `ActivityDrawerModel.stateFilter`.
struct ActivityStateStrip: View {
    let counts: [ActivityGroupCount]
    let selection: ActivityStateGroup?
    let onSelect: (ActivityStateGroup) -> Void

    /// At accessibility text sizes six glyph+count pairs stop fitting on one
    /// line, and a strip that wraps to two lines reads as a list rather than a
    /// summary. The live bands are the ones worth keeping.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var visible: [ActivityGroupCount] {
        guard dynamicTypeSize.isAccessibilitySize else { return counts }
        let capped = Array(counts.prefix(3))
        guard let selection, !capped.contains(where: { $0.group == selection }) else {
            return capped
        }
        guard let selected = counts.first(where: { $0.group == selection }) else {
            return capped
        }
        return Array(capped.dropLast()) + [selected]
    }

    private var summarySentence: String {
        counts.map { "\($0.count) \($0.group.label.lowercased())" }
            .joined(separator: ", ")
    }

    var body: some View {
        HStack(spacing: 6) {
            ForEach(visible) { entry in
                Button {
                    onSelect(entry.group)
                } label: {
                    ActivityStateStripItem(
                        entry: entry,
                        isSelected: selection == entry.group
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(entry.count) \(entry.group.label)")
                .accessibilityAddTraits(selection == entry.group ? [.isSelected] : [])
                .accessibilityHint(
                    selection == entry.group
                        ? "Double tap to show all states"
                        : "Double tap to show only \(entry.group.label.lowercased())"
                )
            }
        }
        // One rotor stop that says the whole state of the account, instead of
        // six unlabelled buttons the reader has to assemble themselves.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agent states: \(summarySentence)")
    }
}

/// One chip in the state strip.
///
/// Sized and filled like a control rather than drawn as bare glyph+number on
/// the background. The first version floated three tinted marks in dead space
/// under the Sessions/Inbox picker with nothing tying them together, so they
/// read as debug output rather than as the filter they are. Equal widths keep
/// the row from reflowing as counts cross from one digit to two.
private struct ActivityStateStripItem: View {
    let entry: ActivityGroupCount
    let isSelected: Bool

    private var tint: Color { activityToneColor(entry.group.tone) }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: entry.group.glyph.systemImage)
                .font(.system(size: 11, weight: .semibold))
            Text("\(entry.count)")
                .font(.system(size: 13, weight: .semibold, design: .rounded).monospacedDigit())
                .contentTransition(.numericText())
        }
        .foregroundStyle(isSelected ? tint : tint.opacity(0.75))
        .frame(maxWidth: .infinity)
        .frame(height: 30)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(tint.opacity(isSelected ? 0.20 : 0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(tint.opacity(isSelected ? 0.55 : 0), lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

// MARK: - Resting summary

/// The collapsed stand-in for idle + done: "◷ 6 idle · ✓ 10 done".
///
/// These two bands are most of a real account's feed and none of its urgency.
/// Rendering them inline is what made the sheet a wall of finished work with
/// the live rows lost somewhere above it.
private struct ActivityRestingSummaryRow: View {
    let counts: [ActivityGroupCount]
    let expand: () -> Void

    private var sentence: String {
        counts.map { "\($0.count) \($0.group.label.lowercased())" }
            .joined(separator: ", ")
    }

    var body: some View {
        Button(action: expand) {
            HStack(spacing: 10) {
                ForEach(counts) { entry in
                    HStack(spacing: 4) {
                        Image(systemName: entry.group.glyph.systemImage)
                            .font(.system(size: 11, weight: .regular))
                        Text("\(entry.count) \(entry.group.label.lowercased())")
                            .font(.system(.footnote, design: .rounded))
                    }
                    .foregroundStyle(activityToneColor(entry.group.tone).opacity(0.85))
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ADEColor.textMuted)
            }
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Resting sessions: \(sentence)")
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
                .font(.system(.caption, design: .rounded))
                .foregroundStyle(ADEColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .background(ADESharedTheme.warningAmber.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(ADESharedTheme.warningAmber.opacity(0.28), lineWidth: 0.7)
        )
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
        case .primary(let tint): return tint.opacity(0.18)
        case .secondary: return ADEColor.surfaceBackground.opacity(0.72)
        case .danger: return ADEColor.danger.opacity(0.14)
        }
    }

    var stroke: Color {
        switch self {
        case .primary(let tint): return tint.opacity(0.32)
        case .secondary: return ADEColor.glassBorder
        case .danger: return ADEColor.danger.opacity(0.30)
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
                .font(.system(.caption2, design: .rounded).weight(.bold))
                .accessibilityHidden(true)
            Text(title)
                .font(.system(.caption, design: .rounded).weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.76)
        }
        .foregroundStyle(variant.foreground)
        .frame(maxWidth: .infinity, minHeight: 44)
        .padding(.horizontal, 10)
        .background(variant.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(variant.stroke, lineWidth: 0.6)
        )
        .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
