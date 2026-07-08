import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

struct SettingsWebClientPairSheet: View {
  @Environment(\.dismiss) private var dismiss

  let syncService: SyncService

  @State private var loadState: WebClientPairLoadState = .loading
  @State private var didCopyLink = false
  @State private var didCopyCode = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          header
          content
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 22)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Pair a browser")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button { dismiss() } label: {
            Image(systemName: "xmark")
              .font(.system(size: 13, weight: .semibold))
          }
          .accessibilityLabel("Close")
        }
      }
      .task {
        await load()
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      Image(systemName: "globe")
        .font(.system(size: 30, weight: .regular))
        .foregroundStyle(ADEColor.purpleAccent)
        .padding(.bottom, 2)
      Text("Pair a browser")
        .font(.title2.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(headerDetail)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var headerDetail: String {
    if case .loaded(let info) = loadState {
      return "Open this in any browser to get ADE's Work, Lanes, Files and PRs for \(machineName(info))."
    }
    return "Open ADE in a browser signed in to this machine."
  }

  @ViewBuilder
  private var content: some View {
    switch loadState {
    case .loading:
      loadingContent
    case .loaded(let info):
      loadedContent(info)
    case .failed:
      failedContent
    }
  }

  private var loadingContent: some View {
    VStack(spacing: 14) {
      ProgressView()
        .tint(ADEColor.purpleAccent)
      Text("Loading pairing info...")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
      ADESkeletonView(height: 230, cornerRadius: 24)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 18)
  }

  private func loadedContent(_ info: WebPairingInfo) -> some View {
    GlassEffectContainer(spacing: 12) {
      VStack(spacing: 12) {
        qrPanel(info)
        linkPanel(info)
        codePanel(info)
        securityLine(info)
      }
    }
  }

  private var failedContent: some View {
    VStack(alignment: .leading, spacing: 16) {
      Image(systemName: "wifi.slash")
        .font(.system(size: 30, weight: .regular))
        .foregroundStyle(ADEColor.textSecondary)
      VStack(alignment: .leading, spacing: 6) {
        Text("Couldn't load pairing info")
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        Text("Make sure you're connected to this machine.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Button {
        Task { await load() }
      } label: {
        Label("Retry", systemImage: "arrow.clockwise")
          .font(.subheadline.weight(.semibold))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 10)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.purpleAccent)
    }
    .webPairPanel()
  }

  private func qrPanel(_ info: WebPairingInfo) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      captionHeader("QR code")
      VStack(spacing: 12) {
        ZStack {
          RoundedRectangle(cornerRadius: 24, style: .continuous)
            .fill(Color.white)
          if let image = SettingsWebClientPairQRCode.image(for: info.pairingUrl) {
            Image(uiImage: image)
              .interpolation(.none)
              .resizable()
              .scaledToFit()
              .padding(18)
              .accessibilityLabel("Browser pairing QR code")
          } else {
            Image(systemName: "qrcode")
              .font(.system(size: 92, weight: .regular))
              .foregroundStyle(Color.black.opacity(0.75))
          }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(1, contentMode: .fit)
        .overlay(
          RoundedRectangle(cornerRadius: 24, style: .continuous)
            .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )

        if !info.hasRelayCandidate {
          relayWarning(info)
        }
      }
    }
    .webPairPanel()
  }

  private func linkPanel(_ info: WebPairingInfo) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      captionHeader("Link")
      Text(displayPairingUrl(info.pairingUrl))
        .font(.system(.footnote, design: .monospaced).weight(.medium))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(ADEColor.recessedBackground.opacity(0.82))
        )
        .overlay(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(ADEColor.border.opacity(0.2), lineWidth: 0.75)
        )

      HStack(spacing: 10) {
        Button {
          UIPasteboard.general.string = info.pairingUrl
          didCopyLink = true
          ADEHaptics.light()
        } label: {
          Label(didCopyLink ? "Copied" : "Copy link", systemImage: didCopyLink ? "checkmark" : "doc.on.doc")
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
        }
        .buttonStyle(.glass)

        if let url = URL(string: info.pairingUrl) {
          ShareLink(item: url) {
            Label("Share", systemImage: "square.and.arrow.up")
              .font(.subheadline.weight(.semibold))
              .frame(maxWidth: .infinity)
              .padding(.vertical, 10)
          }
          .buttonStyle(.glass)
        }
      }
    }
    .webPairPanel()
  }

  @ViewBuilder
  private func codePanel(_ info: WebPairingInfo) -> some View {
    switch info.pinState {
    case .visible(let code):
      VStack(alignment: .leading, spacing: 12) {
        captionHeader("Pairing code")
        HStack(alignment: .center, spacing: 12) {
          Text(spacedCode(code))
            .font(.system(size: 34, weight: .semibold, design: .monospaced))
            .monospacedDigit()
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            .accessibilityLabel("Pairing code")
            .accessibilityValue(code)

          Spacer(minLength: 8)

          Button {
            UIPasteboard.general.string = code
            didCopyCode = true
            ADEHaptics.light()
          } label: {
            Image(systemName: didCopyCode ? "checkmark" : "doc.on.doc")
              .font(.system(size: 15, weight: .semibold))
              .frame(width: 40, height: 40)
          }
          .buttonStyle(.glass)
          .accessibilityLabel(didCopyCode ? "Code copied" : "Copy code")
        }
      }
      .webPairPanel()
    case .configuredHidden:
      unavailableCodePanel(
        iconName: "lock",
        title: "Pairing code hidden",
        detail: "A PIN is configured on \(machineName(info)), but ADE cannot display it after the runtime restarts. If you already know it, the existing PIN still pairs. " +
          "Generate or set a new PIN on the machine only when you need to display or copy one."
      )
    case .notConfigured:
      unavailableCodePanel(
        iconName: "lock.slash",
        title: "No pairing code set",
        detail: "Set a PIN in ADE on the computer, then retry."
      )
    }
  }

  private func unavailableCodePanel(
    iconName: String,
    title: String,
    detail: String
  ) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: iconName)
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(ADEColor.warning)
          .frame(width: 28, height: 28)
          .background(Circle().fill(ADEColor.warning.opacity(0.14)))
        VStack(alignment: .leading, spacing: 4) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(detail)
            .font(.footnote)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      Button {
        Task { await load() }
      } label: {
        Label("Retry", systemImage: "arrow.clockwise")
          .font(.subheadline.weight(.semibold))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 10)
      }
      .buttonStyle(.glass)
    }
    .webPairPanel()
  }

  private func securityLine(_ info: WebPairingInfo) -> some View {
    Text(info.hasRelayCandidate
      ? "Browsers still need the pairing code to connect."
      : "Off-network browsers need a relay route from this machine.")
      .font(.footnote)
      .foregroundStyle(ADEColor.textSecondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 4)
  }

  private func relayWarning(_ info: WebPairingInfo) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.triangle")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(ADEColor.warning)
      Text(info.relayEnabled
        ? "No relay route is available yet. Try again in a moment."
        : "Relay is off, so this may only work on the same network.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func captionHeader(_ text: String) -> some View {
    Text(text)
      .font(.caption.weight(.semibold))
      .foregroundStyle(ADEColor.purpleAccent.opacity(0.85))
  }

  @MainActor
  private func load() async {
    loadState = .loading
    didCopyLink = false
    didCopyCode = false
    guard let info = await syncService.getWebPairingInfo(), !Task.isCancelled else {
      if !Task.isCancelled {
        loadState = .failed
      }
      return
    }
    loadState = .loaded(info)
  }

  private func machineName(_ info: WebPairingInfo) -> String {
    let trimmed = info.machineName.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "this machine" : trimmed
  }

  private func spacedCode(_ code: String) -> String {
    code.map { String($0) }.joined(separator: " ")
  }

  private func displayPairingUrl(_ raw: String) -> String {
    if raw.hasPrefix("https://") {
      return String(raw.dropFirst("https://".count))
    }
    if raw.hasPrefix("http://") {
      return String(raw.dropFirst("http://".count))
    }
    return raw
  }
}

private enum WebClientPairLoadState {
  case loading
  case loaded(WebPairingInfo)
  case failed
}

private enum SettingsWebClientPairQRCode {
  private static let context = CIContext()

  static func image(for value: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(value.utf8)
    filter.correctionLevel = "M"

    guard let output = filter.outputImage else { return nil }
    let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
    guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else {
      return nil
    }
    return UIImage(cgImage: cgImage)
  }
}

private struct SettingsWebPairPanelModifier: ViewModifier {
  func body(content: Content) -> some View {
    content
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(ADEColor.cardBackground.opacity(0.5))
      )
      .glassEffect(in: .rect(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 1)
      )
  }
}

private extension View {
  func webPairPanel() -> some View {
    modifier(SettingsWebPairPanelModifier())
  }
}
