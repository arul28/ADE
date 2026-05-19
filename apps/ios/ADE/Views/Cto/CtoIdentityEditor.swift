import SwiftUI

struct CtoIdentityEditor: View {
  let snapshot: CtoSnapshot?
  let onSaved: (CtoSnapshot) -> Void

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  @State private var localName: String = ""
  @State private var localPersonality: String = "professional"
  @State private var localProvider: String = ""
  @State private var localModel: String = ""
  @State private var localExtension: String = ""

  @State private var isSaving = false
  @State private var errorMessage: String?

  /// Presets mirror desktop `CtoPersonalityPreset`.
  private let presets: [(id: String, label: String)] = [
    ("professional", "Professional"),
    ("strategic", "Strategic"),
    ("hands_on", "Hands-on"),
    ("casual", "Casual"),
    ("minimal", "Minimal"),
    ("custom", "Custom"),
  ]

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        editorHeader

        Form {
          if let errorMessage {
            Section {
              Text(errorMessage)
                .font(.subheadline)
                .foregroundStyle(ADEColor.danger)
            }
          }

          Section("Name") {
            TextField("CTO", text: $localName)
              .textInputAutocapitalization(.words)
              .disableAutocorrection(false)
          }

          Section("Personality") {
            VStack(spacing: 8) {
              ForEach(presets, id: \.id) { preset in
                ADEOptionButton(
                  title: preset.label,
                  subtitle: personalityDescription(for: preset.id),
                  systemImage: personalityIcon(for: preset.id),
                  isSelected: localPersonality == preset.id,
                  tint: ADEColor.ctoAccent
                ) {
                  localPersonality = preset.id
                }
              }
            }
          }

          Section("Model") {
            TextField("anthropic", text: $localProvider)
              .textInputAutocapitalization(.never)
              .disableAutocorrection(true)
              .font(.system(.body, design: .monospaced))
            TextField("claude-sonnet-4-6", text: $localModel)
              .textInputAutocapitalization(.never)
              .disableAutocorrection(true)
              .font(.system(.body, design: .monospaced))
          }

          Section {
            TextEditor(text: $localExtension)
              .font(.system(.body))
              .frame(minHeight: 140)
          } header: {
            Text("System prompt extension")
          }
        }
        .scrollContentBackground(.hidden)
      }
      .adeScreenBackground()
      .navigationTitle("")
      .toolbar(.hidden, for: .navigationBar)
    }
    .presentationDetents([.large])
    .tint(ADEColor.accent)
    .onAppear(perform: hydrate)
  }

  private var editorHeader: some View {
    HStack {
      Button("Cancel") { dismiss() }
        .buttonStyle(.glass)
        .disabled(isSaving)
        .accessibilityLabel("Cancel edit identity")

      Spacer(minLength: 0)

      Text("Edit identity")
        .font(.headline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)

      Spacer(minLength: 0)

      Button {
        Task { await save() }
      } label: {
        if isSaving {
          ProgressView().controlSize(.small)
        } else {
          Text("Save").fontWeight(.semibold)
        }
      }
      .buttonStyle(.glass)
      .disabled(isSaving)
      .accessibilityLabel("Save edit identity")
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .background(ADEColor.pageBackground.opacity(0.98))
  }

  private func personalityDescription(for id: String) -> String {
    switch id {
    case "professional":
      return "Measured, direct planning."
    case "strategic":
      return "Long-range tradeoffs and sequencing."
    case "hands_on":
      return "Operational, implementation-first guidance."
    case "casual":
      return "Lower-formality check-ins."
    case "minimal":
      return "Brief status and next actions."
    default:
      return "Use the prompt extension below."
    }
  }

  private func personalityIcon(for id: String) -> String {
    switch id {
    case "strategic":
      return "map"
    case "hands_on":
      return "hammer"
    case "casual":
      return "bubble.left.and.text.bubble.right"
    case "minimal":
      return "line.3.horizontal.decrease"
    case "custom":
      return "slider.horizontal.3"
    default:
      return "person.crop.circle"
    }
  }

  private func hydrate() {
    guard let identity = snapshot?.identity else { return }
    localName = identity.name
    localPersonality = identity.personality ?? "professional"
    localProvider = identity.modelPreferences.provider
    localModel = identity.modelPreferences.model
    localExtension = identity.systemPromptExtension ?? ""
  }

  private func save() async {
    guard let identity = snapshot?.identity else {
      dismiss()
      return
    }

    // Guard against wiping the name with an accidental blank — the server
    // treats name as required, and an empty string in a patch would overwrite
    // a perfectly good name.
    let trimmedName = localName.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedName.isEmpty {
      errorMessage = "Name can't be empty."
      return
    }

    isSaving = true
    errorMessage = nil
    defer { isSaving = false }

    var patch = CtoIdentityPatch()
    if trimmedName != identity.name { patch.name = trimmedName }
    if localPersonality != (identity.personality ?? "professional") {
      patch.personality = localPersonality
    }

    let trimmedProvider = localProvider.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedModel = localModel.trimmingCharacters(in: .whitespacesAndNewlines)
    let currentProvider = identity.modelPreferences.provider
    let currentModel = identity.modelPreferences.model

    // Only send modelPreferences if at least one of the two changed, and
    // always send both fields together so the server doesn't see a malformed
    // partial (the desktop type requires both).
    if !trimmedProvider.isEmpty, !trimmedModel.isEmpty,
       trimmedProvider != currentProvider || trimmedModel != currentModel {
      patch.modelPreferences = CtoModelPreferences(
        provider: trimmedProvider,
        model: trimmedModel,
        reasoningEffort: identity.modelPreferences.reasoningEffort
      )
    }

    let trimmedExt = localExtension.trimmingCharacters(in: .whitespacesAndNewlines)
    let existingExt = (identity.systemPromptExtension ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedExt != existingExt {
      patch.systemPromptExtension = trimmedExt
    }

    do {
      let updated = try await syncService.updateCtoIdentity(patch: patch)
      onSaved(updated)
      dismiss()
    } catch {
      errorMessage = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }
  }
}
