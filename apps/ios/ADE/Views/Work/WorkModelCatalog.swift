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

/// Curated mobile catalog mirroring `apps/desktop/src/shared/modelRegistry.ts`.
/// Ids use the canonical short sync-contract form the host accepts — e.g.
/// `opus` / `sonnet` / `haiku` for Claude, full `gpt-5.3-codex` strings for
/// Codex, OpenCode-routed `<provider>/<model>` pairs for the OpenCode tab.
/// The `currentModelId` + `currentProvider` hints make sure an arbitrary host
/// model (e.g. a freshly released id we haven't added here) still shows up in
/// the list as the selected entry instead of silently disappearing.
func workModelCatalog(currentModelId: String, currentProvider: String) -> [WorkModelProviderGroup] {
  var catalog: [WorkModelProviderGroup] = []

  catalog.append(WorkModelProviderGroup(
    provider: "claude",
    displayName: "Claude",
    models: [
      WorkModelOption(id: "claude-opus-4-6", displayName: "Claude Opus 4.6", tier: .flagship, tagline: "Flagship · best for complex reasoning", provider: "claude"),
      WorkModelOption(id: "claude-opus-4-6-1m", displayName: "Claude Opus 4.6 1M", tier: .flagship, tagline: "1M-token context window", provider: "claude"),
      WorkModelOption(id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", tier: .balanced, tagline: "Balanced · great default for coding", provider: "claude"),
      WorkModelOption(id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", tier: .fast, tagline: "Fastest · cheapest", provider: "claude"),
    ]
  ))

  catalog.append(WorkModelProviderGroup(
    provider: "codex",
    displayName: "Codex",
    models: [
      WorkModelOption(id: "gpt-5.4-codex", displayName: "GPT-5.4", tier: .flagship, tagline: "Flagship · 400K context", provider: "codex"),
      WorkModelOption(id: "gpt-5.4-mini-codex", displayName: "GPT-5.4-Mini", tier: .fast, tagline: "Cheaper 1M-context variant", provider: "codex"),
      WorkModelOption(id: "gpt-5.3-codex", displayName: "GPT-5.3-Codex", tier: .balanced, tagline: "Tuned for code edits", provider: "codex"),
      WorkModelOption(id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", tier: .balanced, tagline: "Faster Codex variant", provider: "codex"),
      WorkModelOption(id: "gpt-5.2-codex", displayName: "GPT-5.2-Codex", tier: .balanced, tagline: "Prior-gen Codex", provider: "codex"),
      WorkModelOption(id: "gpt-5.1-codex-max", displayName: "GPT-5.1-Codex-Max", tier: .flagship, tagline: "Long-running Codex turns", provider: "codex"),
      WorkModelOption(id: "gpt-5.1-codex-mini", displayName: "GPT-5.1-Codex-Mini", tier: .fast, tagline: "Lowest-cost Codex", provider: "codex"),
    ]
  ))

  catalog.append(WorkModelProviderGroup(
    provider: "cursor",
    displayName: "Cursor",
    models: [
      WorkModelOption(id: "auto", displayName: "Auto", tier: .balanced, tagline: "Cursor picks per turn", provider: "cursor"),
      WorkModelOption(id: "claude-4.6-sonnet-thinking", displayName: "Sonnet 4.6 · Thinking", tier: .reasoning, tagline: "Extended reasoning", provider: "cursor"),
      WorkModelOption(id: "claude-4.6-sonnet", displayName: "Sonnet 4.6", tier: .balanced, tagline: "Fast coding default", provider: "cursor"),
      WorkModelOption(id: "gpt-5", displayName: "GPT-5", tier: .flagship, tagline: "Flagship reasoning", provider: "cursor"),
      WorkModelOption(id: "gpt-5-codex", displayName: "GPT-5 Codex", tier: .balanced, tagline: "Cursor-routed Codex", provider: "cursor"),
    ]
  ))

  // OpenCode routes any upstream model through the OpenCode server using a
  // `<providerId>/<modelId>` id. Mirror the most-common picks from desktop;
  // the "Other" injection below still covers freshly added picks.
  catalog.append(WorkModelProviderGroup(
    provider: "opencode",
    displayName: "OpenCode",
    models: [
      WorkModelOption(id: "opencode/anthropic/claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", tier: .balanced, tagline: "Anthropic via OpenCode", provider: "opencode"),
      WorkModelOption(id: "opencode/anthropic/claude-opus-4-6", displayName: "Claude Opus 4.6", tier: .flagship, tagline: "Anthropic flagship via OpenCode", provider: "opencode"),
      WorkModelOption(id: "opencode/anthropic/claude-haiku-4-5", displayName: "Claude Haiku 4.5", tier: .fast, tagline: "Anthropic fast via OpenCode", provider: "opencode"),
      WorkModelOption(id: "opencode/openai/gpt-5.4", displayName: "GPT-5.4", tier: .flagship, tagline: "OpenAI flagship via OpenCode", provider: "opencode"),
      WorkModelOption(id: "opencode/openai/gpt-5.3-codex", displayName: "GPT-5.3-Codex", tier: .balanced, tagline: "Codex via OpenCode", provider: "opencode"),
      WorkModelOption(id: "opencode/google/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", tier: .fast, tagline: "Google fast via OpenCode", provider: "opencode"),
      WorkModelOption(id: "opencode/google/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", tier: .balanced, tagline: "Google balanced via OpenCode", provider: "opencode"),
      WorkModelOption(id: "opencode/xai/grok-code", displayName: "Grok Code", tier: .balanced, tagline: "xAI Grok coding", provider: "opencode"),
      WorkModelOption(id: "opencode/deepseek/deepseek-chat", displayName: "DeepSeek Chat", tier: .balanced, tagline: "DeepSeek via OpenCode", provider: "opencode"),
      WorkModelOption(id: "opencode/lmstudio/auto", displayName: "LM Studio · Auto", tier: .fast, tagline: "Local LM Studio runtime", provider: "opencode"),
      WorkModelOption(id: "opencode/ollama/auto", displayName: "Ollama · Auto", tier: .fast, tagline: "Local Ollama runtime", provider: "opencode"),
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
