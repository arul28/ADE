import SwiftUI

// MARK: - Personality presets (mirror desktop CTO_PERSONALITY_PRESETS)

/// One CTO personality preset. Label + description mirror the desktop
/// `CTO_PERSONALITY_PRESETS` so the two surfaces read identically.
struct CtoPersonalityPresetOption: Identifiable, Hashable {
  let id: String
  let label: String
  let description: String
  let systemImage: String
}

let ctoPersonalityPresetOptions: [CtoPersonalityPresetOption] = [
  .init(
    id: "strategic",
    label: "Strategic",
    description: "Long-range, architectural, and decisive without losing execution detail.",
    systemImage: "map"
  ),
  .init(
    id: "professional",
    label: "Executive",
    description: "Calm, structured, and leadership-oriented for day-to-day technical direction.",
    systemImage: "person.crop.circle"
  ),
  .init(
    id: "hands_on",
    label: "Hands-on",
    description: "Deep in the code, practical in execution, and quick to unblock delivery.",
    systemImage: "hammer"
  ),
  .init(
    id: "casual",
    label: "Collaborative",
    description: "Warm, human, and easy to work with while still acting like the technical lead.",
    systemImage: "bubble.left.and.text.bubble.right"
  ),
  .init(
    id: "minimal",
    label: "Concise",
    description: "Low-noise, direct, and focused on decisions, blockers, and next actions.",
    systemImage: "line.3.horizontal.decrease"
  ),
  .init(
    id: "custom",
    label: "Custom",
    description: "Use your own personality overlay while staying inside ADE's CTO doctrine.",
    systemImage: "slider.horizontal.3"
  ),
]

/// Human label for a personality preset id, used by the top bar chip and
/// settings summary. Falls back to the first preset for unknown ids.
func ctoPersonalityLabel(for id: String?) -> String {
  ctoPersonalityPresetOptions.first { $0.id == id }?.label ?? ctoPersonalityPresetOptions[0].label
}

// MARK: - Work style (communication style controls)

enum CtoWorkStyle {
  static let verbosityOptions: [(value: String, label: String)] = [
    ("concise", "Concise"),
    ("adaptive", "Adaptive"),
    ("detailed", "Detailed"),
  ]
  static let proactivityOptions: [(value: String, label: String)] = [
    ("reactive", "Reactive"),
    ("balanced", "Balanced"),
    ("proactive", "Proactive"),
  ]
  static let defaultStyle = CtoCommunicationStyle(
    verbosity: "adaptive",
    proactivity: "balanced",
    escalationThreshold: "medium"
  )
}

/// Simple segmented picker used for the work-style rows. Matches the app's
/// glass styling and stays GeometryReader-free.
struct CtoSegmentedRow: View {
  let title: String
  let options: [(value: String, label: String)]
  @Binding var selection: String
  var tint: Color = ADEColor.ctoAccent

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.system(size: 12.5, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)

      HStack(spacing: 3) {
        ForEach(options, id: \.value) { option in
          Button {
            if selection != option.value {
              withAnimation(.snappy(duration: 0.18)) { selection = option.value }
            }
          } label: {
            Text(option.label)
              .font(.caption.weight(.semibold))
              .foregroundStyle(selection == option.value ? tint : ADEColor.textMuted)
              .frame(maxWidth: .infinity, minHeight: 36)
              .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                  .fill(selection == option.value ? tint.opacity(0.14) : Color.clear)
              )
              .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                  .stroke(selection == option.value ? tint.opacity(0.3) : Color.clear, lineWidth: 0.5)
              )
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel(option.label)
          .accessibilityAddTraits(selection == option.value ? [.isSelected] : [])
        }
      }
      .padding(3)
      .background(ADEColor.recessedBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.5)
      )
    }
  }
}

// MARK: - First-run setup card

/// Full-bleed first-run setup shown when the CTO onboarding is incomplete.
/// Pick a personality preset + work style (+ optional name) and save — no
/// multi-step wizard. On save it marks onboarding complete so the tab flips
/// to the live chat.
struct CtoOnboardingScreen: View {
  let snapshot: CtoSnapshot?
  let onCompleted: (CtoSnapshot) -> Void

  @EnvironmentObject private var syncService: SyncService

  @State private var name: String = ""
  @State private var personality: String = "strategic"
  @State private var verbosity: String = CtoWorkStyle.defaultStyle.verbosity
  @State private var proactivity: String = CtoWorkStyle.defaultStyle.proactivity
  @State private var isSaving = false
  @State private var errorMessage: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        header

        if let errorMessage {
          ADENoticeCard(
            title: "Couldn't save setup",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: nil,
            action: nil
          )
        }

        VStack(alignment: .leading, spacing: 8) {
          fieldLabel("Name")
          TextField("CTO", text: $name)
            .textInputAutocapitalization(.words)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(ADEColor.recessedBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(ADEColor.glassBorder, lineWidth: 0.5)
            )
        }

        VStack(alignment: .leading, spacing: 10) {
          fieldLabel("Personality")
          ForEach(ctoPersonalityPresetOptions) { option in
            ADEOptionButton(
              title: option.label,
              subtitle: option.description,
              systemImage: option.systemImage,
              isSelected: personality == option.id,
              tint: ADEColor.ctoAccent
            ) {
              personality = option.id
            }
          }
        }

        VStack(alignment: .leading, spacing: 14) {
          fieldLabel("Work style")
          CtoSegmentedRow(title: "Verbosity", options: CtoWorkStyle.verbosityOptions, selection: $verbosity)
          CtoSegmentedRow(title: "Proactivity", options: CtoWorkStyle.proactivityOptions, selection: $proactivity)
        }

        saveButton
      }
      .padding(.horizontal, 20)
      .padding(.top, 12)
      .padding(.bottom, 40)
    }
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .tint(ADEColor.ctoAccent)
    .onAppear(perform: hydrate)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      ZStack {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(ADEColor.ctoAccent.opacity(0.16))
        Image(systemName: "brain")
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(ADEColor.ctoAccent)
      }
      .frame(width: 52, height: 52)

      Text("Set up your CTO")
        .font(.system(size: 22, weight: .bold))
        .foregroundStyle(ADEColor.textPrimary)
      Text("Pick a personality and work style. You can change these anytime in settings.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func fieldLabel(_ text: String) -> some View {
    Text(text.uppercased())
      .font(.caption.weight(.semibold))
      .tracking(0.4)
      .foregroundStyle(ADEColor.textMuted)
  }

  private var saveButton: some View {
    VStack(spacing: 10) {
      Button {
        Task { await save() }
      } label: {
        HStack(spacing: 8) {
          if isSaving { ProgressView().controlSize(.small).tint(.white) }
          Text(isSaving ? "Saving…" : "Start with this setup")
            .fontWeight(.semibold)
        }
        .frame(maxWidth: .infinity, minHeight: 30)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.ctoAccent)
      .disabled(isSaving)

      Button("Set up later") {
        Task { await dismissSetup() }
      }
      .font(.subheadline)
      .foregroundStyle(ADEColor.textSecondary)
      .disabled(isSaving)
    }
    .padding(.top, 4)
  }

  /// Desktop-parity skip: mark onboarding dismissed (not completed) so the tab
  /// unlocks now and setup can be re-run from settings later.
  private func dismissSetup() async {
    isSaving = true
    errorMessage = nil
    defer { isSaving = false }
    var patch = CtoIdentityPatch()
    patch.onboardingState = CtoOnboardingState(
      completedSteps: snapshot?.identity.onboardingState?.completedSteps ?? [],
      dismissedAt: ISO8601DateFormatter().string(from: Date()),
      completedAt: nil
    )
    do {
      let updated = try await syncService.updateCtoIdentity(patch: patch)
      onCompleted(updated)
    } catch {
      errorMessage = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }
  }

  private func hydrate() {
    guard let identity = snapshot?.identity else { return }
    name = identity.name == "CTO" ? "" : identity.name
    personality = identity.personality ?? "strategic"
    if let style = identity.communicationStyle {
      verbosity = style.verbosity
      proactivity = style.proactivity
    }
  }

  private func save() async {
    isSaving = true
    errorMessage = nil
    defer { isSaving = false }

    let existingStyle = snapshot?.identity.communicationStyle ?? CtoWorkStyle.defaultStyle
    var patch = CtoIdentityPatch()

    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmedName.isEmpty { patch.name = trimmedName }
    patch.personality = personality
    patch.communicationStyle = CtoCommunicationStyle(
      verbosity: verbosity,
      proactivity: proactivity,
      escalationThreshold: existingStyle.escalationThreshold
    )
    // Mark onboarding complete. Desktop's only required step is "identity";
    // stamp completedAt too so older merge paths that don't re-derive it still
    // read as complete.
    //
    // Union rather than replace — see `stepsCompletingSetup`.
    patch.onboardingState = CtoOnboardingState(
      completedSteps: CtoOnboardingState.stepsCompletingSetup(
        existing: snapshot?.identity.onboardingState?.completedSteps
      ),
      dismissedAt: nil,
      completedAt: ISO8601DateFormatter().string(from: Date())
    )

    do {
      let updated = try await syncService.updateCtoIdentity(patch: patch)
      onCompleted(updated)
    } catch {
      errorMessage = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }
  }
}
