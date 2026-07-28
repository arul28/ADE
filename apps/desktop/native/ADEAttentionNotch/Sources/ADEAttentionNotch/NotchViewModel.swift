import AppKit
import Combine
import Foundation
import ADEAttentionNotchCore

@MainActor
final class NotchViewModel: ObservableObject {
    private enum DeferredTransient {
        case attention(itemId: String)
        case celebration(itemId: String)
    }

    @Published private(set) var items: [AttentionItem] = []
    @Published private(set) var interaction = NotchInteractionState()
    @Published private(set) var pointerInside = false
    @Published private(set) var settings = NotchSettings()

    var emit: (NotchOutput) -> Void = { _ in }
    var requestReanchor: () -> Void = {}
    var requestQuit: () -> Void = {}

    private var peekTask: Task<Void, Never>?
    private var closeTask: Task<Void, Never>?
    private var transientTask: Task<Void, Never>?
    private var fingerprintsById: [String: String] = [:]
    private var hostVisibilityRequested = true
    private var hoveredItemId: String?
    private var deferredTransient: DeferredTransient?

    var selectedItem: AttentionItem? {
        guard items.indices.contains(interaction.selectedIndex) else { return nil }
        return items[interaction.selectedIndex]
    }

    var hasPhysicalItems: Bool { !items.isEmpty }

    var shouldPresentSurface: Bool {
        settings.enabled && interaction.isVisible && !items.isEmpty
    }

    var visiblePreview: String {
        selectedItem?.presentation(hideDetails: settings.hideDetails).preview ?? "ADE is ready"
    }

    var navigationActions: [AttentionAction] {
        selectedItem?.actions.filter(\.opensDestination) ?? []
    }

    func handle(_ input: NotchInput) {
        switch input {
        case .snapshot(let snapshot):
            apply(snapshot)
        case .settings(let settings):
            self.settings = settings
            setVisible(settings.enabled && hostVisibilityRequested)
            requestReanchor()
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
        let focusedItemId = pointerInside ? hoveredItemId : selectedItem?.id
        var deduplicated: [String: AttentionItem] = [:]
        for item in snapshot.items where item.contractVersion == 1 {
            if let current = deduplicated[item.id], current.revision > item.revision {
                continue
            }
            deduplicated[item.id] = item
        }
        let sorted = sortedAttentionItems(Array(deduplicated.values))
        let changed = sorted.filter { fingerprintsById[$0.id] != $0.fingerprint }
        let initialSnapshot = fingerprintsById.isEmpty
        fingerprintsById = Dictionary(uniqueKeysWithValues: sorted.map { ($0.id, $0.fingerprint) })
        items = sorted

        var next = interaction
        if let focusedItemId,
           let focusedIndex = sorted.firstIndex(where: { $0.id == focusedItemId }) {
            next.select(index: focusedIndex, itemCount: sorted.count)
        } else {
            next.clampSelection(itemCount: sorted.count)
        }
        interaction = next

        guard !sorted.isEmpty else {
            transientTask?.cancel()
            deferredTransient = nil
            hoveredItemId = nil
            var empty = interaction
            empty.dismissExplicitInteraction()
            interaction = empty
            return
        }

        if settings.celebrationsEnabled,
           let merged = changed.first(where: \.isCelebration),
           (!initialSnapshot || isRecent(merged.occurredAt, within: 120)) {
            if pointerInside {
                deferredTransient = .celebration(itemId: merged.id)
                return
            }
            selectItem(id: merged.id)
            beginCelebration()
            return
        }

        if let attention = changed.first(where: \.isAttention) {
            if pointerInside {
                deferredTransient = .attention(itemId: attention.id)
                return
            }
            selectItem(id: attention.id)
            beginAttention()
        }
    }

    func pointerChanged(isInside: Bool) {
        peekTask?.cancel()
        closeTask?.cancel()

        if isInside {
            guard !pointerInside else { return }
            pointerInside = true
            hoveredItemId = selectedItem?.id
            var next = interaction
            let token = next.pointerEntered(hasItems: !items.isEmpty)
            interaction = next
            peekTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(145))
                guard !Task.isCancelled, let self else { return }
                var delayed = self.interaction
                delayed.applyPeek(generation: token, pointerInside: self.pointerInside)
                self.interaction = delayed
            }
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
        peekTask?.cancel()
        transientTask?.cancel()
        var next = interaction
        next.explicitToggle(hasItems: !items.isEmpty)
        interaction = next
    }

    func dismissExpanded() {
        guard interaction.isExplicitlyInteractive else { return }
        var next = interaction
        next.dismissExplicitInteraction()
        interaction = next
    }

    func navigate(delta: Int) {
        var next = interaction
        next.navigate(delta: delta, itemCount: items.count)
        interaction = next
        if pointerInside {
            hoveredItemId = selectedItem?.id
        }
    }

    func openSelected() {
        guard let item = selectedItem else { return }
        emit(NotchOutput(
            type: "open",
            itemId: item.id,
            destination: item.destination,
            deepLink: item.destination.deepLink
        ))
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

    private func setVisible(_ visible: Bool) {
        peekTask?.cancel()
        closeTask?.cancel()
        transientTask?.cancel()
        pointerInside = false
        hoveredItemId = nil
        deferredTransient = nil
        var next = interaction
        next.setVisible(visible)
        interaction = next
    }

    private func beginAttention() {
        transientTask?.cancel()
        var next = interaction
        next.setAttention()
        interaction = next
        if settings.soundsEnabled {
            NSSound(named: "Glass")?.play()
        }
        transientTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled, let self else { return }
            var finished = self.interaction
            finished.finishTransient(pointerInside: self.pointerInside)
            self.interaction = finished
        }
    }

    private func beginCelebration() {
        transientTask?.cancel()
        var next = interaction
        next.setCelebration()
        interaction = next
        if settings.soundsEnabled {
            NSSound(named: "Hero")?.play()
        }
        transientTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1_650))
            guard !Task.isCancelled, let self else { return }
            var finished = self.interaction
            finished.finishTransient(pointerInside: self.pointerInside)
            self.interaction = finished
        }
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
        switch deferredTransient {
        case .attention(let itemId):
            guard items.contains(where: { $0.id == itemId }) else { return }
            selectItem(id: itemId)
            beginAttention()
        case .celebration(let itemId):
            guard items.contains(where: { $0.id == itemId }) else { return }
            selectItem(id: itemId)
            beginCelebration()
        }
    }

    private func isRecent(_ value: String, within seconds: TimeInterval) -> Bool {
        guard let date = parseAttentionDate(value) else { return false }
        return abs(date.timeIntervalSinceNow) <= seconds
    }
}
