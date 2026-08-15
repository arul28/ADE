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
///
/// The scheme alone is not the whole rule. `ade://` covers more than
/// navigation: `ade://pair#<payload>` walks straight into the pairing flow
/// carrying a payload the plugin chose, which is a state change and not a
/// destination. So a plugin's link is held to the navigation hosts — the ones
/// `DeepLinkRouter` resolves to a screen or a send-to-Mac card — and every
/// other host, including one a later build adds, is refused.
enum PluginDeeplinkURL {
  /// `repo` is the branch shape (`ade://repo/<owner>/<repo>/branch/<branch>`);
  /// there is no `ade://branch` host.
  private static let navigationHosts: Set<String> = [
    "lane",
    "session",
    "file",
    "commit",
    "artifact",
    "repo",
    "pr",
    "linear-issue",
  ]

  static func resolve(_ raw: String?) -> URL? {
    guard let raw, let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return nil }
    switch scheme {
    case "https":
      return url
    case "ade":
      guard let host = url.host?.lowercased(), navigationHosts.contains(host) else { return nil }
      return url
    default:
      return nil
    }
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
        } else if let icon = PluginSymbol.symbol(button.icon) {
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

/// The manifest icon namespace, and the phone's half of it.
///
/// A plugin manifest names an icon with a TOKEN — `beer`, `git-branch`,
/// `list-checks` — drawn from one shared list that every client resolves in its
/// own catalogue. Desktop resolves it against `PLUGIN_ICONS` in
/// `apps/desktop/src/renderer/components/plugins/pluginIcons.tsx` and draws a
/// Phosphor glyph; this map is the same list resolved into SF Symbols.
///
/// Before this map, iOS had no token namespace at all: it passed the manifest
/// string straight to `UIImage(systemName:)`, so a token drew only if it
/// happened to also be an SF Symbol name. Thirty-three of the shared tokens
/// silently became the puzzle piece, and the ones that did draw could mean
/// something else entirely — the alpha test found the sharpest form of it, where
/// a drink plugin's `beer` read as a cup of tea on the phone and a stein on the
/// desktop beside it, from one manifest.
///
/// Two rules follow, and both are load-bearing:
///
/// - **Every token in desktop's list has an entry here.** A parity test walks a
///   literal copy of that list in both directions, so neither side can add a
///   token the other cannot draw.
/// - **The token list is the whole namespace.** An unrecognised string is not
///   retried as an SF Symbol name — see ``symbol(_:)``.
///
/// The pairs are chosen for what a glyph MEANS rather than what it is called:
/// Phosphor's `Robot` and SF's `cpu` share no word and the same idea.
enum PluginSymbol {
  /// Manifest icon token → SF Symbol. Mirrors desktop's `PLUGIN_ICONS`.
  ///
  /// Same additive/removal rule as desktop: adding a token is safe, removing
  /// one silently changes the appearance of a plugin already shipped with it.
  ///
  /// Where the two catalogues do not have the same glyph, the entry picks the
  /// nearest MEANING and the comment says what was given up. A token with no
  /// honest neighbour would be left out rather than pointed at something that
  /// reads as another thing — that mistake is exactly what `beer` was.
  private static let tokens: [String: String] = [
    "beer": "mug",
    "bell": "bell",
    "bookmark": "bookmark",
    "brain": "brain",
    "bug": "ladybug",
    "calendar": "calendar",
    "chart": "chart.line.uptrend.xyaxis",
    "chart-bar": "chart.bar",
    "chat": "bubble.left.and.bubble.right",
    "clock": "clock",
    "clock-counter-clockwise": "clock.arrow.circlepath",
    "cloud": "cloud",
    "code": "chevron.left.forwardslash.chevron.right",
    // Phosphor's compass rose. SF's nearest rose is Safari's; `location.north`
    // is the needle without the dial, which reads as "heading" rather than
    // "explore", so the dial wins.
    "compass": "safari",
    "cube": "cube",
    "currency": "dollarsign.circle",
    "database": "cylinder.split.1x2",
    "desktop": "desktopcomputer",
    "device-mobile": "iphone",
    "envelope": "envelope",
    "eye": "eye",
    "file": "doc.text",
    "flag": "flag",
    "folder": "folder",
    "gear": "gearshape",
    "git-branch": "arrow.triangle.branch",
    // A commit is a node on a line, and SF has no VCS glyph at all. The filled
    // dot inside a ring is the closest reading; it loses the line.
    "git-commit": "smallcircle.filled.circle",
    "git-pull-request": "arrow.triangle.pull",
    "globe": "globe",
    "graph": "point.3.connected.trianglepath.dotted",
    "heart": "heart",
    "image": "photo",
    "kanban": "rectangle.split.3x1",
    "key": "key",
    "lightning": "bolt",
    "link": "link",
    "list": "checklist",
    "list-checks": "checklist",
    "lock": "lock",
    "magic": "wand.and.stars",
    "microphone": "mic",
    "music": "music.note",
    "note": "note.text",
    "package": "shippingbox",
    "palette": "paintpalette",
    "play": "play",
    "plug": "powerplug",
    "puzzle": "puzzlepiece.extension",
    // SF has no robot. `cpu` is the machine-that-acts reading Phosphor's Robot
    // carries in a plugin manifest, and it is not mistakable for anything else
    // in this list.
    "robot": "cpu",
    // Nor a rocket. Launch/ship is the sense, and `paperplane` is the only
    // send-it glyph in the catalogue; it loses the "big release" weight.
    "rocket": "paperplane",
    "rows": "rectangle.split.1x2",
    "shield": "checkmark.shield",
    "sparkle": "sparkles",
    "star": "star",
    "storefront": "storefront",
    "table": "tablecells",
    "tag": "tag",
    "terminal": "terminal",
    "timer": "timer",
    "toolbox": "wrench.and.screwdriver",
    "trend": "chart.line.uptrend.xyaxis",
    "users": "person.3",
    "video": "video",
    "wrench": "wrench.adjustable",
  ]

  /// Tokens this build maps, for the parity test that walks every one of them.
  static var tokenNames: [String] { tokens.keys.sorted() }

  static func exists(_ name: String) -> Bool {
    UIImage(systemName: name) != nil
  }

  /// The SF Symbol a manifest icon draws as, or nil when nothing honest draws.
  ///
  /// **The token list IS the cross-client namespace, and this lookup is the
  /// whole of it.** A known token draws its mapped symbol; anything else draws
  /// nothing here and the caller falls back to the puzzle piece. There is
  /// deliberately no second attempt at `UIImage(systemName:)` on the raw string.
  ///
  /// That fallback existed and was removed on purpose. It looked like
  /// compatibility for an author who had named an SF Symbol directly, but such a
  /// name never *worked* in any sense the author could rely on: it rendered on
  /// this client and drew a puzzle piece on desktop, which cannot resolve SF
  /// Symbol names at all. Keeping it would have meant the phone silently
  /// accepting icons no other client can draw — one manifest, two pictures,
  /// which is the exact bug class the retrospective recorded. With the map
  /// authoritative, an icon that renders anywhere renders everywhere, and an
  /// unrecognised string puzzles identically on both.
  static func symbol(_ name: String?) -> String? {
    guard let raw = name?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
      return nil
    }
    return tokens[raw.lowercased()]
  }

  static func resolve(_ name: String?, fallback: String) -> String {
    symbol(name) ?? fallback
  }
}
