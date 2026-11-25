import SwiftUI

// The CTO's settings on iOS (desktop `CtoSettingsPage`): Look, Brain,
// Memory, Routines and Instructions. Every change saves at once and says a
// quiet "Saved"; every call goes to the CTO's home machine.

/// The settings sheet (its own stack), or the same pages in the pane beside
/// the thread on a wide display (`embedded`, which navigates in place).
struct CtoSettingsScreen: View {
  @ObservedObject var store: CtoStore
  @ObservedObject var live: CtoLiveModel
  var embedded = false
  var initialRoute: CtoSettingsRoute? = nil

  @Environment(\.dismiss) private var dismiss
  @State private var path: [CtoSettingsRoute] = []
  @State private var embeddedRoute: CtoSettingsRoute? = nil

  var body: some View {
    Group {
      if embedded {
        if let embeddedRoute {
          VStack(spacing: 0) {
            HStack {
              Button {
                self.embeddedRoute = nil
              } label: {
                Label("Settings", systemImage: "chevron.left").font(.subheadline.weight(.medium))
              }
              .buttonStyle(.plain)
              .foregroundStyle(live.look.ctoAccent)
              Spacer()
            }
            .padding(.horizontal, 16)
            .frame(height: 44)
            CtoSettingsDestination(route: embeddedRoute, store: store, live: live)
          }
        } else {
          CtoSettingsHome(store: store, live: live, navigate: { embeddedRoute = $0 })
        }
      } else {
        NavigationStack(path: $path) {
          CtoSettingsHome(store: store, live: live)
            .toolbar {
              ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { dismiss() }
              }
            }
            .navigationDestination(for: CtoSettingsRoute.self) { route in
              CtoSettingsDestination(route: route, store: store, live: live)
            }
        }
        .onAppear {
          if let initialRoute, path.isEmpty, initialRoute != .home { path = [initialRoute] }
        }
      }
    }
    .tint(live.look.ctoAccent)
    .adeAnalyticsScreen(.ctoSettings)
    .task {
      guard !store.isFixture else { return }
      if store.memory == nil { await store.loadMemory() }
    }
  }
}

/// One settings route's page.
struct CtoSettingsDestination: View {
  let route: CtoSettingsRoute
  @ObservedObject var store: CtoStore
  @ObservedObject var live: CtoLiveModel

  var body: some View {
    switch route {
    case .home: CtoSettingsHome(store: store, live: live)
    case .look: CtoLookPage(store: store, live: live)
    case .brain: CtoBrainPage(store: store, live: live)
    case .memory: CtoMemoryPage(store: store, live: live)
    case .routines: CtoRoutinesPage(store: store, live: live)
    case .instructions: CtoInstructionsPage(store: store, live: live)
    }
  }
}

/// "Saved" for a moment after each write.
struct CtoSavedBadge: View {
  @ObservedObject var store: CtoStore
  @State private var visibleTick = 0
  @State private var showing = false

  var body: some View {
    Text("Saved")
      .font(.footnote.weight(.medium))
      .foregroundStyle(ADEColor.textMuted)
      .opacity(showing ? 1 : 0)
      .animation(.easeOut(duration: 0.2), value: showing)
      .onChange(of: store.savedTick) { _, tick in
        visibleTick = tick
        showing = true
      }
      .task(id: visibleTick) {
        guard visibleTick > 0 else { return }
        try? await Task.sleep(nanoseconds: 1_400_000_000)
        if !Task.isCancelled { showing = false }
      }
      .accessibilityHidden(!showing)
  }
}

/// The settings pages' shared chrome: inline title and the quiet "Saved" badge.
extension View {
  func ctoSettingsPage(title: String, store: CtoStore) -> some View {
    self
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { CtoSavedBadge(store: store) }
          .sharedBackgroundVisibility(.hidden)
      }
  }
}

// MARK: - Home

struct CtoSettingsHome: View {
  @ObservedObject var store: CtoStore
  @ObservedObject var live: CtoLiveModel
  /// In the pane: go in place instead of pushing.
  var navigate: ((CtoSettingsRoute) -> Void)? = nil

  var body: some View {
    List {
      Section {
        HStack(spacing: 14) {
          CtoAvatarView(look: live.look, state: live.avatarState, size: 52, motion: .lazy)
          VStack(alignment: .leading, spacing: 2) {
            Text(live.name)
              .font(.system(.headline, design: .rounded))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            Text(modelLine)
              .font(.footnote)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
        }
        .padding(.vertical, 4)
      }
      Section {
        row(.look, title: "Look", symbol: "paintpalette", value: CtoResolvedLook(live.look).shape.label)
        row(.brain, title: "Brain", symbol: "cpu", value: shortModel)
        row(.memory, title: "Memory", symbol: "bookmark", value: notesValue)
        row(.routines, title: "Routines", symbol: "arrow.triangle.2.circlepath", value: routinesValue)
        row(.instructions, title: "Instructions", symbol: "text.alignleft", value: nil)
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle("Settings")
    .navigationBarTitleDisplayMode(.inline)
  }

  private var currentModelId: String {
    store.ctoSession?.modelId ?? store.ctoSession?.model
      ?? store.identity?.modelPreferences?.modelId ?? store.identity?.modelPreferences?.model ?? ""
  }

  private var shortModel: String? {
    currentModelId.isEmpty ? nil : prettyWorkChatModelName(currentModelId)
  }

  private var modelLine: String {
    guard let model = shortModel else { return "No model yet" }
    return model
  }

  private var notesValue: String? {
    let count = store.memory?.noteLines.count ?? 0
    return count == 0 ? nil : "\(count) \(count == 1 ? "note" : "notes")"
  }

  private var routinesValue: String? {
    let on = store.upcomingRoutines.filter { !ctoRoutineRowPaused($0) }.count
    return on == 0 ? nil : "\(on) on"
  }

  @ViewBuilder
  private func row(_ route: CtoSettingsRoute, title: String, symbol: String, value: String?) -> some View {
    let label = HStack(spacing: 12) {
      Image(systemName: symbol)
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(live.look.ctoAccent)
        .frame(width: 24)
      Text(title)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Spacer(minLength: 8)
      if let value {
        Text(value)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
    }
    if let navigate {
      Button { navigate(route) } label: {
        HStack {
          label
          Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(ADEColor.textMuted)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("Cto.Settings.\(title)")
    } else {
      NavigationLink(value: route) { label }
        .accessibilityIdentifier("Cto.Settings.\(title)")
    }
  }
}

// MARK: - Look

struct CtoLookPage: View {
  @ObservedObject var store: CtoStore
  @ObservedObject var live: CtoLiveModel

  @State private var previewState: CtoAvatarState = .idle
  @State private var previewToken = 0
  @State private var nameDraft = ""
  @State private var hexDraft = ""
  @FocusState private var nameFocused: Bool

  private var look: CtoResolvedLook { CtoResolvedLook(live.look) }
  private var accent: Color { look.color }
  private let tileColumns = [GridItem(.adaptive(minimum: 72, maximum: 96), spacing: 10)]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        preview
        CtoSectionTitle(title: "Name")
        TextField("Name", text: $nameDraft)
          .font(.body)
          .textInputAutocapitalization(.words)
          .submitLabel(.done)
          .focused($nameFocused)
          .onSubmit { saveName() }
          .padding(.horizontal, 14)
          .frame(height: 46)
          .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .accessibilityLabel("Name")

        CtoSectionTitle(title: "Shape")
        LazyVGrid(columns: tileColumns, spacing: 10) {
          ForEach(CtoAvatarShape.allCases) { shape in
            tile(selected: look.shape == shape, label: shape.label) {
              CtoAvatarView(look: lookWith(shape: shape), state: .idle, size: 46, motion: .still)
            } action: { change { $0.shape = shape } }
          }
        }

        CtoSectionTitle(title: "Colour")
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 5), spacing: 12) {
          ForEach(ctoAvatarSwatches) { swatch in
            Button {
              change { $0.hex = swatch.hex }
            } label: {
              Circle()
                .fill(ctoColor(hex: swatch.hex))
                .frame(width: 34, height: 34)
                .overlay(
                  Circle().strokeBorder(ADEColor.textPrimary.opacity(look.hex == swatch.hex ? 0.9 : 0), lineWidth: 2).padding(-4)
                )
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(swatch.name)
            .accessibilityAddTraits(look.hex == swatch.hex ? .isSelected : [])
          }
        }
        HStack(spacing: 10) {
          Circle().fill(ctoColor(hex: ctoNormalizedHex(hexDraft) ?? look.hex)).frame(width: 22, height: 22)
          TextField("#7c9cff", text: $hexDraft)
            .font(.body.monospaced())
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .onSubmit { saveHex() }
            .accessibilityLabel("Custom colour")
        }
        .padding(.horizontal, 14)
        .frame(height: 46)
        .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(.top, 10)

        CtoSectionTitle(title: "Eyes")
        LazyVGrid(columns: tileColumns, spacing: 10) {
          ForEach(CtoAvatarEyes.allCases) { eyes in
            tile(selected: look.eyes == eyes, label: eyes.label) {
              CtoAvatarView(look: lookWith(eyes: eyes), state: .idle, size: 46, motion: .still)
            } action: { change { $0.eyes = eyes } }
          }
        }

        CtoSectionTitle(title: "Energy")
        Picker("Energy", selection: Binding(get: { look.energy }, set: { value in change { $0.energy = value } })) {
          ForEach(CtoAvatarEnergy.allCases) { energy in Text(energy.label).tag(energy) }
        }
        .pickerStyle(.segmented)

        CtoSectionTitle(title: "Personality")
        VStack(spacing: 0) {
          ForEach(Array(CtoPersonality.allCases.enumerated()), id: \.element.id) { index, personality in
            if index > 0 { CtoRowDivider(inset: 0) }
            personalityRow(personality)
          }
        }
        Color.clear.frame(height: 32)
      }
      .padding(.horizontal, 20)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .ctoSettingsPage(title: "Look", store: store)
    .onAppear {
      nameDraft = store.identity?.name ?? live.name
      hexDraft = look.hex
    }
    .onChange(of: nameFocused) { _, focused in if !focused { saveName() } }
    .onDisappear { saveName() }
  }

  private var preview: some View {
    VStack(spacing: 12) {
      ZStack {
        CtoAvatarHalo(color: accent, diameter: 240)
        CtoAvatarView(look: live.look, state: previewState, size: 132, motion: .live, label: "\(live.name), \(previewState.label.lowercased())", blips: false)
          .id(previewToken)
      }
      .frame(height: 170)
      ScrollView(.horizontal) {
        HStack(spacing: 6) {
          ForEach(CtoAvatarState.allCases) { state in
            Button {
              previewState = state
              previewToken += 1
            } label: {
              Text(state.label)
                .font(.footnote.weight(.medium))
                .foregroundStyle(previewState == state ? ADEColor.textPrimary : ADEColor.textSecondary)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(previewState == state ? accent.opacity(0.2) : ADEKit.track, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(previewState == state ? .isSelected : [])
          }
        }
        .padding(.horizontal, 20)
      }
      .scrollIndicators(.hidden)
      .padding(.horizontal, -20)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 8)
  }

  private func tile<Content: View>(selected: Bool, label: String, @ViewBuilder content: () -> Content, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(spacing: 6) {
        content()
        Text(label)
          .font(.caption.weight(.medium))
          .foregroundStyle(selected ? ADEColor.textPrimary : ADEColor.textSecondary)
          .lineLimit(1)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 10)
      .background(selected ? accent.opacity(0.16) : ADEKit.track, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .strokeBorder(selected ? accent.opacity(0.7) : .clear, lineWidth: 1.5)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private func personalityRow(_ personality: CtoPersonality) -> some View {
    let selected = CtoPersonality(raw: store.identity?.personality) == personality
    return Button {
      guard !selected else { return }
      var patch = CtoIdentityPatch()
      patch.personality = personality.rawValue
      Task { await store.updateIdentity(patch) }
    } label: {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: selected ? "largecircle.fill.circle" : "circle")
          .font(.system(size: 18))
          .foregroundStyle(selected ? accent : ADEColor.textMuted)
          .padding(.top, 1)
        VStack(alignment: .leading, spacing: 3) {
          Text(personality.title)
            .font(.body.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
          Text("“\(personality.example)”")
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(2)
        }
        Spacer(minLength: 0)
      }
      .padding(.vertical, 10)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(personality.title). \(personality.example)")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private func lookWith(shape: CtoAvatarShape? = nil, eyes: CtoAvatarEyes? = nil) -> CtoAvatarLook {
    var next = look
    if let shape { next.shape = shape }
    if let eyes { next.eyes = eyes }
    return next.look
  }

  private func change(_ edit: (inout CtoResolvedLook) -> Void) {
    var next = look
    edit(&next)
    guard next != look else { return }
    ADEHaptics.light()
    live.look = next.look
    hexDraft = next.hex
    var patch = CtoIdentityPatch()
    patch.avatar = next.look
    Task { await store.updateIdentity(patch) }
  }

  private func saveHex() {
    guard let hex = ctoNormalizedHex(hexDraft) else {
      hexDraft = look.hex
      return
    }
    change { $0.hex = hex }
  }

  private func saveName() {
    let trimmed = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      nameDraft = store.identity?.name ?? live.name
      return
    }
    guard trimmed != store.identity?.name else { return }
    live.name = trimmed
    var patch = CtoIdentityPatch()
    patch.name = trimmed
    Task { await store.updateIdentity(patch) }
  }
}

// MARK: - Memory

struct CtoMemoryPage: View {
  @ObservedObject var store: CtoStore
  @ObservedObject var live: CtoLiveModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if let memory = store.memory {
          // An older host sends no rules and refuses scope "rules": no editor.
          if memory.rules != nil || memory.rulesHash != nil {
            CtoSectionTitle(title: "Rules") {
              Text("Yours and the CTO's, followed every turn")
                .font(.footnote)
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            }
            CtoNotesEditor(
              store: store,
              scope: .rules,
              text: memory.rules ?? "",
              hash: memory.rulesHash,
              limit: memory.rulesLimitBytes ?? ctoRulesMaxBytes,
              placeholder: "- Ask before landing a PR — merges to main deploy at once.\n- Use opus for reviews — it catches more than the default.",
              accent: live.look.ctoAccent
            )
          }
          if store.canEditSkills || !(memory.skills ?? []).isEmpty {
            CtoSectionTitle(title: "Skills", count: memory.skills?.count) {
              Text("One how-to per kind of task")
                .font(.footnote)
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            }
            CtoSkillsList(store: store, skills: memory.skills ?? [], accent: live.look.ctoAccent)
          }
          CtoSectionTitle(title: "Project notes")
          CtoNotesEditor(
            store: store,
            scope: .project,
            text: memory.memory,
            hash: memory.memoryHash,
            limit: memory.memoryLimitBytes ?? 4096,
            placeholder: "- Deploys go through the release lane",
            accent: live.look.ctoAccent
          )
          CtoSectionTitle(title: "About you")
          CtoNotesEditor(
            store: store,
            scope: .user,
            text: memory.userNotes ?? "",
            hash: memory.userNotesHash,
            limit: memory.userNotesLimitBytes ?? 2048,
            placeholder: "- Prefers short answers",
            accent: live.look.ctoAccent
          )
          CtoSectionTitle(title: "Open work")
          CtoOpenWorkList(store: store, accent: live.look.ctoAccent)
        } else if let error = store.memoryError {
          CtoEmptyLine(symbol: "exclamationmark.triangle", text: error)
          Button("Try again") { Task { await store.loadMemory() } }
            .padding(.leading, 38)
        } else {
          CtoEmptyLine(symbol: "bookmark", text: "Loading…")
        }
        Color.clear.frame(height: 32)
      }
      .padding(.horizontal, 20)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .ctoSettingsPage(title: "Memory", store: store)
    .task {
      guard !store.isFixture else { return }
      await store.loadMemory()
    }
  }
}

/// A notes file (or the rules) in the shared autosaving editor.
struct CtoNotesEditor: View {
  @ObservedObject var store: CtoStore
  let scope: CtoStore.NotesScope
  let text: String
  let hash: String?
  let limit: Int
  let placeholder: String
  let accent: Color

  var body: some View {
    let store = store, scope = scope
    CtoTextFileEditor(
      text: text,
      hash: hash,
      limit: limit,
      placeholder: placeholder,
      accent: accent,
      minHeight: scope == .user ? 130 : (scope == .rules ? 150 : 200),
      accessibilityLabel: scope == .project ? "Project notes" : (scope == .rules ? "Rules" : "About you"),
      canEdit: store.canEditNotes,
      save: { text, baseHash in await store.saveNotes(scope, text: text, baseHash: baseHash) },
      savedHash: { CtoNotesEditor.hash(of: scope, in: store.memory) },
      reload: {
        await store.loadMemory()
        guard let memory = store.memory else { return nil }
        return (CtoNotesEditor.text(of: scope, in: memory), CtoNotesEditor.hash(of: scope, in: memory))
      },
      onSaved: { store.savedTick += 1 }
    )
  }

  static func text(of scope: CtoStore.NotesScope, in memory: CtoMemory) -> String {
    switch scope {
    case .project: return memory.memory
    case .user: return memory.userNotes ?? ""
    case .rules: return memory.rules ?? ""
    }
  }

  static func hash(of scope: CtoStore.NotesScope, in memory: CtoMemory?) -> String? {
    switch scope {
    case .project: return memory?.memoryHash
    case .user: return memory?.userNotesHash
    case .rules: return memory?.rulesHash
    }
  }
}

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

// MARK: - Routines

struct CtoRoutinesPage: View {
  @ObservedObject var store: CtoStore
  @ObservedObject var live: CtoLiveModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        CtoSectionTitle(title: "Routines", count: store.upcomingRoutines.count) {
          Text("Ask in chat to add one")
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        CtoRoutineList(store: store, accent: live.look.ctoAccent, detailed: true, name: live.name)
        Color.clear.frame(height: 32)
      }
      .padding(.horizontal, 20)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .ctoSettingsPage(title: "Routines", store: store)
    .refreshable { await store.loadRoutines(includeTerminal: true) }
    .task {
      guard !store.isFixture else { return }
      await store.loadRoutines(includeTerminal: true)
    }
  }
}

// MARK: - Instructions

struct CtoInstructionsPage: View {
  @ObservedObject var store: CtoStore
  @ObservedObject var live: CtoLiveModel

  @State private var draft = ""
  @State private var hydrated = false
  @State private var dirty = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        CtoSectionTitle(title: "Standing instructions") {
          Text("Read on every turn")
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        ZStack(alignment: .topLeading) {
          if draft.isEmpty {
            Text("Always open PRs as drafts.")
              .font(.body)
              .foregroundStyle(ADEColor.textMuted.opacity(0.7))
              .padding(.horizontal, 13)
              .padding(.vertical, 16)
              .allowsHitTesting(false)
          }
          TextEditor(text: $draft)
            .font(.body)
            .scrollContentBackground(.hidden)
            .padding(8)
            .frame(minHeight: 260)
            .accessibilityLabel("Standing instructions")
        }
        .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        Color.clear.frame(height: 32)
      }
      .padding(.horizontal, 20)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .ctoSettingsPage(title: "Instructions", store: store)
    .onAppear {
      guard !hydrated else { return }
      hydrated = true
      draft = store.identity?.systemPromptExtension ?? ""
    }
    .onChange(of: draft) { _, next in
      if next != (store.identity?.systemPromptExtension ?? "") { dirty = true }
    }
    .onDisappear {
      // Leaving inside the save delay cancels it: save what is left now.
      guard dirty else { return }
      var patch = CtoIdentityPatch()
      patch.systemPromptExtension = draft.trimmingCharacters(in: .whitespacesAndNewlines)
      let store = store
      Task { await store.updateIdentity(patch) }
    }
    .task(id: draft) {
      guard dirty else { return }
      try? await Task.sleep(nanoseconds: 1_200_000_000)
      guard !Task.isCancelled else { return }
      var patch = CtoIdentityPatch()
      patch.systemPromptExtension = draft.trimmingCharacters(in: .whitespacesAndNewlines)
      if await store.updateIdentity(patch) { dirty = false }
    }
  }
}
