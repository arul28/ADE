import SwiftUI

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
  let availableModelIds: [String]?
  let cursorAvailabilityMode: WorkCursorAvailabilityMode
  let isBusy: Bool
  let onSelect: (WorkModelOption, String?, String) -> Void

  init(
    currentModelId: String,
    currentProvider: String,
    currentReasoningEffort: String = "",
    availableModelIds: [String]? = nil,
    cursorAvailabilityMode: WorkCursorAvailabilityMode = .chat,
    isBusy: Bool,
    onSelect: @escaping (WorkModelOption, String?, String) -> Void
  ) {
    self.currentModelId = currentModelId
    self.currentProvider = currentProvider
    self.currentReasoningEffort = currentReasoningEffort
    self.availableModelIds = availableModelIds
    self.cursorAvailabilityMode = cursorAvailabilityMode
    self.isBusy = isBusy
    self.onSelect = onSelect
  }

  @StateObject private var picker = ModelPickerStore()
  @State private var selection: ModelPickerRailSelection = .favorites
	  @State private var searchText: String = ""
	  @State private var liveCatalog: [WorkModelCatalogGroup]?
	  @State private var isLoadingCatalog = false
	  @State private var didPickInitialSelection = false
	  @State private var selectedProviderTabKey: String?

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

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        searchBar
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
	              currentModelId: currentModelId,
              currentReasoningEffort: currentReasoningEffort,
              favorites: picker.favorites,
              isBusy: isBusy,
	              onSelect: { model, effort in commit(model: model, effort: effort) },
	              onSelectProviderTab: { selectedProviderTabKey = $0 },
              onToggleFavorite: { picker.toggleFavorite($0, syncService: syncService) }
            )
          }
        }
      }
      .adeScreenBackground()
      .navigationTitle("Select Model")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            dismiss()
          } label: {
            Image(systemName: "xmark")
              .font(.subheadline.weight(.semibold))
          }
          .accessibilityLabel("Close")
        }
      }
    }
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
    .onAppear {
      picker.load(syncService: syncService)
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
	      ?? providers.first(where: { provider in provider.models.contains(where: { workModelIdsEquivalent($0.id, currentModelId) }) })?.key
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
  private var searchBar: some View {
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
    .padding(.vertical, 9)
    .background(ADEColor.recessedBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    )
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .padding(.bottom, 10)
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

  // MARK: Behavior

	  @MainActor
	  private func loadLiveCatalog() async {
	    isLoadingCatalog = true
	    defer { isLoadingCatalog = false }

	    if liveCatalog == nil, let cached = syncService.cachedChatModelCatalog() {
      liveCatalog = workModelCatalogGroups(
        hostCatalog: cached,
        currentModelId: currentModelId,
        currentProvider: currentProvider
      )
	    }

	    do {
	      let hostCatalog = try await syncService.getChatModelCatalog(mode: "cached")
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
		      let hostCatalog = try await syncService.getChatModelCatalog(mode: "refresh-stale", refreshProvider: refreshProvider)
	      guard !Task.isCancelled else { return }
	      apply(hostCatalog: hostCatalog)
	      if hostCatalog.stale == true {
	        let freshCatalog = try await syncService.getChatModelCatalog(mode: "force", refreshProvider: refreshProvider)
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

	  private func commit(model: WorkModelOption, effort: String?) {
	    guard model.isAvailable else { return }
    let normalizedEffort = effort?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased() ?? ""
    let normalizedCurrentEffort = currentReasoningEffort
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    let nextEffort: String? = normalizedEffort.isEmpty ? nil : normalizedEffort
    let effortChanged = (nextEffort ?? "") != normalizedCurrentEffort
    let isNoOp = workModelIdsEquivalent(model.id, currentModelId) && !effortChanged

    if isNoOp {
      dismiss()
      return
    }

    picker.pushRecent(model.id, syncService: syncService)
    onSelect(model, nextEffort, runtimeProvider(for: model))
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
        ForEach(entries) { entry in
          VStack(spacing: 4) {
            railButton(entry)
            if case .recents = entry {
              Divider()
                .overlay(ADEColor.glassBorder)
                .frame(width: 28)
                .padding(.vertical, 4)
            }
          }
        }
      }
      .padding(.vertical, 8)
      .padding(.horizontal, 6)
    }
    .frame(width: 56)
    .background(ADEColor.recessedBackground.opacity(0.4))
  }

  @ViewBuilder
  private func railButton(_ entry: ModelPickerRailEntry) -> some View {
    let isActive = entry.selection == selected
    Button {
      onSelect(entry.selection)
    } label: {
      ZStack(alignment: .topTrailing) {
        railIcon(for: entry, isActive: isActive)
          .frame(width: 44, height: 44)
          .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(isActive ? ADEColor.accent.opacity(0.16) : Color.clear)
          )
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(isActive ? ADEColor.accent.opacity(0.35) : Color.clear, lineWidth: 0.8)
          )
        if let badge = badgeCount(for: entry), badge > 0 {
          Text("\(badge)")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(ADEColor.textPrimary)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(
              Capsule(style: .continuous)
                .fill(ADEColor.surfaceBackground)
            )
            .overlay(
              Capsule(style: .continuous)
                .stroke(ADEColor.glassBorder, lineWidth: 0.5)
            )
            .offset(x: 6, y: -4)
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
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(ADEColor.warning)
    case .recents:
      Image(systemName: isActive ? "clock.fill" : "clock")
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(isActive ? ADEColor.accent : ADEColor.textSecondary)
    case .providerGroup(let key, _):
      WorkProviderLogo(provider: providerKeyForLogo(key), size: 30)
    }
  }

  /// The rail rows show a per-family logo. For the curated "claude"/"codex"
  /// groups the brand asset key is the same as the group key, but the desktop
  /// catalog uses keys like "opencode" / "cursor" / "droid" which already
  /// resolve to brand assets via the existing `providerAssetName` map.
  private func providerKeyForLogo(_ key: String) -> String {
    key
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
  let currentModelId: String
  let currentReasoningEffort: String
  let favorites: [String]
  let isBusy: Bool
  let onSelect: (WorkModelOption, String?) -> Void
  let onSelectProviderTab: (String) -> Void
  let onToggleFavorite: (String) -> Void

  private var favoritesSet: Set<String> { Set(favorites) }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      providerTabStrip
      Divider().overlay(ADEColor.glassBorder)
      if groupedRows.allSatisfy({ $0.models.isEmpty }) {
        emptyState
      } else {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 14) {
            ForEach(groupedRows) { group in
              VStack(alignment: .leading, spacing: 6) {
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
                    isActive: workModelIdsEquivalent(model.id, currentModelId),
                    isFavorite: favoritesSet.contains(model.id),
                    isBusy: isBusy,
                    currentReasoningEffort: currentReasoningEffort,
                    onSelect: { effort in onSelect(model, effort) },
                    onToggleFavorite: { onToggleFavorite(model.id) }
                  )
                }
              }
            }
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 14)
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
        tab.models.contains { workModelIdsEquivalent($0.id, currentModelId) }
      })?.key
      ?? providerTabs.first(where: { tab in
        tab.models.contains(where: { $0.isAvailable })
      })?.key
      ?? providerTabs.first?.key
  }

  @ViewBuilder
  private var header: some View {
    HStack(alignment: .center, spacing: 8) {
      Image(systemName: headerSystemImage)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(headerTint)
      Text(headerTitle)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Spacer()
      if !models.isEmpty {
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
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
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

  private var headerSystemImage: String {
    if isSearching { return "magnifyingglass" }
    switch selection {
    case .favorites: return "star.fill"
    case .recents: return "clock.fill"
    case .providerGroup: return "cpu"
    }
  }

  private var headerTint: Color {
    if isSearching { return ADEColor.textSecondary }
    switch selection {
    case .favorites: return ADEColor.warning
    case .recents: return ADEColor.accent
    case .providerGroup: return ADEColor.textSecondary
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

struct ModelPickerListRow: View {
  let model: WorkModelOption
  let isActive: Bool
  let isFavorite: Bool
  let isBusy: Bool
  let currentReasoningEffort: String
  let onSelect: (String?) -> Void
  let onToggleFavorite: () -> Void

  private var supportedTiers: [String] {
    var seen = Set<String>()
    return model.reasoningEfforts.compactMap { effort in
      let tier = effort.effort.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      guard !tier.isEmpty, seen.insert(tier).inserted else { return nil }
      return tier
    }
  }

  private var rowSelectionEffort: String? {
    guard !supportedTiers.isEmpty else { return nil }
    let normalizedCurrent = currentReasoningEffort
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    if supportedTiers.contains(normalizedCurrent) {
      return normalizedCurrent
    }
    return supportedTiers.first(where: { $0 == "medium" })
      ?? supportedTiers.first(where: { $0 == "low" })
      ?? supportedTiers.first
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
	      Button {
	        onSelect(rowSelectionEffort)
      } label: {
        headerRow
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
	      }
	      .buttonStyle(.plain)
	      .disabled(isBusy || !model.isAvailable)

      if !supportedTiers.isEmpty {
        reasoningPills(tiers: supportedTiers)
          .padding(.top, 8)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
	        .fill(isActive ? ADEColor.accent.opacity(0.08) : ADEColor.surfaceBackground.opacity(model.isAvailable ? 0.55 : 0.32))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(isActive ? ADEColor.accent.opacity(0.35) : ADEColor.glassBorder, lineWidth: isActive ? 1 : 0.5)
    )
    .contentShape(Rectangle())
  }

  @ViewBuilder
  private var headerRow: some View {
    HStack(alignment: .center, spacing: 10) {
      WorkProviderLogo(provider: model.provider, size: 28)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
	          Text(model.displayName)
	            .font(.subheadline.weight(.semibold))
	            .foregroundStyle(model.isAvailable ? ADEColor.textPrimary : ADEColor.textMuted)
            .lineLimit(1)
          if isActive {
            Text("active")
              .font(.caption2.weight(.bold))
              .tracking(0.3)
              .foregroundStyle(ADEColor.accent)
              .padding(.horizontal, 6)
              .padding(.vertical, 2)
              .background(ADEColor.accent.opacity(0.15), in: Capsule())
          }
        }
        HStack(spacing: 6) {
          Text(workModelTierLabel(model.tier))
            .font(.caption2.monospaced().weight(.bold))
            .tracking(0.3)
            .foregroundStyle(workModelTierTint(model.tier))
          Text("·")
            .foregroundStyle(ADEColor.textMuted)
	          Text(model.tagline)
	            .font(.caption)
	            .foregroundStyle(model.isAvailable ? ADEColor.textSecondary : ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 8)
      favoriteButton
      if isActive {
        Image(systemName: "checkmark")
          .font(.subheadline.weight(.bold))
          .foregroundStyle(ADEColor.accent)
      }
    }
    .accessibilityLabel("\(model.displayName), \(workModelTierLabel(model.tier)). \(model.tagline)\(isActive ? ". Currently selected." : "")")
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
    let normalizedCurrent = currentReasoningEffort
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    HStack(spacing: 6) {
      Text("REASONING")
        .font(.system(size: 9, weight: .bold))
        .tracking(0.4)
        .foregroundStyle(ADEColor.textMuted)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 5) {
          ForEach(tiers, id: \.self) { tier in
            let normalized = tier.lowercased()
            let isActiveTier = isActive && normalized == normalizedCurrent
            Button {
              onSelect(normalized)
            } label: {
              Text(reasoningLabel(for: tier))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(isActiveTier ? Color.white : ADEColor.textSecondary)
                .lineLimit(1)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(
                  Capsule(style: .continuous)
                    .fill(isActiveTier ? ADEColor.accent : ADEColor.surfaceBackground.opacity(0.6))
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
      Spacer(minLength: 0)
    }
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
