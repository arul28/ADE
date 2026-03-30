import CryptoKit
import SwiftUI
import UIKit

enum ADEColor {
  static let pageBackground = Color(.systemGroupedBackground)
  static let surfaceBackground = Color(.secondarySystemGroupedBackground)
  static let recessedBackground = Color(.tertiarySystemGroupedBackground)
  static let border = Color(.separator)
  static let textPrimary = Color.primary
  static let textSecondary = Color.secondary
  static let textMuted = Color(.tertiaryLabel)
  static let accent = Color.accentColor
  static let success = Color.green
  static let warning = Color.orange
  static let danger = Color.red
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

  func removeData(for key: String) {
    memoryCache.removeObject(forKey: key as NSString)
    let url = cacheDirectory.appendingPathComponent(diskFilename(for: key))
    try? fileManager.removeItem(at: url)
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
      .background(ADEColor.surfaceBackground.opacity(0.08), in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: cornerRadius))
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.75)
      )
  }
}

private struct ADEInsetFieldModifier: ViewModifier {
  let cornerRadius: CGFloat
  let padding: CGFloat

  func body(content: Content) -> some View {
    content
      .padding(padding)
      .background(ADEColor.recessedBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: cornerRadius))
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.5)
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
