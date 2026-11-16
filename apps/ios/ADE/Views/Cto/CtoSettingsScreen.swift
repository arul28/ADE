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

private extension View {
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

// MARK: - Brain

struct CtoBrainPage: View {
  @ObservedObject var store: CtoStore
  @ObservedObject var live: CtoLiveModel
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared

  private enum Picking: Identifiable {
    case main, backup
    var id: String { self == .main ? "main" : "backup" }
  }

  @State private var picking: Picking? = nil
  @State private var modelBusy = false
  @State private var refreshState: String? = nil
  @State private var refreshing = false
  @State private var showingHomeChooser = false
  @State private var accounts: [ProviderAccount] = []
  @State private var accountBusy = false

  private var accent: Color { live.look.ctoAccent }

  /// Claude or Codex: the providers with more than one login per machine.
  private var accountProvider: ProviderAccountProvider? { ProviderAccountProvider(rawValue: currentProvider) }
  /// The accounts that can run the CTO. The row shows only with two or more.
  private var usableAccounts: [ProviderAccount] { accounts.filter(\.canTakeChats) }
  private var currentAccountId: String? {
    store.ctoSession?.instanceId
      ?? store.identity?.modelPreferences?.instanceId
      ?? usableAccounts.first(where: \.isDefault)?.id
  }
  private var fallbacks: [CtoModelPreferences] { store.identity?.fallbackModels ?? [] }

  private var currentModelId: String {
    store.ctoSession?.modelId ?? store.ctoSession?.model
      ?? store.identity?.modelPreferences?.modelId ?? store.identity?.modelPreferences?.model ?? ""
  }

  private var currentProvider: String {
    store.ctoSession?.provider ?? store.identity?.modelPreferences?.provider ?? "claude"
  }

  var body: some View {
    List {
      Section {
        Button { if !store.isFixture { picking = .main } } label: {
          modelRow(provider: currentProvider, modelId: currentModelId, placeholder: "Pick a model", trailing: modelBusy ? AnyView(ProgressView().controlSize(.small)) : AnyView(chevron))
        }
        .buttonStyle(.plain)
        .disabled(modelBusy)
        .accessibilityLabel("Main model, \(currentModelId.isEmpty ? "none" : prettyWorkChatModelName(currentModelId))")
        if usableAccounts.count >= 2 {
          accountRow
        }
      } header: {
        Text("Main model")
      } footer: {
        Text("Claude, Codex, Cursor, OpenCode or Copilot")
          .lineLimit(1)
      }

      Section {
        ForEach(Array(fallbacks.enumerated()), id: \.offset) { index, entry in
          modelRow(
            provider: entry.provider,
            modelId: entry.modelId ?? entry.model,
            placeholder: entry.model,
            trailing: AnyView(backupMenu(index: index))
          )
        }
        if fallbacks.count < 3 {
          Button { picking = .backup } label: {
            Label(fallbacks.isEmpty ? "Add a backup" : "Add another", systemImage: "plus")
              .foregroundStyle(accent)
          }
          .disabled(store.isFixture)
        }
      } header: {
        Text("Backups")
      } footer: {
        Text("Used in order when limits hit").lineLimit(1)
      }

      if store.canRefreshContext {
        Section {
          HStack {
            VStack(alignment: .leading, spacing: 2) {
              Text("Refresh context").foregroundStyle(ADEColor.textPrimary)
              Text(refreshState ?? "Keeps notes and recent messages")
                .font(.footnote)
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            }
            Spacer(minLength: 8)
            Button(refreshing ? "Refreshing…" : "Refresh") {
              Task {
                refreshing = true
                refreshState = await store.refreshContext()
                refreshing = false
              }
            }
            .buttonStyle(.bordered)
            .disabled(refreshing)
          }
        }
      }

      Section {
        homeMachineRow
      } header: {
        Text("Home machine")
      } footer: {
        if !store.isFixture, syncPublishes.service.activeProjectGitOriginUrl == nil {
          Text(ctoHomeNeedsGitOriginMessage)
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .ctoSettingsPage(title: "Brain", store: store)
    .task(id: currentProvider) { await loadAccounts() }
    .sheet(item: $picking) { which in
      WorkModelPickerSheet(
        currentModelId: which == .main ? currentModelId : "",
        currentProvider: currentProvider,
        currentReasoningEffort: which == .main ? (store.ctoSession?.reasoningEffort ?? "") : "",
        currentCodexFastMode: which == .main ? (store.ctoSession?.effectiveFastMode ?? false) : false,
        lanes: [],
        commandScope: .project,
        isBusy: modelBusy,
        modelFilter: { providerSupportsLiveRedirect($0.provider) },
        onSelect: { option, reasoning, _, fastMode in
          Task { @MainActor in
            if which == .main {
              await setMain(option, reasoning: reasoning, fastMode: fastMode)
            } else {
              await addBackup(option)
            }
          }
        }
      )
      .environmentObject(syncPublishes.service)
    }
  }

  private var chevron: some View {
    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(ADEColor.textMuted)
  }

  private func modelRow(provider: String, modelId: String, placeholder: String, trailing: AnyView) -> some View {
    HStack(spacing: 12) {
      WorkProviderLogo(provider: provider, size: 30)
      Text(modelId.isEmpty ? placeholder : prettyWorkChatModelName(modelId))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Spacer(minLength: 8)
      trailing
    }
    .contentShape(Rectangle())
  }

  private func backupMenu(index: Int) -> some View {
    Menu {
      if index > 0 {
        Button { moveBackup(from: index, to: index - 1) } label: { Label("Move up", systemImage: "arrow.up") }
      }
      if index < fallbacks.count - 1 {
        Button { moveBackup(from: index, to: index + 1) } label: { Label("Move down", systemImage: "arrow.down") }
      }
      Button(role: .destructive) { removeBackup(at: index) } label: { Label("Remove", systemImage: "trash") }
    } label: {
      Image(systemName: "ellipsis")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 36, height: 36)
        .contentShape(Rectangle())
    }
    .accessibilityLabel("Backup \(index + 1) options")
  }

  /// Which account runs the main model. Same conversation on every account:
  /// the host moves the thread, it does not start a new one.
  private var accountRow: some View {
    let current = usableAccounts.first { $0.id == currentAccountId }
    return Menu {
      ForEach(usableAccounts) { account in
        Button {
          Task { await setAccount(account) }
        } label: {
          if account.id == currentAccountId {
            Label(account.displayName, systemImage: "checkmark")
          } else {
            Text(account.displayName)
          }
        }
      }
    } label: {
      HStack(spacing: 12) {
        Image(systemName: "person.crop.circle")
          .font(.system(size: 18))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 30)
        Text("Account").foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 8)
        if accountBusy {
          ProgressView().controlSize(.small)
        } else {
          Text(current?.displayName ?? "Default")
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .contentShape(Rectangle())
    }
    .disabled(accountBusy || modelBusy)
    .accessibilityLabel("Account, \(current?.displayName ?? "default")")
  }

  @MainActor
  private func loadAccounts() async {
    guard let provider = accountProvider else { accounts = []; return }
    #if DEBUG
    if store.isFixture {
      accounts = ProviderAccountsPreviewData.accounts.filter { $0.provider == provider.rawValue }
      return
    }
    #endif
    guard let sync = SyncService.shared, sync.supportsProviderAccounts else { accounts = []; return }
    accounts = (try? await ProviderAccountsClient(host: sync).list(provider)) ?? []
  }

  @MainActor
  private func setAccount(_ account: ProviderAccount) async {
    guard account.id != currentAccountId, var preferences = store.identity?.modelPreferences else { return }
    accountBusy = true
    defer { accountBusy = false }
    preferences.instanceId = account.id
    var patch = CtoIdentityPatch()
    patch.modelPreferences = preferences
    guard await store.updateIdentity(patch) else { return }
    if !store.isFixture, let sync = SyncService.shared {
      // The host moves the thread on ensure, or when the next turn starts if one is running.
      if let session = try? await sync.ensureCtoSession() { store.ctoSession = session }
      await store.reloadIdentity()
    }
    ADEHaptics.light()
  }

  private func saveBackups(_ next: [CtoModelPreferences]) {
    var patch = CtoIdentityPatch()
    patch.fallbackModels = next
    Task { await store.updateIdentity(patch) }
  }

  private func moveBackup(from: Int, to: Int) {
    var next = fallbacks
    guard next.indices.contains(from), next.indices.contains(to) else { return }
    next.swapAt(from, to)
    saveBackups(next)
  }

  private func removeBackup(at index: Int) {
    var next = fallbacks
    guard next.indices.contains(index) else { return }
    next.remove(at: index)
    saveBackups(next)
  }

  private func preferenceName(_ modelId: String) -> String {
    modelId.split(separator: "/").last.map(String.init) ?? modelId
  }

  @MainActor
  private func addBackup(_ option: WorkModelOption) async {
    guard option.id != currentModelId, !fallbacks.contains(where: { ($0.modelId ?? $0.model) == option.id }) else { return }
    var next = fallbacks
    next.append(CtoModelPreferences(provider: option.provider, model: preferenceName(option.id), reasoningEffort: nil, modelId: option.id))
    saveBackups(Array(next.prefix(3)))
  }

  @MainActor
  private func setMain(_ option: WorkModelOption, reasoning: String?, fastMode: Bool) async {
    guard let sync = store.isFixture ? nil : SyncService.shared else { return }
    modelBusy = true
    defer { modelBusy = false }
    do {
      let session: AgentChatSessionSummary
      if let existing = store.ctoSession { session = existing } else { session = try await sync.ensureCtoSession() }
      let nextReasoning = reasoning ?? ""
      _ = try await sync.updateChatSession(
        sessionId: session.sessionId,
        modelId: option.id,
        reasoningEffort: nextReasoning == (session.reasoningEffort ?? "") ? nil : nextReasoning,
        codexFastMode: fastMode == session.effectiveFastMode ? nil : fastMode
      )
      store.ctoSession = try await sync.ensureCtoSession()
      await store.reloadIdentity()
      store.savedTick += 1
      ADEHaptics.light()
    } catch {
      store.errorText = ctoShortError(error, fallback: "Couldn't switch the model")
      ADEHaptics.error()
    }
  }

  @ViewBuilder
  private var homeMachineRow: some View {
    if store.isFixture {
      HStack(spacing: 12) {
        Image(systemName: "desktopcomputer").foregroundStyle(ADEColor.textSecondary).frame(width: 30)
        Text("This Mac").foregroundStyle(ADEColor.textPrimary)
        Spacer()
      }
    } else {
      let sync = syncPublishes.service
      let canChoose = sync.supportsRemoteAction("cto.setHomeMachine")
      Button { showingHomeChooser = true } label: {
        HStack(spacing: 12) {
          Image(systemName: sync.ctoHomeIsCloudComputer ? "cloud" : "desktopcomputer")
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 30)
          VStack(alignment: .leading, spacing: 2) {
            Text(ctoHomeRowName(sync))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            if sync.ctoHomeIsCloudComputer {
              Text("ADE Cloud")
                .font(.footnote)
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            }
          }
          Spacer(minLength: 8)
          if canChoose {
            Image(systemName: "chevron.up.chevron.down")
              .font(.system(size: 11, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!canChoose)
      .accessibilityLabel("Home machine, \(ctoHomeRowName(sync))")
      .sheet(isPresented: $showingHomeChooser) {
        CtoHomeChooserSheet(
          look: live.look,
          name: live.name,
          currentName: sync.ctoHomeNeedsChoice ? nil : ctoHomeRowName(sync),
          blockedReason: sync.activeProjectGitOriginUrl == nil ? ctoHomeNeedsGitOriginMessage : nil,
          onChoose: { option in
            let note = try await ctoChooseHome(option, sync: sync)
            await store.reloadIdentity()
            store.savedTick += 1
            return note
          }
        )
      }
    }
  }
}

// MARK: - Home machine

/// The home's name for the settings row: "Not chosen yet" before the person
/// picks one, else the record's name, or this machine's when the home is it.
@MainActor
func ctoHomeRowName(_ sync: SyncService) -> String {
  if sync.ctoHomeNeedsChoice { return "Not chosen yet" }
  if let name = nonEmptyTrimmed(sync.ctoHomeMachineName) { return name }
  if sync.ctoHomeMachineKey == nil { return sync.focusedMachineDisplayName }
  return "Another machine"
}

/// Records `option` as the CTO's home, then has that machine take the CTO from
/// its account copy, so its notes, routines and recent chat move with it.
/// Answers the confirmation line when the new home restored one, else nil.
@MainActor
func ctoChooseHome(_ option: WorkNewChatMachineOption, sync: SyncService) async throws -> String? {
  // The machine that is already the home has nothing to change or take.
  if !sync.ctoHomeNeedsChoice, option.machineKey == sync.ctoHomeMachineKey { return nil }
  let record = try await sync.setCtoHomeMachine(machineKey: option.machineKey, name: option.name)
  guard let adopted = await sync.adoptCtoAccountCopy(home: record, machineKey: option.machineKey),
        adopted.restored
  else { return nil }
  return "Moved from \(adopted.fromName ?? "the old machine"). Notes, routines and recent chat came along."
}

/// The CTO's one question — where it lives — as a full page: the first run on
/// a project with no home record, and a sheet over Settings when changing it.
///
/// There is no default, so the person picks one of their machines with a
/// checkout of this repository. ADE Cloud is offered as a home, never sold:
/// the iPhone app shows no price, links to no checkout and starts no computer
/// (App Store rule; the desktop makes it), so its row is never a pick.
struct CtoHomeChooser: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @EnvironmentObject private var machineFleet: MachineFleet

  let look: CtoAvatarLook?
  /// The CTO's name, for "Where should Nova live?".
  let name: String
  /// The home when changing it; nil on first run.
  var currentName: String? = nil
  /// Why nothing can be picked (no git origin), or nil.
  var blockedReason: String? = nil
  /// Records the pick. Answers the confirmation line when the new home took
  /// the CTO's account copy, else nil. Throws when it could not be saved.
  let onChoose: @MainActor (WorkNewChatMachineOption) async throws -> String?
  /// Leaves without a pick, when there is a way back. Nil on first run.
  var onCancel: (() -> Void)? = nil

  @State private var selectedId: String?
  @State private var saving = false
  @State private var errorText: String?
  @State private var confirmation: String?
  @State private var cloudPaid: Bool?

  private var sync: SyncService { syncPublishes.service }
  private var accent: Color { look.ctoAccent }
  private var changing: Bool { currentName != nil }
  private var options: [WorkNewChatMachineOption] {
    workNewChatMachineOptions(syncService: sync, fleet: machineFleet)
  }
  private var selected: WorkNewChatMachineOption? { options.first { $0.id == selectedId } }
  /// ADE Cloud is an option only where the account has it on.
  private var cloudShown: Bool { sync.cloudAvailable && sync.cloudSupported }
  /// The machine already the home: nothing to save, nothing to take.
  private var sameAsCurrent: Bool {
    guard let selected, !sync.ctoHomeNeedsChoice else { return false }
    return selected.machineKey == sync.ctoHomeMachineKey
  }
  private var canConfirm: Bool {
    !saving && confirmation == nil && blockedReason == nil && selected != nil && !sameAsCurrent
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        header
        if let confirmation {
          ADESettingsNotice(message: confirmation, tone: .neutral)
            .padding(.top, 16)
        } else if let blockedReason {
          ADESettingsNotice(message: blockedReason, tone: .warn)
            .padding(.top, 16)
        } else {
          CtoSectionTitle(title: "Machines")
          ADESettingsRows {
            ForEach(options) { option in machineRow(option) }
            if cloudShown { cloudRow }
          }
          if let errorText {
            ADESettingsNotice(message: errorText, tone: .crit)
              .padding(.top, 12)
          }
          CtoPrimaryButton(title: confirmTitle, look: look, busy: saving) {
            Task { await confirm() }
          }
          .disabled(!canConfirm)
          .opacity(canConfirm || saving ? 1 : 0.5)
          .frame(maxWidth: .infinity)
          .padding(.top, 20)
        }
        Color.clear.frame(height: 28)
      }
      .padding(.horizontal, 20)
    }
    .scrollBounceBehavior(.basedOnSize)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .task {
      guard cloudShown, cloudPaid == nil else { return }
      cloudPaid = await sync.readCloudPlanIsPaid()
    }
  }

  private var header: some View {
    VStack(spacing: 10) {
      CtoAvatarView(
        look: look,
        state: confirmation == nil ? (changing ? .idle : .asleep) : .happy,
        size: 76,
        motion: .lazy
      )
      Text(changing ? "Move \(name)" : "Where should \(name) live?")
        .font(.system(.title2, design: .rounded).weight(.bold))
        .foregroundStyle(ADEColor.textPrimary)
        .multilineTextAlignment(.center)
      Text(changing
        ? "Notes, routines and the recent chat come along."
        : "Pick the machine that's usually on. It keeps \(name)'s notes and chat.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 10)
  }

  private func machineRow(_ option: WorkNewChatMachineOption) -> some View {
    let isSelected = selectedId == option.id
    let isCurrent = !sync.ctoHomeNeedsChoice && option.machineKey == sync.ctoHomeMachineKey
    return Button {
      selectedId = option.id
      ADEHaptics.light()
    } label: {
      HStack(spacing: 12) {
        Image(systemName: option.symbol)
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(isSelected ? accent : ADEColor.textSecondary)
          .frame(width: 24)
        VStack(alignment: .leading, spacing: 2) {
          Text(option.name)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if !option.isLive {
            Text("Offline")
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
        }
        Spacer(minLength: 8)
        if isCurrent {
          Text("Current")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textMuted)
        }
        Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
          .font(.system(size: 18))
          .foregroundStyle(isSelected ? accent : ADEColor.textMuted)
      }
      .padding(.horizontal, ADEKit.inset)
      .padding(.vertical, 11)
      .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(option.isLive ? option.name : "\(option.name), offline")
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }

  /// ADE Cloud as a home: on the phone it explains, it never starts anything
  /// and never sells anything.
  private var cloudRow: some View {
    HStack(spacing: 12) {
      Image(systemName: "cloud")
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 2) {
        Text("ADE Cloud")
          .font(.system(size: 15))
          .foregroundStyle(ADEColor.textPrimary)
        Text(cloudPaid == true ? "Set it up from ADE on a computer" : "Needs a paid plan")
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
    .opacity(0.6)
    .accessibilityElement(children: .combine)
    .accessibilityHint("Made from ADE on a computer, not on the iPhone")
  }

  private var confirmTitle: String {
    guard let selected else { return "Pick a machine" }
    if selected.machineKey == nil { return changing ? "Move it here" : "Use this machine" }
    return changing ? "Move to \(selected.name)" : "Use \(selected.name)"
  }

  @MainActor
  private func confirm() async {
    guard let selected, canConfirm else { return }
    saving = true
    errorText = nil
    defer { saving = false }
    // A pick is also a decision to keep that machine connected.
    if let key = selected.machineKey, !selected.isLive { machineFleet.keepLive(machineKey: key) }
    do {
      let note = try await onChoose(selected)
      ADEHaptics.success()
      if let note {
        confirmation = note
      } else {
        onCancel?()
      }
    } catch {
      ADEHaptics.error()
      errorText = ctoShortError(error, fallback: "Couldn't save the home machine")
    }
  }
}

/// The chooser over Settings: changing the home. A move that restored the
/// CTO's copy stays up with its one line; anything else closes at once.
struct CtoHomeChooserSheet: View {
  @Environment(\.dismiss) private var dismiss

  let look: CtoAvatarLook?
  let name: String
  let currentName: String?
  var blockedReason: String? = nil
  let onChoose: @MainActor (WorkNewChatMachineOption) async throws -> String?

  var body: some View {
    NavigationStack {
      CtoHomeChooser(
        look: look,
        name: name,
        currentName: currentName,
        blockedReason: blockedReason,
        onChoose: onChoose,
        onCancel: { dismiss() }
      )
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }
        }
      }
    }
    .tint(look.ctoAccent)
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

/// A notes file: saves a beat after the last keystroke, with a byte meter.
/// A write the host refuses because the file changed meanwhile asks to reload.
struct CtoNotesEditor: View {
  @ObservedObject var store: CtoStore
  let scope: CtoStore.NotesScope
  let text: String
  let hash: String?
  let limit: Int
  let placeholder: String
  let accent: Color

  private enum SaveState: Equatable { case idle, saving, saved, conflict, failed(String) }

  @State private var draft = ""
  @State private var baseHash: String? = nil
  @State private var dirty = false
  @State private var state: SaveState = .idle
  @State private var hydrated = false

  private var bytes: Int { draft.utf8.count }
  private var over: Bool { bytes > limit }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ZStack(alignment: .topLeading) {
        if draft.isEmpty {
          Text(placeholder)
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
          .frame(minHeight: scope == .project ? 200 : 130)
          .disabled(!store.canEditNotes)
          .accessibilityLabel(scope == .project ? "Project notes" : "About you")
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
    .task(id: draft) {
      guard dirty, !over, store.canEditNotes else { return }
      try? await Task.sleep(nanoseconds: 1_200_000_000)
      guard !Task.isCancelled else { return }
      await save()
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
        Task { await reload() }
      } label: {
        Text("Changed elsewhere · Reload").font(.footnote.weight(.medium)).foregroundStyle(accent)
      }
      .buttonStyle(.plain)
      .lineLimit(1)
    case .failed(let message):
      Text(message).font(.footnote).foregroundStyle(ADEColor.warning).lineLimit(1)
    }
  }

  private func save() async {
    state = .saving
    let sent = draft
    let result = await store.saveNotes(scope, text: sent, baseHash: baseHash)
    switch result {
    case .saved:
      dirty = draft != sent
      if let memory = store.memory {
        baseHash = scope == .project ? memory.memoryHash : memory.userNotesHash
      }
      state = .saved
      store.savedTick += 1
    case .conflict:
      state = .conflict
    case .failed(let message):
      state = .failed(message)
    }
  }

  private func reload() async {
    await store.loadMemory()
    guard let memory = store.memory else { return }
    dirty = false
    draft = scope == .project ? memory.memory : (memory.userNotes ?? "")
    baseHash = scope == .project ? memory.memoryHash : memory.userNotesHash
    state = .idle
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
