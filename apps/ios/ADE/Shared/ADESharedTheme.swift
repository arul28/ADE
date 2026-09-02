import SwiftUI

/// Minimal theme subset needed by widgets. Extensions cannot import
/// main-app sources directly, so the
/// provider brand map is duplicated here and must be kept in sync with
/// `ADEDesignSystem.swift:brandClaude..brandGroq` and `providerBrand(for:)`.
public enum ADESharedTheme {
    // MARK: - Brand colors (mirror of ADEDesignSystem)
    public static let brandClaude   = Color(red: 0xD9 / 255.0, green: 0x77 / 255.0, blue: 0x06 / 255.0) // #D97706
    public static let brandCodex    = Color(red: 0x10 / 255.0, green: 0xA3 / 255.0, blue: 0x7F / 255.0) // #10A37F
    public static let brandPi       = Color(red: 0xF9 / 255.0, green: 0x73 / 255.0, blue: 0x16 / 255.0) // #F97316
    public static let brandCursor   = Color(red: 0xA7 / 255.0, green: 0x8B / 255.0, blue: 0xFA / 255.0) // #A78BFA
    public static let brandOpenCode = Color(red: 0x25 / 255.0, green: 0x63 / 255.0, blue: 0xEB / 255.0) // #2563EB
    public static let brandGoogle   = Color(red: 0xF5 / 255.0, green: 0x9E / 255.0, blue: 0x0B / 255.0) // #F59E0B
    public static let brandMistral  = Color(red: 0xF9 / 255.0, green: 0x73 / 255.0, blue: 0x16 / 255.0) // #F97316
    public static let brandDeepSeek = Color(red: 0x3B / 255.0, green: 0x82 / 255.0, blue: 0xF6 / 255.0) // #3B82F6
    public static let brandXAI      = Color(red: 0xDC / 255.0, green: 0x26 / 255.0, blue: 0x26 / 255.0) // #DC2626
    public static let brandGroq     = Color(red: 0x06 / 255.0, green: 0xB6 / 255.0, blue: 0xD4 / 255.0) // #06B6D4
    public static let brandCTO      = Color(red: 0xC4 / 255.0, green: 0xB5 / 255.0, blue: 0xFD / 255.0) // #C4B5FD
    // ACP providers. Hexes mirror PROVIDER_GROUP_COLORS in the desktop's
    // `shared/modelCatalog.ts`; Grok reuses brandXAI, which already carries
    // that vendor's #DC2626.
    public static let brandQwen     = Color(red: 0x6D / 255.0, green: 0x4A / 255.0, blue: 0xFF / 255.0) // #6D4AFF
    public static let brandKimi     = Color(red: 0x1F / 255.0, green: 0x1F / 255.0, blue: 0x1F / 255.0) // #1F1F1F
    public static let brandCopilot  = Color(red: 0x8B / 255.0, green: 0x5C / 255.0, blue: 0xF6 / 255.0) // #8B5CF6

    /// Neutral fallback when the provider slug is unknown. Keeps parity with
    /// `ADEColor.purpleAccent` in the main design system.
    public static let neutralAccent = Color(red: 0x8B / 255.0, green: 0x5C / 255.0, blue: 0xF6 / 255.0)

    /// Collapses a wire provider string to the family the three tables below
    /// are keyed by.
    ///
    /// The tables used to match the lowercased slug EXACTLY, which quietly
    /// assumed the wire only ever sends canonical slugs. It does not. A run
    /// whose provider is derived from its tool type is published through
    /// `providerDisplayName` in `apps/ade-cli/src/services/push/`
    /// (`attentionItemBuilder.ts` capitalises the first letter of anything it
    /// does not know; `pushPublisherService.ts` falls back to `"CLI"`), so the
    /// phone really receives `"Codex-chat"`, `"Claude-chat"`, `"Shell"` and
    /// `"CLI"` — and every one of those missed the exact match and resolved to
    /// no mark and no brand at all.
    ///
    /// Mirrors `providerFamilyKey` in
    /// `ADE/Views/Work/WorkStatusAndFormattingHelpers.swift`, which the Work
    /// session card already runs its own mark through; it is restated here
    /// because the widget extension cannot import main-app sources. The
    /// `-chat` / `_chat` suffix strip, the `gemini`/`google` fold and the
    /// `github` fold are additions the Work helper does not carry. `anthropic`
    /// and `openai` deliberately do NOT fold into `claude`/`codex` the way the
    /// Work helper folds them: this file's asset table ships a separate mark
    /// for each, and folding would hand an API-key run the CLI's logo.
    public static func providerFamilyKey(for providerSlug: String) -> String {
        var raw = providerSlug
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        for suffix in ["-chat", "_chat", " chat"] where raw.hasSuffix(suffix) && raw.count > suffix.count {
            raw = String(raw.dropLast(suffix.count))
            break
        }
        if raw == "anthropic" { return "anthropic" }
        if raw.hasPrefix("claude") { return "claude" }
        if raw == "openai" { return "openai" }
        if raw == "openai-codex" || raw.hasPrefix("codex") { return "codex" }
        if raw == "pi" || raw.hasPrefix("pi/") || raw.hasPrefix("pi-") { return "pi" }
        if raw.hasPrefix("opencode") { return "opencode" }
        if raw.hasPrefix("cursor") { return "cursor" }
        if raw == "factory" || raw.hasPrefix("droid") { return "droid" }
        if raw == "gemini" || raw.hasPrefix("google") { return "google" }
        // Copilot before the bare `github` fold: `github-copilot` is the ACP
        // provider, not the GitHub integration that fold was written for.
        if raw == "github-copilot" || raw == "githubcopilot" || raw.hasPrefix("copilot") { return "copilot" }
        if raw.hasPrefix("github") { return "github" }
        if raw.hasPrefix("qwen") { return "qwen" }
        if raw == "moonshot" || raw == "moonshotai" || raw.hasPrefix("kimi") { return "kimi" }
        if raw.hasPrefix("grok") { return "grok" }
        return raw
    }

    /// Resolves a provider slug (e.g. "claude", "openai", "grok") to its brand
    /// color. Same arms as `ADEDesignSystem.swift` `providerBrand(for:)`, but
    /// keyed by family rather than raw slug, so a `-chat` suffix resolves here
    /// and does not there.
    public static func brandColor(for providerSlug: String) -> Color {
        switch providerFamilyKey(for: providerSlug) {
        case "claude", "anthropic": return brandClaude
        case "codex", "openai":     return brandCodex
        case "pi":                   return brandPi
        case "cursor":              return brandCursor
        case "opencode":            return brandOpenCode
        case "google", "gemini":    return brandGoogle
        case "mistral":             return brandMistral
        case "deepseek":            return brandDeepSeek
        case "xai", "grok":         return brandXAI
        case "groq":                return brandGroq
        case "cto":                 return brandCTO
        case "qwen":                return brandQwen
        case "kimi":                return brandKimi
        case "copilot":             return brandCopilot
        default:                    return neutralAccent
        }
    }

    /// Bundled provider mark shared by the main app and widget extension.
    /// Unknown providers intentionally return nil so callers can keep a clear
    /// status-symbol fallback without introducing a new image dependency.
    ///
    /// Keyed by `providerFamilyKey(for:)`, the same key `providerDisplayName`
    /// uses, so a surface that draws the mark and speaks the name cannot end up
    /// resolving the two from different readings of one slug.
    public static func providerAssetName(for providerSlug: String?) -> String? {
        guard let providerSlug else { return nil }
        switch providerFamilyKey(for: providerSlug) {
        case "claude":              return "ProviderClaude"
        case "anthropic":           return "ProviderAnthropic"
        case "codex":               return "ProviderCodex"
        case "openai":              return "ProviderOpenAI"
        case "cursor":              return "ProviderCursor"
        case "opencode":            return "ProviderOpenCode"
        case "droid", "factory":    return "ProviderDroid"
        case "pi":                   return nil
        case "github":              return "ProviderGitHub"
        case "qwen":                return "ProviderQwen"
        case "kimi":                return "ProviderKimi"
        case "grok", "xai":         return "ProviderXAI"
        // GitHub's own mark, already bundled for the GitHub surfaces.
        case "copilot":             return "ProviderGitHub"
        default:                    return nil
        }
    }

    /// The provider's name in words. Keyed by the same family as the mark, and
    /// deliberately total for any non-blank slug: a surface with no mark to draw
    /// falls back to this, so returning nil here would leave the row saying
    /// nothing at all about what is running.
    public static func providerDisplayName(for providerSlug: String?) -> String? {
        guard let providerSlug else { return nil }
        switch providerFamilyKey(for: providerSlug) {
        case "claude":              return "Claude"
        case "anthropic":           return "Anthropic"
        case "codex":               return "Codex"
        case "openai":              return "OpenAI"
        case "cursor":              return "Cursor"
        case "opencode":            return "OpenCode"
        case "droid", "factory":    return "Droid"
        case "pi":                   return "Pi"
        case "google", "gemini":    return "Gemini"
        case "mistral":             return "Mistral"
        case "deepseek":            return "DeepSeek"
        case "xai", "grok":         return "Grok"
        case "groq":                return "Groq"
        case "cto":                 return "CTO"
        case "github":              return "GitHub"
        case "qwen":                return "Qwen"
        case "kimi":                return "Kimi"
        case "copilot":             return "GitHub Copilot"
        case "ade":                 return "ADE"
        default:
            let value = providerSlug.trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        }
    }

    /// Live Activity payloads carry a model id rather than a provider slug.
    /// Infer only high-confidence families so an unknown model keeps the phase
    /// symbol instead of being assigned the wrong brand.
    public static func providerSlug(forModel model: String?) -> String? {
        guard let model else { return nil }
        let value = model.lowercased()
        // ACP registry ids are namespaced and go first: `github-copilot/...`
        // ids name the upstream vendor after the slash, so the vendor checks
        // below would otherwise claim them.
        if value.hasPrefix("github-copilot/") { return "copilot" }
        if value.hasPrefix("qwen/") || value.contains("qwen") { return "qwen" }
        if value.hasPrefix("moonshot/") || value.contains("kimi") { return "kimi" }
        if value.hasPrefix("xai/") || value.contains("grok") { return "grok" }
        if value.contains("claude") || value.contains("anthropic") { return "claude" }
        if value.contains("codex") { return "codex" }
        if value.contains("gpt") || value.contains("openai") || value.hasPrefix("o3") || value.hasPrefix("o4") {
            return "openai"
        }
        if value.contains("cursor") { return "cursor" }
        if value.contains("opencode") { return "opencode" }
        if value.contains("droid") || value.contains("factory") { return "droid" }
        if value.contains("gemini") || value.contains("google") { return "google" }
        return nil
    }

    // MARK: - Semantic status colors

    // Attention phase colors mirror the desktop Activity pane so the same
    // state reads identically on every ADE surface. One hue, one meaning —
    // see `AgentRunPhase` and `sessionStatusPresentation.ts` for why:
    //
    //   statusRunning  blue     work is happening, nothing is asked of you
    //   warningAmber   amber    YOUR MOVE — and nothing else, ever
    //   statusSuccess  emerald  finished cleanly, unseen
    //   statusFailed   red      it broke
    //   statusIdle     neutral  true, but not actionable

    /// Blue (#60A5FA), deliberately not a green — emerald belongs to "done"
    /// alone, so in-flight and finished work never share a colour.
    public static let statusRunning = Color(red: 0x60 / 255.0, green: 0xA5 / 255.0, blue: 0xFA / 255.0) // #60A5FA
    public static let statusFailed = Color(red: 0xF8 / 255.0, green: 0x71 / 255.0, blue: 0x71 / 255.0) // #F87171
    public static let statusReview = Color(red: 0xA7 / 255.0, green: 0x8B / 255.0, blue: 0xFA / 255.0) // #A78BFA
    public static let statusSuccess = Color(red: 0x34 / 255.0, green: 0xD3 / 255.0, blue: 0x99 / 255.0) // #34D399
    /// Reserved for states that are literally waiting on the user. If you are
    /// reaching for this to say "in progress", "syncing", "stale" or "offline",
    /// reach for `statusIdle` instead — amber that means five things means none.
    public static let warningAmber = Color(red: 0xFB / 255.0, green: 0xBF / 255.0, blue: 0x24 / 255.0) // #FBBF24
    /// Alias for the same "your move" amber, read from attention surfaces.
    public static let statusAttention = warningAmber
    /// Neutral gray for everything that is true but not actionable — idle,
    /// pending, stale, syncing, offline.
    public static let statusIdle = Color(red: 0x71 / 255.0, green: 0x71 / 255.0, blue: 0x7A / 255.0)

    /// Connection-dot color mapping. Syncing is neutral rather than amber: a
    /// transport catching up asks nothing of the user.
    public static func connectionColor(for status: String) -> Color {
        switch status.lowercased() {
        case "connected": return statusSuccess
        case "syncing":   return statusIdle
        default:          return statusFailed
        }
    }
}
