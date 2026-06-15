import SwiftUI

/// Settings section for the voice-to-text dictation feature. A single toggle
/// persisted via `@AppStorage("ade.voiceInput.enabled")` (default on); the mic
/// affordance in every composer reads the same key and hides itself when this
/// is off (or when on-device transcription isn't available).
struct SettingsVoiceInputSection: View {
  @AppStorage("ade.voiceInput.enabled") private var voiceInputEnabled = true

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      SettingsSectionHeader(
        label: "VOICE INPUT",
        hint: "Dictate prompts with on-device speech-to-text"
      )

      Toggle(isOn: $voiceInputEnabled) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Enable voice input")
            .font(.body.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Adds a mic to each composer. Audio is transcribed on device.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      .tint(ADEColor.accent)
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .background(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(ADEColor.surfaceBackground.opacity(0.5))
      )
      .glassEffect(in: .rect(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.75)
      )
      .accessibilityHint("Show or hide the dictation microphone in chat composers.")
    }
  }
}
