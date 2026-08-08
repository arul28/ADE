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

    /// Neutral fallback when the provider slug is unknown. Keeps parity with
    /// `ADEColor.purpleAccent` in the main design system.
    public static let neutralAccent = Color(red: 0x8B / 255.0, green: 0x5C / 255.0, blue: 0xF6 / 255.0)

    /// Resolves a provider slug (e.g. "claude", "openai", "grok") to its brand
    /// color. Matches `ADEDesignSystem.swift` `providerBrand(for:)` verbatim.
    public static func brandColor(for providerSlug: String) -> Color {
        switch providerSlug.lowercased() {
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
        default:                    return neutralAccent
        }
    }

    /// Bundled provider mark shared by the main app and widget extension.
    /// Unknown providers intentionally return nil so callers can keep a clear
    /// status-symbol fallback without introducing a new image dependency.
    public static func providerAssetName(for providerSlug: String?) -> String? {
        guard let providerSlug else { return nil }
        switch providerSlug.lowercased() {
        case "claude":              return "ProviderClaude"
        case "anthropic":           return "ProviderAnthropic"
        case "codex":               return "ProviderCodex"
        case "openai":              return "ProviderOpenAI"
        case "cursor":              return "ProviderCursor"
        case "opencode":            return "ProviderOpenCode"
        case "droid", "factory":    return "ProviderDroid"
        case "pi":                   return nil
        case "github":              return "ProviderGitHub"
        default:                    return nil
        }
    }

    public static func providerDisplayName(for providerSlug: String?) -> String? {
        guard let providerSlug else { return nil }
        switch providerSlug.lowercased() {
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
