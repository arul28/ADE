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

  static let tintProject = purpleAccent
  static let tintLanes = Color(red: 0xf5 / 255.0, green: 0x9e / 255.0, blue: 0x0b / 255.0)
  static let tintFiles = Color(red: 0x71 / 255.0, green: 0x71 / 255.0, blue: 0x7a / 255.0)
  static let tintWork = Color(red: 0x22 / 255.0, green: 0xc5 / 255.0, blue: 0x5e / 255.0)
  static let tintGraph = Color(red: 0x63 / 255.0, green: 0x66 / 255.0, blue: 0xf1 / 255.0)
  static let tintPRs = purpleAccent
  static let tintHistory = Color(red: 0xd9 / 255.0, green: 0x77 / 255.0, blue: 0x06 / 255.0)
  static let tintAutomations = Color(red: 0xf9 / 255.0, green: 0x73 / 255.0, blue: 0x16 / 255.0)
  static let tintMissions = Color(red: 0x3b / 255.0, green: 0x82 / 255.0, blue: 0xf6 / 255.0)
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
    "anthropic/claude-opus-4-7": 0xD97706,
    "opus": 0xD97706,
    "anthropic/claude-opus-4-7-1m": 0xB45309,
    "opus-1m": 0xB45309,
    "opus[1m]": 0xB45309,
    "claude-opus-4-7[1m]": 0xB45309,
    "anthropic/claude-sonnet-4-6": 0x8B5CF6,
    "sonnet": 0x8B5CF6,
    "anthropic/claude-haiku-4-5": 0x06B6D4,
    "haiku": 0x06B6D4,
    // OpenAI / Codex
    "openai/gpt-5.4-codex": 0x10A37F,
    "gpt-5.4-codex": 0x10A37F,
    "openai/gpt-5.4-mini-codex": 0x34D399,
    "gpt-5.4-mini-codex": 0x34D399,
    "openai/gpt-5.3-codex": 0x10B981,
    "gpt-5.3-codex": 0x10B981,
    "openai/gpt-5.3-codex-spark": 0x34D399,
    "gpt-5.3-codex-spark": 0x34D399,
    "openai/gpt-5.2-codex": 0x10B981,
    "gpt-5.2-codex": 0x10B981,
    "openai/gpt-5.1-codex-max": 0x10B981,
    "gpt-5.1-codex-max": 0x10B981,
    "openai/gpt-5.1-codex-mini": 0x2DD4BF,
    "gpt-5.1-codex-mini": 0x2DD4BF,
    // Local
    "ollama/llama-3.3": 0x71717A,
    "llama-3.3": 0x71717A,
  ]

  /// Resolve a model id (registry id or short id) to its brand color.
  /// Returns nil when the model isn't in the registry; callers should fall back to `providerBrand`.
  static func modelBrand(for modelId: String?) -> Color? {
    guard let raw = modelId?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
    if let hexValue = modelColors[raw] {
      return Color(uiColor: hex(hexValue))
    }
    let lower = raw.lowercased()
    if let hexValue = modelColors[lower] {
      return Color(uiColor: hex(hexValue))
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
    if sdkId.range(of: "claude|sonnet|opus|haiku", options: .regularExpression) != nil { return 0xD97706 }
    if sdkId.contains("composer") { return 0x8B5CF6 }
    if sdkId.contains("gemini") { return 0x4285F4 }
    if sdkId.contains("grok") { return 0x1DA1F2 }
    if sdkId.range(of: "^gpt|^o\\d|codex", options: .regularExpression) != nil { return 0x10A37F }
    return 0x71717A
  }

  /// Per-model reasoning tiers mirroring desktop's `reasoningTiers` field in
  /// `apps/desktop/src/shared/modelRegistry.ts`. Keys cover both the registry
  /// id ("anthropic/claude-opus-4-7") and shortId ("opus") so lookups work
  /// against either form of `chatSummary.modelId`. Models missing from this
  /// map (e.g. Haiku) don't support effort tiers; callers should hide the
  /// effort picker entirely in that case.
  private static let modelReasoningTiers: [String: [String]] = [
    // Claude
    "anthropic/claude-opus-4-7": ["low", "medium", "high", "max"],
    "opus": ["low", "medium", "high", "max"],
    "anthropic/claude-opus-4-7-1m": ["low", "medium", "high", "xhigh", "max"],
    "opus-1m": ["low", "medium", "high", "xhigh", "max"],
    "opus[1m]": ["low", "medium", "high", "xhigh", "max"],
    "claude-opus-4-7[1m]": ["low", "medium", "high", "xhigh", "max"],
    "anthropic/claude-sonnet-4-6": ["low", "medium", "high"],
    "sonnet": ["low", "medium", "high"],
    // Claude Haiku intentionally absent — no reasoning tiers.
    // OpenAI / Codex
    "openai/gpt-5.4-codex": ["low", "medium", "high", "xhigh"],
    "gpt-5.4-codex": ["low", "medium", "high", "xhigh"],
    "openai/gpt-5.4-mini-codex": ["low", "medium", "high", "xhigh"],
    "gpt-5.4-mini-codex": ["low", "medium", "high", "xhigh"],
    "openai/gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
    "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
    "openai/gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
    "gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
    "openai/gpt-5.2-codex": ["low", "medium", "high", "xhigh"],
    "gpt-5.2-codex": ["low", "medium", "high", "xhigh"],
    "openai/gpt-5.1-codex-max": ["low", "medium", "high", "xhigh"],
    "gpt-5.1-codex-max": ["low", "medium", "high", "xhigh"],
    "openai/gpt-5.1-codex-mini": ["medium", "high"],
    "gpt-5.1-codex-mini": ["medium", "high"],
  ]

  /// Return the reasoning tiers supported by a model, or nil when the model
  /// doesn't expose tiers (e.g. Haiku). Used by the composer to decide whether
  /// to render the effort picker.
  static func reasoningTiers(for modelId: String?) -> [String]? {
    guard let raw = modelId?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
    if let tiers = modelReasoningTiers[raw] { return tiers }
    let lower = raw.lowercased()
    if let tiers = modelReasoningTiers[lower] { return tiers }
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
        userInfo: [NSLocalizedDescriptionKey: "The host returned an unreadable image preview."]
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

struct ADEConnectionPill: View {
  @EnvironmentObject private var syncService: SyncService

  private var tint: Color {
    switch syncService.connectionState {
    case .connected, .syncing: return ADEColor.success
    case .connecting: return ADEColor.accent
    case .disconnected, .error: return ADEColor.danger
    }
  }

  private var label: String {
    switch syncService.connectionState {
    case .connected, .syncing: return "Connected"
    case .connecting: return "Connecting"
    case .disconnected: return "Not connected"
    case .error: return "Offline"
    }
  }

  var body: some View {
    Button {
      syncService.settingsPresented = true
    } label: {
      HStack(spacing: 6) {
        Circle()
          .fill(tint)
          .frame(width: 8, height: 8)
        Text(label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Connection: \(label). Tap to open settings.")
  }
}

struct ADEConnectionDot: View {
  @EnvironmentObject private var syncService: SyncService

  private var tint: Color {
    switch syncService.connectionState {
    case .connected: return ADEColor.success
    case .syncing: return ADEColor.warning
    case .connecting: return ADEColor.warning
    case .error, .disconnected: return ADEColor.danger
    }
  }

  private var statusText: String {
    switch syncService.connectionState {
    case .connected: return "Connected"
    case .syncing: return "Syncing"
    case .connecting: return "Connecting"
    case .error: return "Error"
    case .disconnected: return "Disconnected"
    }
  }

  private var showsHostSuffix: Bool {
    syncService.connectionState == .connected
  }

  private var showsConnectedGlow: Bool {
    syncService.connectionState == .connected
  }

  private var truncatedHostName: String? {
    guard let rawName = syncService.hostName else { return nil }
    let cleaned = rawName
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: ".…"))
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleaned.isEmpty else { return nil }
    if cleaned.count <= 10 { return cleaned }
    return String(cleaned.prefix(9)) + "…"
  }

  private var accessibilityLabel: String {
    let errorSuffix: String = {
      guard syncService.connectionState == .error, let err = syncService.lastError?.trimmingCharacters(in: .whitespacesAndNewlines), !err.isEmpty else {
        return ""
      }
      let clipped = err.count > 120 ? String(err.prefix(117)) + "…" : err
      return ". \(clipped)"
    }()

    switch syncService.connectionState {
    case .connected:
      if let name = syncService.hostName, !name.isEmpty {
        return "Connected to \(name)"
      }
      return "Connected"
    case .syncing:
      return "Syncing with host"
    case .connecting:
      return "Connecting to host"
    case .error:
      return "Connection error\(errorSuffix)"
    case .disconnected:
      return "Disconnected from host"
    }
  }

  var body: some View {
    Button {
      syncService.settingsPresented = true
    } label: {
      HStack(spacing: 6) {
        Circle()
          .fill(tint)
          .frame(width: 10, height: 10)
          .shadow(color: tint.opacity(showsConnectedGlow ? 0.5 : 0), radius: showsConnectedGlow ? 4 : 0)
        Text(statusText)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .minimumScaleFactor(0.75)
        if showsHostSuffix, let name = truncatedHostName {
          Text("·")
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textMuted)
            .minimumScaleFactor(0.75)
          Text(name)
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .minimumScaleFactor(0.75)
        }
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityHint("Opens settings to pair or reconnect.")
    .accessibilityShowsLargeContentViewer()
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
      .toolbarBackground(.clear, for: .tabBar)
      .toolbarBackgroundVisibility(.visible, for: .tabBar)
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
}
