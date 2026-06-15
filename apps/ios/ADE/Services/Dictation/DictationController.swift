import ActivityKit
import Combine
import Foundation
import SwiftUI
import UIKit

/// App-level singleton that owns the **single** `SpeechDictationService` and
/// the dictation Dynamic Island Live Activity.
///
/// Lifting capture above any individual composer is what lets recording survive
/// navigation: the user can start dictating in the Work composer, switch tabs,
/// and keep watching the waveform animate in the Dynamic Island. Only one
/// recording exists at a time.
///
/// ## Insertion target
/// The controller does not know how to mutate a specific composer's text, so
/// each composer registers an *insertion target* (its draft binding + the
/// per-composer `DictationInsertionCoordinator`) while it owns the mic. On
/// finish the controller transcribes, then routes the cleaned text to the
/// active target; if none is registered (the composer was dismissed mid-record)
/// it still copies to the clipboard — clipboard is always written as a recovery
/// net, matching the previous behavior.
///
/// ## Live Activity
/// While recording, the controller drives a `DictationActivityAttributes`
/// activity, pushing a throttled `ContentState` (waveform window + timer) a few
/// times a second. The island's Done/Cancel buttons run in this process and
/// call back through `DictationActivityActionRegistry`.
@MainActor
final class DictationController: ObservableObject, DictationActivityActionHandler {
    enum FinishOrigin {
        case composer
        case globalPill
        case liveActivity
    }

    struct ClipboardNotice: Identifiable, Equatable {
        let id = UUID()
        let message: String
    }

    /// The one capture service. Composers observe this for `isRecording`,
    /// `audioLevel`, and `elapsedTime` so the in-app pill and the island reflect
    /// the same global state.
    let service: SpeechDictationService

    /// True from the moment Done is tapped until insertion completes. Mirrors
    /// the old per-composer `coordinator.isFinishing` but lives globally so the
    /// island and whichever composer is on screen both show the finalizing
    /// state.
    @Published private(set) var isFinishing = false

    /// Identifier of the composer that currently owns the mic, if any. Used to
    /// scope the recording pill so only the originating composer expands it.
    @Published private(set) var activeTargetId: String?
    /// True when the composer that started the active recording is registered on
    /// screen. The global top pill hides in that state because the inline pill is
    /// already visible and owns the same controls.
    @Published private(set) var activeTargetIsVisible = false
    /// Brief confirmation shown when global/remote Done cannot route back to the
    /// original composer and the dictated input is preserved via clipboard.
    @Published private(set) var clipboardNotice: ClipboardNotice?

    // Republished mirrors of the nested SpeechDictationService state. SwiftUI
    // does NOT observe a nested ObservableObject reached via `controller.service`,
    // so views must read these `@Published` controller properties instead —
    // otherwise audioLevel/elapsedTime/isRecording changes never trigger a
    // re-render (the waveform stayed frozen / never "lit up", the timer froze).
    @Published private(set) var audioLevel: Float = 0
    @Published private(set) var elapsedTime: TimeInterval = 0
    @Published private(set) var isRecording = false

    private let glossary: VoiceGlossary

    // MARK: - Insertion target

    /// A registered composer that can receive dictated text. The closure
    /// performs the deterministic clean + smart-spacing insert
    /// against that composer's own draft binding and coordinator.
    private struct InsertionTarget {
        let id: String
        let insert: (_ rawTranscript: String) -> Void
        var isVisible: Bool
    }
    private var insertionTargets: [String: InsertionTarget] = [:]
    private var visibleTargetOrder: [String] = []
    private var latestTargetId: String?

    // MARK: - Live Activity

    /// Rolling waveform window (each 0...1), newest pushed on the right. Seeded
    /// flat and updated from `service.audioLevel`.
    private var levelWindow: [Double] = DictationActivityAttributes.idleLevels
    private var liveActivityUpdateTask: Task<Void, Never>?
    private var clipboardNoticeTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()
    /// Throttle ActivityKit updates to ~1/sec. The tiny Dynamic Island only
    /// needs the timer (which ticks once a second) and a calm, non-animating
    /// waveform — the live high-frequency waveform is for the in-app pill, not
    /// the island. Pushing at ~4/sec is what made the island relayout/"bounce"
    /// on every update, so we deliberately keep it slow here.
    private let activityUpdateInterval: TimeInterval = 1.0
    private var lastActivityPush = Date.distantPast

    // MARK: - Init

    init(glossary: VoiceGlossary = .shared) {
        self.glossary = glossary
        self.service = SpeechDictationService(glossary: glossary)
        DictationActivityActionRegistry.register(self)

        // Republish nested service state so SwiftUI views (which observe this
        // controller, not the inner service) actually re-render on changes.
        service.$audioLevel
            .receive(on: RunLoop.main)
            .sink { [weak self] level in
                guard let self else { return }
                self.audioLevel = level   // drives the in-app waveform
                self.pushLevel(level)     // drives the island rolling window
            }
            .store(in: &cancellables)
        service.$elapsedTime
            .receive(on: RunLoop.main)
            .sink { [weak self] value in self?.elapsedTime = value }
            .store(in: &cancellables)
        service.$isRecording
            .receive(on: RunLoop.main)
            .sink { [weak self] value in self?.isRecording = value }
            .store(in: &cancellables)
    }

    // MARK: - Target registration

    /// Called by a composer when its mic appears. Registers where a finished
    /// transcript can be inserted; the active recording target still controls
    /// which composer owns the inline recording UI.
    func registerInsertionTarget(
        id: String,
        insert: @escaping (_ rawTranscript: String) -> Void
    ) {
        let wasVisible = insertionTargets[id]?.isVisible ?? true
        insertionTargets[id] = InsertionTarget(id: id, insert: insert, isVisible: wasVisible)
        visibleTargetOrder.removeAll { $0 == id }
        visibleTargetOrder.append(id)
        latestTargetId = id
        refreshActiveTargetVisibility()
    }

    /// Keeps visibility separate from registration. SwiftUI can keep a
    /// disappearing chat view alive during navigation transitions; geometry
    /// tells us when the inline pill has actually moved offscreen so the global
    /// pill can appear immediately.
    func updateInsertionTargetVisibility(id: String, isVisible: Bool) {
        guard var target = insertionTargets[id], target.isVisible != isVisible else { return }
        target.isVisible = isVisible
        insertionTargets[id] = target
        refreshActiveTargetVisibility()
    }

    /// Called by a composer when it is torn down. Only clears the target if it
    /// still owns it, so a fast composer swap doesn't drop the new registration.
    /// The recording itself keeps going — a finish after this point falls back
    /// to clipboard-only.
    func unregisterInsertionTarget(id: String) {
        insertionTargets.removeValue(forKey: id)
        visibleTargetOrder.removeAll { $0 == id }
        if latestTargetId == id {
            latestTargetId = visibleTargetOrder.last
        }
        if activeTargetId == id, !service.isRecording, !isFinishing {
            activeTargetId = nil
        }
        refreshActiveTargetVisibility()
    }

    // MARK: - Recording lifecycle

    /// Begin recording on behalf of the composer identified by `targetId`.
    /// No-ops if a recording is already in flight (only one at a time).
    func startRecording(targetId: String) async {
        guard !service.isRecording, !service.isStarting, !isFinishing else { return }
        activeTargetId = targetId
        refreshActiveTargetVisibility()
        do {
            try await service.start()
            startLiveActivity()
        } catch {
            activeTargetId = nil
            refreshActiveTargetVisibility()
            ADEHaptics.warning()
        }
    }

    /// Finish the active recording: transcribe, then insert into the registered
    /// target (or clipboard-only if none). Invoked by the composer's Done button
    /// AND by the Dynamic Island Done intent.
    func finishRecording(origin: FinishOrigin = .composer) {
        guard service.isRecording, !isFinishing else { return }
        isFinishing = true
        updateLiveActivity(force: true)
        Task { [weak self] in
            guard let self else { return }
            let raw = await self.service.stop()
            await MainActor.run {
                self.completeFinish(rawTranscript: raw, origin: origin)
            }
        }
    }

    /// Cancel the active recording without producing a transcript. Invoked by
    /// the composer's Cancel button AND the island Cancel intent.
    func cancelRecording() {
        guard service.isRecording else { return }
        ADEHaptics.warning()
        Task { [weak self] in
            guard let self else { return }
            await self.service.cancel()
            await MainActor.run {
                self.isFinishing = false
                self.activeTargetId = nil
                self.refreshActiveTargetVisibility()
                self.endLiveActivity()
            }
        }
    }

    private func completeFinish(rawTranscript raw: String, origin: FinishOrigin) {
        isFinishing = false
        let targetId = activeTargetId
        let originalTarget = targetId.flatMap { insertionTargets[$0] }
        let originalVisibleTarget = originalTarget?.isVisible == true ? originalTarget : nil
        let latestVisibleTarget = latestVisibleInsertionTarget()
        let target = originalVisibleTarget ?? latestVisibleTarget
        let originalTargetVisible = originalVisibleTarget != nil
        activeTargetId = nil
        refreshActiveTargetVisibility()
        endLiveActivity()

        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        if let target {
            // A composer is currently visible: insert there, whether it is the
            // original prompt or the current prompt the user navigated to.
            target.insert(trimmed)
        } else {
            // No live prompt binding: clean deterministically and copy so the
            // dictated input is still recoverable.
            let cleaned = DictationCleanup.clean(trimmed, glossary: glossary)
            UIPasteboard.general.string = cleaned.isEmpty ? trimmed : cleaned
            ADEHaptics.success()
        }

        if origin != .composer && !originalTargetVisible {
            showClipboardNotice()
        }
    }

    private func refreshActiveTargetVisibility() {
        activeTargetIsVisible = activeTargetId.flatMap { insertionTargets[$0]?.isVisible } ?? false
    }

    private func latestVisibleInsertionTarget() -> InsertionTarget? {
        for id in visibleTargetOrder.reversed() {
            if let target = insertionTargets[id], target.isVisible {
                return target
            }
        }
        if let latestTargetId, let target = insertionTargets[latestTargetId], target.isVisible {
            return target
        }
        return nil
    }

    private func showClipboardNotice() {
        let notice = ClipboardNotice(message: "Input copied to clipboard")
        clipboardNotice = notice
        clipboardNoticeTask?.cancel()
        clipboardNoticeTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_400_000_000)
            await MainActor.run {
                if self?.clipboardNotice == notice {
                    self?.clipboardNotice = nil
                }
            }
        }
    }

    // MARK: - DictationActivityActionHandler

    /// Done tapped in the Dynamic Island. Routes to the same finish path as the
    /// in-app pill.
    func finishFromLiveActivity() {
        finishRecording(origin: .liveActivity)
    }

    /// Cancel tapped in the Dynamic Island.
    func cancelFromLiveActivity() {
        cancelRecording()
    }

    // MARK: - Waveform window

    private func pushLevel(_ level: Float) {
        guard service.isRecording else { return }
        var next = levelWindow
        if next.count >= DictationActivityAttributes.barCount {
            next.removeFirst(next.count - DictationActivityAttributes.barCount + 1)
        }
        next.append(Double(max(0.08, min(1, level))))
        levelWindow = next
        maybePushActivity()
    }

    // MARK: - Live Activity lifecycle

    private func startLiveActivity() {
        guard #available(iOS 17.0, *) else { return }
        levelWindow = DictationActivityAttributes.idleLevels
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        // End any stray dictation activity first so we never stack two.
        for activity in Activity<DictationActivityAttributes>.activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }

        let attributes = DictationActivityAttributes()
        let state = makeContentState()
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(60 * 30))
        do {
            _ = try Activity<DictationActivityAttributes>.request(
                attributes: attributes,
                content: content,
                pushType: nil
            )
            lastActivityPush = Date()
            // A steady tick drives the timer even during silence (when no new
            // audio-level samples arrive to push updates).
            startActivityTick()
        } catch {
            // User disabled Live Activities, no foreground gesture, or budget
            // exhausted — recording still works; the in-app pill carries on.
        }
    }

    private func startActivityTick() {
        liveActivityUpdateTask?.cancel()
        liveActivityUpdateTask = Task { [weak self] in
            while !Task.isCancelled {
                // ~1s cadence: just enough to advance the m:ss timer during
                // silence. The waveform-driven pushes from `pushLevel` are
                // already throttled to the same interval, so the island stays
                // calm instead of re-animating several times a second.
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self else { return }
                if !self.service.isRecording && !self.isFinishing { return }
                self.updateLiveActivity(force: false)
            }
        }
    }

    private func maybePushActivity() {
        guard Date().timeIntervalSince(lastActivityPush) >= activityUpdateInterval else { return }
        updateLiveActivity(force: false)
    }

    private func updateLiveActivity(force: Bool) {
        guard #available(iOS 17.0, *) else { return }
        if !force {
            guard Date().timeIntervalSince(lastActivityPush) >= activityUpdateInterval else { return }
        }
        lastActivityPush = Date()
        let state = makeContentState()
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(60 * 30))
        for activity in Activity<DictationActivityAttributes>.activities {
            Task { await activity.update(content) }
        }
    }

    private func endLiveActivity() {
        liveActivityUpdateTask?.cancel()
        liveActivityUpdateTask = nil
        levelWindow = DictationActivityAttributes.idleLevels
        guard #available(iOS 17.0, *) else { return }
        for activity in Activity<DictationActivityAttributes>.activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }

    private func makeContentState() -> DictationActivityAttributes.ContentState {
        DictationActivityAttributes.ContentState(
            levels: levelWindow,
            elapsedTime: service.elapsedTime,
            isFinishing: isFinishing,
            generatedAt: Date()
        )
    }
}
