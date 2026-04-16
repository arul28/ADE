import SwiftUI

/// Mobile model picker. Mirrors the desktop `ProviderModelSelector` shape on a
/// phone: "Select Model" title, a live search field, a provider tab strip
/// (CLAUDE / CODEX / CURSOR / OPENCODE) with count badges, and one compact
/// row per model with brand logo, name, tagline, tier chip, and a checkmark
/// on the active model. Users switch models in one tap — no detour through
/// any "session settings" screen.
struct WorkModelPickerSheet: View {
  @Environment(\.dismiss) private var dismiss

  let currentModelId: String
  let currentProvider: String
  let isBusy: Bool
  let onSelect: (WorkModelOption) -> Void

  @State private var activeProvider: String = ""
  @State private var searchText: String = ""

  private var catalog: [WorkModelProviderGroup] {
    workModelCatalog(currentModelId: currentModelId, currentProvider: currentProvider)
  }

  private var visibleGroup: WorkModelProviderGroup? {
    guard let index = catalog.firstIndex(where: { $0.provider == activeProvider }) else {
      return catalog.first
    }
    return catalog[index]
  }

  private var filteredModels: [WorkModelOption] {
    guard let group = visibleGroup else { return [] }
    let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if needle.isEmpty { return group.models }
    return group.models.filter {
      $0.displayName.lowercased().contains(needle) ||
      $0.id.lowercased().contains(needle) ||
      $0.tagline.lowercased().contains(needle)
    }
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        searchBar
        providerTabStrip
        Divider()
          .overlay(ADEColor.border.opacity(0.18))
        modelList
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
      if activeProvider.isEmpty {
        let lower = currentProvider.lowercased()
        activeProvider = catalog.first(where: { $0.provider == lower })?.provider
          ?? catalog.first?.provider
          ?? ""
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
  private var providerTabStrip: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(catalog) { group in
          tabButton(for: group)
        }
      }
      .padding(.horizontal, 16)
      .padding(.bottom, 10)
    }
  }

  @ViewBuilder
  private func tabButton(for group: WorkModelProviderGroup) -> some View {
    let isActive = activeProvider == group.provider
    Button {
      withAnimation(.easeInOut(duration: 0.18)) {
        activeProvider = group.provider
      }
    } label: {
      HStack(spacing: 6) {
        Text(group.displayName.uppercased())
          .font(.caption.weight(.bold))
          .tracking(0.4)
        if group.models.count > 1 {
          Text("\(group.models.count)")
            .font(.caption2.weight(.bold))
            .foregroundStyle(isActive ? ADEColor.accent : ADEColor.textMuted)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background((isActive ? ADEColor.accent : ADEColor.textMuted).opacity(0.18), in: Capsule())
        }
      }
      .foregroundStyle(isActive ? ADEColor.textPrimary : ADEColor.textSecondary)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(
        Capsule(style: .continuous)
          .fill(isActive ? ADEColor.accent.opacity(0.18) : Color.clear)
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(isActive ? ADEColor.accent.opacity(0.38) : ADEColor.border.opacity(0.18), lineWidth: 0.6)
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
          ForEach(filteredModels) { model in
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
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
    }
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
