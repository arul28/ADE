import AppKit
import Combine
import Foundation
import ADEAttentionNotchCore

/// Transients are host-driven since the Activity revamp.
///
/// The helper used to synthesise its own alerts by diffing item fingerprints,
/// which fired on every cosmetic republish. The renderer now owns that decision
/// (`useActivitySync`'s toast emitter) because only it can see the account's
/// delivery policy, the per-item 10-minute cooldown, and the global rate limit.
/// The machinery below is unchanged; the trigger moved.
@MainActor
final class NotchViewModel: ObservableObject {

    @Published private(set) var items: [AttentionItem] = []
    @Published private(set) var interaction = NotchInteractionState()
    @Published private(set) var pointerInside = false
    @Published private(set) var settings = NotchSettings()
    @Published private(set) var availability: AttentionAvailability?
    @Published private(set) var counts = AttentionCounts()
    /// The event currently being shown as a takeover, if any. Cleared when the
    /// takeover settles so a later hover cannot resurrect stale news.
    @Published private(set) var activeToast: AttentionToast?
    /// The out half of the takeover: the card is morphing back into its glyph
    /// in the strip. A separate flag rather than a state so the card and the
    /// strip can be on screen together for the length of the morph.
    @Published private(set) var isTakeoverCollapsing = false
    /// The brief "all clear" beat the strip plays when the last needs-you item
    /// clears. Earned, not ambient: it only ever follows an amber count.
    @Published private(set) var isAllClear = false
    /// Keeps the strip on screen in hover mode for a moment after a takeover
    /// collapses, so the morph has something to land in.
    @Published private(set) var isHoldingReveal = false

    @Published private(set) var selectedTab: NotchPanelTab = .agents
    /// Done is the most final and most common state, so the panel opens with it
    /// folded away. Named through the group table rather than as a literal, so
    /// a renamed section id cannot silently stop collapsing it.
    @Published private(set) var collapsedSectionIds: Set<String> = [
        NotchStripGroupKind.done.sectionId,
    ]
    @Published private(set) var expandedClusterIds: Set<String> = []
    /// The row keyboard navigation is on, which is also what Return opens.
    @Published private(set) var focusedRowId: String?

    var emit: (NotchOutput) -> Void = { _ in }
    var requestReanchor: () -> Void = {}
    var requestQuit: () -> Void = {}

    private var closeTask: Task<Void, Never>?
    private var transientTask: Task<Void, Never>?
    private var allClearTask: Task<Void, Never>?
    private var revealHoldTask: Task<Void, Never>?
    private var hostVisibilityRequested = true
    private var hoveredItemId: String?
    private var deferredTransient: AttentionToast?
    private var snapshotCursor = AttentionSnapshotCursor()
    private var lastNeedsYouCount = 0

    /// System-level reduced motion, read here rather than in the view because
    /// the morph is a *timing* decision the model owns: with motion reduced the
    /// card is dropped instead of animated away. Injectable so the takeover
    /// lifecycle can be tested without depending on the tester's own settings.
    var prefersReducedMotion: () -> Bool = {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    var selectedItem: AttentionItem? {
        guard items.indices.contains(interaction.selectedIndex) else { return nil }
        return items[interaction.selectedIndex]
    }

    // MARK: - Compact strip

    /// Every nonzero state group, glyph and count, in urgency order.
    ///
    /// Stored rather than computed: the strip runs a `TimelineView` for the
    /// amber pulse, so its body is evaluated ~20 times a second for as long as
    /// the Mac is on, and it decides the surface's width. Projecting once per
    /// snapshot keeps that redraw free of a sort.
    @Published private(set) var stripGroups: [NotchStripGroup] = []

    /// The one thing worth a wing: a real headline when something happened, a
    /// quiet summary when nothing did. Present in both reveal modes.
    @Published private(set) var topSignal = NotchTopSignal(
        text: "All clear",
        tone: .neutral,
        symbolName: "checkmark.circle",
        isNotable: false
    )

    /// Recomputed wherever the inputs to the strip change: the rows, the
    /// account's counts, the stream's health, and the privacy setting.
    private func refreshStripProjection() {
        stripGroups = notchStripGroups(items: items, counts: counts)
        topSignal = notchTopSignal(
            items: items,
            counts: counts,
            status: statusPresentation,
            hideDetails: settings.hideDetails
        )
    }

    /// What the strip's width is derived from. The all-clear beat borrows the
    /// left wing, so it has to be measured too or the surface snaps narrower
    /// mid-animation.
    var stripMetrics: NotchStripMetrics {
        let measured = notchStripMetrics(groups: stripGroups, signal: topSignal)
        guard isAllClear else { return measured }
        return NotchStripMetrics(
            leadingWidth: max(measured.leadingWidth, 74),
            trailingWidth: measured.trailingWidth
        )
    }

    /// Rows the account has that this frame did not carry.
    var overflowCount: Int { counts.overflow(shownItemCount: items.count) }

    /// How far the user lets the surface grow, and what a click does.
    var policy: NotchPresentationPolicy { NotchPresentationPolicy(settings: settings) }

    var isDormantHoverSurface: Bool {
        guard !isHoldingReveal else { return false }
        return notchSurfaceIsDormant(
            presentation: interaction.presentation,
            revealMode: settings.revealMode,
            pointerInside: pointerInside
        )
    }

    /// Non-nil whenever the surface has something to say instead of an item:
    /// an empty-but-healthy stream, or an unhealthy one.
    var statusPresentation: NotchStatusPresentation? {
        notchStatusPresentation(availability: availability, itemCount: items.count)
    }

    /// The surface stays up for the whole time the user has it enabled. An
    /// empty or broken stream is reported, not hidden — disappearing would read
    /// as "nothing needs you" even when the truth is "ADE lost the stream".
    var shouldPresentSurface: Bool {
        settings.enabled && interaction.isVisible
    }

    /// A click opens the surface whenever it is showing anything at all,
    /// including the empty and error states.
    var hasPresentableContent: Bool {
        !items.isEmpty || statusPresentation != nil
    }

    var visiblePreview: String {
        takeoverItem?.presentation(hideDetails: settings.hideDetails).preview
            ?? statusPresentation?.message
            ?? "ADE is ready"
    }

    var navigationActions: [AttentionAction] {
        notchSecondaryActions(takeoverItem?.actions ?? selectedItem?.actions ?? [])
    }

    /// The row a takeover card is about — which is not always the selected row,
    /// because the panel's selection follows the pointer.
    var takeoverItem: AttentionItem? {
        if let itemId = activeToast?.itemId,
           let match = items.first(where: { $0.id == itemId }) {
            return match
        }
        return selectedItem
    }

    /// What the takeover card shows. A live toast wins; otherwise this is the
    /// card the selected row would produce, so the layout is never empty.
    var toastPresentation: AttentionToast? {
        if let activeToast {
            guard !settings.hideDetails else {
                return AttentionToast(
                    itemId: activeToast.itemId,
                    eventKind: activeToast.eventKind,
                    treatment: activeToast.treatment,
                    title: activeToast.itemId.flatMap { id in
                        items.first(where: { $0.id == id })?
                            .presentation(hideDetails: true).title
                    } ?? "ADE update",
                    subtitle: activeToast.itemId.flatMap { id in
                        items.first(where: { $0.id == id })?.privacyPreview
                    },
                    tone: activeToast.tone,
                    durationMs: activeToast.durationMs
                )
            }
            return activeToast
        }
        guard let item = selectedItem else {
            guard let status = statusPresentation else { return nil }
            return AttentionToast(
                eventKind: "status",
                treatment: status.isProblem ? .alert : .info,
                title: status.title,
                subtitle: status.message,
                tone: status.tone.rawValue
            )
        }
        let presentation = item.presentation(hideDetails: settings.hideDetails)
        return AttentionToast(
            itemId: item.id,
            eventKind: item.eventKind,
            treatment: item.isAttention ? .alert : .info,
            title: presentation.title,
            subtitle: presentation.preview,
            tone: notchStatusTone(for: item.phase).rawValue
        )
    }

    // MARK: - Expanded panel

    /// Everything the panel draws, flattened in draw order.
    ///
    /// One array rather than nested views because it is also the keyboard's
    /// model: focus moves by index through exactly what is on screen, so a
    /// collapsed section is skipped without any second traversal to keep in
    /// step with the first.
    var panelRows: [NotchPanelRow] {
        switch selectedTab {
        case .agents:
            // The same five-way table the strip counts with, so a row the strip
            // counts as failed is a row the panel files under Failed.
            var rows: [NotchPanelRow] = []
            for section in notchActivityGroupSections(notchItems(items, in: .agents)) {
                appendSection(
                    &rows,
                    id: section.id,
                    title: section.title,
                    tone: section.tone,
                    items: section.items
                )
            }
            return rows
        case .events:
            return notchEventClusters(items, hideDetails: settings.hideDetails)
                .flatMap { cluster -> [NotchPanelRow] in
                    // A single-update cluster has nothing to expand into: its
                    // one row would repeat the header it hangs under.
                    let expanded = cluster.count > 1 && expandedClusterIds.contains(cluster.id)
                    let header = NotchPanelRow.cluster(cluster, expanded: expanded)
                    guard expanded else { return [header] }
                    return [header] + cluster.items.map { .clusterItem($0, clusterId: cluster.id) }
                }
        }
    }

    private func appendSection(
        _ rows: inout [NotchPanelRow],
        id: String,
        title: String,
        tone: NotchStatusTone,
        items sectionItems: [AttentionItem]
    ) {
        guard !sectionItems.isEmpty else { return }
        let collapsed = collapsedSectionIds.contains(id)
        rows.append(.section(id: id, title: title, tone: tone, count: sectionItems.count, collapsed: collapsed))
        guard !collapsed else { return }
        rows.append(contentsOf: sectionItems.map { NotchPanelRow.item($0) })
    }

    var agentCount: Int { notchItems(items, in: .agents).count }
    var eventCount: Int { notchEventClusters(items).count }

    func selectTab(_ tab: NotchPanelTab) {
        guard selectedTab != tab else { return }
        selectedTab = tab
        focusedRowId = panelRows.first?.id
    }

    func toggleSection(_ id: String) {
        if collapsedSectionIds.contains(id) {
            collapsedSectionIds.remove(id)
        } else {
            collapsedSectionIds.insert(id)
        }
    }

    func toggleCluster(_ id: String) {
        if expandedClusterIds.contains(id) {
            expandedClusterIds.remove(id)
        } else {
            expandedClusterIds.insert(id)
        }
    }

    // MARK: - Input

    func handle(_ input: NotchInput) {
        switch input {
        case .snapshot(let snapshot):
            apply(snapshot)
        case .settings(let settings):
            self.settings = settings
            refreshStripProjection()
            setVisible(settings.enabled && hostVisibilityRequested)
            applyPresentationPolicy()
            requestReanchor()
        case .toast(let toast):
            present(toast)
        case .visibility(let visible):
            hostVisibilityRequested = visible
            setVisible(settings.enabled && visible)
        case .reanchor:
            requestReanchor()
        case .quit:
            requestQuit()
        case .ignored:
            break
        }
    }

    func apply(_ snapshot: AttentionSnapshot) {
        let acceptance = snapshotCursor.accept(snapshot)
        guard acceptance != .rejectedStale else { return }
        if case .accepted(resetPresentationState: true) = acceptance {
            // An account switch: news from the previous account may not be
            // waiting to interrupt the new one.
            deferredTransient = nil
            activeToast = nil
            transientTask?.cancel()
            lastNeedsYouCount = 0
        }
        availability = snapshot.availability
        counts = snapshot.resolvedCounts()
        let focusedItemId = pointerInside ? hoveredItemId : selectedItem?.id
        var deduplicated: [String: AttentionItem] = [:]
        for item in snapshot.items where item.contractVersion == 1 {
            if let current = deduplicated[item.id], current.revision > item.revision {
                continue
            }
            deduplicated[item.id] = item
        }
        let sorted = sortedAttentionItems(Array(deduplicated.values))
        items = sorted

        var next = interaction
        if let focusedItemId,
           let focusedIndex = sorted.firstIndex(where: { $0.id == focusedItemId }) {
            next.select(index: focusedIndex, itemCount: sorted.count)
        } else {
            next.clampSelection(itemCount: sorted.count)
        }
        interaction = next

        refreshStripProjection()
        dismissTakeoverIfAcknowledgedElsewhere()
        noteNeedsYouTransition(to: counts.needsYou)
        pruneExpandedClusters()

        guard sorted.isEmpty else { return }
        transientTask?.cancel()
        deferredTransient = nil
        activeToast = nil
        hoveredItemId = nil
        // Draining to zero is not a reason to yank the surface out from under
        // the pointer or out of a panel the user opened: those states render
        // the empty/error copy instead.
        if interaction.presentation == .flash || interaction.presentation == .celebration {
            settleTakeover()
        }
    }

    /// The one takeover rule the notch cannot enforce on its own: an item acked
    /// on the phone, in the web client, or in ADE itself has already been dealt
    /// with, so its card goes away here too.
    private func dismissTakeoverIfAcknowledgedElsewhere() {
        guard let itemId = activeToast?.itemId else { return }
        let match = items.first(where: { $0.id == itemId })
        guard match == nil || match?.isAcknowledged == true else { return }
        finishTakeover(morphing: false)
    }

    /// Fires the all-clear beat exactly on the falling edge: the last amber row
    /// clearing is the moment worth marking, and only that moment.
    private func noteNeedsYouTransition(to needsYou: Int) {
        defer { lastNeedsYouCount = needsYou }
        guard lastNeedsYouCount > 0, needsYou == 0, interaction.isVisible else { return }
        allClearTask?.cancel()
        isAllClear = true
        holdRevealBriefly(for: .milliseconds(2_600))
        allClearTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(2_400))
            guard !Task.isCancelled, let self else { return }
            self.isAllClear = false
        }
    }

    /// Clusters the feed no longer carries must not keep a stale expansion,
    /// which would silently re-expand a different PR that reuses the key.
    private func pruneExpandedClusters() {
        guard !expandedClusterIds.isEmpty else { return }
        let live = Set(notchEventClusters(items).map(\.id))
        expandedClusterIds.formIntersection(live)
    }

    /// Shows one event. Celebrations honour the account's celebrations setting;
    /// everything else rides the flash card. A takeover that arrives while the
    /// pointer is on the surface waits rather than yanking the content out from
    /// under it.
    func present(_ toast: AttentionToast) {
        if toast.treatment == .celebration, !settings.celebrationsEnabled { return }
        if pointerInside || interaction.isExplicitlyInteractive {
            deferredTransient = toast
            return
        }
        if let itemId = toast.itemId { selectItem(id: itemId) }
        begin(toast)
    }

    func pointerChanged(isInside: Bool) {
        closeTask?.cancel()

        if isInside {
            guard !pointerInside else { return }
            pointerInside = true
            hoveredItemId = selectedItem?.id
            var next = interaction
            next.pointerEntered()
            interaction = next
        } else {
            guard pointerInside else { return }
            closeTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled, let self else { return }
                self.pointerInside = false
                self.hoveredItemId = nil
                var next = self.interaction
                next.pointerExited()
                self.interaction = next
                self.presentDeferredTransientIfNeeded()
            }
        }
    }

    /// A click, and only a click, opens the panel — in both reveal modes.
    /// Returns whether the panel took the click, so the caller can decide
    /// whether the panel needs key focus.
    @discardableResult
    func toggleExpanded() -> Bool {
        // Clicking through a takeover opens the panel *at* what it was about,
        // which is the whole point of the two tabs.
        if interaction.presentation == .flash || interaction.presentation == .celebration {
            let revealed = takeoverItem
            finishTakeover(morphing: false)
            return openPanel(revealing: revealed)
        }
        var next = interaction
        let opened = next.explicitToggle(hasItems: hasPresentableContent, policy: policy)
        interaction = next
        if opened {
            focusedRowId = panelRows.first?.id
        } else if !policy.clickOpensPanel, hasPresentableContent {
            // The user turned the tall panel off. A click still has to do
            // something, so it opens Activity in ADE instead.
            openActivity()
        }
        return opened
    }

    /// Opens the panel already showing a particular row: the Events tab for a
    /// PR or CI outcome, with that item's cluster expanded and focused.
    @discardableResult
    func openPanel(revealing item: AttentionItem?) -> Bool {
        var next = interaction
        guard next.explicitToggle(hasItems: hasPresentableContent, policy: policy) else {
            interaction = next
            if !policy.clickOpensPanel, hasPresentableContent { openActivity() }
            return false
        }
        interaction = next
        guard let item else {
            focusedRowId = panelRows.first?.id
            return true
        }
        selectedTab = notchPanelTab(for: item)
        if selectedTab == .events,
           let cluster = notchEventClusters(items).first(where: { $0.items.contains(where: { $0.id == item.id }) }) {
            if cluster.count > 1 { expandedClusterIds.insert(cluster.id) }
            focusedRowId = "cluster:\(cluster.id)"
        } else {
            // A section the row lives in must be open for the row to be focused.
            collapsedSectionIds.remove(notchStripGroupKind(for: item).sectionId)
            focusedRowId = item.id
        }
        selectItem(id: item.id)
        return true
    }

    func dismissExpanded() {
        guard interaction.isExplicitlyInteractive else { return }
        var next = interaction
        next.dismissExplicitInteraction()
        interaction = next
        focusedRowId = nil
        presentDeferredTransientIfNeeded()
    }

    // MARK: - Keyboard

    func moveFocus(by delta: Int) {
        let rows = panelRows
        guard !rows.isEmpty else { return }
        guard let current = focusedRowId,
              let index = rows.firstIndex(where: { $0.id == current }) else {
            focusedRowId = rows.first?.id
            return
        }
        let next = min(max(0, index + delta), rows.count - 1)
        focusedRowId = rows[next].id
        if case .item(let item) = rows[next] { selectItem(id: item.id) }
        if case .clusterItem(let item, _) = rows[next] { selectItem(id: item.id) }
    }

    /// Return on a heading collapses or expands it; on a row it opens the row.
    func activateFocusedRow() {
        guard let focusedRowId, let row = panelRows.first(where: { $0.id == focusedRowId }) else {
            openSelected()
            return
        }
        switch row {
        case .section(let id, _, _, _, _):
            toggleSection(id)
        case .cluster(let cluster, _):
            if cluster.count > 1 {
                toggleCluster(cluster.id)
            } else if let lead = cluster.lead {
                open(lead)
            }
        case .item(let item), .clusterItem(let item, _):
            open(item)
        }
    }

    /// Left and right collapse and expand whatever the focus is on, matching
    /// how a disclosure list behaves everywhere else on the system.
    func setFocusedRowExpanded(_ expanded: Bool) {
        guard let focusedRowId, let row = panelRows.first(where: { $0.id == focusedRowId }) else { return }
        switch row {
        case .section(let id, _, _, _, let collapsed):
            if collapsed == expanded { toggleSection(id) }
        case .cluster(let cluster, let isExpanded):
            if cluster.count > 1, isExpanded != expanded { toggleCluster(cluster.id) }
        case .item, .clusterItem:
            break
        }
    }

    func cycleTab() {
        selectTab(selectedTab == .agents ? .events : .agents)
    }

    // MARK: - Focus and navigation

    /// Focus a row the pointer is over, so "Open in ADE" and the tooltip agree
    /// with what the user is looking at.
    func focus(_ item: AttentionItem) {
        selectItem(id: item.id)
        if pointerInside { hoveredItemId = item.id }
    }

    func openSelected() {
        guard let item = takeoverItem ?? selectedItem else { return }
        open(item)
    }

    func open(_ item: AttentionItem) {
        emit(NotchOutput(
            type: "open",
            itemId: item.id,
            destination: item.destination,
            deepLink: item.destination.deepLink
        ))
    }

    /// Asks the host to file the row away. The helper never mutates the feed
    /// itself — the next snapshot is what removes the row.
    func dismiss(_ item: AttentionItem) {
        emit(NotchOutput(
            type: "dismiss_item",
            itemId: item.id,
            destination: item.destination
        ))
    }

    func openSettings() {
        emit(NotchOutput(type: "open_settings"))
    }

    func openFor(_ action: AttentionAction) {
        guard let item = takeoverItem ?? selectedItem else { return }
        emit(NotchOutput(
            type: "action",
            itemId: item.id,
            action: action,
            destination: item.destination,
            deepLink: item.destination.deepLink
        ))
    }

    /// The wire name stays `open_center`: the host routes on it and the surface
    /// only renamed what it calls the destination.
    func openActivity() {
        emit(NotchOutput(type: "open_center"))
    }

    func requestRefresh() {
        emit(NotchOutput(type: "refresh"))
    }

    func applySettingsMenuAction(_ action: NotchSettingsMenuAction) {
        let next = applyingNotchSettingsMenuAction(action, to: settings)
        settings = next
        refreshStripProjection()
        setVisible(next.enabled && hostVisibilityRequested)
        applyPresentationPolicy()
        requestReanchor()
        emit(NotchOutput(type: "settings", settings: next))
    }

    // MARK: - Takeovers

    /// Explicit close on the card. Morphs like a timeout would: the user is
    /// telling it to go away, not telling it to disappear.
    func dismissTakeover() {
        guard interaction.presentation == .flash || interaction.presentation == .celebration else { return }
        finishTakeover(morphing: true)
    }

    private func setVisible(_ visible: Bool) {
        closeTask?.cancel()
        transientTask?.cancel()
        revealHoldTask?.cancel()
        allClearTask?.cancel()
        pointerInside = false
        hoveredItemId = nil
        deferredTransient = nil
        activeToast = nil
        isTakeoverCollapsing = false
        isHoldingReveal = false
        isAllClear = false
        var next = interaction
        next.setVisible(visible)
        interaction = next
    }

    private func begin(_ toast: AttentionToast) {
        transientTask?.cancel()
        isTakeoverCollapsing = false
        if settings.soundsEnabled {
            NSSound(named: toast.treatment == .celebration ? "Hero" : "Glass")?.play()
        }
        activeToast = toast
        var next = interaction
        if toast.treatment == .celebration {
            next.setCelebration()
        } else {
            next.setFlash()
        }
        interaction = next
        let durationMs = toast.resolvedDurationMs
        transientTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(durationMs))
            guard !Task.isCancelled, let self else { return }
            self.finishTakeover(morphing: true)
        }
    }

    /// Ends a takeover. `morphing` runs the collapse into the strip's glyph —
    /// skipped for a remote acknowledgement (there is nothing to morph *from*
    /// once someone else has handled it) and whenever motion is reduced.
    private func finishTakeover(morphing: Bool) {
        transientTask?.cancel()
        guard morphing, !prefersReducedMotion() else {
            settleTakeover()
            return
        }
        isTakeoverCollapsing = true
        // Long enough to read as a morph, short enough that nobody waits on it.
        transientTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(280))
            guard !Task.isCancelled, let self else { return }
            self.settleTakeover()
        }
    }

    private func settleTakeover() {
        isTakeoverCollapsing = false
        activeToast = nil
        // The user may have clicked through into the panel while the card was
        // still up; its timer must not then close what they opened.
        guard !interaction.isExplicitlyInteractive else { return }
        var settled = interaction
        settled.finishTransient(pointerInside: pointerInside)
        interaction = settled
        // In hover mode the strip is dormant, so the glyph the card just
        // morphed into would vanish in the same frame. Hold it a beat.
        if settings.revealMode == .hover, !pointerInside {
            holdRevealBriefly(for: .milliseconds(1_400))
        }
        presentDeferredTransientIfNeeded()
    }

    private func holdRevealBriefly(for duration: Duration) {
        revealHoldTask?.cancel()
        isHoldingReveal = true
        revealHoldTask = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard !Task.isCancelled, let self else { return }
            self.isHoldingReveal = false
        }
    }

    /// Applies the current settings to whatever is already on screen.
    private func applyPresentationPolicy() {
        var next = interaction
        next.applyPolicy(policy)
        interaction = next
    }

    private func selectItem(id: String) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        var next = interaction
        next.select(index: index, itemCount: items.count)
        interaction = next
    }

    private func presentDeferredTransientIfNeeded() {
        guard let deferredTransient else { return }
        self.deferredTransient = nil
        // The row it was about may have drained, or been handled elsewhere,
        // while the pointer sat there.
        if let itemId = deferredTransient.itemId,
           !items.contains(where: { $0.id == itemId && !$0.isAcknowledged }) {
            return
        }
        present(deferredTransient)
    }
}

/// The panel's draw order, flattened. Sections and clusters are rows in their
/// own right so collapsing, keyboard focus, and VoiceOver all traverse exactly
/// one list.
enum NotchPanelRow: Identifiable, Equatable {
    case section(id: String, title: String, tone: NotchStatusTone, count: Int, collapsed: Bool)
    case item(AttentionItem)
    case cluster(NotchEventCluster, expanded: Bool)
    case clusterItem(AttentionItem, clusterId: String)

    var id: String {
        switch self {
        case .section(let id, _, _, _, _): return "section:\(id)"
        case .item(let item): return item.id
        case .cluster(let cluster, _): return "cluster:\(cluster.id)"
        case .clusterItem(let item, let clusterId): return "\(clusterId)/\(item.id)"
        }
    }
}
