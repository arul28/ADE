import SwiftUI
import UIKit
import AVKit

/// Media, action controls, and the degradation markers for the vocabulary
/// renderer. Split out of `PluginVocabularyView.swift` for length; the node
/// switch there dispatches into these.

// MARK: - Media

struct PluginVocabVideoView: View {
  let video: PluginVocabVideo

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let url = PluginMediaURL.resolve(video.src) {
        PluginVideoPlayerView(url: url)
      } else {
        PluginInlineEmptyText(text: "This video is not playable from your phone.")
      }
      if let title = video.title {
        Text(title)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
  }
}

/// Owns the `AVPlayer` so it survives the redraws a panel reload causes. Same
/// shape as `WorkArtifactVideoPlayerView`.
private struct PluginVideoPlayerView: View {
  let url: URL
  @StateObject private var model: WorkArtifactVideoPlayerModel

  init(url: URL) {
    self.url = url
    _model = StateObject(wrappedValue: WorkArtifactVideoPlayerModel(url: url))
  }

  var body: some View {
    VideoPlayer(player: model.player)
      .frame(height: 200)
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      .onChange(of: url) { _, newValue in
        model.update(url: newValue)
      }
  }
}

struct PluginVocabImageView: View {
  let image: PluginVocabImage

  var body: some View {
    if let url = PluginMediaURL.resolve(image.src) {
      AsyncImage(url: url) { phase in
        switch phase {
        case let .success(loaded):
          loaded
            .resizable()
            .scaledToFit()
            .frame(maxHeight: image.maxHeight.map { CGFloat($0) } ?? 260)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        case .failure:
          PluginInlineEmptyText(text: image.alt)
        default:
          ADESkeletonView(height: 120, cornerRadius: 12)
        }
      }
      .accessibilityLabel(image.alt)
    } else {
      PluginInlineEmptyText(text: image.alt)
    }
  }
}

/// Schemes a panel may point media at: `https` is the network case and `data`
/// the self-contained one.
///
/// A `src` is a string from another machine that this renderer turns into a
/// fetch, so everything else is a capability the plugin was never granted —
/// `file:` reads the phone's own disk, plain `http:` puts a panel's contents on
/// the wire in the clear, and a custom scheme hands the OS a launch. A relative
/// path has no scheme at all and is refused rather than resolved. The same rule
/// is enforced on desktop in `vocabularyComponents.tsx`.
enum PluginMediaURL {
  static func resolve(_ raw: String) -> URL? {
    guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return nil }
    return ["https", "data"].contains(scheme) ? url : nil
  }
}

/// The same rule for the one link a plugin can put in front of the user: a
/// fallback card's `deeplink`. `ade://` routes back through `DeepLinkRouter`
/// and `https` leaves the app through the browser; anything else — `file:`,
/// another app's custom scheme — would hand a plugin a tap-to-launch primitive
/// it was never granted.
enum PluginDeeplinkURL {
  static func resolve(_ raw: String?) -> URL? {
    guard let raw, let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return nil }
    return ["ade", "https"].contains(scheme) ? url : nil
  }
}

// MARK: - Actions

struct PluginVocabButtonView: View {
  let button: PluginVocabButton
  @ObservedObject var store: PluginPaneStore

  private var isBusy: Bool { store.isInFlight(button.onPress) }
  private var isDisabled: Bool { button.disabled || isBusy || !store.canInvoke }

  var body: some View {
    Button {
      ADEHaptics.light()
      store.perform(button.onPress)
    } label: {
      HStack(spacing: 6) {
        if isBusy {
          ProgressView().controlSize(.mini)
        } else if let icon = button.icon, PluginSymbol.exists(icon) {
          Image(systemName: icon)
            .font(.system(size: 11, weight: .semibold))
        }
        Text(button.label)
          .font(.caption.weight(.semibold))
      }
      .foregroundStyle(foreground)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(background, in: Capsule())
      .glassEffect()
      .overlay(Capsule().stroke(ADEColor.border.opacity(button.kind == .quiet ? 0 : 0.18), lineWidth: 0.5))
    }
    .buttonStyle(ADEScaleButtonStyle())
    .disabled(isDisabled)
    .opacity(isDisabled && !isBusy ? 0.5 : 1)
  }

  private var foreground: Color {
    switch button.kind {
    case .primary: return ADEColor.accent
    case .default: return ADEColor.textPrimary
    case .quiet: return ADEColor.textSecondary
    }
  }

  private var background: Color {
    switch button.kind {
    case .primary: return ADEColor.accent.opacity(0.14)
    case .default: return ADEColor.surfaceBackground.opacity(0.5)
    case .quiet: return .clear
    }
  }
}

struct PluginVocabEmptyStateView: View {
  let emptyState: PluginVocabEmptyState
  @ObservedObject var store: PluginPaneStore

  var body: some View {
    ADEEmptyStateView(
      symbol: PluginSymbol.resolve(emptyState.icon, fallback: "puzzlepiece.extension"),
      title: emptyState.title,
      message: emptyState.description ?? ""
    ) {
      if let label = emptyState.actionLabel, let action = emptyState.action {
        ADEGlassActionButton(title: label, symbol: "play.circle", tint: ADEColor.accent) {
          ADEHaptics.light()
          store.perform(action)
        }
        .disabled(!store.canInvoke || store.isInFlight(action))
      }
    }
  }
}

// MARK: - Markers and shared bits

/// What a component this build cannot draw looks like.
///
/// Compact and in place, per the degradation ladder: the surrounding panel is
/// intact and only this node is missing, so the marker says which component
/// without claiming anything is broken.
struct PluginUnsupportedNodeMarker: View {
  let node: PluginVocabNode

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "square.dashed")
        .font(.system(size: 10, weight: .semibold))
      Text(label)
        .font(.caption2.weight(.medium))
    }
    .foregroundStyle(ADEColor.textMuted)
    .padding(.horizontal, 9)
    .padding(.vertical, 6)
    .background(ADEColor.surfaceBackground.opacity(0.4), in: Capsule())
    .overlay(Capsule().strokeBorder(ADEColor.border.opacity(0.3), style: StrokeStyle(lineWidth: 0.5, dash: [3, 3])))
    .accessibilityLabel(label)
  }

  private var label: String {
    switch node {
    case let .invalid(name, _):
      return "\(name) — this plugin sent something unusable"
    default:
      return "\(node.componentName) — not shown on iPhone"
    }
  }
}

struct PluginInlineEmptyText: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.caption)
      .foregroundStyle(ADEColor.textMuted)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 6)
  }
}

/// Icon names arrive from a plugin manifest written for four clients, so most
/// of them are not SF Symbols. Checking before use keeps an unrecognized name
/// from rendering as an empty box beside a label.
enum PluginSymbol {
  static func exists(_ name: String) -> Bool {
    UIImage(systemName: name) != nil
  }

  static func resolve(_ name: String?, fallback: String) -> String {
    guard let name, exists(name) else { return fallback }
    return name
  }
}
