import Foundation
import SwiftUI

/// A single model entry that can be displayed in the mobile model picker.
/// Mirrors a subset of the desktop `ModelDescriptor` — the mobile picker
/// doesn't need pricing/tier/reasoning metadata yet, just enough to render a
/// branded row (logo + display name + tier hint) and send a `modelId` to
/// `SyncService.updateChatSession`.
struct WorkModelOption: Identifiable, Hashable {
  /// Stable sync-contract id the host accepts (e.g. "claude-opus-4-6").
  let id: String
  let displayName: String
  let tier: Tier
  /// Short one-line pitch — "Fastest · cheapest" / "Best for deep reasoning".
  let tagline: String
  /// Provider family key that maps to a `providerAssetName` logo + tint.
  let provider: String

  enum Tier: String { case fast, balanced, flagship, reasoning }
}

/// One provider section in the picker with its display name + branded mark +
/// the models the user can currently pick. The picker groups by this.
struct WorkModelProviderGroup: Identifiable, Hashable {
  var id: String { provider }
  let provider: String
  let displayName: String
  let models: [WorkModelOption]
}

/// Curated mobile catalog. Intentionally short: phone users don't need the
/// full desktop `@lobehub/icons` matrix of 40+ models. Covers the providers
/// ADE ships with a mobile-branded logo (Claude / Codex / Cursor / OpenCode).
/// The `currentModelId` + `currentProvider` hints make sure an arbitrary host
/// model (e.g. a freshly released id we haven't added here) still shows up in
/// the list as the selected entry instead of silently disappearing.
func workModelCatalog(currentModelId: String, currentProvider: String) -> [WorkModelProviderGroup] {
  var catalog: [WorkModelProviderGroup] = []

  catalog.append(WorkModelProviderGroup(
    provider: "claude",
    displayName: "Claude",
    models: [
      WorkModelOption(id: "claude-opus-4-6", displayName: "Opus 4.6", tier: .flagship, tagline: "Flagship · best for complex reasoning", provider: "claude"),
      WorkModelOption(id: "claude-sonnet-4-6", displayName: "Sonnet 4.6", tier: .balanced, tagline: "Balanced · great default for coding", provider: "claude"),
      WorkModelOption(id: "claude-haiku-4-5", displayName: "Haiku 4.5", tier: .fast, tagline: "Fastest · cheapest", provider: "claude"),
    ]
  ))

  catalog.append(WorkModelProviderGroup(
    provider: "codex",
    displayName: "Codex",
    models: [
      WorkModelOption(id: "gpt-5", displayName: "GPT-5", tier: .flagship, tagline: "Flagship reasoning", provider: "codex"),
      WorkModelOption(id: "gpt-5-codex", displayName: "GPT-5 Codex", tier: .balanced, tagline: "Tuned for code edits", provider: "codex"),
      WorkModelOption(id: "gpt-4.1", displayName: "GPT-4.1", tier: .fast, tagline: "Fast general-purpose", provider: "codex"),
    ]
  ))

  catalog.append(WorkModelProviderGroup(
    provider: "cursor",
    displayName: "Cursor",
    models: [
      WorkModelOption(id: "auto", displayName: "Auto", tier: .balanced, tagline: "Cursor picks per turn", provider: "cursor"),
      WorkModelOption(id: "claude-4.6-sonnet-thinking", displayName: "Sonnet 4.6 · Thinking", tier: .reasoning, tagline: "Extended reasoning", provider: "cursor"),
      WorkModelOption(id: "gpt-5", displayName: "GPT-5", tier: .flagship, tagline: "Flagship reasoning", provider: "cursor"),
    ]
  ))

  catalog.append(WorkModelProviderGroup(
    provider: "opencode",
    displayName: "OpenCode",
    models: [
      WorkModelOption(id: "opencode-default", displayName: "OpenCode", tier: .balanced, tagline: "Local OpenCode runtime", provider: "opencode"),
    ]
  ))

  // Ensure the currently-selected model always surfaces even if the host picked
  // one outside the curated list — fold it into the matching provider group or
  // surface an "Other" bucket.
  if currentModelId.isEmpty == false {
    let alreadyPresent = catalog.contains { group in
      group.models.contains { $0.id == currentModelId }
    }
    if !alreadyPresent {
      let providerKey = currentProvider.lowercased().isEmpty ? "other" : currentProvider.lowercased()
      let injected = WorkModelOption(
        id: currentModelId,
        displayName: currentModelId,
        tier: .balanced,
        tagline: "In use on the paired host",
        provider: providerKey
      )
      if let index = catalog.firstIndex(where: { $0.provider == providerKey }) {
        let existing = catalog[index]
        catalog[index] = WorkModelProviderGroup(
          provider: existing.provider,
          displayName: existing.displayName,
          models: [injected] + existing.models
        )
      } else {
        catalog.append(WorkModelProviderGroup(
          provider: providerKey,
          displayName: currentProvider.isEmpty ? "Other" : providerLabel(currentProvider),
          models: [injected]
        ))
      }
    }
  }

  return catalog
}

func workModelTierLabel(_ tier: WorkModelOption.Tier) -> String {
  switch tier {
  case .fast: return "FAST"
  case .balanced: return "BALANCED"
  case .flagship: return "FLAGSHIP"
  case .reasoning: return "REASONING"
  }
}

func workModelTierTint(_ tier: WorkModelOption.Tier) -> Color {
  switch tier {
  case .fast: return ADEColor.success
  case .balanced: return ADEColor.accent
  case .flagship: return ADEColor.warning
  case .reasoning: return ADEColor.purpleAccent
  }
}
