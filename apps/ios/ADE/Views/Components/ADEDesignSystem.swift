import CryptoKit
import SwiftUI
import UIKit

enum ADEColorSchemeChoice: String, CaseIterable, Identifiable {
  case system
  case light
  case dark

  var id: String { rawValue }

  var preferredColorScheme: ColorScheme? {
    switch self {
    case .system: return nil
    case .light: return .light
    case .dark: return .dark
    }
  }

  var label: String {
    switch self {
    case .system: return "System"
    case .light: return "Light"
    case .dark: return "Dark"
    }
  }

  var symbol: String {
    switch self {
    case .system: return "circle.righthalf.filled"
    case .light: return "sun.max.fill"
    case .dark: return "moon.fill"
    }
  }
}

private func adaptiveColor(light: UIColor, dark: UIColor) -> Color {
  Color(uiColor: UIColor { traits in
    traits.userInterfaceStyle == .dark ? dark : light
  })
}

private func hex(_ value: UInt32, alpha: CGFloat = 1.0) -> UIColor {
  UIColor(
    red: CGFloat((value >> 16) & 0xff) / 255.0,
    green: CGFloat((value >> 8) & 0xff) / 255.0,
    blue: CGFloat(value & 0xff) / 255.0,
    alpha: alpha
  )
}

enum ADEColor {
  static let pageBackground = adaptiveColor(light: hex(0xf5f3f0), dark: hex(0x0c0b10))
  static let surfaceBackground = adaptiveColor(light: hex(0xfaf8f5), dark: hex(0x16141e))
  static let cardBackground = adaptiveColor(light: hex(0xffffff), dark: hex(0x1a1830))
  static let raisedBackground = adaptiveColor(light: hex(0xffffff), dark: hex(0x1e1b2e))
  static let recessedBackground = adaptiveColor(light: hex(0xeae7e2), dark: hex(0x0a090e))
  static let composerBackground = adaptiveColor(light: hex(0xffffff, alpha: 0.82), dark: hex(0x14121f, alpha: 0.86))
  static let glassBackground = adaptiveColor(light: hex(0xffffff, alpha: 0.78), dark: hex(0x141220, alpha: 0.78))
  static let glassBorder = adaptiveColor(light: hex(0x1a1a1e, alpha: 0.10), dark: hex(0xffffff, alpha: 0.10))
  static let border = adaptiveColor(light: hex(0xd6d3ce), dark: hex(0x302c42))
  static let textPrimary = adaptiveColor(light: hex(0x1a1a1e), dark: hex(0xf0f0f2))
  static let textSecondary = adaptiveColor(light: hex(0x52525b), dark: hex(0xa8a8b4))
  static let textMuted = adaptiveColor(light: hex(0x636370), dark: hex(0x908fa0))
  static let accent = adaptiveColor(light: hex(0x049068), dark: hex(0xA78BFA))
  static let accentBright = adaptiveColor(light: hex(0x049068), dark: hex(0xC4B5FD))
  static let accentDeep = adaptiveColor(light: hex(0x047857), dark: hex(0x7C3AED))
  static let success = adaptiveColor(light: hex(0x16a34a), dark: hex(0x22c55e))
  static let warning = adaptiveColor(light: hex(0xd97706), dark: hex(0xf59e0b))
  static let danger = adaptiveColor(light: hex(0xdc2626), dark: hex(0xef4444))
  static let info = adaptiveColor(light: hex(0x2563eb), dark: hex(0x3b82f6))
  static let purpleAccent = Color(red: 167.0 / 255.0, green: 139.0 / 255.0, blue: 250.0 / 255.0)  // #A78BFA
  static let purpleGlow = purpleAccent.opacity(0.35)
  static let ctoAccent = Color(red: 0xA7 / 255.0, green: 0x8B / 255.0, blue: 0xFA / 255.0)  // #A78BFA

  static let tintProject = purpleAccent
  static let tintLanes = Color(red: 0xf5 / 255.0, green: 0x9e / 255.0, blue: 0x0b / 255.0)
  static let tintFiles = Color(red: 0x71 / 255.0, green: 0x71 / 255.0, blue: 0x7a / 255.0)
  static let tintWork = Color(red: 0x22 / 255.0, green: 0xc5 / 255.0, blue: 0x5e / 255.0)
  static let tintGraph = Color(red: 0x63 / 255.0, green: 0x66 / 255.0, blue: 0xf1 / 255.0)
  static let tintPRs = purpleAccent
  static let tintHistory = Color(red: 0xd9 / 255.0, green: 0x77 / 255.0, blue: 0x06 / 255.0)
  static let tintAutomations = Color(red: 0xf9 / 255.0, green: 0x73 / 255.0, blue: 0x16 / 255.0)
  static let tintSettings = Color(red: 0x71 / 255.0, green: 0x71 / 255.0, blue: 0x7a / 255.0)

  /// Per-provider brand colors mirroring desktop's PROVIDER_BADGE_COLORS.
  /// Keep in sync with apps/desktop/src/renderer/components/shared/providerModelSelectorGrouping.ts.
  static let brandClaude = Color(red: 0xD9 / 255.0, green: 0x77 / 255.0, blue: 0x06 / 255.0)      // #D97706
  static let brandCodex = Color(red: 0x10 / 255.0, green: 0xA3 / 255.0, blue: 0x7F / 255.0)       // #10A37F
  static let brandCursor = Color(red: 0xA7 / 255.0, green: 0x8B / 255.0, blue: 0xFA / 255.0)      // #A78BFA
  static let brandOpenCode = Color(red: 0x25 / 255.0, green: 0x63 / 255.0, blue: 0xEB / 255.0)    // #2563EB
  static let brandGoogle = Color(red: 0xF5 / 255.0, green: 0x9E / 255.0, blue: 0x0B / 255.0)      // #F59E0B
  static let brandMistral = Color(red: 0xF9 / 255.0, green: 0x73 / 255.0, blue: 0x16 / 255.0)     // #F97316
  static let brandDeepSeek = Color(red: 0x3B / 255.0, green: 0x82 / 255.0, blue: 0xF6 / 255.0)    // #3B82F6
  static let brandXAI = Color(red: 0xDC / 255.0, green: 0x26 / 255.0, blue: 0x26 / 255.0)         // #DC2626
  static let brandGroq = Color(red: 0x06 / 255.0, green: 0xB6 / 255.0, blue: 0xD4 / 255.0)        // #06B6D4

  /// Resolve a provider id/label ("claude", "codex", "anthropic"…) to its brand color.
  /// Falls back to the neutral purple accent when the provider isn't recognized.
  static func providerBrand(for provider: String) -> Color {
    switch provider.lowercased() {
    case "claude", "anthropic": return brandClaude
    case "codex", "openai": return brandCodex
    case "cursor": return brandCursor
    case "opencode": return brandOpenCode
    case "google", "gemini": return brandGoogle
    case "mistral": return brandMistral
    case "deepseek": return brandDeepSeek
    case "xai", "grok": return brandXAI
    case "groq": return brandGroq
    default: return purpleAccent
    }
  }

  /// Per-model brand colors mirroring desktop's MODEL_REGISTRY entries.
  /// Keep in sync with apps/desktop/src/shared/modelRegistry.ts.
  /// Keys cover both the registry id ("anthropic/claude-opus-4-7") and shortId ("opus").
  private static let modelColors: [String: UInt32] = [
    // Anthropic
    "anthropic/claude-fable-5": 0xD97706,
    "anthropic/claude-fable-5-api": 0xD97706,
    "claude-fable-5": 0xD97706,
    "fable": 0xD97706,
    "anthropic/claude-opus-4-8": 0xD97706,
    "claude-opus-4-8": 0xD97706,
    "anthropic/claude-opus-4-7": 0xD97706,
    "claude-opus-4-7": 0xD97706,
    "opus": 0xD97706,
    "anthropic/claude-opus-4-7-1m": 0xB45309,
    "claude-opus-4-7-1m": 0xB45309,
    "opus-1m": 0xB45309,
    "opus[1m]": 0xB45309,
    "claude-opus-4-7[1m]": 0xB45309,
    "anthropic/claude-sonnet-4-6": 0x8B5CF6,
    "sonnet": 0x8B5CF6,
    "anthropic/claude-haiku-4-5": 0x06B6D4,
    "haiku": 0x06B6D4,
    // OpenAI / Codex
    "openai/gpt-5.5": 0x10A37F,
    "gpt-5.5": 0x10A37F,
    "openai/gpt-5.4": 0x10A37F,
    "gpt-5.4": 0x10A37F,
    "openai/gpt-5.4-mini": 0x34D399,
    "gpt-5.4-mini": 0x34D399,
    "openai/gpt-5.3-codex": 0x10B981,
    "gpt-5.3-codex": 0x10B981,
    // Local
    "ollama/llama-3.3": 0x71717A,
    "llama-3.3": 0x71717A,
  ]

  private static func modelLookupCandidates(for modelId: String?) -> [String] {
    guard let raw = modelId?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return [] }
    var candidates: [String] = []
    func append(_ value: String) {
      let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      if !normalized.isEmpty && !candidates.contains(normalized) {
        candidates.append(normalized)
      }
    }

    append(raw)
    let lower = raw.lowercased()
    if lower.hasPrefix("openai/") {
      append(String(lower.dropFirst("openai/".count)))
    }
    if lower.hasPrefix("anthropic/") {
      append(String(lower.dropFirst("anthropic/".count)))
    }

    switch lower {
    case "gpt-5.5", "gpt-5.5-codex", "openai/gpt-5.5", "openai/gpt-5.5-codex":
      append("openai/gpt-5.5")
      append("gpt-5.5")
    case "gpt-5.4", "gpt-5.4-codex", "openai/gpt-5.4", "openai/gpt-5.4-codex":
      append("openai/gpt-5.4")
      append("gpt-5.4")
    case "gpt-5.4-mini", "gpt-5.4-mini-codex", "openai/gpt-5.4-mini", "openai/gpt-5.4-mini-codex":
      append("openai/gpt-5.4-mini")
      append("gpt-5.4-mini")
    case "fable", "anthropic/claude-fable-5", "anthropic/claude-fable-5-api", "claude-fable-5":
      append("anthropic/claude-fable-5")
      append("anthropic/claude-fable-5-api")
      append("claude-fable-5")
      append("fable")
    case "anthropic/claude-opus-4-8", "claude-opus-4-8",
         "opus-4.8", "opus-4-8", "opus-4.8-1m", "opus-4.8[1m]", "opus-4-8-1m",
         "anthropic/claude-opus-4-8-1m", "claude-opus-4-8-1m", "claude-opus-4-8[1m]":
      append("anthropic/claude-opus-4-8")
      append("claude-opus-4-8")
    case "opus", "anthropic/claude-opus-4-7", "claude-opus-4-7":
      append("anthropic/claude-opus-4-7")
      append("opus")
    case "opus[1m]", "opus-1m", "anthropic/claude-opus-4-7-1m", "claude-opus-4-7-1m", "claude-opus-4-7[1m]":
      append("anthropic/claude-opus-4-7-1m")
      append("opus-1m")
    default:
      break
    }

    return candidates
  }

  /// Resolve a model id (registry id or short id) to its brand color.
  /// Returns nil when the model isn't in the registry; callers should fall back to `providerBrand`.
  static func modelBrand(for modelId: String?) -> Color? {
    let candidates = modelLookupCandidates(for: modelId)
    guard let lower = candidates.first else { return nil }
    for candidate in candidates {
      if let hexValue = modelColors[candidate] {
        return Color(uiColor: hex(hexValue))
      }
    }
    // Heuristic fallback for dynamic Cursor SDK ids: `cursor/<id>`.
    if lower.hasPrefix("cursor/") {
      let sdk = String(lower.dropFirst("cursor/".count))
      return Color(uiColor: hex(cursorSdkHex(for: sdk)))
    }
    return nil
  }

  private static func cursorSdkHex(for sdkId: String) -> UInt32 {
    if sdkId == "auto" { return 0xA78BFA }
    if sdkId.range(of: "claude|fable|sonnet|opus|haiku", options: .regularExpression) != nil { return 0xD97706 }
    if sdkId.contains("composer") { return 0x8B5CF6 }
    if sdkId.contains("gemini") { return 0x4285F4 }
    if sdkId.contains("grok") { return 0x1DA1F2 }
    if sdkId.range(of: "^gpt|^o\\d|codex", options: .regularExpression) != nil { return 0x10A37F }
    return 0x71717A
  }

  /// Per-model reasoning tiers mirroring desktop's `reasoningTiers` field in
  /// `apps/desktop/src/shared/modelRegistry.ts`. Keys cover both the registry
  /// id ("anthropic/claude-opus-4-7") and shortId ("opus") so lookups work
  /// against either form of `chatSummary.modelId`. Keep this aligned with
  /// `apps/desktop/src/shared/modelRegistry.ts` so the mobile composer exposes
  /// the same effort actions as desktop and the ADE TUI.
  private static let modelReasoningTiers: [String: [String]] = [
    // Claude
    "anthropic/claude-fable-5": ["low", "medium", "high", "xhigh", "max", "ultracode"],
    "anthropic/claude-fable-5-api": ["low", "medium", "high", "xhigh", "max", "ultracode"],
    "claude-fable-5": ["low", "medium", "high", "xhigh", "max", "ultracode"],
    "fable": ["low", "medium", "high", "xhigh", "max", "ultracode"],
    "anthropic/claude-opus-4-8": ["low", "medium", "high", "xhigh", "max", "ultracode"],
    "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max", "ultracode"],
    "anthropic/claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
    "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
    "opus": ["low", "medium", "high", "xhigh", "max"],
    "anthropic/claude-opus-4-7-1m": ["low", "medium", "high", "xhigh", "max"],
    "claude-opus-4-7-1m": ["low", "medium", "high", "xhigh", "max"],
    "opus-1m": ["low", "medium", "high", "xhigh", "max"],
    "opus[1m]": ["low", "medium", "high", "xhigh", "max"],
    "claude-opus-4-7[1m]": ["low", "medium", "high", "xhigh", "max"],
    "anthropic/claude-sonnet-4-6": ["low", "medium", "high", "max"],
    "sonnet": ["low", "medium", "high", "max"],
    // Claude Haiku intentionally absent — no reasoning tiers.
    // OpenAI / Codex
    "openai/gpt-5.5": ["low", "medium", "high", "xhigh"],
    "gpt-5.5": ["low", "medium", "high", "xhigh"],
    "openai/gpt-5.4": ["low", "medium", "high", "xhigh"],
    "gpt-5.4": ["low", "medium", "high", "xhigh"],
    "openai/gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
    "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
    "openai/gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
    "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
    "openai/gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
    "gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
    "gpt-5.3-spark": ["low", "medium", "high", "xhigh"],
    "codex-spark": ["low", "medium", "high", "xhigh"],
    "spark": ["low", "medium", "high", "xhigh"],
    "openai/gpt-5.2": ["low", "medium", "high", "xhigh"],
    "gpt-5.2": ["low", "medium", "high", "xhigh"],
  ]

  /// Return the reasoning tiers supported by a model, or nil when the model
  /// doesn't expose tiers (e.g. Haiku). Used by the composer to decide whether
  /// to render the effort picker.
  static func reasoningTiers(for modelId: String?) -> [String]? {
    for candidate in modelLookupCandidates(for: modelId) {
      if let tiers = modelReasoningTiers[candidate] { return tiers }
    }
    return nil
  }

  /// Per-provider chat-surface accent. Kept separate from `providerBrand` (which
  /// drives logos/badges across the app) so chat surfaces can be tuned without
  /// churning other UI. Claude = amber across all variants, Codex = warm white,
  /// mirroring the shared desktop mapping in
  /// `apps/desktop/src/renderer/components/chat/chatSurfaceTheme.ts`.
  private static let providerChatAccents: [String: UInt32] = [
    "claude": 0xD97706,
    "anthropic": 0xD97706,
    "codex": 0xE7E5E4,
    "openai": 0xE7E5E4,
    "cursor": 0xA78BFA,
    "droid": 0x8B5CF6,
    "factory": 0x8B5CF6,
    "opencode": 0x2563EB,
    "google": 0xF59E0B,
    "gemini": 0xF59E0B,
    "mistral": 0xF97316,
    "deepseek": 0x3B82F6,
    "xai": 0xDC2626,
    "grok": 0xDC2626,
    "groq": 0x06B6D4,
  ]

  /// Resolve the chat-surface accent for a session. Precedence: explicit hex
  /// override > provider accent (unified per-provider tone so Claude is always
  /// amber, Codex warm white, etc.) > per-model color fallback > neutral.
  static func chatSurfaceAccent(modelId: String?, provider: String?, accentColorHex: String? = nil) -> Color {
    if let trimmed = accentColorHex?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty,
       let parsed = parseHexColor(trimmed) {
      return parsed
    }
    if let provider {
      let key = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      if let value = providerChatAccents[key] {
        return Color(uiColor: hex(value))
      }
    }
    if let modelColor = modelBrand(for: modelId) { return modelColor }
    return Color(uiColor: hex(0x71717A))
  }

  /// Per-provider chat-surface accent resolved from a bare source/provider id
  /// ("claude", "codex", "cursor"…). Thin wrapper over `chatSurfaceAccent` for
  /// the question/plan cards, which only know the asking provider. Falls back to
  /// the neutral grey when the provider isn't recognized.
  static func providerChatAccent(for provider: String?) -> Color {
    chatSurfaceAccent(modelId: nil, provider: provider)
  }

  private static func parseHexColor(_ input: String) -> Color? {
    var s = input
    if s.hasPrefix("#") { s.removeFirst() }
    if s.count == 3 {
      s = s.map { "\($0)\($0)" }.joined()
    }
    guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
    return Color(uiColor: hex(value))
  }
}

enum ADEListRowMetrics {
  static let cornerRadius: CGFloat = 18
  static let padding: CGFloat = 14
}

enum ADEMotion {
  static func standard(reduceMotion: Bool) -> Animation {
    reduceMotion ? .easeInOut(duration: 0.18) : .smooth
  }

  static func quick(reduceMotion: Bool) -> Animation {
    reduceMotion ? .easeInOut(duration: 0.18) : .snappy
  }

  static func emphasis(reduceMotion: Bool) -> Animation {
    reduceMotion ? .easeInOut(duration: 0.18) : .spring(.bouncy(duration: 0.35))
  }

  static func pulse(reduceMotion: Bool) -> Animation? {
    reduceMotion ? nil : .smooth(duration: 1.0).repeatForever(autoreverses: true)
  }

  static func allowsMatchedGeometry(reduceMotion: Bool) -> Bool {
    !reduceMotion
  }
}

enum ADEUIKitAppearance {
  /// Intentionally empty — ADE uses the system `TabView` tab bar so iOS 26
  /// Liquid Glass stays native. Do not override `UITabBar.appearance()` here.
  @MainActor
  static func configureTabBar() {}
}

final class ADEImageCache {
  static let shared = ADEImageCache()

  private let memoryCache = NSCache<NSString, NSData>()
  private let cacheDirectory: URL
  private let fileManager: FileManager

  init(cacheDirectory: URL? = nil, fileManager: FileManager = .default) {
    self.fileManager = fileManager
    let resolvedDirectory = cacheDirectory
      ?? fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first!
        .appendingPathComponent("ADEImageCache", isDirectory: true)
    self.cacheDirectory = resolvedDirectory
    try? fileManager.createDirectory(at: resolvedDirectory, withIntermediateDirectories: true, attributes: nil)
  }

  func cachedData(for key: String) -> Data? {
    if let cached = memoryCache.object(forKey: key as NSString) {
      return Data(referencing: cached)
    }

    let url = cacheDirectory.appendingPathComponent(diskFilename(for: key))
    guard let data = try? Data(contentsOf: url) else { return nil }
    memoryCache.setObject(data as NSData, forKey: key as NSString)
    return data
  }

  func cachedImage(for key: String) -> UIImage? {
    guard let data = cachedData(for: key) else { return nil }
    return UIImage(data: data)
  }

  func store(_ data: Data, for key: String) {
    memoryCache.setObject(data as NSData, forKey: key as NSString)
    let url = cacheDirectory.appendingPathComponent(diskFilename(for: key))
    try? data.write(to: url, options: .atomic)
  }

  func loadRemoteImage(from url: URL, cacheKey: String? = nil) async throws -> UIImage {
    let key = cacheKey ?? url.absoluteString
    if let image = cachedImage(for: key) {
      return image
    }

    let (data, _) = try await URLSession.shared.data(from: url)
    store(data, for: key)

    guard let image = UIImage(data: data) else {
      throw NSError(
        domain: "ADE",
        code: 301,
        userInfo: [NSLocalizedDescriptionKey: "The machine returned an unreadable image preview."]
      )
    }

    return image
  }

  func diskFilename(for key: String) -> String {
    SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

struct ADENoticeCard: View {
  let title: String
  let message: String
  let icon: String
  let tint: Color
  let actionTitle: String?
  let action: (() -> Void)?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: icon)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 32, height: 32)
          .background(tint.opacity(0.18), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .glassEffect(in: .rect(cornerRadius: 12))

        VStack(alignment: .leading, spacing: 4) {
          Text(title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text(message)
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        Spacer(minLength: 0)
      }

      if let actionTitle, let action {
        Button(actionTitle, action: action)
          .buttonStyle(.glassProminent)
          .tint(tint == ADEColor.textSecondary ? ADEColor.accent : tint)
          .controlSize(.small)
      }
    }
    .adeGlassCard()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title). \(message)")
  }
}

struct ADEStatusPill: View {
  let text: String
  let tint: Color

  var body: some View {
    Text(text)
      .font(.system(.caption2, design: .monospaced).weight(.semibold))
      .padding(.horizontal, 9)
      .padding(.vertical, 5)
      .background(tint.opacity(0.12), in: Capsule())
      .foregroundStyle(tint)
      .glassEffect()
      .accessibilityLabel("Status: \(text)")
  }
}

/// Single source of truth for the "machine connection" presentation
/// (status-dot tint, glow, accessibility label, truncated host name).
///
/// The view-model is computed from the same inputs the underlying views read
/// directly from `SyncService` — `connectionHealth`, `connectionState`, and
/// `hostName` — so its branching matches `switch health.transport` exactly
/// and the existing semantics are preserved. Two callsites used to duplicate
/// these computed-vars; both now instantiate this struct and read from it.
struct ConnectionHealthPresentation {
  let tint: Color
  let showsConnectedGlow: Bool
  let truncatedHostName: String?
  let accessibilityLabel: String

  init(
    health: SyncConnectionHealth,
    connectionState: RemoteConnectionState,
    hostName: String?
  ) {
    let truncated = Self.truncate(hostName: hostName)
    self.tint = Self.computeTint(health: health)
    self.showsConnectedGlow = health.transport.isConnected
    self.truncatedHostName = truncated
    self.accessibilityLabel = Self.computeAccessibilityLabel(
      health: health,
      connectionState: connectionState,
      truncatedHostName: truncated
    )
  }

  private static func computeTint(health: SyncConnectionHealth) -> Color {
    switch health.transport {
    case .connected:
      return health.load == .strained ? ADEColor.warning : ADEColor.success
    case .connecting:
      return ADEColor.warning
    case .unreachable, .disconnected:
      return ADEColor.danger
    }
  }

  private static func truncate(hostName: String?) -> String? {
    guard let rawName = hostName else { return nil }
    let cleaned = rawName
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: ".…"))
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleaned.isEmpty else { return nil }
    if cleaned.count <= 10 { return cleaned }
    return String(cleaned.prefix(9)) + "…"
  }

  private static func computeAccessibilityLabel(
    health: SyncConnectionHealth,
    connectionState: RemoteConnectionState,
    truncatedHostName: String?
  ) -> String {
    let errorSuffix: String = {
      guard health.transport == .unreachable,
            let raw = health.lastFailureMessage?.trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty
      else {
        return ""
      }
      let normalized = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
      let clipped = normalized.count > 120 ? String(normalized.prefix(117)) + "…" : normalized
      return ". \(clipped)"
    }()

    switch health.transport {
    case .connected:
      if let name = truncatedHostName {
        if health.load == .strained {
          return "Connected to \(name). Machine is responding slowly"
        }
        if connectionState == .syncing {
          return "Connected to \(name). Syncing changes"
        }
        return "Connected to \(name)"
      }
      if health.load == .strained {
        return "Connected. Machine is responding slowly"
      }
      if connectionState == .syncing {
        return "Connected. Syncing changes"
      }
      return "Connected"
    case .connecting:
      return "Connecting to machine"
    case .unreachable:
      return "Connection error\(errorSuffix)"
    case .disconnected:
      return "Disconnected from machine"
    }
  }
}

struct ADEConnectionDot: View {
  @EnvironmentObject private var syncService: SyncService

  private var presentation: ConnectionHealthPresentation {
    ConnectionHealthPresentation(
      health: syncService.connectionHealth,
      connectionState: syncService.connectionState,
      hostName: syncService.hostName
    )
  }

  private var tint: Color { presentation.tint }
  private var showsConnectedGlow: Bool { presentation.showsConnectedGlow }
  private var accessibilityLabel: String { presentation.accessibilityLabel }

  /// Standalone disc — retained for detail screens that still need the chip
  /// form. The root top-bar uses `ADERootToolbarControls` which draws the
  /// same affordance inside the shared liquid-glass capsule.
  var body: some View {
    Button(action: openSettings) {
      Label {
        Text("Machine connection")
      } icon: {
        PrsGlassDisc(tint: tint, isAlive: showsConnectedGlow) {
          Image(systemName: "laptopcomputer")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(tint)
        }
      }
      .labelStyle(.iconOnly)
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Machine connection · \(accessibilityLabel)")
    .accessibilityHint("Opens machine connection settings.")
    .accessibilityShowsLargeContentViewer()
    .adeInspectable(
      "Root.Toolbar.ConnectionButton",
      metadata: [
        "label": "Machine connection · \(accessibilityLabel)",
        "role": "button"
      ]
    )
  }

  fileprivate func openSettings() {
    syncService.settingsPresented = true
  }

  fileprivate var iconTint: Color { tint }
  fileprivate var isAlive: Bool { showsConnectedGlow }
  fileprivate var a11yLabel: String { "Machine connection · \(accessibilityLabel)" }
}

private let projectIconImageCache = NSCache<NSString, UIImage>()

/// Decodes a base64 `data:` URL project icon into a `UIImage`, memoised in a
/// process-wide cache. Returns nil when the project has no icon. Shared by the
/// project-home list rows and the root toolbar's projects affordance so both
/// resolve icons through one cache.
func projectIconImage(from dataUrl: String?) -> UIImage? {
  guard let dataUrl, !dataUrl.isEmpty else { return nil }
  let cacheKey = dataUrl as NSString
  if let cached = projectIconImageCache.object(forKey: cacheKey) {
    return cached
  }
  guard let commaIndex = dataUrl.firstIndex(of: ",") else { return nil }
  let base64 = String(dataUrl[dataUrl.index(after: commaIndex)...])
  // Project icons are pre-rendered host-side to a 64×64 PNG (a few KB), so a
  // payload past ~768 KB of base64 is malformed or hostile — reject it rather
  // than drive a large allocation/decode on the UI path.
  guard base64.count <= 1_048_576,
        let data = Data(base64Encoded: base64),
        let image = UIImage(data: data)
  else { return nil }
  projectIconImageCache.setObject(image, forKey: cacheKey)
  return image
}

extension Image {
  /// Shared presentation for a decoded project icon: high-quality fit inside a
  /// rounded square. Size and corner radius vary per surface (toolbar capsule,
  /// leading disc, project-home rows), so they stay parameters.
  func projectIconStyle(size: CGFloat, cornerRadius: CGFloat) -> some View {
    self
      .resizable()
      .interpolation(.high)
      .aspectRatio(contentMode: .fit)
      .frame(width: size, height: size)
      .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
  }
}

struct ADEProjectHomeButton: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    Button(action: openProjectHome) {
      Label {
        Text("Projects")
      } icon: {
        PrsGlassDisc(tint: PrsGlass.glowPurple, isAlive: true) {
          if let icon = projectIconImage(from: syncService.activeProject?.iconDataUrl) {
            // Detected project logo replaces the generic grid glyph.
            Image(uiImage: icon).projectIconStyle(size: 20, cornerRadius: 5)
          } else {
            Image(systemName: "square.grid.2x2.fill")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(PrsGlass.accentTop)
          }
        }
      }
      .labelStyle(.iconOnly)
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Projects")
    .accessibilityHint("Opens the ADE project menu.")
    .accessibilityShowsLargeContentViewer()
    .adeInspectable(
      "Root.Toolbar.ProjectsButton",
      metadata: [
        "label": "Projects",
        "role": "button"
      ]
    )
  }

  fileprivate func openProjectHome() {
    syncService.showProjectHome()
  }
}

/// Root toolbar control cluster: machine connection, project switching, and
/// attention bell collapsed into one floating liquid-glass capsule so the PRs
/// (and every root tab) top-bar reads as a single glass chip rather than three
/// disjointed discs.
///
/// Visual spec mirrors the pencil: `.ultraThinMaterial` capsule (14pt radius),
/// white α0.08 stroke, outer shadow, inner top highlight. The three icons are
/// separated by 1pt white α0.08 vertical dividers. All tap targets, wiring and
/// accessibility labels are preserved exactly.
@available(iOS 17.0, *)
struct ADERootToolbarControls: View {
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var drawer: AttentionDrawerModel

  /// Disambiguator folded into inspector ids so two simultaneous instances of
  /// this control (e.g. the active and incoming root tab during a transition)
  /// don't emit colliding element ids. Callers typically pass the screen title.
  let scopeKey: String?

  init(scopeKey: String? = nil) {
    self.scopeKey = scopeKey
  }

  private var presentation: ConnectionHealthPresentation {
    ConnectionHealthPresentation(
      health: syncService.connectionHealth,
      connectionState: syncService.connectionState,
      hostName: syncService.hostName
    )
  }

  private var connectionTint: Color { presentation.tint }
  private var connectionIsAlive: Bool { presentation.showsConnectedGlow }
  private var connectionAccessibilityLabel: String {
    "Machine connection · \(presentation.accessibilityLabel)"
  }

  private var hasUnread: Bool { drawer.unreadCount > 0 }

  var body: some View {
    HStack(spacing: 0) {
      toolbarIconButton(
        icon: "laptopcomputer",
        tint: connectionTint,
        isAlive: connectionIsAlive,
        accessibilityLabel: connectionAccessibilityLabel,
        action: { syncService.settingsPresented = true }
      )

      divider

      toolbarIconButton(
        icon: "square.grid.2x2.fill",
        tint: PrsGlass.accentTop,
        isAlive: false,
        iconImage: projectIconImage(from: syncService.activeProject?.iconDataUrl),
        accessibilityLabel: "Projects",
        action: { syncService.showProjectHome() }
      )

      divider

      ZStack(alignment: .topTrailing) {
        toolbarIconButton(
          icon: "bell.fill",
          tint: hasUnread ? ADESharedTheme.warningAmber : PrsGlass.textSecondary,
          isAlive: hasUnread,
          accessibilityLabel: "Attention items: \(drawer.unreadCount)",
          action: { syncService.attentionDrawerPresented = true }
        )

        if hasUnread {
          Circle()
            .fill(ADEColor.warning)
            .frame(width: 7, height: 7)
            .overlay(
              Circle().stroke(PrsGlass.ink, lineWidth: 1.25)
            )
            .shadow(color: ADEColor.warning.opacity(0.45), radius: 3, x: 0, y: 0)
            .offset(x: -7, y: 6)
            .transition(.scale.combined(with: .opacity))
            .accessibilityHidden(true)
        }
      }
      .animation(.snappy(duration: 0.2), value: drawer.unreadCount)
    }
    .padding(.vertical, 4)
    .background {
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(ADEColor.glassBackground)
    }
    .overlay {
      // Soft vertical highlight (white 0.10 → 0).
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(
          LinearGradient(
            colors: [Color.white.opacity(0.10), .clear],
            startPoint: .top,
            endPoint: .bottom
          )
        )
        .allowsHitTesting(false)
    }
    .overlay {
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .strokeBorder(
          LinearGradient(
            colors: [Color.white.opacity(0.22), Color.white.opacity(0.04)],
            startPoint: .top,
            endPoint: .bottom
          ),
          lineWidth: 1
        )
        .allowsHitTesting(false)
    }
    .overlay {
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(Color.white.opacity(0.08), lineWidth: 0.75)
        .allowsHitTesting(false)
    }
    .compositingGroup()
    .shadow(color: Color.black.opacity(0.28), radius: 12, x: 0, y: 5)
    .fixedSize(horizontal: true, vertical: false)
  }

  private var divider: some View {
    Rectangle()
      .fill(Color.white.opacity(0.08))
      .frame(width: 1, height: 18)
      .allowsHitTesting(false)
  }

  @ViewBuilder
  private func toolbarIconButton(
    icon: String,
    tint: Color,
    isAlive: Bool,
    iconImage: UIImage? = nil,
    accessibilityLabel: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      ZStack {
        if isAlive {
          Circle()
            .fill(tint.opacity(0.18))
            .frame(width: 24, height: 24)
            .blur(radius: 3)
        }
        if let iconImage {
          // Detected project logo replaces the generic grid glyph.
          Image(uiImage: iconImage).projectIconStyle(size: 22, cornerRadius: 5)
        } else {
          Image(systemName: icon)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(tint)
            .shadow(color: isAlive ? tint.opacity(0.28) : .clear, radius: 2, x: 0, y: 0)
        }
      }
      .frame(width: 38, height: 34)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accessibilityLabel)
    .adeInspectable(
      "Root.Toolbar.\(icon)",
      key: scopeKey,
      metadata: [
        "label": accessibilityLabel,
        "role": "button"
      ]
    )
  }
}

/// Compact leading cluster for detail screens that still need the controls
/// beside the back affordance instead of the title-balancing root layout.
@available(iOS 17.0, *)
struct ADERootToolbarLeading: View {
  var body: some View {
    HStack(spacing: 10) {
      ADEConnectionDot()
      ADEProjectHomeButton()
      AttentionDrawerButton()
    }
    .fixedSize(horizontal: true, vertical: false)
  }
}

@available(iOS 17.0, *)
struct ADERootTopBar<Actions: View>: View {
  let title: String
  let showsGlobalControls: Bool
  let actions: Actions

  init(
    title: String,
    showsGlobalControls: Bool = true,
    @ViewBuilder actions: () -> Actions
  ) {
    self.title = title
    self.showsGlobalControls = showsGlobalControls
    self.actions = actions()
  }

  var body: some View {
    ZStack {
      if !title.isEmpty {
        Text(title)
          .font(.system(size: 22, weight: .heavy, design: .rounded))
          .foregroundStyle(PrsGlass.textPrimary)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.leading, 4)
          .shadow(color: Color.black.opacity(0.55), radius: 8, x: 0, y: 3)
          .accessibilityAddTraits(.isHeader)
      }

      HStack(spacing: 8) {
        Spacer(minLength: 0)
        actions
        if showsGlobalControls {
          ADERootToolbarControls(scopeKey: title)
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 2)
    .frame(height: 60)
    .background {
      LinearGradient(
        colors: [
          ADEColor.pageBackground,
          ADEColor.pageBackground.opacity(0.98),
          ADEColor.pageBackground.opacity(0.88),
          ADEColor.pageBackground.opacity(0)
        ],
        startPoint: .top,
        endPoint: .bottom
      )
      .ignoresSafeArea(edges: .top)
      .allowsHitTesting(false)
    }
  }
}

@available(iOS 17.0, *)
extension ADERootTopBar where Actions == EmptyView {
  init(title: String, showsGlobalControls: Bool = true) {
    self.title = title
    self.showsGlobalControls = showsGlobalControls
    self.actions = EmptyView()
  }
}

/// Toolbar content variant for screens that need the root controls in the
/// navigation bar. The explicit shared background opt-out keeps iOS 26's
/// toolbar glass from joining settings and attention into one capsule.
@available(iOS 17.0, *)
struct ADERootToolbarLeadingItems: ToolbarContent {
  var body: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      ADEConnectionDot()
    }
    .sharedBackgroundVisibility(.hidden)

    ToolbarItem(placement: .topBarLeading) {
      ADEProjectHomeButton()
    }
    .sharedBackgroundVisibility(.hidden)

    ToolbarItem(placement: .topBarLeading) {
      AttentionDrawerButton()
    }
    .sharedBackgroundVisibility(.hidden)
  }
}

/// Canonical chat-composer send affordance: a compact circular button with an
/// upward arrow, matching the desktop composer (phosphor `ArrowUp` in a white
/// disc). Shared by the New Chat composer and the in-session chat composer so
/// every prompt box sends with the same glyph instead of mismatched paperplanes.
struct ADEComposerSendButton: View {
  /// Whether there is sendable input. Drives the filled vs. recessed treatment.
  let enabled: Bool
  /// While a send is in flight, swaps the arrow for an inline spinner.
  let sending: Bool
  var accessibilityLabelText: String = "Send message"
  /// Optional VoiceOver label used while disabled (e.g. "Enter a message to
  /// send") so users hear *why* the button is unavailable. Falls back to
  /// `accessibilityLabelText` when nil.
  var disabledAccessibilityLabel: String? = nil
  let action: () -> Void

  /// Dark glyph color on the light disc (matches the in-session composer).
  private let glyphColor = Color(red: 0.12, green: 0.12, blue: 0.14)

  private var resolvedAccessibilityLabel: String {
    if sending { return "Sending message" }
    if !enabled, let disabledAccessibilityLabel { return disabledAccessibilityLabel }
    return accessibilityLabelText
  }

  var body: some View {
    Button(action: action) {
      ZStack {
        if sending {
          ProgressView()
            .controlSize(.mini)
            .tint(enabled ? glyphColor : ADEColor.textSecondary)
        } else {
          Image(systemName: "arrow.up")
            .font(.system(size: 14, weight: .bold))
        }
      }
      .frame(width: 28, height: 28)
      .foregroundStyle(enabled ? glyphColor : ADEColor.textSecondary.opacity(0.2))
      .background(
        Circle()
          .fill(enabled ? Color.white.opacity(0.9) : Color.white.opacity(0.06))
      )
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
    .accessibilityLabel(resolvedAccessibilityLabel)
  }
}

struct ADEEmptyStateView<Actions: View>: View {
  let symbol: String
  let title: String
  let message: String
  let actions: Actions

  init(symbol: String, title: String, message: String, @ViewBuilder actions: () -> Actions) {
    self.symbol = symbol
    self.title = title
    self.message = message
    self.actions = actions()
  }

  init(symbol: String, title: String, message: String) where Actions == EmptyView {
    self.init(symbol: symbol, title: title, message: message) {
      EmptyView()
    }
  }

  var body: some View {
    VStack(spacing: 16) {
      Image(systemName: symbol)
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(ADEColor.accent)
        .frame(width: 58, height: 58)
        .background(ADEColor.surfaceBackground, in: Circle())
        .glassEffect()

      VStack(spacing: 6) {
        Text(title)
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        Text(message)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
      }

      actions
    }
    .frame(maxWidth: .infinity)
    .padding(24)
    .adeGlassCard(cornerRadius: 20, padding: 24)
  }
}

struct ADESkeletonView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var width: CGFloat? = nil
  var height: CGFloat = 14
  var cornerRadius: CGFloat = 10

  @State private var shimmerOffset: CGFloat = -1.2

  var body: some View {
    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
      .fill(ADEColor.surfaceBackground)
      .frame(width: width, height: height)
      .overlay {
        GeometryReader { proxy in
          LinearGradient(
            colors: [
              .clear,
              Color.primary.opacity(0.12),
              .clear,
            ],
            startPoint: .leading,
            endPoint: .trailing
          )
          .frame(width: proxy.size.width * 0.8)
          .offset(x: proxy.size.width * shimmerOffset)
        }
        .mask(
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(.white)
        )
      }
      .onAppear {
        guard !reduceMotion else { return }
        withAnimation(.linear(duration: 1.15).repeatForever(autoreverses: false)) {
          shimmerOffset = 1.2
        }
      }
  }
}

struct ADECardSkeleton: View {
  var rows: Int = 3

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ADESkeletonView(width: 120, height: 16)
      ForEach(0..<rows, id: \.self) { index in
        ADESkeletonView(width: index == rows - 1 ? 140 : nil, height: 12)
      }
    }
    .adeGlassCard()
  }
}

struct ADEGlassGroup<Content: View>: View {
  let spacing: CGFloat
  let content: Content

  init(spacing: CGFloat = 10, @ViewBuilder content: () -> Content) {
    self.spacing = spacing
    self.content = content()
  }

  var body: some View {
    GlassEffectContainer(spacing: spacing) {
      HStack(spacing: spacing) {
        content
      }
    }
  }
}

struct ADERootTabBarHiddenPreferenceKey: PreferenceKey {
  static var defaultValue = false

  static func reduce(value: inout Bool, nextValue: () -> Bool) {
    value = value || nextValue()
  }
}

private struct ADEGlassCardModifier: ViewModifier {
  let cornerRadius: CGFloat
  let padding: CGFloat

  func body(content: Content) -> some View {
    content
      .padding(padding)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.glassBackground, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: cornerRadius))
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.75)
      )
  }
}

private struct ADEInsetFieldModifier: ViewModifier {
  let cornerRadius: CGFloat
  let padding: CGFloat

  func body(content: Content) -> some View {
    content
      .padding(padding)
      .background(ADEColor.recessedBackground.opacity(0.78), in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: cornerRadius))
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.5)
      )
  }
}

private struct ADENavigationGlassModifier: ViewModifier {
  func body(content: Content) -> some View {
    content
      .toolbarBackground(.clear, for: .navigationBar)
      .toolbarBackgroundVisibility(.visible, for: .navigationBar)
  }
}

private struct ADEMatchedGeometryModifier: ViewModifier {
  let id: String?
  let namespace: Namespace.ID?

  @ViewBuilder
  func body(content: Content) -> some View {
    if let id, let namespace {
      content.matchedGeometryEffect(id: id, in: namespace)
    } else {
      content
    }
  }
}

private struct ADEMatchedTransitionSourceModifier: ViewModifier {
  let id: String?
  let namespace: Namespace.ID?

  @ViewBuilder
  func body(content: Content) -> some View {
    if let id, let namespace {
      content.matchedTransitionSource(id: id, in: namespace)
    } else {
      content
    }
  }
}

private struct ADENavigationZoomTransitionModifier: ViewModifier {
  let id: String?
  let namespace: Namespace.ID?

  @ViewBuilder
  func body(content: Content) -> some View {
    if let id, let namespace {
      content.navigationTransition(.zoom(sourceID: id, in: namespace))
    } else {
      content
    }
  }
}

extension View {
  func adeGlassCard(cornerRadius: CGFloat = 16, padding: CGFloat = 16) -> some View {
    modifier(ADEGlassCardModifier(cornerRadius: cornerRadius, padding: padding))
  }

  func adeScreenBackground() -> some View {
    background(ADEColor.pageBackground.ignoresSafeArea())
  }

  func adeNavigationGlass() -> some View {
    modifier(ADENavigationGlassModifier())
  }

  func adeInsetField(cornerRadius: CGFloat = 12, padding: CGFloat = 12) -> some View {
    modifier(ADEInsetFieldModifier(cornerRadius: cornerRadius, padding: padding))
  }

  func adeListCard(
    cornerRadius: CGFloat = ADEListRowMetrics.cornerRadius,
    padding: CGFloat = ADEListRowMetrics.padding
  ) -> some View {
    adeGlassCard(cornerRadius: cornerRadius, padding: padding)
  }

  func adeMatchedGeometry(id: String?, in namespace: Namespace.ID?) -> some View {
    modifier(ADEMatchedGeometryModifier(id: id, namespace: namespace))
  }

  func adeMatchedTransitionSource(id: String?, in namespace: Namespace.ID?) -> some View {
    modifier(ADEMatchedTransitionSourceModifier(id: id, namespace: namespace))
  }

  func adeNavigationZoomTransition(id: String?, in namespace: Namespace.ID?) -> some View {
    modifier(ADENavigationZoomTransitionModifier(id: id, namespace: namespace))
  }

  func adeRootTabBarHidden(_ hidden: Bool = true) -> some View {
    preference(key: ADERootTabBarHiddenPreferenceKey.self, value: hidden)
  }
}
