import SwiftUI

/// Mobile model picker — desktop-shaped 2-level organization. Mirrors
/// `apps/desktop/src/renderer/components/shared/ModelCatalogPanel.tsx`:
/// "Select Model" header with search, CLAUDE / CODEX / CURSOR / OPENCODE
/// group tab strip, provider badge row for the active group (Anthropic for
/// Claude, or Anthropic/OpenAI/Google/… for OpenCode), then the models in
/// the selected provider.
struct WorkModelPickerSheet: View {
  @Environment(\.dismiss) private var dismiss

  let currentModelId: String
  let currentProvider: String
  let isBusy: Bool
  let onSelect: (WorkModelOption) -> Void

  @State private var activeGroup: String = ""
  @State private var activeProvider: String = ""
  @State private var searchText: String = ""

  private var catalog: [WorkModelCatalogGroup] {
    workModelCatalogGroups(currentModelId: currentModelId, currentProvider: currentProvider)
  }

  private var isSearching: Bool {
    !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var activeGroupBlock: WorkModelCatalogGroup? {
    catalog.first(where: { $0.key == activeGroup }) ?? catalog.first
  }

  private var activeProviderBlock: WorkModelProvider? {
    guard let block = activeGroupBlock else { return nil }
    return block.providers.first(where: { $0.key == activeProvider }) ?? block.providers.first
  }

  private var filteredModels: [WorkModelOption] {
    guard let provider = activeProviderBlock else { return [] }
    let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !needle.isEmpty else { return provider.models }
    return provider.models.filter {
      $0.displayName.lowercased().contains(needle) ||
      $0.id.lowercased().contains(needle) ||
      $0.tagline.lowercased().contains(needle)
    }
  }

  /// Flat search result — when a query is active we ignore group/provider
  /// tabs and show every matching model, grouped by group header like the
  /// desktop search mode.
  private var searchTree: [WorkModelCatalogGroup] {
    let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !needle.isEmpty else { return [] }
    return catalog.compactMap { group in
      let filteredProviders = group.providers.compactMap { provider -> WorkModelProvider? in
        let matches = provider.models.filter {
          $0.displayName.lowercased().contains(needle) ||
          $0.id.lowercased().contains(needle) ||
          $0.tagline.lowercased().contains(needle)
        }
        return matches.isEmpty ? nil : WorkModelProvider(
          key: provider.key,
          displayName: provider.displayName,
          models: matches
        )
      }
      return filteredProviders.isEmpty ? nil : WorkModelCatalogGroup(
        key: group.key,
        displayName: group.displayName,
        providers: filteredProviders
      )
    }
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        searchBar
        if isSearching {
          searchList
        } else {
          groupTabStrip
          providerBadgeRow
          Divider().overlay(ADEColor.border.opacity(0.18))
          modelList
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
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .onAppear {
      if activeGroup.isEmpty {
        let lower = currentProvider.lowercased()
        activeGroup = catalog.first(where: { $0.key == lower })?.key
          ?? catalog.first?.key
          ?? ""
      }
      if activeProvider.isEmpty, let block = activeGroupBlock {
        activeProvider = block.providers.first?.key ?? ""
      }
    }
    .onChange(of: activeGroup) { _, newKey in
      if let first = catalog.first(where: { $0.key == newKey })?.providers.first?.key {
        activeProvider = first
      }
    }
  }

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
        .stroke(ADEColor.border.opacity(0.2), lineWidth: 0.5)
    )
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .padding(.bottom, 10)
  }

  @ViewBuilder
  private var groupTabStrip: some View {
    HStack(spacing: 4) {
      ForEach(catalog) { group in
        groupTabButton(for: group)
      }
    }
    .padding(.horizontal, 4)
    .padding(.vertical, 4)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(ADEColor.surfaceBackground.opacity(0.3))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.border.opacity(0.12), lineWidth: 0.5)
    )
    .padding(.horizontal, 16)
    .padding(.bottom, 10)
  }

  @ViewBuilder
  private func groupTabButton(for group: WorkModelCatalogGroup) -> some View {
    let isActive = (activeGroupBlock?.key ?? "") == group.key
    Button {
      withAnimation(.easeInOut(duration: 0.18)) {
        activeGroup = group.key
      }
    } label: {
      HStack(spacing: 4) {
        Text(group.displayName.uppercased())
          .font(.caption2.weight(.bold))
          .tracking(0.4)
        if group.key == "opencode" && group.modelCount > 0 {
          Text("(\(group.modelCount))")
            .font(.system(size: 9, weight: .bold))
            .opacity(0.6)
        }
      }
      .foregroundStyle(isActive ? ADEColor.textPrimary : ADEColor.textSecondary.opacity(0.6))
      .frame(maxWidth: .infinity)
      .padding(.vertical, 7)
      .background(
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .fill(isActive ? ADEColor.accent.opacity(0.18) : Color.clear)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .stroke(isActive ? ADEColor.accent.opacity(0.35) : Color.clear, lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(isActive ? .isSelected : [])
  }

  @ViewBuilder
  private var providerBadgeRow: some View {
    if let block = activeGroupBlock, block.providers.count > 1 || block.key == "opencode" {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(block.providers) { prov in
            providerBadge(prov)
          }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
      }
    } else if let block = activeGroupBlock, let only = block.providers.first {
      HStack(spacing: 8) {
        providerBadge(only)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 16)
      .padding(.bottom, 10)
    }
  }

  @ViewBuilder
  private func providerBadge(_ prov: WorkModelProvider) -> some View {
    let isActive = activeProviderBlock?.key == prov.key
    Button {
      activeProvider = prov.key
    } label: {
      HStack(spacing: 6) {
        WorkProviderLogo(provider: prov.key, size: 16)
        Text(prov.displayName)
          .font(.caption.weight(.semibold))
          .foregroundStyle(isActive ? ADEColor.textPrimary : ADEColor.textSecondary)
        if prov.models.count > 1 {
          Text("\(prov.models.count)")
            .font(.caption2.weight(.bold))
            .foregroundStyle(isActive ? ADEColor.accent : ADEColor.textMuted)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background((isActive ? ADEColor.accent : ADEColor.textMuted).opacity(0.18), in: Capsule())
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(
        Capsule(style: .continuous)
          .fill(isActive ? ADEColor.accent.opacity(0.14) : ADEColor.surfaceBackground.opacity(0.5))
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(isActive ? ADEColor.accent.opacity(0.32) : ADEColor.border.opacity(0.18), lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(isActive ? .isSelected : [])
  }

  @ViewBuilder
  private var modelList: some View {
    ScrollView {
      LazyVStack(spacing: 10) {
        if filteredModels.isEmpty {
          emptyState
        } else {
          ForEach(filteredModels) { model in
            modelButton(model: model)
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
    }
  }

  @ViewBuilder
  private var searchList: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        if searchTree.isEmpty {
          VStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
              .font(.title3)
              .foregroundStyle(ADEColor.textMuted)
            Text("No models match \"\(searchText)\".")
              .font(.footnote)
              .foregroundStyle(ADEColor.textSecondary)
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 40)
        } else {
          ForEach(searchTree) { group in
            VStack(alignment: .leading, spacing: 8) {
              Text(group.displayName.uppercased())
                .font(.caption2.weight(.bold))
                .tracking(0.4)
                .foregroundStyle(ADEColor.textMuted)
                .padding(.horizontal, 6)
              ForEach(group.providers) { prov in
                VStack(alignment: .leading, spacing: 6) {
                  if group.providers.count > 1 {
                    HStack(spacing: 6) {
                      WorkProviderLogo(provider: prov.key, size: 14)
                      Text(prov.displayName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(ADEColor.textSecondary)
                    }
                    .padding(.horizontal, 6)
                  }
                  ForEach(prov.models) { model in
                    modelButton(model: model)
                  }
                }
              }
            }
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 10)
      .padding(.bottom, 12)
    }
  }

  @ViewBuilder
  private var emptyState: some View {
    VStack(spacing: 6) {
      Image(systemName: "cpu")
        .font(.title3)
        .foregroundStyle(ADEColor.textMuted)
      Text("No models in this provider.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 40)
  }

  @ViewBuilder
  private func modelButton(model: WorkModelOption) -> some View {
    Button {
      if model.id == currentModelId {
        dismiss()
      } else {
        onSelect(model)
      }
    } label: {
      modelRow(model: model)
    }
    .buttonStyle(.plain)
    .disabled(isBusy && model.id != currentModelId)
  }

  @ViewBuilder
  private func modelRow(model: WorkModelOption) -> some View {
    let isSelected = model.id == currentModelId
    HStack(alignment: .center, spacing: 12) {
      WorkProviderLogo(provider: model.provider, size: 30)

      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(model.displayName)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if isSelected {
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
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
      }

      Spacer(minLength: 8)

      if isSelected {
        Image(systemName: "checkmark")
          .font(.subheadline.weight(.bold))
          .foregroundStyle(ADEColor.accent)
      } else {
        HStack(spacing: 5) {
          Circle()
            .fill(ADEColor.success)
            .frame(width: 6, height: 6)
          Text("Ready")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.success)
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(isSelected ? ADEColor.accent.opacity(0.08) : ADEColor.surfaceBackground.opacity(0.55))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(isSelected ? ADEColor.accent.opacity(0.35) : ADEColor.border.opacity(0.14), lineWidth: isSelected ? 1 : 0.5)
    )
    .contentShape(Rectangle())
    .accessibilityLabel("\(model.displayName), \(workModelTierLabel(model.tier)). \(model.tagline)\(isSelected ? ". Currently selected." : "")")
  }
}
