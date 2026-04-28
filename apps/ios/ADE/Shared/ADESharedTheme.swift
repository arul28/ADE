import SwiftUI

/// Minimal theme subset needed by widgets and the notification service
/// extension. Extensions cannot import main-app sources directly, so the
/// provider brand map is duplicated here and must be kept in sync with
/// `ADEDesignSystem.swift:brandClaude..brandGroq` and `providerBrand(for:)`.
public enum ADESharedTheme {
    // MARK: - Brand colors (mirror of ADEDesignSystem)
    public static let brandClaude   = Color(red: 0xD9 / 255.0, green: 0x77 / 255.0, blue: 0x06 / 255.0) // #D97706
    public static let brandCodex    = Color(red: 0x10 / 255.0, green: 0xA3 / 255.0, blue: 0x7F / 255.0) // #10A37F
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

    // MARK: - Semantic status colors

    /// Red used for failed / CI-failing states. Matches the XAI brand red to
    /// keep the palette tight; the two states are not visually confusable
    /// because they carry distinct SF Symbols.
    public static let statusFailed = brandXAI
    /// Green used for passing / completed. Derived from the Codex teal.
    public static let statusSuccess = brandCodex
    /// Amber used for awaiting-input / warnings.
    public static let statusAttention = Color(red: 0xF5 / 255.0, green: 0x9E / 255.0, blue: 0x0B / 255.0)
    /// Brighter amber used in the mockup palette for attention pulses, review
    /// states, and inline warning chips. Matches `STATUS.attention` /
    /// `STATUS.review` from `surfaces.jsx`.
    public static let warningAmber = Color(red: 0xFB / 255.0, green: 0xBF / 255.0, blue: 0x24 / 255.0) // #FBBF24
    /// Neutral gray used for idle / pending.
    public static let statusIdle = Color(red: 0x71 / 255.0, green: 0x71 / 255.0, blue: 0x7A / 255.0)

    /// Connection-dot color mapping.
    public static func connectionColor(for status: String) -> Color {
        switch status.lowercased() {
        case "connected": return statusSuccess
        case "syncing":   return statusAttention
        default:          return statusFailed
        }
    }
}
