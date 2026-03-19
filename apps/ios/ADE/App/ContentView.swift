import SwiftUI
import UIKit
import VisionKit

private let adeAccent = ADEPalette.accent

private enum RootTab: Hashable {
  case lanes
  case files
  case work
  case prs
  case settings
}

struct ContentView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var selectedTab: RootTab = .lanes

  var body: some View {
    TabView(selection: $selectedTab) {
        LanesTabView()
          .tag(RootTab.lanes)
          .tabItem {
            Label("Lanes", systemImage: "square.stack.3d.up")
          }
        FilesTabView()
          .tag(RootTab.files)
          .tabItem {
            Label("Files", systemImage: "doc.text")
          }
        WorkTabView()
          .tag(RootTab.work)
          .tabItem {
            Label("Work", systemImage: "terminal")
          }
        PRsTabView()
          .tag(RootTab.prs)
          .tabItem {
            Label("PRs", systemImage: "arrow.triangle.pull")
          }
        ConnectionSettingsView()
          .tag(RootTab.settings)
          .tabItem {
            Label("Settings", systemImage: "gearshape")
          }
    }
    .tint(adeAccent)
    .background(ADEPalette.pageBackground.ignoresSafeArea())
    .preferredColorScheme(.dark)
    .onChange(of: syncService.settingsPresented) { _, presented in
      guard presented else { return }
      selectedTab = .settings
      syncService.settingsPresented = false
    }
    .onChange(of: syncService.requestedFilesNavigation?.id) { _, requestId in
      guard requestId != nil else { return }
      selectedTab = .files
    }
  }
}

private struct ConnectionOverviewCard: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        ADEBrandMark(size: 42)

        VStack(alignment: .leading, spacing: 4) {
          Text(statusTitle)
            .font(.headline)
          Text(primarySubtitle)
            .font(.subheadline)
            .foregroundStyle(ADEPalette.textSecondary)
          if let error = syncService.lastError,
             syncService.connectionState != .connected,
             syncService.connectionState != .syncing {
            Text(error)
              .font(.caption)
              .foregroundStyle(ADEPalette.danger)
              .fixedSize(horizontal: false, vertical: true)
          }
        }

        Spacer()

        StatusBadge(state: syncService.connectionState)
      }

      VStack(spacing: 8) {
        SettingsMetricRow(
          icon: "externaldrive.badge.wifi",
          label: "Host route",
          value: syncService.currentAddress ?? "No live route"
        )
        SettingsMetricRow(
          icon: "arrow.trianglehead.2.clockwise.rotate.90",
          label: "Queued work",
          value: syncService.pendingOperationCount == 0 ? "Queue clear" : "\(syncService.pendingOperationCount) queued"
        )
        SettingsMetricRow(
          icon: "clock.arrow.circlepath",
          label: "Last sync",
          value: lastSyncText
        )
      }
    }
    .foregroundStyle(ADEPalette.textPrimary)
    .adeGlassCard(cornerRadius: 16, padding: 16)
  }

  private var statusTitle: String {
    switch syncService.connectionState {
    case .connected:
      return "Connected to host"
    case .connecting:
      return "Connecting to host"
    case .syncing:
      return "Syncing project state"
    case .error:
      return "Connection needs attention"
    case .disconnected:
      if syncService.activeHostProfile == nil {
        return syncService.hasCachedHostData ? "Pair again to relink host" : "Ready to pair"
      }
      return "Saved host disconnected"
    }
  }

  private var primarySubtitle: String {
    if let hostName = syncService.hostName {
      return hostName
    }
    if let profile = syncService.activeHostProfile {
      return profile.hostName ?? profile.lastSuccessfulAddress ?? "Saved host"
    }
    if syncService.hasCachedHostData {
      return "Cached phone data is still visible, but the previous host trust was cleared. Pair again before trusting it."
    }
    return "Scan the host QR code or choose a discovered ADE host."
  }

  private var lastSyncText: String {
    guard let date = syncService.lastSyncAt else { return "No sync yet" }
    return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
  }
}

private struct SettingsMetricRow: View {
  let icon: String
  let label: String
  let value: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: icon)
        .foregroundStyle(ADEPalette.textSecondary)
        .frame(width: 18)
      Text(label)
        .font(.caption)
        .foregroundStyle(ADEPalette.textSecondary)
      Spacer(minLength: 12)
      Text(value)
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(ADEPalette.textPrimary)
        .multilineTextAlignment(.trailing)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}

struct ConnectionSettingsView: View {
  @EnvironmentObject private var syncService: SyncService

  @State private var host = "127.0.0.1"
  @State private var port = "8787"
  @State private var pairingCode = ""
  @State private var selectedHostIdentity: String?
  @State private var selectedHostName: String?
  @State private var candidateAddresses: [String] = []
  @State private var selectedTailscaleAddress: String?
  @State private var qrScanPresented = false
  @State private var qrError: String?

  var body: some View {
    NavigationStack {
      List {
        Section {
          ConnectionOverviewCard()
            .environmentObject(syncService)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        }
        .listRowBackground(Color.clear)

        Section("Sync status") {
          ForEach(SyncDomain.allCases, id: \.self) { domain in
            SyncDomainStatusRow(domain: domain, status: syncService.status(for: domain))
          }
        }

        if let profile = syncService.activeHostProfile {
          Section("Saved host") {
            hostSummary(profile: profile)
          }
        } else {
          Section("Connection") {
            Text("Pair once from this tab, then reconnect here without rescanning. If cached data remains after revoke or forget, it stays readable but is not treated as live.")
              .font(.subheadline)
              .foregroundStyle(ADEPalette.textSecondary)
          }
        }

        Section("Pairing") {
          Button {
            qrScanPresented = true
          } label: {
            Label("Scan host QR code", systemImage: "qrcode.viewfinder")
          }
          .tint(adeAccent)

          Button {
            Task {
              await syncService.reconnectIfPossible()
            }
          } label: {
            Label("Reconnect saved host", systemImage: "arrow.clockwise")
          }
          .disabled(syncService.activeHostProfile == nil)
        }

        if !syncService.discoveredHosts.isEmpty {
          Section("Discovered on LAN") {
            ForEach(syncService.discoveredHosts) { discovered in
              VStack(alignment: .leading, spacing: 8) {
                HStack {
                  VStack(alignment: .leading, spacing: 3) {
                    Text(discovered.hostName)
                      .font(.headline)
                    Text(discovered.addresses.joined(separator: ", "))
                      .font(.caption.monospaced())
                      .foregroundStyle(.secondary)
                  }
                  Spacer()
                  Button("Use") {
                    host = discovered.addresses.first ?? host
                    port = String(discovered.port)
                    selectedHostIdentity = discovered.hostIdentity
                    selectedHostName = discovered.hostName
                    candidateAddresses = discovered.addresses
                    selectedTailscaleAddress = discovered.tailscaleAddress
                  }
                  .buttonStyle(.borderedProminent)
                }
                if let tailscaleAddress = discovered.tailscaleAddress {
                  Label("Tailscale \(tailscaleAddress)", systemImage: "network")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
              }
              .padding(.vertical, 4)
            }
          }
        }

        Section("Manual code entry") {
          TextField("Host", text: $host)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          TextField("Port", text: $port)
            .keyboardType(.numberPad)
          TextField("Pairing code", text: $pairingCode)
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()

          Button {
            Task {
              await syncService.pairAndConnect(
                host: host,
                port: Int(port) ?? 8787,
                code: pairingCode,
                hostIdentity: selectedHostIdentity,
                hostName: selectedHostName,
                candidateAddresses: candidateAddresses,
                tailscaleAddress: selectedTailscaleAddress
              )
            }
          } label: {
            Label("Pair and connect", systemImage: "link.badge.plus")
          }
          .buttonStyle(.borderedProminent)
          .disabled(pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }

        if let error = qrError ?? syncService.lastError {
          Section("Status") {
            Text(error)
              .foregroundStyle(ADEPalette.danger)
          }
        }
      }
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
      .navigationTitle("Settings")
      .onAppear {
        guard let profile = syncService.activeHostProfile else { return }
        host = profile.lastSuccessfulAddress ?? profile.savedAddressCandidates.first ?? host
        port = String(profile.port)
        selectedHostIdentity = profile.hostIdentity
        selectedHostName = profile.hostName
        candidateAddresses = profile.savedAddressCandidates
        selectedTailscaleAddress = profile.tailscaleAddress
      }
      .sheet(isPresented: $qrScanPresented) {
        PairingQrScannerSheet { scannedValue in
          do {
            let payload = try syncService.decodePairingQrPayload(from: scannedValue)
            qrError = nil
            host = payload.addressCandidates.first?.host ?? host
            port = String(payload.port)
            pairingCode = payload.pairingCode
            selectedHostIdentity = payload.hostIdentity.deviceId
            selectedHostName = payload.hostIdentity.name
            candidateAddresses = payload.addressCandidates.map(\.host)
            selectedTailscaleAddress = payload.addressCandidates.first(where: { $0.kind == "tailscale" })?.host
            qrScanPresented = false
            Task {
              await syncService.pairAndConnect(using: payload)
            }
          } catch {
            qrError = error.localizedDescription
          }
        }
      }
    }
  }

  @ViewBuilder
  private func hostSummary(profile: HostConnectionProfile) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text(profile.hostName ?? profile.lastSuccessfulAddress ?? "Saved ADE host")
            .font(.headline)
          if let address = profile.lastSuccessfulAddress {
            Text("\(address):\(profile.port)")
              .font(.caption.monospaced())
              .foregroundStyle(.secondary)
          }
        }
        Spacer()
        StatusBadge(state: syncService.connectionState)
      }

      if !profile.discoveredLanAddresses.isEmpty {
        Label(profile.discoveredLanAddresses.joined(separator: ", "), systemImage: "wifi")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      if let tailscaleAddress = profile.tailscaleAddress {
        Label("Tailscale \(tailscaleAddress)", systemImage: "network")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      HStack(spacing: 10) {
        Button("Disconnect") {
          syncService.disconnect()
        }
        .buttonStyle(.bordered)

        Button("Forget host", role: .destructive) {
          syncService.forgetHost()
        }
        .buttonStyle(.bordered)
      }
    }
    .padding(.vertical, 4)
  }
}

private struct StatusBadge: View {
  let state: RemoteConnectionState

  var body: some View {
    Text(label)
      .font(.caption.weight(.semibold))
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .foregroundStyle(color)
  }

  private var label: String {
    switch state {
    case .connected:
      return "Connected"
    case .connecting:
      return "Connecting"
    case .syncing:
      return "Syncing"
    case .error:
      return "Error"
    case .disconnected:
      return "Offline"
    }
  }

  private var color: Color {
    switch state {
    case .connected:
      return ADEPalette.success
    case .connecting, .syncing:
      return ADEPalette.warning
    case .error:
      return ADEPalette.danger
    case .disconnected:
      return ADEPalette.textSecondary
    }
  }
}

private struct SyncDomainStatusRow: View {
  let domain: SyncDomain
  let status: SyncDomainStatus

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 10) {
        Image(systemName: icon)
          .foregroundStyle(ADEPalette.textSecondary)
          .frame(width: 18)
        Text(title)
          .font(.body.weight(.medium))
        Spacer()
        ADEStatusPill(text: phaseLabel, tint: tint)
      }

      HStack {
        if let lastHydratedAt = status.lastHydratedAt {
          Text("Hydrated \(RelativeDateTimeFormatter().localizedString(for: lastHydratedAt, relativeTo: Date()))")
            .font(.caption)
            .foregroundStyle(ADEPalette.textSecondary)
        } else {
          Text(phaseDescription)
            .font(.caption)
            .foregroundStyle(ADEPalette.textSecondary)
        }
        Spacer()
      }

      if let lastError = status.lastError, status.phase == .failed {
        Text(lastError)
          .font(.caption)
          .foregroundStyle(ADEPalette.danger)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.vertical, 2)
  }

  private var title: String {
    switch domain {
    case .lanes:
      return "Lanes"
    case .files:
      return "Files"
    case .work:
      return "Work"
    case .prs:
      return "PRs"
    }
  }

  private var icon: String {
    switch domain {
    case .lanes:
      return "square.stack.3d.up"
    case .files:
      return "doc.text"
    case .work:
      return "terminal"
    case .prs:
      return "arrow.triangle.pull"
    }
  }

  private var phaseLabel: String {
    switch status.phase {
    case .disconnected:
      return "offline"
    case .hydrating:
      return "hydrating"
    case .ready:
      return "ready"
    case .failed:
      return "failed"
    }
  }

  private var phaseDescription: String {
    switch status.phase {
    case .disconnected:
      return "Waiting for a live host connection."
    case .hydrating:
      return "Refreshing host state on this device."
    case .ready:
      return "Hydrated and ready on this phone."
    case .failed:
      return "The last host refresh did not complete."
    }
  }

  private var tint: Color {
    switch status.phase {
    case .disconnected:
      return ADEPalette.textSecondary
    case .hydrating:
      return ADEPalette.warning
    case .ready:
      return ADEPalette.success
    case .failed:
      return ADEPalette.danger
    }
  }
}

private struct PairingQrScannerSheet: View {
  let onScan: (String) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
          PairingQrScannerRepresentable(onScan: onScan)
          .ignoresSafeArea()
        } else {
          ContentUnavailableView(
            "Camera scanning unavailable",
            systemImage: "camera.metering.unknown",
            description: Text("Use the numeric pairing code on the host or scan from a physical iPhone running iOS 26.")
          )
        }
      }
      .navigationTitle("Scan ADE host")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") {
            dismiss()
          }
        }
      }
    }
  }
}

enum ADEPalette {
  static let pageBackground = Color(red: 13 / 255, green: 11 / 255, blue: 19 / 255)
  static let surfaceBackground = Color(red: 24 / 255, green: 20 / 255, blue: 33 / 255)
  static let recessedBackground = Color(red: 18 / 255, green: 15 / 255, blue: 25 / 255)
  static let border = Color(red: 62 / 255, green: 57 / 255, blue: 77 / 255)
  static let textPrimary = Color(red: 250 / 255, green: 250 / 255, blue: 250 / 255)
  static let textSecondary = Color(red: 161 / 255, green: 161 / 255, blue: 170 / 255)
  static let textMuted = Color(red: 139 / 255, green: 139 / 255, blue: 154 / 255)
  static let accent = Color(red: 167 / 255, green: 139 / 255, blue: 250 / 255)
  static let success = Color(red: 34 / 255, green: 197 / 255, blue: 94 / 255)
  static let warning = Color(red: 245 / 255, green: 158 / 255, blue: 11 / 255)
  static let danger = Color(red: 239 / 255, green: 68 / 255, blue: 68 / 255)
}

struct ADENoticeCard: View {
  let title: String
  let message: String
  let icon: String
  let tint: Color
  let actionTitle: String?
  let action: (() -> Void)?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: icon)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 28, height: 28)
          .background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

        VStack(alignment: .leading, spacing: 4) {
          Text(title)
            .font(.headline)
            .foregroundStyle(ADEPalette.textPrimary)
          Text(message)
            .font(.subheadline)
            .foregroundStyle(ADEPalette.textSecondary)
        }

        Spacer()
      }

      if let actionTitle, let action {
        Button(actionTitle, action: action)
          .buttonStyle(.borderedProminent)
          .tint(ADEPalette.accent)
      }
    }
    .adeGlassCard()
  }
}

struct ADEStatusPill: View {
  let text: String
  let tint: Color

  var body: some View {
    Text(text)
      .font(.system(.caption2, design: .monospaced).weight(.semibold))
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .foregroundStyle(tint)
  }
}

private struct ADEGlassCardModifier: ViewModifier {
  let cornerRadius: CGFloat
  let padding: CGFloat

  func body(content: Content) -> some View {
    content
      .padding(padding)
      .background(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .fill(ADEPalette.surfaceBackground)
          .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
              .stroke(ADEPalette.border, lineWidth: 1)
          )
      )
      .shadow(color: Color.black.opacity(0.18), radius: 10, x: 0, y: 4)
  }
}

extension View {
  func adeGlassCard(cornerRadius: CGFloat = 14, padding: CGFloat = 16) -> some View {
    modifier(ADEGlassCardModifier(cornerRadius: cornerRadius, padding: padding))
  }
}

private struct ADEBrandMark: View {
  let size: CGFloat

  private var width: CGFloat {
    UIImage(named: "BrandMark") == nil ? size : size * 1.72
  }

  var body: some View {
    Group {
      if let image = UIImage(named: "BrandMark") {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .padding(.horizontal, 8)
          .padding(.vertical, 10)
      } else {
        Image(systemName: "bolt.fill")
          .font(.system(size: size * 0.38, weight: .semibold))
          .foregroundStyle(ADEPalette.accent)
      }
    }
    .frame(width: width, height: size)
    .background(ADEPalette.recessedBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEPalette.border, lineWidth: 1)
    )
  }
}

private struct PairingQrScannerRepresentable: UIViewControllerRepresentable {
  let onScan: (String) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(onScan: onScan)
  }

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let controller = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      qualityLevel: .balanced,
      recognizesMultipleItems: false,
      isHighFrameRateTrackingEnabled: true,
      isPinchToZoomEnabled: true,
      isGuidanceEnabled: true,
      isHighlightingEnabled: true
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
