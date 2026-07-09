import SwiftUI

enum WorkModelPickerScope: Equatable {
  case project
  case personal
}

/// Mobile model picker — desktop-shaped Favorites / Recents / Providers layout.
/// Mirrors `apps/desktop/src/renderer/components/shared/ModelPicker/`: a
/// vertical rail on the leading edge picks the section (Favorites, Recents,
/// or a provider family), and the trailing pane shows the matching model
/// rows with a search field on top.
///
/// Favorites and recents are sourced from the cross-surface RPC contract
/// (`modelPicker.getFavorites` / `getRecents` / `toggleFavorite` /
/// `pushRecent`) so the same starred and recently-used models follow the user
/// between the desktop, the TUI, and the iOS app.
struct WorkModelPickerSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let currentModelId: String
  let currentProvider: String
  let currentReasoningEffort: String
  let currentCodexFastMode: Bool
  let availableModelIds: [String]?
  let cursorAvailabilityMode: WorkCursorAvailabilityMode
  let lanes: [LaneSummary]
  let isBusy: Bool
  let commandScope: WorkModelPickerScope
  let onSelect: (WorkModelOption, String?, String, Bool) -> Void

  init(
    currentModelId: String,
    currentProvider: String,
    currentReasoningEffort: String = "",
    currentCodexFastMode: Bool = false,
    availableModelIds: [String]? = nil,
    cursorAvailabilityMode: WorkCursorAvailabilityMode = .chat,
    lanes: [LaneSummary] = [],
    commandScope: WorkModelPickerScope = .project,
    isBusy: Bool,
    onSelect: @escaping (WorkModelOption, String?, String, Bool) -> Void
  ) {
    self.currentModelId = currentModelId
    self.currentProvider = currentProvider
    self.currentReasoningEffort = currentReasoningEffort
    self.currentCodexFastMode = currentCodexFastMode
    self.availableModelIds = availableModelIds
    self.cursorAvailabilityMode = cursorAvailabilityMode
    self.lanes = lanes
    self.commandScope = commandScope
    self.isBusy = isBusy
    self.onSelect = onSelect
    _selectedModelId = State(initialValue: currentModelId)
    _selectedRuntimeProvider = State(initialValue: currentProvider)
    _selectedReasoningEffort = State(initialValue: currentReasoningEffort)
    _selectedCodexFastMode = State(initialValue: currentCodexFastMode)
  }

  @StateObject private var picker = ModelPickerStore()
  @State private var selection: ModelPickerRailSelection = .favorites
  @State private var searchText: String = ""
  @State private var liveCatalog: [WorkModelCatalogGroup]?
  @State private var isLoadingCatalog = false
  @State private var didPickInitialSelection = false
  @State private var selectedProviderTabKey: String?
  @State private var selectedModelId: String
  @State private var selectedRuntimeProvider: String
  @State private var selectedReasoningEffort: String
  @State private var selectedCodexFastMode: Bool
  @State private var fallbackLoginLanes: [LaneSummary] = []
  @State private var claudeLoginBusy = false
  @State private var claudeLoginError: String?

  private var catalog: [WorkModelCatalogGroup] {
    if let liveCatalog {
      return scopedCatalog(liveCatalog)
    }
    return []
  }

  private var flattenedModels: [WorkModelOption] {
    var seen = Set<String>()
    var out: [WorkModelOption] = []
    for group in catalog {
      for provider in group.providers {
        for model in provider.models where seen.insert(model.id).inserted {
          out.append(model)
        }
      }
    }
    return out
  }

  private var modelById: [String: WorkModelOption] {
    Dictionary(uniqueKeysWithValues: flattenedModels.map { ($0.id, $0) })
  }

  /// Rail entries: Favorites + Recents first, then one row per provider that
  /// has at least one model in the active catalog.
  private var railEntries: [ModelPickerRailEntry] {
    var entries: [ModelPickerRailEntry] = [.favorites, .recents]
    for group in catalog {
      entries.append(.providerGroup(key: group.key, label: groupLabel(group)))
    }
    return entries
  }

  private var isSearching: Bool {
    !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var hasCatalog: Bool {
    !catalog.isEmpty
  }

  private var cursorCatalogSourceValue: String {
    switch cursorAvailabilityMode {
    case .chat: return "sdk"
    case .cli: return "cli"
    }
  }

  private func cursorCatalogSource(for refreshProvider: String? = nil) -> String? {
    guard refreshProvider == nil || refreshProvider == "cursor" else { return nil }
    return cursorCatalogSourceValue
  }

  private var claudeLoginLane: LaneSummary? {
    let candidateLanes = lanes.isEmpty ? fallbackLoginLanes : lanes
    let activeLanes = candidateLanes.filter { $0.archivedAt == nil }
    return activeLanes.first { $0.laneType == "primary" }
      ?? activeLanes.first
      ?? candidateLanes.first
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        topControlBar
        if isLoadingCatalog && catalog.isEmpty {
          loadingState
        } else if catalog.isEmpty {
          catalogEmptyState
        } else {
          Divider().overlay(ADEColor.glassBorder)
          HStack(spacing: 0) {
            ModelPickerRail(
              entries: railEntries,
              selected: effectiveSelection,
              favoritesCount: picker.favorites.count,
              recentsCount: picker.recents.count,
              onSelect: { next in
                selection = next
                selectedProviderTabKey = nil
                if case .providerGroup(let key, _) = next {
                  Task { await refreshCatalog(for: key) }
                }
              }
            )
            Divider().overlay(ADEColor.glassBorder)
            ModelPickerContentPane(
              selection: effectiveSelection,
              isSearching: isSearching,
              searchText: searchText,
              models: visibleModels,
              groupedRows: groupedRows,
              providerTabs: providerTabs,
              selectedProviderTabKey: selectedProviderTabKey,
              selectedModelId: selectedModelId,
              selectedReasoningEffort: selectedReasoningEffort,
              selectedCodexFastMode: selectedCodexFastMode,
              favorites: picker.favorites,
              isBusy: isBusy,
              onSelect: { model in select(model: model) },
              onSelectReasoning: { model, effort in select(reasoningEffort: effort, for: model) },
              onToggleFastMode: { model, enabled in select(fastMode: enabled, for: model) },
              onSelectProviderTab: { selectedProviderTabKey = $0 },
              onToggleFavorite: { modelId in
                guard commandScope == .project else { return }
                picker.toggleFavorite(modelId, syncService: syncService)
              },
              onClaudeLogin: commandScope == .project ? { Task { await openClaudeLoginTerminal() } } : nil,
              isClaudeLoginBusy: claudeLoginBusy,
              claudeLoginError: claudeLoginError
            )
          }
          Divider().overlay(ADEColor.glassBorder)
          currentModelBar
        }
      }
      .adeScreenBackground()
      .toolbar(.hidden, for: .navigationBar)
    }
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
    .onAppear {
      if commandScope == .project {
        picker.load(syncService: syncService)
      }
    }
    .task(id: "\(currentModelId)\u{0}\(currentProvider)") {
      await loadLiveCatalog()
      pickInitialSelectionIfNeeded()
      if case .providerGroup(let key, _) = selection {
        await refreshCatalog(for: key)
      }
    }
  }

  /// Falls back to the first available provider entry only when the user's
  /// last-picked provider group has disappeared from the catalog (e.g. the
  /// host removed it). Favorites/Recents always reflect the user's choice
  /// even when empty — the empty-state hint nudges them to star or pick a
  /// model rather than silently swapping their section.
  private var effectiveSelection: ModelPickerRailSelection {
    if isSearching { return selection }
    switch selection {
    case .favorites, .recents:
      return selection
    case .providerGroup(let key, _):
      if catalog.contains(where: { $0.key == key }) {
        return selection
      }
      return firstProviderSelection() ?? .favorites
    }
  }

  private func firstProviderSelection() -> ModelPickerRailSelection? {
    guard let first = catalog.first else { return nil }
    return .providerGroup(key: first.key, label: groupLabel(first))
  }

  private func scopedCatalog(_ groups: [WorkModelCatalogGroup]) -> [WorkModelCatalogGroup] {
    let availabilityScoped = workFilterCatalogForCursorAvailability(groups, mode: cursorAvailabilityMode)
    guard let availableModelIds else { return availabilityScoped }
    let scopedIds = availableModelIds
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    guard !scopedIds.isEmpty else { return [] }
    return availabilityScoped.compactMap { group -> WorkModelCatalogGroup? in
      let providers = group.providers.compactMap { provider -> WorkModelProvider? in
        let models = provider.models.filter { model in
          scopedIds.contains { workModelIdsEquivalent($0, model.id) }
        }
        guard !models.isEmpty else { return nil }
        return WorkModelProvider(key: provider.key, displayName: provider.displayName, models: models)
      }
      guard !providers.isEmpty else { return nil }
      return WorkModelCatalogGroup(key: group.key, displayName: group.displayName, providers: providers)
    }
  }

  private func pickInitialSelectionIfNeeded() {
    guard hasCatalog, !didPickInitialSelection else { return }
    didPickInitialSelection = true
    if let activeGroupKey = catalogGroupContaining(modelId: currentModelId) {
      let label = catalog.first(where: { $0.key == activeGroupKey }).map(groupLabel) ?? activeGroupKey
      selection = .providerGroup(key: activeGroupKey, label: label)
      return
    }
    if !picker.recents.isEmpty {
      selection = .recents
      return
    }
    selection = firstProviderSelection() ?? .favorites
  }

  /// When the user types in the search box every section behaves like a flat
  /// "all models" list; the rail selection becomes informational only.
  private var visibleModels: [WorkModelOption] {
    let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let pool: [WorkModelOption]
    if isSearching {
      pool = flattenedModels
    } else {
      switch effectiveSelection {
      case .favorites:
        let lookup = modelById
        pool = picker.favorites.compactMap { lookup[$0] }
      case .recents:
        let lookup = modelById
        pool = picker.recents.compactMap { lookup[$0] }
      case .providerGroup(let key, _):
        let group = catalog.first(where: { $0.key == key })
        let providers = filteredProviders(for: group)
        pool = providers.flatMap { $0.models }
      }
    }

    guard !needle.isEmpty else { return pool }
    return pool.filter { model in
      model.displayName.lowercased().contains(needle) ||
        model.id.lowercased().contains(needle) ||
        model.tagline.lowercased().contains(needle)
    }
  }

  /// For provider sections we split models by sub-provider (Anthropic vs
  /// OpenAI vs Google inside OpenCode, etc.) so the rendered list mirrors the
  /// desktop "sub-header per provider" layout. Search results collapse to a
  /// single flat list to match the desktop's search-active mode.
  private var groupedRows: [ModelPickerRowGroup] {
    if isSearching {
      return [ModelPickerRowGroup(id: "_search", title: nil, models: visibleModels)]
    }
    switch effectiveSelection {
    case .favorites, .recents:
      return [ModelPickerRowGroup(id: "_root", title: nil, models: visibleModels)]
    case .providerGroup:
      return [ModelPickerRowGroup(id: "_root", title: nil, models: visibleModels)]
    }
  }

  private var providerTabs: [WorkModelProvider] {
    guard !isSearching else { return [] }
    guard case .providerGroup(let key, _) = effectiveSelection else { return [] }
    return catalog.first(where: { $0.key == key })?.providers.filter { !$0.models.isEmpty } ?? []
  }

  private func filteredProviders(for group: WorkModelCatalogGroup?) -> [WorkModelProvider] {
    guard let group else { return [] }
    let providers = group.providers.filter { !$0.models.isEmpty }
    guard providers.count > 1 else { return providers }
    let activeKey = selectedProviderTabKey
      ?? providers.first(where: { provider in provider.models.contains(where: { workModelIdsEquivalent($0.id, selectedModelId) }) })?.key
      ?? providers.first(where: { provider in provider.models.contains(where: { $0.isAvailable }) })?.key
      ?? providers.first?.key
    guard let activeKey else { return providers }
    return providers.filter { $0.key == activeKey }
  }

  private func catalogGroupContaining(modelId: String) -> String? {
    for group in catalog {
      for provider in group.providers {
        if provider.models.contains(where: { workModelIdsEquivalent($0.id, modelId) }) {
          return group.key
        }
      }
    }
    return nil
  }

  private func runtimeProvider(for model: WorkModelOption) -> String {
    if let group = catalog.first(where: { group in
      group.providers.contains { provider in
        provider.models.contains { $0.id == model.id }
      }
    }) {
      if group.key == "lmstudio" || group.key == "ollama" {
        return "opencode"
      }
      return group.key
    }
    let fallback = workModelCatalogGroupKey(for: model.id, currentProvider: currentProvider)
    return fallback == "lmstudio" || fallback == "ollama" ? "opencode" : fallback
  }

  private func groupLabel(_ group: WorkModelCatalogGroup) -> String {
    group.displayName
  }

  // MARK: Subviews

  @ViewBuilder
  private var topControlBar: some View {
    HStack(spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textMuted)
        TextField("Search models…", text: $searchText)
          .textFieldStyle(.plain)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textPrimary)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
        if !searchText.isEmpty {
          Button {
            searchText = ""
          } label: {
            Image(systemName: "xmark.circle.fill")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textMuted)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Clear search")
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(ADEColor.recessedBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.5)
      )

      Button {
        dismiss()
      } label: {
        Image(systemName: "xmark")
          .font(.subheadline.weight(.bold))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(width: 38, height: 38)
          .background(ADEColor.surfaceBackground.opacity(0.62), in: Circle())
          .overlay(Circle().stroke(ADEColor.glassBorder, lineWidth: 0.75))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Close")
    }
    .padding(.horizontal, 14)
    .padding(.top, 12)
    .padding(.bottom, 8)
  }

  @ViewBuilder
  private var currentModelBar: some View {
    ModelPickerCurrentModelBar(
      model: selectedModel,
      provider: selectedModel.map(runtimeProvider(for:)) ?? selectedRuntimeProvider,
      reasoningEffort: selectedReasoningEffort,
      fastModeEnabled: selectedCodexFastMode
    )
    .padding(.horizontal, 14)
    .padding(.vertical, 9)
    .background(ADEColor.recessedBackground.opacity(0.32))
  }

  @ViewBuilder
  private var loadingState: some View {
    VStack(spacing: 12) {
      Spacer(minLength: 24)
      ProgressView()
        .tint(ADEColor.accent)
      Text("Loading models from the paired machine…")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 24)
    }
    .frame(maxWidth: .infinity)
  }

  @ViewBuilder
  private var catalogEmptyState: some View {
    VStack(spacing: 12) {
      Spacer(minLength: 24)
      Image(systemName: "tray")
        .font(.title3.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text("No models are currently available.")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text("Connect a provider on the paired machine or load a local model provider, then reopen the picker.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 28)
      Spacer(minLength: 24)
    }
    .frame(maxWidth: .infinity)
  }

  private var selectedModel: WorkModelOption? {
    modelById.first(where: { workModelIdsEquivalent($0.key, selectedModelId) })?.value
  }

  // MARK: Behavior

  @MainActor
  private func loadLiveCatalog() async {
    isLoadingCatalog = true
    defer { isLoadingCatalog = false }

    if commandScope == .project, liveCatalog == nil, let cached = syncService.cachedChatModelCatalog() {
      liveCatalog = workModelCatalogGroups(
        hostCatalog: cached,
        currentModelId: currentModelId,
        currentProvider: currentProvider
      )
    }

    do {
      let hostCatalog = try await modelCatalog(mode: "cached")
      guard !Task.isCancelled else { return }
      apply(hostCatalog: hostCatalog)
    } catch {
      guard !Task.isCancelled else { return }
    }
  }

  @MainActor
  private func refreshCatalog(for groupKey: String) async {
    let refreshProvider: String?
    switch groupKey {
    case "opencode", "cursor", "droid", "lmstudio", "ollama":
      refreshProvider = groupKey
    default:
      refreshProvider = nil
    }
    guard let refreshProvider else { return }
    do {
      let hostCatalog = try await modelCatalog(mode: "refresh-stale", refreshProvider: refreshProvider)
      guard !Task.isCancelled else { return }
      apply(hostCatalog: hostCatalog)
      if hostCatalog.stale == true {
        let freshCatalog = try await modelCatalog(mode: "force", refreshProvider: refreshProvider)
        guard !Task.isCancelled else { return }
        apply(hostCatalog: freshCatalog)
      }
    } catch {
      // Keep stale catalog visible.
    }
  }

  @MainActor
  private func apply(hostCatalog: AgentChatModelCatalog) {
    liveCatalog = workModelCatalogGroups(
      hostCatalog: hostCatalog,
      currentModelId: currentModelId,
      currentProvider: currentProvider
    )
  }

  private func modelCatalog(
    mode: String,
    refreshProvider: String? = nil
  ) async throws -> AgentChatModelCatalog {
    let cursorSource = cursorCatalogSource(for: refreshProvider)
    if commandScope == .personal {
      return try await syncService.getPersonalChatModelCatalog(
        mode: mode,
        refreshProvider: refreshProvider,
        cursorSource: cursorSource
      )
    }
    return try await syncService.getChatModelCatalog(
      mode: mode,
      refreshProvider: refreshProvider,
      cursorSource: cursorSource
    )
  }

  @MainActor
  private func openClaudeLoginTerminal() async {
    guard !claudeLoginBusy else { return }
    claudeLoginBusy = true
    claudeLoginError = nil
    defer { claudeLoginBusy = false }

    do {
      if claudeLoginLane == nil {
        fallbackLoginLanes = try await syncService.fetchLanes(includeArchived: false)
      }
      guard let lane = claudeLoginLane else {
        claudeLoginError = "No active lane is available."
        return
      }
      let result = try await syncService.startClaudeLoginTerminal(laneId: lane.id)
      let sessionId = result.session?.id ?? result.sessionId
      syncService.requestedWorkSessionNavigation = WorkSessionNavigationRequest(sessionId: sessionId)
      dismiss()
    } catch {
      claudeLoginError = error.localizedDescription
    }
  }

  private func select(model: WorkModelOption) {
    guard model.isAvailable else { return }

    let changedModel = !workModelIdsEquivalent(model.id, selectedModelId)
    selectedModelId = model.id
    selectedRuntimeProvider = runtimeProvider(for: model)
    if changedModel {
      selectedReasoningEffort = defaultReasoningEffort(for: model) ?? ""
      selectedCodexFastMode = false
    } else if !modelSupportsReasoningEffort(model, selectedReasoningEffort) {
      selectedReasoningEffort = defaultReasoningEffort(for: model) ?? ""
    }
    if !model.supportsCodexFastMode {
      selectedCodexFastMode = false
    }

    if commandScope == .project { picker.pushRecent(model.id, syncService: syncService) }
    emitSelection(model)
  }

  private func select(reasoningEffort: String, for model: WorkModelOption) {
    guard model.isAvailable else { return }
    if !workModelIdsEquivalent(model.id, selectedModelId) {
      selectedModelId = model.id
      selectedRuntimeProvider = runtimeProvider(for: model)
      selectedCodexFastMode = false
    }
    selectedReasoningEffort = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if commandScope == .project { picker.pushRecent(model.id, syncService: syncService) }
    emitSelection(model)
  }

  private func select(fastMode enabled: Bool, for model: WorkModelOption) {
    guard model.isAvailable else { return }
    if !workModelIdsEquivalent(model.id, selectedModelId) {
      selectedModelId = model.id
      selectedRuntimeProvider = runtimeProvider(for: model)
      selectedReasoningEffort = defaultReasoningEffort(for: model) ?? ""
    }
    selectedCodexFastMode = model.supportsCodexFastMode ? enabled : false
    if commandScope == .project { picker.pushRecent(model.id, syncService: syncService) }
    emitSelection(model)
  }

  private func emitSelection(_ model: WorkModelOption) {
    let normalizedEffort = selectedReasoningEffort
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    let effortPayload = normalizedEffort.isEmpty ? nil : normalizedEffort
    onSelect(
      model,
      effortPayload,
      runtimeProvider(for: model),
      model.supportsCodexFastMode ? selectedCodexFastMode : false
    )
  }

  private func defaultReasoningEffort(for model: WorkModelOption) -> String? {
    let tiers = supportedReasoningTiers(for: model)
    guard !tiers.isEmpty else { return nil }
    if tiers.contains("medium") { return "medium" }
    return tiers[tiers.count / 2]
  }

  private func modelSupportsReasoningEffort(_ model: WorkModelOption, _ effort: String) -> Bool {
    let normalized = effort.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !normalized.isEmpty else { return false }
    return supportedReasoningTiers(for: model).contains(normalized)
  }

  private func supportedReasoningTiers(for model: WorkModelOption) -> [String] {
    var seen = Set<String>()
    return model.reasoningEfforts.compactMap { effort in
      let tier = effort.effort.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      guard !tier.isEmpty, seen.insert(tier).inserted else { return nil }
      return tier
    }
  }
}

// MARK: - Rail

enum ModelPickerRailSelection: Equatable {
  case favorites
  case recents
  case providerGroup(key: String, label: String)

  static func == (lhs: ModelPickerRailSelection, rhs: ModelPickerRailSelection) -> Bool {
    switch (lhs, rhs) {
    case (.favorites, .favorites): return true
    case (.recents, .recents): return true
    case (.providerGroup(let lk, _), .providerGroup(let rk, _)): return lk == rk
    default: return false
    }
  }
}

enum ModelPickerRailEntry: Identifiable, Equatable {
  case favorites
  case recents
  case providerGroup(key: String, label: String)

  var id: String {
    switch self {
    case .favorites: return "_favorites"
    case .recents: return "_recents"
    case .providerGroup(let key, _): return "provider:\(key)"
    }
  }

  var selection: ModelPickerRailSelection {
    switch self {
    case .favorites: return .favorites
    case .recents: return .recents
    case .providerGroup(let key, let label): return .providerGroup(key: key, label: label)
    }
  }
}

struct ModelPickerRail: View {
  let entries: [ModelPickerRailEntry]
  let selected: ModelPickerRailSelection
  let favoritesCount: Int
  let recentsCount: Int
  let onSelect: (ModelPickerRailSelection) -> Void

  var body: some View {
    ScrollView(.vertical, showsIndicators: false) {
      VStack(alignment: .center, spacing: 4) {
        ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
          if index > 0, case .providerGroup = entry, case .recents = entries[index - 1] {
            Divider()
              .overlay(ADEColor.glassBorder.opacity(0.8))
              .frame(width: 28)
              .padding(.vertical, 2)
          }
          railButton(entry)
        }
      }
      .padding(.vertical, 8)
      .padding(.horizontal, 5)
    }
    .frame(width: 60)
    .background(ADEColor.recessedBackground.opacity(0.35))
  }

  @ViewBuilder
  private func railButton(_ entry: ModelPickerRailEntry) -> some View {
    let isActive = entry.selection == selected
    Button {
      onSelect(entry.selection)
    } label: {
      ZStack(alignment: .topTrailing) {
        railIcon(for: entry, isActive: isActive)
          .frame(maxWidth: .infinity, minHeight: 44)
          .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(isActive ? Color.white.opacity(0.07) : Color.clear)
          )
          .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .stroke(isActive ? Color.white.opacity(0.06) : Color.clear, lineWidth: 0.8)
          )
        if let badge = badgeCount(for: entry), badge > 0 {
          Text("\(badge)")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(ADEColor.textPrimary)
            .padding(.horizontal, 3)
            .padding(.vertical, 1)
            .background(
              Capsule(style: .continuous)
                .fill(ADEColor.surfaceBackground)
            )
            .overlay(
              Capsule(style: .continuous)
                .stroke(ADEColor.glassBorder, lineWidth: 0.5)
            )
            .offset(x: 4, y: -3)
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accessibilityLabel(for: entry))
    .accessibilityAddTraits(isActive ? .isSelected : [])
  }

  private func badgeCount(for entry: ModelPickerRailEntry) -> Int? {
    switch entry {
    case .favorites: return favoritesCount
    case .recents: return recentsCount
    case .providerGroup: return nil
    }
  }

  @ViewBuilder
  private func railIcon(for entry: ModelPickerRailEntry, isActive: Bool) -> some View {
    switch entry {
    case .favorites:
      Image(systemName: isActive ? "star.fill" : "star")
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(ADEColor.warning)
    case .recents:
      Image(systemName: isActive ? "clock.fill" : "clock")
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(isActive ? ADEColor.textPrimary : ADEColor.textSecondary)
    case .providerGroup(let key, _):
      WorkProviderBareLogo(
        provider: workRailLogoProvider(for: key),
        fallbackSymbol: providerIcon(key),
        tint: providerTint(key),
        size: 18
      )
    }
  }

  private func accessibilityLabel(for entry: ModelPickerRailEntry) -> String {
    switch entry {
    case .favorites: return "Favorites (\(favoritesCount))"
    case .recents: return "Recents (\(recentsCount))"
    case .providerGroup(_, let label): return label
    }
  }
}

// MARK: - Content pane

struct ModelPickerRowGroup: Identifiable {
  let id: String
  let title: String?
  let models: [WorkModelOption]
}

struct ModelPickerContentPane: View {
  let selection: ModelPickerRailSelection
  let isSearching: Bool
  let searchText: String
  let models: [WorkModelOption]
  let groupedRows: [ModelPickerRowGroup]
  let providerTabs: [WorkModelProvider]
  let selectedProviderTabKey: String?
  let selectedModelId: String
  let selectedReasoningEffort: String
  let selectedCodexFastMode: Bool
  let favorites: [String]
  let isBusy: Bool
  let onSelect: (WorkModelOption) -> Void
  let onSelectReasoning: (WorkModelOption, String) -> Void
  let onToggleFastMode: (WorkModelOption, Bool) -> Void
  let onSelectProviderTab: (String) -> Void
  let onToggleFavorite: (String) -> Void
  let onClaudeLogin: (() -> Void)?
  let isClaudeLoginBusy: Bool
  let claudeLoginError: String?

  private var favoritesSet: Set<String> { Set(favorites) }

  private var catalogGroupKey: String? {
    if case .providerGroup(let key, _) = selection { return key }
    return nil
  }

  private var rowStyle: ModelPickerRowStyle {
    if isSearching { return .compact }
    switch selection {
    case .favorites, .recents:
      return .compact
    case .providerGroup:
      return .detailed
    }
  }

  private var showsClaudeLoginAction: Bool {
    guard onClaudeLogin != nil else { return false }
    let rows = groupedRows.flatMap(\.models)
    if case .providerGroup(let key, _) = selection, providerFamilyKey(key) == "claude" {
      return rows.contains { !$0.isAvailable }
    }
    return rows.contains { !$0.isAvailable && providerFamilyKey($0.provider) == "claude" }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      providerTabStrip
      if showsClaudeLoginAction {
        claudeLoginBanner
      }
      Divider().overlay(ADEColor.glassBorder)
      if groupedRows.allSatisfy({ $0.models.isEmpty }) {
        emptyState
      } else {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: rowStyle == .compact ? 4 : 5) {
            ForEach(groupedRows) { group in
              VStack(alignment: .leading, spacing: rowStyle == .compact ? 4 : 5) {
                if let title = group.title {
                  Text(title.uppercased())
                    .font(.caption2.weight(.bold))
                    .tracking(0.4)
                    .foregroundStyle(ADEColor.textMuted)
                    .padding(.horizontal, 4)
                    .padding(.top, 2)
                }
                ForEach(group.models) { model in
                  ModelPickerListRow(
                    model: model,
                    style: rowStyle,
                    catalogGroupKey: catalogGroupKey,
                    isSelected: workModelIdsEquivalent(model.id, selectedModelId),
                    isFavorite: favoritesSet.contains(model.id),
                    isBusy: isBusy,
                    selectedReasoningEffort: selectedReasoningEffort,
                    selectedCodexFastMode: selectedCodexFastMode,
                    onSelect: { onSelect(model) },
                    onSelectReasoning: { effort in onSelectReasoning(model, effort) },
                    onToggleFastMode: { enabled in onToggleFastMode(model, enabled) },
                    onToggleFavorite: { onToggleFavorite(model.id) },
                    onClaudeLogin: onClaudeLogin,
                    isClaudeLoginBusy: isClaudeLoginBusy
                  )
                }
              }
            }
          }
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  @ViewBuilder
  private var providerTabStrip: some View {
    if providerTabs.count > 1 {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(providerTabs) { provider in
            let selected = provider.key == activeProviderTabKey
            Button {
              onSelectProviderTab(provider.key)
            } label: {
              Text(provider.displayName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(selected ? Color.white : ADEColor.textSecondary)
                .lineLimit(1)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(selected ? ADEColor.accent : ADEColor.surfaceBackground.opacity(0.55), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selected ? .isSelected : [])
          }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 8)
      }
    }
  }

  private var activeProviderTabKey: String? {
    selectedProviderTabKey
      ?? providerTabs.first(where: { tab in
        tab.models.contains { workModelIdsEquivalent($0.id, selectedModelId) }
      })?.key
      ?? providerTabs.first(where: { tab in
        tab.models.contains(where: { $0.isAvailable })
      })?.key
      ?? providerTabs.first?.key
  }

  @ViewBuilder
  private var claudeLoginBanner: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 10) {
        Image(systemName: "terminal.fill")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(providerTint("claude"))
          .frame(width: 24, height: 24)
          .background(providerTint("claude").opacity(0.14), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        VStack(alignment: .leading, spacing: 2) {
          Text("Claude is signed out")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Open a primary-lane terminal to finish Claude Code login.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 8)
        Button {
          onClaudeLogin?()
        } label: {
          HStack(spacing: 6) {
            if isClaudeLoginBusy {
              ProgressView()
                .controlSize(.small)
                .tint(ADEColor.textPrimary)
            } else {
              Image(systemName: "arrow.right.circle.fill")
                .font(.caption.weight(.bold))
            }
            Text("Login to Claude")
              .font(.caption.weight(.bold))
              .lineLimit(1)
          }
          .foregroundStyle(ADEColor.textPrimary)
          .padding(.horizontal, 10)
          .padding(.vertical, 7)
          .background(ADEColor.accent.opacity(0.22), in: Capsule())
          .overlay(
            Capsule(style: .continuous)
              .stroke(ADEColor.accent.opacity(0.28), lineWidth: 0.6)
          )
        }
        .buttonStyle(.plain)
        .disabled(isClaudeLoginBusy)
        .accessibilityLabel("Login to Claude")
      }
      if let claudeLoginError, !claudeLoginError.isEmpty {
        Text(claudeLoginError)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(10)
    .background(ADEColor.surfaceBackground.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.glassBorder.opacity(0.75), lineWidth: 0.6)
    )
    .padding(.horizontal, 12)
    .padding(.bottom, 8)
  }

  @ViewBuilder
  private var header: some View {
    ZStack {
      HStack(spacing: 7) {
        headerLeadingIcon
        Text(headerTitle)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
      }

      if !models.isEmpty {
        HStack {
          Spacer()
          Text("\(models.count)")
            .font(.caption.weight(.bold))
            .foregroundStyle(ADEColor.textMuted)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
              Capsule(style: .continuous)
                .fill(ADEColor.recessedBackground.opacity(0.5))
            )
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 10)
    .padding(.bottom, 8)
  }

  @ViewBuilder
  private var headerLeadingIcon: some View {
    if isSearching {
      Image(systemName: "magnifyingglass")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)
    } else {
      switch selection {
      case .favorites:
        Image(systemName: "star.fill")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.warning)
      case .recents:
        Image(systemName: "clock.fill")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
      case .providerGroup(let key, _):
        WorkProviderBareLogo(
          provider: workRailLogoProvider(for: key),
          fallbackSymbol: providerIcon(key),
          tint: providerTint(key),
          size: 16
        )
      }
    }
  }

  private var headerTitle: String {
    if isSearching {
      let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
      return "Search · \"\(trimmed)\""
    }
    switch selection {
    case .favorites: return "Favorites"
    case .recents: return "Recents"
    case .providerGroup(_, let label): return label
    }
  }

  @ViewBuilder
  private var emptyState: some View {
    VStack(spacing: 8) {
      Spacer(minLength: 24)
      Image(systemName: emptyImage)
        .font(.title3.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(emptyTitle)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(emptyHint)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 24)
      Spacer(minLength: 24)
    }
    .frame(maxWidth: .infinity)
  }

  private var emptyImage: String {
    if isSearching { return "magnifyingglass" }
    switch selection {
    case .favorites: return "star"
    case .recents: return "clock"
    case .providerGroup: return "cpu"
    }
  }

  private var emptyTitle: String {
    if isSearching { return "No models match this search." }
    switch selection {
    case .favorites: return "No favorites yet."
    case .recents: return "No recent models."
    case .providerGroup: return "No models in this provider."
    }
  }

  private var emptyHint: String {
    if isSearching {
      return "Try a different name, family, or model id."
    }
    switch selection {
    case .favorites:
      return "Tap the star on any model to pin it here. Favorites sync between desktop, TUI, and mobile."
    case .recents:
      return "Models you pick here will appear in the recents list, on every paired surface."
    case .providerGroup:
      return "Sign in to this provider on the paired machine to load its models."
    }
  }
}

// MARK: - Row

enum ModelPickerRowStyle {
  case compact
  case detailed
}

struct ModelPickerListRow: View {
  let model: WorkModelOption
  let style: ModelPickerRowStyle
  let catalogGroupKey: String?
  let isSelected: Bool
  let isFavorite: Bool
  let isBusy: Bool
  let selectedReasoningEffort: String
  let selectedCodexFastMode: Bool
  let onSelect: () -> Void
  let onSelectReasoning: (String) -> Void
  let onToggleFastMode: (Bool) -> Void
  let onToggleFavorite: () -> Void
  let onClaudeLogin: (() -> Void)?
  let isClaudeLoginBusy: Bool

  private var isHighlighted: Bool {
    isSelected
  }

  private var rowLogoProvider: String {
    workModelRowLogoProvider(for: model, catalogGroupKey: catalogGroupKey)
  }

  private var supportedTiers: [String] {
    var seen = Set<String>()
    return model.reasoningEfforts.compactMap { effort in
      let tier = effort.effort.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      guard !tier.isEmpty, seen.insert(tier).inserted else { return nil }
      return tier
    }
  }

  private var showsClaudeLoginAction: Bool {
    !model.isAvailable && providerFamilyKey(model.provider) == "claude" && onClaudeLogin != nil
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        onSelect()
      } label: {
        Group {
          switch style {
          case .compact:
            compactHeaderRow
          case .detailed:
            detailedHeaderRow
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(isBusy || !model.isAvailable)

      if isHighlighted && shouldShowSelectedControls {
        VStack(alignment: .leading, spacing: 8) {
          if !supportedTiers.isEmpty {
            reasoningPills(tiers: supportedTiers)
          }
          if model.supportsCodexFastMode {
            fastModeToggle
          }
        }
        .padding(.top, style == .detailed ? 8 : 6)
      }

      if showsClaudeLoginAction {
        claudeLoginButton
          .padding(.top, style == .detailed ? 7 : 5)
      }
    }
    .padding(.horizontal, style == .compact ? 10 : 11)
    .padding(.vertical, style == .compact ? 7 : 8)
    .background(
      RoundedRectangle(cornerRadius: style == .compact ? 10 : 11, style: .continuous)
        .fill(isHighlighted ? ADEColor.accent.opacity(0.10) : ADEColor.surfaceBackground.opacity(model.isAvailable ? 0.45 : 0.28))
    )
    .overlay(
      RoundedRectangle(cornerRadius: style == .compact ? 10 : 11, style: .continuous)
        .stroke(isHighlighted ? ADEColor.accent.opacity(0.42) : ADEColor.glassBorder.opacity(0.7), lineWidth: isHighlighted ? 1 : 0.5)
    )
    .contentShape(Rectangle())
  }

  private var shouldShowSelectedControls: Bool {
    !supportedTiers.isEmpty || model.supportsCodexFastMode
  }

  @ViewBuilder
  private var compactHeaderRow: some View {
    HStack(alignment: .center, spacing: 8) {
      favoriteButton
      WorkProviderBareLogo(
        provider: rowLogoProvider,
        fallbackSymbol: providerIcon(rowLogoProvider),
        tint: providerTint(rowLogoProvider),
        size: 18
      )
      VStack(alignment: .leading, spacing: 1) {
        Text(model.displayName)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(model.isAvailable ? ADEColor.textPrimary : ADEColor.textMuted)
          .lineLimit(1)
      }
      Spacer(minLength: 4)
    }
    .accessibilityLabel("\(model.displayName)\(isSelected ? ". Selected." : "")")
  }

  @ViewBuilder
  private var detailedHeaderRow: some View {
    HStack(alignment: .center, spacing: 9) {
      WorkProviderBareLogo(
        provider: rowLogoProvider,
        fallbackSymbol: providerIcon(rowLogoProvider),
        tint: providerTint(rowLogoProvider),
        size: 20
      )
      VStack(alignment: .leading, spacing: 1) {
        Text(model.displayName)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(model.isAvailable ? ADEColor.textPrimary : ADEColor.textMuted)
          .lineLimit(1)
      }
      Spacer(minLength: 6)
      favoriteButton
    }
    .accessibilityLabel("\(model.displayName)\(isSelected ? ". Selected." : "")")
  }

  @ViewBuilder
  private var claudeLoginButton: some View {
    Button {
      onClaudeLogin?()
    } label: {
      HStack(spacing: 6) {
        if isClaudeLoginBusy {
          ProgressView()
            .controlSize(.small)
            .tint(ADEColor.textPrimary)
        } else {
          Image(systemName: "terminal.fill")
            .font(.caption.weight(.semibold))
        }
        Text("Login to Claude")
          .font(.caption.weight(.bold))
          .lineLimit(1)
      }
      .foregroundStyle(ADEColor.textPrimary)
      .padding(.horizontal, 9)
      .padding(.vertical, 6)
      .background(ADEColor.accent.opacity(0.18), in: Capsule())
      .overlay(
        Capsule(style: .continuous)
          .stroke(ADEColor.accent.opacity(0.24), lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
    .disabled(isClaudeLoginBusy)
    .accessibilityLabel("Login to Claude")
  }

  @ViewBuilder
  private var favoriteButton: some View {
    Button {
      onToggleFavorite()
    } label: {
      Image(systemName: isFavorite ? "star.fill" : "star")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(isFavorite ? ADEColor.warning : ADEColor.textMuted)
        .frame(width: 30, height: 30)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(isFavorite ? "Remove from favorites" : "Add to favorites")
  }

  @ViewBuilder
  private func reasoningPills(tiers: [String]) -> some View {
    let normalizedCurrent = selectedReasoningEffort
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(tiers, id: \.self) { tier in
          let normalized = tier.lowercased()
          let isActiveTier = normalized == normalizedCurrent
          Button {
            onSelectReasoning(normalized)
          } label: {
            Text(reasoningLabel(for: tier))
              .font(.caption.weight(.semibold))
              .foregroundStyle(isActiveTier ? Color.white : ADEColor.textSecondary)
              .lineLimit(1)
              .padding(.horizontal, 12)
              .padding(.vertical, 7)
              .background(
                Capsule(style: .continuous)
                  .fill(isActiveTier ? ADEColor.accent : ADEColor.surfaceBackground.opacity(0.55))
              )
              .overlay(
                Capsule(style: .continuous)
                  .stroke(isActiveTier ? ADEColor.accent : ADEColor.glassBorder, lineWidth: 0.6)
              )
          }
          .buttonStyle(.plain)
          .disabled(isBusy || !model.isAvailable)
          .accessibilityLabel("\(model.displayName) · reasoning \(reasoningLabel(for: tier))")
          .accessibilityAddTraits(isActiveTier ? .isSelected : [])
        }
      }
    }
  }

  @ViewBuilder
  private var fastModeToggle: some View {
    Toggle(isOn: Binding(
      get: { selectedCodexFastMode },
      set: { onToggleFastMode($0) }
    )) {
      HStack(spacing: 7) {
        Image(systemName: "bolt.fill")
          .font(.caption.weight(.bold))
          .foregroundStyle(selectedCodexFastMode ? ADEColor.warning : ADEColor.textMuted)
        Text("Fast mode")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(selectedCodexFastMode ? "On" : "Off")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .toggleStyle(.switch)
    .tint(ADEColor.warning)
    .disabled(isBusy || !model.isAvailable)
    .accessibilityLabel("Fast mode \(selectedCodexFastMode ? "on" : "off")")
  }

  private func reasoningLabel(for tier: String) -> String {
    switch tier.lowercased() {
    case "xhigh": return "XHigh"
    case "max": return "Max"
    case "ultracode": return "Ultracode"
    default: return tier.capitalized
    }
  }
}

struct ModelPickerCurrentModelBar: View {
  let model: WorkModelOption?
  let provider: String
  let reasoningEffort: String
  let fastModeEnabled: Bool

  private var logoProvider: String {
    model?.provider ?? provider
  }

  private var reasoningLabel: String {
    workReasoningChipLabel(reasoningEffort) ?? "Default"
  }

  var body: some View {
    HStack(spacing: 9) {
      WorkProviderBareLogo(
        provider: logoProvider,
        fallbackSymbol: providerIcon(logoProvider),
        tint: providerTint(logoProvider),
        size: 18
      )

      VStack(alignment: .leading, spacing: 2) {
        Text("Current model")
          .font(.caption2.weight(.bold))
          .tracking(0.4)
          .foregroundStyle(ADEColor.textMuted)
        Text(model?.displayName ?? "Pick a model")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
      }

      Spacer(minLength: 6)

      HStack(spacing: 6) {
        Text(reasoningLabel)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)

        HStack(spacing: 3) {
          Image(systemName: "bolt.fill")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(fastModeEnabled ? ADEColor.warning : ADEColor.textMuted)
          Text(fastModeStatusLabel)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(fastModeEnabled ? ADEColor.warning : ADEColor.textMuted)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(ADEColor.surfaceBackground.opacity(0.46), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.5)
      )
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Current model \(model?.displayName ?? "none"), reasoning \(reasoningLabel), \(fastModeAccessibilityLabel)")
  }

  private var fastModeStatusLabel: String {
    if fastModeEnabled { return "Fast on" }
    if model?.supportsCodexFastMode == true { return "Fast off" }
    return "No fast"
  }

  private var fastModeAccessibilityLabel: String {
    if fastModeEnabled { return "fast mode on" }
    if model?.supportsCodexFastMode == true { return "fast mode off" }
    return "fast mode unavailable"
  }
}

// MARK: - Store

/// Owns the favorites/recents lists for the picker UI. Optimistic local
/// updates fire immediately so taps feel instant; the RPC sync runs in the
/// background and reconciles when the server responds. Failures roll back to
/// the last known-good list rather than letting the UI diverge silently.
@MainActor
final class ModelPickerStore: ObservableObject {
  @Published private(set) var favorites: [String] = []
  @Published private(set) var recents: [String] = []
  @Published private(set) var isLoading: Bool = false

  private var hasLoaded = false

  func load(syncService: SyncService) {
    guard !hasLoaded else { return }
    hasLoaded = true
    isLoading = true
    Task { @MainActor [weak self] in
      await self?.refresh(syncService: syncService)
    }
  }

  func refresh(syncService: SyncService) async {
    async let favTask = try? await syncService.getModelFavorites()
    async let recTask = try? await syncService.getModelRecents()
    let fav = await favTask
    let rec = await recTask
    if let fav { favorites = fav }
    if let rec { recents = rec }
    isLoading = false
  }

  func toggleFavorite(_ modelId: String, syncService: SyncService) {
    let previous = favorites
    if favorites.contains(modelId) {
      favorites.removeAll { $0 == modelId }
    } else {
      favorites = [modelId] + favorites.filter { $0 != modelId }
    }
    Task { @MainActor [weak self] in
      do {
        let result = try await syncService.toggleModelFavorite(modelId)
        self?.favorites = result.favorites
      } catch {
        self?.favorites = previous
      }
    }
  }

  func pushRecent(_ modelId: String, syncService: SyncService) {
    let trimmed = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    let previous = recents
    // Optimistic update: dedupe + cap at server's MAX_RECENTS (10) so the UI
    // doesn't briefly flash an over-long list before the server response
    // settles.
    var next = recents.filter { $0 != trimmed }
    next.insert(trimmed, at: 0)
    if next.count > 10 { next = Array(next.prefix(10)) }
    recents = next
    Task { @MainActor [weak self] in
      do {
        let updated = try await syncService.pushModelRecent(trimmed)
        self?.recents = updated
      } catch {
        self?.recents = previous
      }
    }
  }
}
