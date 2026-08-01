import AppKit
import Combine
import Foundation
import ADEAttentionNotchCore

/// Transients are host-driven since the Activity revamp.
///
/// The helper used to synthesise its own alerts by diffing item fingerprints,
/// which fired on every cosmetic republish. The renderer now owns that decision
/// (`useAttentionSync`'s toast emitter) because only it can see the account's
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
    /// The event currently being shown as a transient, if any. Cleared when the
    /// transient settles so a later hover cannot resurrect stale news.
    @Published private(set) var activeToast: AttentionToast?

    var emit: (NotchOutput) -> Void = { _ in }
    var requestReanchor: () -> Void = {}
    var requestQuit: () -> Void = {}

    private var closeTask: Task<Void, Never>?
    private var transientTask: Task<Void, Never>?
    private var hostVisibilityRequested = true
    private var hoveredItemId: String?
    private var deferredTransient: AttentionToast?
    private var snapshotCursor = AttentionSnapshotCursor()

    var selectedItem: AttentionItem? {
        guard items.indices.contains(interaction.selectedIndex) else { return nil }
        return items[interaction.selectedIndex]
    }

    /// The panel's three sections, filed exactly as the desktop popover files
    /// them. Recomputed from `items` rather than cached: the list is capped at
    /// the host's 48-row projection, so this is a trivial pass.
    var sections: NotchActivitySections { notchActivitySections(items) }

    /// Rows the hover strip's avatars are drawn from: the highest-priority
    /// work, which is what someone glancing at the notch is looking for.
    var leadingItems: [AttentionItem] { Array(sections.live.prefix(3)) }

    /// What the pinned ticker cycles. Empty means the strip stays still.
    var tickerItems: [AttentionItem] {
        guard settings.tickerEnabled, settings.revealMode == .minimal else { return [] }
        return Array(sections.live.prefix(8))
    }

    /// Rows the account has that this frame did not carry.
    var overflowCount: Int { counts.overflow(shownItemCount: items.count) }

    /// How far the user lets the surface grow, and what opens it.
    var policy: NotchPresentationPolicy { NotchPresentationPolicy(settings: settings) }

    var isDormantHoverSurface: Bool {
        notchSurfaceIsDormant(
            presentation: interaction.presentation,
            revealMode: settings.revealMode
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

    /// Hover and click open the surface whenever it is showing anything at all,
    /// including the empty and error states.
    var hasPresentableContent: Bool {
        !items.isEmpty || statusPresentation != nil
    }

    var visiblePreview: String {
        selectedItem?.presentation(hideDetails: settings.hideDetails).preview
            ?? statusPresentation?.message
            ?? "ADE is ready"
    }

    var navigationActions: [AttentionAction] {
        notchSecondaryActions(selectedItem?.actions ?? [])
    }

    /// What the transient card shows. A live toast wins; otherwise this is the
    /// short card a click opens in compact mode, so the layout is never empty.
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

    func handle(_ input: NotchInput) {
        switch input {
        case .snapshot(let snapshot):
            apply(snapshot)
        case .settings(let settings):
            self.settings = settings
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

        guard sorted.isEmpty else { return }
        transientTask?.cancel()
        deferredTransient = nil
        activeToast = nil
        hoveredItemId = nil
        // Draining to zero is not a reason to yank the surface out from under
        // the pointer or out of a panel the user opened: those states render
        // the empty/error copy instead.
        if interaction.presentation == .attention || interaction.presentation == .celebration {
            var settled = interaction
            settled.finishTransient(pointerInside: pointerInside, policy: policy)
            interaction = settled
        }
    }

    /// Shows one event. Celebrations honour the account's celebrations setting;
    /// everything else rides the alert layout. A toast that arrives while the
    /// pointer is on the surface waits rather than yanking the content out from
    /// under it.
    func present(_ toast: AttentionToast) {
        if toast.treatment == .celebration, !settings.celebrationsEnabled { return }
        if pointerInside {
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
            next.pointerEntered(hasItems: hasPresentableContent, policy: policy)
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

    func toggleExpanded() {
        transientTask?.cancel()
        activeToast = nil
        var next = interaction
        next.explicitToggle(hasItems: hasPresentableContent, policy: policy)
        interaction = next
    }

    func dismissExpanded() {
        guard interaction.isExplicitlyInteractive else { return }
        var next = interaction
        next.dismissExplicitInteraction()
        interaction = next
    }

    /// Focus a row the pointer is over, so "Open in ADE" and the tooltip agree
    /// with what the user is looking at. The pager it replaced is gone: the
    /// panel is a scrolling list now, not one card at a time.
    func focus(_ item: AttentionItem) {
        selectItem(id: item.id)
        if pointerInside { hoveredItemId = item.id }
    }

    func openSelected() {
        guard let item = selectedItem else { return }
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
        guard let item = selectedItem else { return }
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
        setVisible(next.enabled && hostVisibilityRequested)
        applyPresentationPolicy()
        requestReanchor()
        emit(NotchOutput(type: "settings", settings: next))
    }

    private func setVisible(_ visible: Bool) {
        closeTask?.cancel()
        transientTask?.cancel()
        pointerInside = false
        hoveredItemId = nil
        deferredTransient = nil
        activeToast = nil
        var next = interaction
        next.setVisible(visible)
        interaction = next
    }

    private func begin(_ toast: AttentionToast) {
        transientTask?.cancel()
        // The cue still fires in compact/manual modes: the user asked the
        // surface to stay small, not to stop telling them something needs them.
        if settings.soundsEnabled {
            NSSound(named: toast.treatment == .celebration ? "Hero" : "Glass")?.play()
        }
        activeToast = toast
        guard policy.allowsAutomaticReveal else { return }
        var next = interaction
        if toast.treatment == .celebration {
            next.setCelebration(policy: policy)
        } else {
            next.setAttention(policy: policy)
        }
        interaction = next
        let durationMs = toast.resolvedDurationMs
        transientTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(durationMs))
            guard !Task.isCancelled, let self else { return }
            var finished = self.interaction
            finished.finishTransient(pointerInside: self.pointerInside, policy: self.policy)
            self.interaction = finished
            self.activeToast = nil
        }
    }

    /// Applies the current settings to whatever is already on screen.
    private func applyPresentationPolicy() {
        // Turning automatic reveal off mid-toast has to collapse what is on
        // screen; otherwise the setting looks broken until the next event.
        if !policy.allowsAutomaticReveal {
            transientTask?.cancel()
            deferredTransient = nil
            activeToast = nil
        }
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
        // The row it was about may have drained while the pointer sat there.
        if let itemId = deferredTransient.itemId,
           !items.contains(where: { $0.id == itemId }) {
            return
        }
        present(deferredTransient)
    }
}
