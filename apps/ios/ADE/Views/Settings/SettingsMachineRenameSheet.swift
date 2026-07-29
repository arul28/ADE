import SwiftUI

struct SettingsMachineRenameSheet: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject private var account = AccountService.shared

  let machine: AccountMachine
  @State private var name: String
  @State private var isSaving = false
  @State private var errorText: String?

  init(machine: AccountMachine) {
    self.machine = machine
    _name = State(initialValue: machine.displayName)
  }

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 14) {
        TextField("Machine name", text: $name)
          .textInputAutocapitalization(.words)
          .submitLabel(.done)
          .textFieldStyle(.roundedBorder)
          .disabled(isSaving)
          .onSubmit { save(trimmedName) }

        if let errorText {
          Text(errorText)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
        }

        Button("Save") { save(trimmedName) }
          .buttonStyle(.glassProminent)
          .disabled(isSaving || !isValidName)
          .frame(maxWidth: .infinity)

        if machine.customName != nil {
          Button("Use hostname") { save(nil) }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .disabled(isSaving)
            .frame(maxWidth: .infinity, minHeight: 44)
        }
      }
      .padding(20)
      .adeScreenBackground()
      .navigationTitle("Rename machine")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(isSaving)
        }
      }
    }
  }

  private var trimmedName: String {
    name.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var isValidName: Bool {
    !trimmedName.isEmpty && trimmedName.count <= 80
  }

  private func save(_ customName: String?) {
    guard !isSaving else { return }
    if customName != nil, !isValidName { return }
    isSaving = true
    errorText = nil
    Task {
      do {
        try await account.renameMachine(machine, customName: customName)
        dismiss()
      } catch {
        errorText = error.localizedDescription
        isSaving = false
      }
    }
  }
}
