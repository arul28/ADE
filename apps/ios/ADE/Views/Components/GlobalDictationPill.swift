import SwiftUI

/// A top-of-app capture indicator that keeps voice capture visible across every
/// tab, mirroring the desktop's global header pill. The in-composer
/// `RecordingPill` only exists while the originating composer is on screen; this
/// popup restores an in-app presence so the user can always see the same timer
/// and waveform and tap Done / Cancel without returning to the composer.
///
/// It observes the injected app-level `DictationController` and shows itself
/// whenever startup, recording, or finalizing is in flight. It deliberately
/// does not hide based on whether a composer's own pill is also visible.
struct GlobalDictationPill: View {
  @EnvironmentObject private var controller: DictationController
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var isPresented: Bool {
    (controller.isStarting || controller.isPreparing || controller.isRecording || controller.isFinishing) && !controller.activeTargetIsVisible
  }

  var body: some View {
    VStack(spacing: 8) {
      if isPresented {
        RecordingPill(
          elapsedTime: controller.elapsedTime,
          audioLevel: controller.audioLevel,
          isStarting: controller.isStarting || controller.isPreparing,
          isFinishing: controller.isFinishing,
          startupLabel: controller.isPreparing ? "Preparing..." : "Starting...",
          onCancel: { controller.cancelRecording() },
          onDone: { controller.finishRecording(origin: .globalPill) },
          opaque: true
        )
        .frame(maxWidth: 360)
        .padding(.top, 6)
        .shadow(color: Color.black.opacity(0.18), radius: 10, x: 0, y: 4)
        .transition(.identity)
      }

      if let notice = controller.clipboardNotice {
        DictationClipboardNoticePill(message: notice.message)
          .transition(.move(edge: .top).combined(with: .opacity))
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.horizontal, 16)
    .padding(.bottom, (isPresented || controller.clipboardNotice != nil) ? 8 : 0)
    .animation(reduceMotion ? nil : .linear(duration: 0.05), value: isPresented)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: controller.clipboardNotice)
  }
}

private struct DictationClipboardNoticePill: View {
  let message: String

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "doc.on.clipboard")
        .font(.system(size: 11, weight: .semibold))
      Text(message)
        .font(.caption.weight(.semibold))
    }
    .foregroundStyle(ADEColor.textPrimary)
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
    .background(
      Capsule(style: .continuous)
        .fill(ADEColor.surfaceBackground)
    )
    .overlay(
      Capsule(style: .continuous)
        .stroke(ADEColor.border.opacity(0.35), lineWidth: 0.8)
    )
    .shadow(color: Color.black.opacity(0.14), radius: 8, x: 0, y: 3)
    .accessibilityLabel(message)
  }
}
