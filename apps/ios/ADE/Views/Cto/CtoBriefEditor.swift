import SwiftUI

struct CtoBriefEditor: View {
  let snapshot: CtoSnapshot?
  let onSaved: (CtoSnapshot) -> Void

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  @State private var projectSummary: String = ""
  @State private var criticalConventions: String = ""
  @State private var userPreferences: String = ""
  @State private var activeFocus: String = ""
  @State private var notes: String = ""

  @State private var isSaving = false
  @State private var errorMessage: String?

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

          Section {
            TextEditor(text: $projectSummary)
              .font(.system(.body))
              .frame(minHeight: 100)
          } header: {
            Text("Project summary")
          }

          Section {
            TextEditor(text: $criticalConventions)
              .font(.system(.callout, design: .monospaced))
              .frame(minHeight: 100)
          } header: {
            Text("Critical conventions")
          } footer: {
            Text("One per line.")
          }

          Section {
            TextEditor(text: $userPreferences)
              .font(.system(.callout, design: .monospaced))
              .frame(minHeight: 100)
          } header: {
            Text("User preferences")
          } footer: {
            Text("One per line.")
          }

          Section {
            TextEditor(text: $activeFocus)
              .font(.system(.callout, design: .monospaced))
              .frame(minHeight: 80)
          } header: {
            Text("Active focus")
          } footer: {
            Text("One per line.")
          }

          Section {
            TextEditor(text: $notes)
              .font(.system(.callout, design: .monospaced))
              .frame(minHeight: 80)
          } header: {
            Text("Notes")
          } footer: {
            Text("One per line.")
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
        .accessibilityLabel("Cancel edit brief")

      Spacer(minLength: 0)

      Text("Edit brief")
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
      .accessibilityLabel("Save edit brief")
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .background(ADEColor.pageBackground.opacity(0.98))
  }

  private func hydrate() {
    guard let memory = snapshot?.coreMemory else { return }
    projectSummary = memory.projectSummary
    criticalConventions = memory.criticalConventions.joined(separator: "\n")
    userPreferences = memory.userPreferences.joined(separator: "\n")
    activeFocus = memory.activeFocus.joined(separator: "\n")
    notes = memory.notes.joined(separator: "\n")
  }

  private func save() async {
    guard let memory = snapshot?.coreMemory else {
      dismiss()
      return
    }

    isSaving = true
    errorMessage = nil
    defer { isSaving = false }

    var patch = CtoCoreMemoryPatch(
      projectSummary: nil,
      criticalConventions: nil,
      userPreferences: nil,
      activeFocus: nil,
      notes: nil
    )

    let trimmedSummary = projectSummary.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedSummary != memory.projectSummary.trimmingCharacters(in: .whitespacesAndNewlines) {
      patch.projectSummary = trimmedSummary
    }

    let parsedConventions = Self.parseLines(criticalConventions)
    if parsedConventions != memory.criticalConventions {
      patch.criticalConventions = parsedConventions
    }

    let parsedPrefs = Self.parseLines(userPreferences)
    if parsedPrefs != memory.userPreferences {
      patch.userPreferences = parsedPrefs
    }

    let parsedFocus = Self.parseLines(activeFocus)
    if parsedFocus != memory.activeFocus {
      patch.activeFocus = parsedFocus
    }

    let parsedNotes = Self.parseLines(notes)
    if parsedNotes != memory.notes {
      patch.notes = parsedNotes
    }

    do {
      let updated = try await syncService.updateCtoCoreMemory(patch: patch)
      onSaved(updated)
      dismiss()
    } catch {
      errorMessage = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }
  }

  private static func parseLines(_ text: String) -> [String] {
    text
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
  }
}
