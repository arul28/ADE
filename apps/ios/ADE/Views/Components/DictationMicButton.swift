import SwiftUI
import UIKit

/// Reusable voice-dictation control bound to a composer's draft `Binding<String>`.
///
/// Idle: a 28×28 circular mic button styled to match `WorkChatComposerSendButton`
/// (`ADEColor.accent` idle / `ADEColor.danger` recording). Tapping it begins
/// recording and the host composer swaps its trailing controls for the inline
/// `RecordingPill` (the host decides layout; this view only renders the mic and
/// owns the dictation state machine).
///
/// ## Cursor insertion
/// SwiftUI's `TextField`/`TextEditor` do not expose the caret offset or a
/// `UITextRange`, and there is no public API to read selection from a bound
/// `String`. Rather than risk destroying text by guessing an offset, this
/// control **appends** the dictated text to the end of the current draft with
/// smart spacing (a separating space only when the draft doesn't already end in
/// whitespace). The existing draft is always preserved. Because the dictated
/// span is appended, we know its exact character range, which lets the raw-undo
/// chip target precisely that span without disturbing
/// anything the user typed before recording.
struct DictationMicButton: View {
  @Binding var draft: String

  @AppStorage("ade.voiceInput.enabled") private var voiceInputEnabled = true
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// App-level dictation singleton. Observing it (instead of owning a private
  /// `@StateObject` service) is what lets recording continue across navigation
  /// and drive the global in-app recording pill.
  @EnvironmentObject private var controller: DictationController
  /// The insertion coordinator is owned by the host composer so the matching
  /// `DictationRawUndoChip` can share span/undo state with this button.
  @ObservedObject private var coordinator: DictationInsertionCoordinator

  /// Stable per-composer identity so the controller knows which composer owns
  /// the mic and where to route a finished transcript.
  private let targetId: String

  /// Surfaced to the host so it can collapse its other trailing controls while
  /// recording. Driven by the controller's recording state for this target.
  var onRecordingChange: ((Bool) -> Void)?

  init(
    draft: Binding<String>,
    coordinator: DictationInsertionCoordinator,
    targetId: String = UUID().uuidString,
    onRecordingChange: ((Bool) -> Void)? = nil
  ) {
    self._draft = draft
    self._coordinator = ObservedObject(wrappedValue: coordinator)
    self.targetId = targetId
    self.onRecordingChange = onRecordingChange
  }

  /// Whether the mic should be shown at all: feature flag + platform support.
  private var isVisible: Bool {
    voiceInputEnabled && SpeechDictationService.isAvailable
  }

  /// True when *this* composer is the one currently driving the mic.
  private var isActiveTarget: Bool {
    controller.activeTargetId == targetId
  }

  var body: some View {
    Group {
      if isVisible {
        content
      }
    }
    // The controller registers/clears this composer's insertion target as the
    // view appears/disappears. Registration is also (re)asserted on tap so the
    // most recently-focused composer always wins.
    .onAppear {
      registerTarget()
      publishRecordingState()
    }
    .onDisappear {
      controller.unregisterInsertionTarget(id: targetId)
      onRecordingChange?(false)
    }
    // Observed at the top level so the transition back to idle is seen even
    // though the idle mic sub-view is removed while the pill is shown. The
    // host collapses its other controls whenever the dictation UI is active —
    // starting, preparing, recording, or finalizing after Done — so the pill
    // never briefly coexists with the normal cluster.
    .onChange(of: controller.isRecording) { _, _ in
      publishRecordingState()
    }
    .onChange(of: controller.isStarting) { _, _ in
      publishRecordingState()
    }
    .onChange(of: controller.isPreparing) { _, _ in
      publishRecordingState()
    }
    .onChange(of: controller.isFinishing) { _, _ in
      publishRecordingState()
    }
    .onChange(of: controller.activeTargetId) { _, _ in
      publishRecordingState()
    }
    .background(visibilityReporter)
  }

  /// True when the recording pill should be on screen for *this* composer
  /// (starting, preparing, recording, or finalizing AND this composer owns the mic).
  private var isDictationUIActive: Bool {
    isActiveTarget && (controller.isStarting || controller.isPreparing || controller.isRecording || controller.isFinishing)
  }

  private func publishRecordingState() {
    onRecordingChange?(isDictationUIActive)
  }

  private var visibilityReporter: some View {
    GeometryReader { proxy in
      Color.clear
        .onAppear { publishVisibility(proxy.frame(in: .global)) }
        .onChange(of: proxy.frame(in: .global)) { _, frame in
          publishVisibility(frame)
        }
    }
  }

  private func publishVisibility(_ frame: CGRect) {
    let screen = CGRect(origin: .zero, size: UIScreen.main.bounds.size)
    let isOnscreen = frame.width > 1 && frame.height > 1 && frame.intersects(screen)
    controller.updateInsertionTargetVisibility(id: targetId, isVisible: isOnscreen)
  }

  @ViewBuilder
  private var content: some View {
    if isDictationUIActive {
      RecordingPill(
        elapsedTime: controller.elapsedTime,
        audioLevel: controller.audioLevel,
        isStarting: controller.isStarting || controller.isPreparing,
        isFinishing: controller.isFinishing,
        startupLabel: controller.isPreparing ? "Preparing..." : "Starting...",
        onCancel: cancelRecording,
        onDone: finishRecording
      )
    } else {
      micButton
    }
  }

  private var micButton: some View {
    Button(action: startRecording) {
      Image(systemName: "mic.fill")
        .font(.system(size: 13, weight: .bold))
        .frame(width: 28, height: 28)
        .foregroundStyle(ADEColor.accent)
        .background(
          Circle().fill(ADEColor.accent.opacity(0.14))
        )
        .overlay(
          Circle().stroke(ADEColor.accent.opacity(0.30), lineWidth: 0.8)
        )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Dictate message")
    .accessibilityHint("Records your voice and inserts cleaned-up text.")
  }

  // MARK: - Target registration

  /// Register this composer's draft + coordinator as the place a finished
  /// transcript should land. The controller invokes the closure on the main
  /// actor when Done fires.
  private func registerTarget() {
    controller.registerInsertionTarget(id: targetId) { raw in
      insert(rawTranscript: raw)
    }
  }

  // MARK: - Actions

  private func startRecording() {
    ADEHaptics.medium()
    // Re-assert this composer as the active target right before recording so a
    // tap always wins over a stale registration from another composer.
    registerTarget()
    Task {
      await controller.startRecording(targetId: targetId)
    }
  }

  private func cancelRecording() {
    controller.cancelRecording()
  }

  private func finishRecording() {
    controller.finishRecording()
  }

  // MARK: - Insertion + cleanup + undo

  private func insert(rawTranscript raw: String) {
    let trimmedRaw = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedRaw.isEmpty else { return }

    // 1. Deterministic clean (instant).
    let cleaned = DictationCleanup.clean(trimmedRaw, glossary: .shared)
    guard !cleaned.isEmpty else { return }

    // 2. Append at end with smart spacing, recording the inserted span so we
    //    can later revert it. The span is
    //    tracked in UTF-16 offsets so it round-trips cleanly through
    //    `NSRange` ↔ `Range<String.Index>` for the swap/revert below.
    let separator = needsLeadingSpace(before: draft) ? " " : ""
    let insertText = separator + cleaned
    let spanStart = draft.utf16.count + separator.utf16.count
    draft += insertText
    coordinator.beginSpan(
      range: NSRange(location: spanStart, length: cleaned.utf16.count),
      rawTranscript: trimmedRaw,
      cleaned: cleaned
    )

    ADEHaptics.success()

    // 3. Auto-copy the final transcript as a recovery net.
    UIPasteboard.general.string = cleaned

    // 4. Show the "raw ↩" undo chip for ~3s.
    coordinator.showUndoChip(reduceMotion: reduceMotion)

    // NOTE: We intentionally do NOT run a Foundation Models "polish" pass here.
    // The on-device model treats dictated text as a prompt and *answers* it
    // (e.g. "hi how are you" → "I'm fine, how are you?"), replacing the
    // transcript with a chatbot reply. Deterministic cleanup is the final text;
    // it matches the desktop behavior and never fabricates a response.
  }

  /// True when the draft is non-empty and doesn't already end in whitespace, so
  /// the appended dictation reads as a new word rather than being glued on.
  private func needsLeadingSpace(before text: String) -> Bool {
    guard let last = text.last else { return false }
    return !last.isWhitespace
  }
}

/// Holds the transient state around an inserted dictation span: the span range,
/// the raw transcript (for the undo chip), shimmer trigger, and the ~3s undo
/// chip visibility. Kept in a separate `ObservableObject` so the button view
/// stays simple and the host can host the chip/shimmer overlay if needed.
@MainActor
final class DictationInsertionCoordinator: ObservableObject {
  struct Span {
    var range: NSRange
    let rawTranscript: String
    var cleaned: String
  }

  @Published private(set) var span: Span?
  @Published private(set) var showsUndoChip = false
  @Published private(set) var shimmerActive = false

  private var undoChipTask: Task<Void, Never>?
  private var shimmerTask: Task<Void, Never>?

  func beginSpan(range: NSRange, rawTranscript: String, cleaned: String) {
    span = Span(range: range, rawTranscript: rawTranscript, cleaned: cleaned)
  }

  func updateSpanContent(to newContent: String) {
    guard var current = span else { return }
    current.range = NSRange(location: current.range.location, length: newContent.utf16.count)
    current.cleaned = newContent
    span = current
  }

  func showUndoChip(reduceMotion: Bool) {
    showsUndoChip = true
    undoChipTask?.cancel()
    undoChipTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 3_000_000_000)
      await MainActor.run { self?.showsUndoChip = false }
    }
  }

  func triggerShimmer(reduceMotion: Bool) {
    guard !reduceMotion else { return }
    shimmerActive = true
    shimmerTask?.cancel()
    shimmerTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      await MainActor.run { self?.shimmerActive = false }
    }
  }

  func clear() {
    span = nil
    showsUndoChip = false
    shimmerActive = false
    undoChipTask?.cancel()
    shimmerTask?.cancel()
  }
}

/// Small "raw ↩" chip rendered by the host composer just after an insert. Tapping
/// reverts the inserted span to the exact raw transcript. Lives ~3s. Provided as
/// a reusable view so each entry point can place it consistently.
struct DictationRawUndoChip: View {
  @ObservedObject var coordinator: DictationInsertionCoordinator
  @Binding var draft: String

  var body: some View {
    if coordinator.showsUndoChip, let span = coordinator.span {
      Button {
        revert(span: span)
      } label: {
        HStack(spacing: 4) {
          Image(systemName: "arrow.uturn.backward")
            .font(.system(size: 10, weight: .bold))
          Text("raw")
            .font(.caption2.weight(.semibold))
        }
        .foregroundStyle(ADEColor.textSecondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Capsule().fill(ADEColor.surfaceBackground.opacity(0.9)))
        .overlay(Capsule().stroke(ADEColor.border.opacity(0.3), lineWidth: 0.6))
      }
      .buttonStyle(.plain)
      .transition(.opacity.combined(with: .scale(scale: 0.9)))
      .accessibilityLabel("Revert to raw dictation")
    }
  }

  private func revert(span: DictationInsertionCoordinator.Span) {
    guard span.range.location + span.range.length <= draft.utf16.count,
          let swiftRange = Range(span.range, in: draft),
          String(draft[swiftRange]) == span.cleaned else { return }
    draft.replaceSubrange(swiftRange, with: span.rawTranscript)
    coordinator.clear()
    ADEHaptics.light()
  }
}
