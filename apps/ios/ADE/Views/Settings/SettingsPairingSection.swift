import SwiftUI
import UIKit
import VisionKit

struct SettingsPairingSection: View {
  @EnvironmentObject private var syncService: SyncService
  @Binding var presentedSheet: SettingsPairSheetRoute?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      SettingsSectionHeader(
        label: "PAIR A COMPUTER",
        hint: pairingHint
      )

      GlassEffectContainer(spacing: 8) {
        VStack(spacing: 8) {
          SettingsPairActionRow(
            icon: "dot.radiowaves.left.and.right",
            title: "Discover on network",
            subtitle: discoverSubtitle
          ) {
            presentedSheet = .discover
          }

          SettingsPairActionRow(
            icon: "qrcode.viewfinder",
            title: "Scan pairing QR",
            subtitle: "Show on your Mac under Settings → Sync"
          ) {
            presentedSheet = .qr
          }

          SettingsPairActionRow(
            icon: "keyboard",
            title: "Enter host details",
            subtitle: "Host address and port"
          ) {
            presentedSheet = .manual
          }
        }
      }
    }
  }

  private var discoverSubtitle: String? {
    let count = syncService.discoveredHosts.count
    if count == 0, syncService.savedReconnectHost?.tailscaleAddress != nil {
      return "Saved Tailscale route"
    }
    if count == 0 {
      return "Looking nearby"
    }
    return count == 1 ? "1 nearby host found" : "\(count) nearby hosts found"
  }

  private var pairingHint: String? {
    guard syncService.activeHostProfile?.hostIdentity != nil else {
      return "Pick how to reach your Mac"
    }
    return "Add another Mac or replace the paired one"
  }
}

struct SettingsSectionHeader: View {
  let label: String
  let hint: String?

  init(label: String, hint: String? = nil) {
    self.label = label
    self.hint = hint
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Circle()
          .fill(ADEColor.purpleAccent.opacity(0.55))
          .frame(width: 4, height: 4)
        Text(label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.purpleAccent.opacity(0.85))
          .tracking(0.7)
      }
      if let hint {
        Text(hint)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .padding(.leading, 10)
      }
    }
    .padding(.horizontal, 4)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct SettingsPairActionRow: View {
  let icon: String
  let title: String
  let subtitle: String?
  let shimmerSubtitle: Bool
  let action: () -> Void

  init(
    icon: String,
    title: String,
    subtitle: String?,
    shimmerSubtitle: Bool = false,
    action: @escaping () -> Void
  ) {
    self.icon = icon
    self.title = title
    self.subtitle = subtitle
    self.shimmerSubtitle = shimmerSubtitle
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 14) {
        Image(systemName: icon)
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(ADEColor.purpleAccent)
          .frame(width: 38, height: 38)
          .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(
                LinearGradient(
                  colors: [
                    ADEColor.purpleAccent.opacity(0.30),
                    ADEColor.purpleAccent.opacity(0.10),
                  ],
                  startPoint: .top,
                  endPoint: .bottom
                )
              )
          )
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .strokeBorder(ADEColor.purpleAccent.opacity(0.35), lineWidth: 0.6)
          )
          .shadow(color: ADEColor.purpleGlow.opacity(0.25), radius: 6, y: 2)

        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.body.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
          if let subtitle {
            subtitleView(subtitle)
          }
        }

        Spacer(minLength: 8)

        Image(systemName: "chevron.right")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.purpleAccent.opacity(0.55))
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(
            LinearGradient(
              colors: [
                ADEColor.purpleAccent.opacity(0.06),
                Color.clear,
              ],
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            )
          )
      )
      .glassEffect(in: .rect(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .strokeBorder(
            LinearGradient(
              colors: [
                ADEColor.purpleAccent.opacity(0.32),
                ADEColor.border.opacity(0.10),
              ],
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            ),
            lineWidth: 0.75
          )
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
    .accessibilityLabel(subtitle.map { "\(title), \($0)" } ?? title)
  }

  @ViewBuilder
  private func subtitleView(_ text: String) -> some View {
    if shimmerSubtitle {
      HStack(spacing: 6) {
        Text(text)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
        ADESkeletonView(width: 10, height: 10, cornerRadius: 5)
      }
    } else {
      Text(text)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }
  }
}

// MARK: - Discover hosts sheet

struct DiscoverHostsSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let onPick: (DiscoveredSyncHost) -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 10) {
          let savedHost = syncService.savedReconnectHost
          let liveHosts = syncService.discoveredHosts.filter { host in
            guard let savedHost else { return true }
            if let hostIdentity = host.hostIdentity, let savedIdentity = savedHost.hostIdentity {
              return hostIdentity != savedIdentity
            }
            return host.id != savedHost.id
          }

          if savedHost == nil && liveHosts.isEmpty {
            VStack(spacing: 14) {
              ADESkeletonView(height: 56, cornerRadius: 14)
              ADESkeletonView(height: 56, cornerRadius: 14)
              Text("Looking for ADE hosts on your network...")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .padding(.top, 4)
            }
            .padding(.top, 24)
          } else {
            if let savedHost {
              Button {
                dismiss()
                Task { await syncService.reconnectIfPossible(userInitiated: true) }
              } label: {
                DiscoveredHostRow(
                  host: savedHost,
                  detailPrefix: savedHost.tailscaleAddress == nil ? "Saved" : "Saved Tailscale",
                  accessoryText: "Reconnect"
                )
              }
              .buttonStyle(ADEScaleButtonStyle())
            }

            ForEach(liveHosts) { host in
              Button {
                onPick(host)
              } label: {
                DiscoveredHostRow(host: host)
              }
              .buttonStyle(ADEScaleButtonStyle())
            }
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Nearby hosts")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
    }
  }
}

private struct DiscoveredHostRow: View {
  let host: DiscoveredSyncHost
  var detailPrefix: String?
  var accessoryText: String?

  var body: some View {
    HStack(spacing: 14) {
      Image(systemName: "desktopcomputer")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(ADEColor.purpleAccent)
        .frame(width: 36, height: 36)
        .background(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(ADEColor.purpleAccent.opacity(0.14))
        )

      VStack(alignment: .leading, spacing: 2) {
        Text(host.hostName)
          .font(.body.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
        Text(routeText)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }

      Spacer(minLength: 8)

      if let accessoryText {
        Text(accessoryText)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.purpleAccent)
      } else {
        Image(systemName: "chevron.right")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(ADEColor.surfaceBackground.opacity(0.08))
    )
    .glassEffect(in: .rect(cornerRadius: 14))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.75)
    )
  }

  private var routeText: String {
    let route = primaryRoute
    let prefix = detailPrefix ?? inferredRoutePrefix(for: route)
    guard let prefix else { return route }
    return "\(prefix): \(route)"
  }

  private var primaryRoute: String {
    if let tailscaleAddress = host.tailscaleAddress,
       detailPrefix?.localizedCaseInsensitiveContains("tailscale") == true {
      return tailscaleAddress
    }
    return host.addresses.first { address in
      !isLoopback(address) && !syncIsTailscaleRoute(address)
    } ?? host.tailscaleAddress ?? host.addresses.first ?? "No route"
  }

  private func inferredRoutePrefix(for route: String) -> String? {
    if syncIsTailscaleRoute(route) {
      return "Tailscale"
    }
    return nil
  }

  private func isLoopback(_ address: String) -> Bool {
    address == "127.0.0.1" || address == "::1"
  }
}

// MARK: - Scan QR sheet

struct ScanQRSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let onDecoded: (SyncPairingQrPayload) -> Void

  @State private var scanError: String?

  var body: some View {
    NavigationStack {
      Group {
        if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
          ZStack(alignment: .bottom) {
            PairingQrScannerRepresentable { scannedValue in
              handle(scannedValue: scannedValue)
            }
            .ignoresSafeArea()

            if let scanError {
              Text(scanError)
                .font(.footnote)
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(ADEColor.danger.opacity(0.85), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .padding(.horizontal, 24)
                .padding(.bottom, 48)
            }
          }
        } else {
          ContentUnavailableView(
            "Camera scanning unavailable",
            systemImage: "camera.metering.unknown",
            description: Text("Use Discover or Enter details to pair from this device.")
          )
        }
      }
      .navigationTitle("Scan QR code")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
        }
      }
      .adeNavigationGlass()
    }
  }

  private func handle(scannedValue: String) {
    do {
      let payload = try syncService.decodePairingQrPayload(from: scannedValue)
      scanError = nil
      onDecoded(payload)
    } catch {
      scanError = error.localizedDescription
    }
  }
}

// MARK: - Manual entry sheet

struct ManualEntrySheet: View {
  @Environment(\.dismiss) private var dismiss

  @State private var host: String = ""
  @State private var port: String = "8787"

  let onConnect: (String, Int) -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text("Reach your Mac directly")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("Use this when your network blocks Bonjour discovery.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)

          TextField("Host or IP address", text: $host)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .adeInsetField()

          TextField("Port", text: $port)
            .keyboardType(.numberPad)
            .adeInsetField()

          Button {
            let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
            let parsedPort = Int(port.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 8787
            guard !trimmedHost.isEmpty else { return }
            onConnect(trimmedHost, parsedPort)
          } label: {
            Text("Continue")
              .font(.subheadline.weight(.semibold))
              .frame(maxWidth: .infinity)
              .padding(.vertical, 10)
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.purpleAccent)
          .disabled(host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .padding(.top, 4)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 20)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Enter host details")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
    }
  }
}

// MARK: - QR scanner bridge

private struct PairingQrScannerRepresentable: UIViewControllerRepresentable {
  let onScan: (String) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(onScan: onScan)
  }

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let controller = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      qualityLevel: .fast,
      recognizesMultipleItems: false,
      isHighFrameRateTrackingEnabled: false,
      isPinchToZoomEnabled: true,
      isGuidanceEnabled: true,
      isHighlightingEnabled: false
    )
    controller.delegate = context.coordinator
    try? controller.startScanning()
    return controller
  }

  func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    private let onScan: (String) -> Void
    private var didEmit = false

    init(onScan: @escaping (String) -> Void) {
      self.onScan = onScan
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
      guard !didEmit else { return }
      for item in addedItems {
        if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue {
          didEmit = true
          onScan(payload)
          dataScanner.stopScanning()
          break
        }
      }
    }
  }
}
