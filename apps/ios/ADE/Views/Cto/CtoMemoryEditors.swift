import SwiftUI

// The Memory page's whole-file editors (desktop `AutosaveTextArea` and
// `CtoSkillsList`): the notes and rules editor, and the skills list with its
// editor sheet. Every call goes to the CTO's home machine.

/// A whole file the person edits: saves a beat after the last keystroke, with
/// a byte meter. A write the host refuses because the file changed meanwhile
/// asks to reload. Shared by the notes, the rules and each skill.
struct CtoTextFileEditor: View {
  let text: String
  let hash: String?
  let limit: Int
  let placeholder: String
  let accent: Color
  var minHeight: CGFloat = 200
  let accessibilityLabel: String
  let canEdit: Bool
  var monospaced = false
  /// Writes the whole text against `baseHash`.
  let save: (String, String?) async -> CtoStore.NotesSaveResult
  /// The file's hash after a save.
  let savedHash: () -> String?
  /// Re-reads the file after a conflict.
  let reload: () async -> (text: String, hash: String?)?
  var onSaved: () -> Void = {}

  private enum SaveState: Equatable { case idle, saving, saved, conflict, failed(String) }

  @State private var draft = ""
  @State private var baseHash: String? = nil
  @State private var dirty = false
  @State private var state: SaveState = .idle
  @State private var hydrated = false

  private var bytes: Int { draft.utf8.count }
  private var over: Bool { bytes > limit }
  private var font: Font { monospaced ? .callout.monospaced() : .body }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ZStack(alignment: .topLeading) {
        if draft.isEmpty {
          Text(placeholder)
            .font(font)
            .foregroundStyle(ADEColor.textMuted.opacity(0.7))
            .padding(.horizontal, 13)
            .padding(.vertical, 16)
            .allowsHitTesting(false)
        }
        TextEditor(text: $draft)
          .font(font)
          .scrollContentBackground(.hidden)
          .padding(8)
          .frame(minHeight: minHeight)
          .disabled(!canEdit)
          .autocorrectionDisabled(monospaced)
          .textInputAutocapitalization(monospaced ? .never : .sentences)
          .accessibilityLabel(accessibilityLabel)
      }
      .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      HStack(spacing: 8) {
        Text("\(bytes.formatted()) of \(limit.formatted())")
          .font(.footnote.monospacedDigit())
          .foregroundStyle(over ? ADEColor.warning : ADEColor.textMuted)
          .lineLimit(1)
        Spacer(minLength: 8)
        statusView
      }
      .frame(minHeight: 24)
    }
    .onAppear {
      guard !hydrated else { return }
      hydrated = true
      draft = text
      baseHash = hash
    }
    .onChange(of: text) { _, next in
      // The CTO or another device wrote the file: adopt it unless mid-edit.
      guard !dirty else { return }
      draft = next
      baseHash = hash
    }
    .onChange(of: hash) { _, next in if !dirty { baseHash = next } }
    .onChange(of: draft) { _, next in
      if next != text { dirty = true }
    }
    .onDisappear {
      // Leaving inside the save delay cancels it: save what is left now. The
      // store outlives this page.
      guard dirty, !over, canEdit else { return }
      if case .saving = state { return }
      let save = save, text = draft, base = baseHash
      Task { _ = await save(text, base) }
    }
    .task(id: draft) {
      guard dirty, !over, canEdit else { return }
      try? await Task.sleep(nanoseconds: 1_200_000_000)
      guard !Task.isCancelled else { return }
      await runSave()
    }
  }

  @ViewBuilder
  private var statusView: some View {
    switch state {
    case .idle:
      EmptyView()
    case .saving:
      Text("Saving…").font(.footnote).foregroundStyle(ADEColor.textMuted)
    case .saved:
      Text("Saved").font(.footnote).foregroundStyle(ADEColor.textMuted)
    case .conflict:
      Button {
        Task { await runReload() }
      } label: {
        Text("Changed elsewhere · Reload").font(.footnote.weight(.medium)).foregroundStyle(accent)
      }
      .buttonStyle(.plain)
      .lineLimit(1)
    case .failed(let message):
      Text(message).font(.footnote).foregroundStyle(ADEColor.warning).lineLimit(1)
    }
  }

  private func runSave() async {
    state = .saving
    let sent = draft
    let result = await save(sent, baseHash)
    switch result {
    case .saved:
      dirty = draft != sent
      if let next = savedHash() { baseHash = next }
      state = .saved
      onSaved()
    case .conflict:
      state = .conflict
    case .failed(let message):
      state = .failed(message)
    }
  }

  private func runReload() async {
    guard let file = await reload() else { return }
    dirty = false
    draft = file.text
    baseHash = file.hash
    state = .idle
  }
}

/// The CTO's skills, one how-to per kind of task (desktop `CtoSkillsList`).
/// A row opens its whole SKILL.md in the autosaving editor; every read and
/// write goes to the CTO's home machine.
struct CtoSkillsList: View {
  @ObservedObject var store: CtoStore
  let skills: [CtoSkillSummary]
  let accent: Color

  @State private var adding = false
  @State private var draft = ""
  @State private var openName: CtoSkillEditorTarget? = nil
  @State private var confirmingDelete: CtoSkillSummary? = nil
  @FocusState private var fieldFocused: Bool

  var body: some View {
    let editable = store.canEditSkills
    VStack(alignment: .leading, spacing: 0) {
      if skills.isEmpty && !adding {
        CtoEmptyLine(symbol: "book", text: "No skills yet", hint: "The CTO saves one after a kind of task it will do again.")
      }
      ForEach(Array(skills.enumerated()), id: \.element.id) { index, skill in
        if index > 0 { CtoRowDivider() }
        row(skill, editable: editable)
      }
      if editable {
        if !skills.isEmpty || adding { CtoRowDivider() }
        if adding {
          HStack(spacing: 10) {
            Image(systemName: "book")
              .font(.system(size: 15))
              .foregroundStyle(ADEColor.textMuted.opacity(0.6))
              .frame(width: 28)
            TextField("Skill name, e.g. release-desktop", text: $draft)
              .font(.body)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .focused($fieldFocused)
              .submitLabel(.done)
              .onSubmit { create() }
              .accessibilityLabel("New skill name")
          }
          .frame(minHeight: 44)
        } else {
          Button {
            adding = true
            fieldFocused = true
          } label: {
            HStack(spacing: 10) {
              Image(systemName: "plus")
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 28)
              Text("Add")
                .font(.body)
              Spacer(minLength: 0)
            }
            .foregroundStyle(accent)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(skills.count >= ctoSkillsMax)
          .accessibilityLabel(skills.count >= ctoSkillsMax ? "Add skill, full at \(ctoSkillsMax)" : "Add skill")
        }
      }
    }
    .onChange(of: fieldFocused) { _, focused in
      if !focused && draft.trimmingCharacters(in: .whitespaces).isEmpty { adding = false }
    }
    .sheet(item: $openName) { target in
      CtoSkillEditorSheet(store: store, name: target.name, accent: accent)
    }
    .confirmationDialog(
      "Delete this skill?",
      isPresented: Binding(get: { confirmingDelete != nil }, set: { if !$0 { confirmingDelete = nil } }),
      titleVisibility: .visible,
      presenting: confirmingDelete
    ) { skill in
      Button("Delete \(skill.name)", role: .destructive) {
        Task { await store.deleteSkill(skill.name) }
      }
    } message: { _ in
      Text("The CTO stops using it at once.")
    }
  }

  private func row(_ skill: CtoSkillSummary, editable: Bool) -> some View {
    HStack(spacing: 10) {
      Button {
        guard editable else { return }
        openName = CtoSkillEditorTarget(name: skill.name)
      } label: {
        HStack(spacing: 10) {
          Image(systemName: "book")
            .font(.system(size: 15))
            .foregroundStyle(accent)
            .frame(width: 28)
          VStack(alignment: .leading, spacing: 1) {
            Text(skill.name)
              .font(.body.weight(.medium))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            if !skill.description.isEmpty {
              Text(skill.description)
                .font(.footnote)
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(2)
            }
          }
          Spacer(minLength: 8)
          if editable {
            Image(systemName: "chevron.right")
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted.opacity(0.7))
          }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(skill.description.isEmpty ? skill.name : "\(skill.name). \(skill.description)")
      .accessibilityHint(editable ? "Opens the skill" : "")
      if store.canDeleteSkills {
        Button {
          confirmingDelete = skill
        } label: {
          Image(systemName: "trash")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted.opacity(0.8))
            .frame(width: 32, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(store.busyIds.contains("skill:\(skill.name)"))
        .accessibilityLabel("Delete skill \(skill.name)")
      }
    }
    .frame(minHeight: 44)
  }

  private func create() {
    let name = ctoSkillSlug(draft)
    guard !name.isEmpty else {
      adding = false
      draft = ""
      return
    }
    // A name that is already a skill opens it rather than writing over it.
    if skills.contains(where: { $0.name == name }) {
      draft = ""
      adding = false
      openName = CtoSkillEditorTarget(name: name)
      return
    }
    Task {
      switch await store.saveSkill(name, text: ctoNewSkillText(name), baseHash: nil) {
      case .saved:
        draft = ""
        adding = false
        openName = CtoSkillEditorTarget(name: name)
      case .conflict:
        store.errorText = "That skill already changed"
      case .failed(let message):
        store.errorText = message
        ADEHaptics.error()
      }
    }
  }
}

struct CtoSkillEditorTarget: Identifiable, Hashable {
  let name: String
  var id: String { name }
}

/// One skill's whole SKILL.md, loaded from the home machine and autosaved
/// back with the hash it started from.
struct CtoSkillEditorSheet: View {
  @ObservedObject var store: CtoStore
  let name: String
  let accent: Color

  @Environment(\.dismiss) private var dismiss
  @State private var file: CtoSkillFile? = nil
  @State private var loadError: String? = nil
  @State private var loaded = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          if let file {
            CtoTextFileEditor(
              text: file.text,
              hash: file.hash,
              limit: ctoSkillMaxBytes,
              placeholder: ctoNewSkillText(name),
              accent: accent,
              minHeight: 360,
              accessibilityLabel: "Skill \(name)",
              canEdit: store.canEditSkills,
              monospaced: true,
              save: { text, baseHash in
                let result = await store.saveSkill(name, text: text, baseHash: baseHash)
                if result == .saved { await load() }
                return result
              },
              savedHash: { self.file?.hash },
              reload: {
                await load()
                return self.file.map { ($0.text, $0.hash) }
              },
              onSaved: { store.savedTick += 1 }
            )
            .padding(.top, 12)
          } else if let loadError {
            CtoEmptyLine(symbol: "exclamationmark.triangle", text: loadError)
            Button("Try again") { Task { await load() } }
              .padding(.leading, 38)
          } else if loaded {
            CtoEmptyLine(symbol: "book", text: "This skill is gone")
          } else {
            CtoEmptyLine(symbol: "book", text: "Loading…")
          }
          Color.clear.frame(height: 32)
        }
        .padding(.horizontal, 20)
      }
      .scrollDismissesKeyboard(.interactively)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle(name)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }
        }
      }
    }
    .tint(accent)
    .task { await load() }
  }

  private func load() async {
    do {
      file = try await store.loadSkill(name)
      loadError = nil
    } catch {
      loadError = ctoShortError(error, fallback: "Couldn't read the skill")
    }
    loaded = true
  }
}
