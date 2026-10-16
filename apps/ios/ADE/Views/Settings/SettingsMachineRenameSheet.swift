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
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          TextField("Machine name", text: $name)
            .font(.system(size: 15))
            .textInputAutocapitalization(.words)
            .submitLabel(.done)
            .disabled(isSaving)
            .onSubmit { save(trimmedName) }
            .padding(.horizontal, ADEKit.inset)
            .frame(minHeight: 48)
            .adeKitCard(padding: nil)

          if let errorText {
            ADESettingsNotice(message: errorText, tone: .crit)
          }

          Button("Save") { save(trimmedName) }
            .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
            .disabled(isSaving || !isValidName)

          if machine.customName != nil {
            Button("Use hostname") { save(nil) }
              .buttonStyle(ADEKitButtonStyle(wide: true))
              .disabled(isSaving)
          }
        }
        .padding(20)
      }
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
