import AppIntents
import SwiftUI

/// Account-wide Activity, in two buckets: Sessions and Inbox.
///
/// Sessions is every agent across every signed-in machine, priority-flat
/// (needs you → working → done). Inbox is the traffic that wants an
/// acknowledgement — pull requests, CI, and outcomes nobody has looked at.
/// Rows carry a swipe to dismiss or mark seen, which is the first per-item
/// affordance this surface has ever had.
struct ActivityDrawerSheet: View {
    @EnvironmentObject private var drawer: ActivityDrawerModel
    @EnvironmentObject private var accountService: AccountService
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var bucket: ActivityBucket = .sessions

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                bucketPicker
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
                    ActivitySectionHeader(band: section.band, count: section.count)
                }
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
                ActivityRow(row: row, dimmed: !row.machineOnline) { follow(row) }
                ActivityActionButtons(
                    row: row,
                    open: { follow(row) },
                    markSeen: { drawer.markSeen(row.id) }
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

    private func follow(_ row: ActivityRowPresentation) {
        guard let url = row.deepLink else { return }
        drawer.markSeen(row.id)
        dismiss()
        DispatchQueue.main.asyncAfter(deadline: .now() + (reduceMotion ? 0 : 0.18)) {
            DeepLinkRouter.shared.handle(url)
        }
    }
}

// MARK: - Section header

private struct ActivitySectionHeader: View {
    let band: ActivityBand
    let count: Int

    private var tint: Color {
        switch band {
        case .needsYou: return ADESharedTheme.warningAmber
        case .working: return ADESharedTheme.statusRunning
        case .done: return ADESharedTheme.statusSuccess
        }
    }

    var body: some View {
        HStack(spacing: 7) {
            Text(band.title)
                .font(.system(.subheadline, design: .rounded).weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .textCase(nil)
            Text("\(count)")
                .font(.system(.caption, design: .rounded).weight(.semibold).monospacedDigit())
                .foregroundStyle(tint)
                .contentTransition(.numericText())
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 4, trailing: 16))
        .accessibilityElement(children: .combine)
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

/// The item's own `actions[]`, rendered instead of the per-kind buttons this
/// sheet used to hardcode. Inline App Intents run against the paired host, so
/// they only appear when the row's machine is both this one and reachable —
/// otherwise every action degrades to navigation.
struct ActivityActionButtons: View {
    let row: ActivityRowPresentation
    let open: () -> Void
    let markSeen: () -> Void

    private var canActInline: Bool { row.inlineActionsAllowed && row.machineOnline }

    private var visibleActions: [AccountAttentionAction] {
        row.actions.filter { action in
            switch action.kind {
            case .approve, .deny, .answer, .restart, .rerunChecks:
                return canActInline
            case .open:
                return row.deepLink != nil
            case .markSeen, .dismiss, .unrecognized:
                return false
            }
        }
    }

    var body: some View {
        if visibleActions.isEmpty {
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
        ForEach(visibleActions, id: \.id) { action in
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

        // Answering happens in the session, not in a drawer row.
        case .answer, .open, .markSeen, .dismiss, .unrecognized:
            Button(action: open) {
                ActivityActionLabel(action.label, systemImage: "arrow.right", variant: .secondary)
            }
            .buttonStyle(.plain)
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
