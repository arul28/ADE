import SwiftUI

/// Mobile model picker. Presented as a bottom sheet from the composer when the
/// user taps the model chip. Mirrors the desktop `ProviderModelSelector`'s
/// mobile-variant shape (grouped list by provider with branded logos) rather
/// than the full `ModelCatalogPanel` grid — phone users aren't reviewing
/// pricing tables, they just want to switch model with one tap.
struct WorkModelPickerSheet: View {
  @Environment(\.dismiss) private var dismiss

  let currentModelId: String
  let currentProvider: String
  let isBusy: Bool
  /// Called when the user commits a selection. Receives the canonical sync
  /// `modelId` and the picked option's provider so the caller can pair them
  /// with the right `updateChatSession` call.
  let onSelect: (WorkModelOption) -> Void
  let onOpenSettings: (() -> Void)?

  private var catalog: [WorkModelProviderGroup] {
    workModelCatalog(currentModelId: currentModelId, currentProvider: currentProvider)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          header
          ForEach(catalog) { group in
            groupSection(group)
          }
          if let onOpenSettings {
            Button {
              onOpenSettings()
              dismiss()
            } label: {
              Label("More in session settings", systemImage: "slider.horizontal.3")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ADEColor.accent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(ADEColor.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                  RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(ADEColor.accent.opacity(0.32), lineWidth: 0.5)
                )
            }
            .buttonStyle(.plain)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .adeScreenBackground()
      .navigationTitle("Model")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }
            .fontWeight(.semibold)
        }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }

  @ViewBuilder
  private var header: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Switch the model this chat resumes with.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
      if isBusy {
        HStack(spacing: 6) {
          ProgressView().controlSize(.mini)
          Text("Applying…")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
        }
      }
    }
  }

  @ViewBuilder
  private func groupSection(_ group: WorkModelProviderGroup) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        WorkProviderLogo(provider: group.provider, size: 22)
        Text(group.displayName)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
      }

      VStack(spacing: 0) {
        ForEach(Array(group.models.enumerated()), id: \.element.id) { index, model in
          Button {
            guard model.id != currentModelId else {
              dismiss()
              return
            }
            onSelect(model)
          } label: {
            row(for: model, isFirst: index == 0, isLast: index == group.models.count - 1)
          }
          .buttonStyle(.plain)
          .disabled(isBusy && model.id != currentModelId)
        }
      }
      .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(ADEColor.border.opacity(0.15), lineWidth: 0.5)
      )
    }
  }

  @ViewBuilder
  private func row(for model: WorkModelOption, isFirst: Bool, isLast: Bool) -> some View {
    let isSelected = model.id == currentModelId
    HStack(alignment: .center, spacing: 10) {
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(model.displayName)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(workModelTierLabel(model.tier))
            .font(.caption2.monospaced().weight(.bold))
            .tracking(0.4)
            .foregroundStyle(workModelTierTint(model.tier))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(workModelTierTint(model.tier).opacity(0.12), in: Capsule())
        }
        Text(model.tagline)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(isSelected ? ADEColor.accent : ADEColor.textMuted.opacity(0.5))
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .contentShape(Rectangle())
    .overlay(alignment: .bottom) {
      if !isLast {
        Rectangle()
          .fill(ADEColor.border.opacity(0.12))
          .frame(height: 0.5)
          .padding(.leading, 14)
      }
    }
    .accessibilityLabel("\(model.displayName), \(workModelTierLabel(model.tier)). \(model.tagline)\(isSelected ? ". Currently selected." : "")")
  }
}
