/// Following lane displays the window server moves.
///
/// Adding or removing any display — this helper's, another ADE helper's, a
/// monitor — makes macOS re-arrange the others. A lane's display can be
/// pushed from x = -2560 to -5120 while its windows stay at their global
/// coordinates, which now belong to another lane's screen. Each move is
/// followed here: the lane's windows move by the same offset, its placement
/// is updated, and a `display-moved` event tells the service.

import CoreGraphics
import Foundation
import ADEDesktopDriverCore

/// The `CGDisplayRegisterReconfigurationCallback` registration, coalesced: one
/// rearrangement fires the callback once per display, and the work runs once,
/// on the main queue, a beat after the change completes.
final class DisplayReconfigurationWatcher {
    private let onChange: () -> Void
    private var started = false
    private var scheduled = false

    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
    }

    func start() {
        guard !started else { return }
        started = true
        CGDisplayRegisterReconfigurationCallback({ _, flags, refcon in
            guard let refcon, !flags.contains(.beginConfigurationFlag) else { return }
            let watcher = Unmanaged<DisplayReconfigurationWatcher>.fromOpaque(refcon).takeUnretainedValue()
            DispatchQueue.main.async { watcher.schedule() }
        }, Unmanaged.passUnretained(self).toOpaque())
    }

    /// Runs the follow-up once, a beat from now, however many asked.
    func schedule() {
        guard !scheduled else { return }
        scheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.scheduled = false
            self?.onChange()
        }
    }
}

extension DriverRuntime {
    /// Follows every lane display that moved since its placement was read.
    /// Also called right after this helper creates a display, which is when a
    /// move is most likely.
    func relocateMovedDisplays() {
        // A window moved under a held button fights the gesture, as the
        // watcher's repark does; the move waits for the button to come up.
        // The placements are not read meanwhile, so the move is not lost.
        if gestures.isActive {
            displayReconfiguration.schedule()
            return
        }
        for move in displays.refreshMovedPlacements() {
            windows.displayMoved(laneId: move.laneId, from: move.from, to: move.to, displayId: move.displayId)
            emit(DriverEvent(event: "display-moved", fields: [
                "laneId": .string(move.laneId),
                "origin": .object([
                    "x": .double(Double(move.to.origin.x)),
                    "y": .double(Double(move.to.origin.y)),
                ]),
            ]))
        }
    }
}
