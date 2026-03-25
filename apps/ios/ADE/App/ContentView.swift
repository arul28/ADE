import SwiftUI
import UIKit
import VisionKit

private let adeAccent = ADEColor.accent

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
        .badge(syncService.runningChatSessionCount)
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
    .tabBarMinimizeBehavior(.onScrollDown)
    .adeScreenBackground()
    .adeNavigationGlass()
    .sensoryFeedback(.selection, trigger: selectedTab)
    .onChange(of: syncService.settingsPresented) { _, presented in
      guard presented else { return }
      selectedTab = .settings
      syncService.settingsPresented = false
    }
    .onChange(of: syncService.requestedFilesNavigation?.id) { _, requestId in
      guard requestId != nil else { return }
      selectedTab = .files
    }
    .onChange(of: syncService.requestedLaneNavigation?.id) { _, requestId in
      guard requestId != nil else { return }
      selectedTab = .lanes
    }
  }
}

private struct ConnectionOverviewCard: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(alignment: .top, spacing: 14) {
        ADEBrandMark(size: 44)

        VStack(alignment: .leading, spacing: 5) {
          Text(statusTitle)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text(primarySubtitle)
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
          if let error = syncService.lastError,
             syncService.connectionState != .connected,
             syncService.connectionState != .syncing {
            Text(error)
              .font(.caption)
              .foregroundStyle(ADEColor.danger)
              .fixedSize(horizontal: false, vertical: true)
          }
        }

        Spacer(minLength: 0)

        StatusBadge(state: syncService.connectionState)
      }

      VStack(spacing: 10) {
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

      if syncService.hasFailedDomainStatuses {
        Button {
          Task {
            await syncService.retryFailedDomains()
          }
        } label: {
          Label("Retry all", systemImage: "arrow.clockwise")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .tint(adeAccent)
        .controlSize(.small)
      }
    }
    .adeGlassCard(cornerRadius: 20, padding: 18)
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
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 18)
      Text(label)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 12)
      Text(value)
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .multilineTextAlignment(.trailing)
    }
    .adeInsetField(cornerRadius: 12, padding: 12)
  }
}

private struct SettingsSectionCard<Content: View>: View {
  let title: String
  let content: Content

  init(_ title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      content
    }
    .adeGlassCard(cornerRadius: 18)
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
      ScrollView {
        LazyVStack(spacing: 14) {
          ConnectionOverviewCard()
            .environmentObject(syncService)

          SettingsSectionCard("Sync status") {
            VStack(spacing: 10) {
              ForEach(SyncDomain.allCases, id: \.self) { domain in
                SyncDomainStatusRow(domain: domain, status: syncService.status(for: domain))
                  .environmentObject(syncService)
              }
            }
          }

          if let profile = syncService.activeHostProfile {
            SettingsSectionCard("Saved host") {
              hostSummary(profile: profile)
            }
          } else {
            SettingsSectionCard("Connection") {
              Text("Pair once from this tab, then reconnect here without rescanning. If cached data remains after revoke or forget, it stays readable but is not treated as live.")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }

          SettingsSectionCard("Pairing") {
            VStack(spacing: 10) {
              Button {
                qrScanPresented = true
              } label: {
                Label("Scan host QR code", systemImage: "qrcode.viewfinder")
                  .frame(maxWidth: .infinity)
              }
              .buttonStyle(.glassProminent)
              .tint(adeAccent)

              Button {
                Task {
                  await syncService.reconnectIfPossible()
                }
              } label: {
                Label("Reconnect saved host", systemImage: "arrow.clockwise")
                  .frame(maxWidth: .infinity)
              }
              .buttonStyle(.glass)
              .disabled(syncService.activeHostProfile == nil)
            }
          }

          if !syncService.discoveredHosts.isEmpty {
            SettingsSectionCard("Discovered on LAN") {
              VStack(spacing: 10) {
                ForEach(syncService.discoveredHosts) { discovered in
                  VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top, spacing: 10) {
                      VStack(alignment: .leading, spacing: 4) {
                        Text(discovered.hostName)
                          .font(.headline)
                          .foregroundStyle(ADEColor.textPrimary)
                        Text(discovered.addresses.joined(separator: ", "))
                          .font(.caption.monospaced())
                          .foregroundStyle(ADEColor.textSecondary)
                      }
                      Spacer(minLength: 8)
                      Button("Use") {
                        host = discovered.addresses.first ?? host
                        port = String(discovered.port)
                        selectedHostIdentity = discovered.hostIdentity
                        selectedHostName = discovered.hostName
                        candidateAddresses = discovered.addresses
                        selectedTailscaleAddress = discovered.tailscaleAddress
                      }
                      .buttonStyle(.glassProminent)
                      .controlSize(.small)
                    }
                    if let tailscaleAddress = discovered.tailscaleAddress {
                      Label("Tailscale \(tailscaleAddress)", systemImage: "network")
                        .font(.caption)
                        .foregroundStyle(ADEColor.textSecondary)
                    }
                  }
                  .adeInsetField(cornerRadius: 14, padding: 14)
                }
              }
            }
          }

          SettingsSectionCard("Manual code entry") {
            VStack(spacing: 10) {
              TextField("Host", text: $host)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .adeInsetField()

              TextField("Port", text: $port)
                .keyboardType(.numberPad)
                .adeInsetField()

              TextField("Pairing code", text: $pairingCode)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .adeInsetField()

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
                  .frame(maxWidth: .infinity)
              }
              .buttonStyle(.glassProminent)
              .tint(adeAccent)
              .disabled(pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
          }

          if let error = qrError ?? syncService.lastError {
            SettingsSectionCard("Status") {
              Text(error)
                .font(.subheadline)
                .foregroundStyle(ADEColor.danger)
            }
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Settings")
      .sensoryFeedback(.success, trigger: syncService.connectionState == .connected)
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
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(profile.hostName ?? profile.lastSuccessfulAddress ?? "Saved ADE host")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          if let address = profile.lastSuccessfulAddress {
            Text("\(address):\(profile.port)")
              .font(.caption.monospaced())
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        Spacer(minLength: 8)
        StatusBadge(state: syncService.connectionState)
      }

      if !profile.discoveredLanAddresses.isEmpty {
        Label(profile.discoveredLanAddresses.joined(separator: ", "), systemImage: "wifi")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
      if let tailscaleAddress = profile.tailscaleAddress {
        Label("Tailscale \(tailscaleAddress)", systemImage: "network")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }

      ADEGlassGroup {
        Button("Disconnect") {
          syncService.disconnect()
        }
        .buttonStyle(.glass)

        Button("Forget host", role: .destructive) {
          syncService.forgetHost()
        }
        .buttonStyle(.glass)
      }
    }
  }
}

private struct StatusBadge: View {
  let state: RemoteConnectionState

  var body: some View {
    HStack(spacing: 6) {
      if state == .connecting || state == .syncing {
        ProgressView()
          .controlSize(.mini)
          .tint(color)
      }
      Text(label)
        .font(.caption.weight(.semibold))
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(color.opacity(0.14), in: Capsule())
    .foregroundStyle(color)
    .glassEffect()
    .animation(.smooth, value: state)
    .accessibilityLabel("Connection status: \(label)")
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
      return ADEColor.success
    case .connecting, .syncing:
      return ADEColor.warning
    case .error:
      return ADEColor.danger
    case .disconnected:
      return ADEColor.textSecondary
    }
  }
}

private struct SyncDomainStatusRow: View {
  @EnvironmentObject private var syncService: SyncService

  let domain: SyncDomain
  let status: SyncDomainStatus

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: icon)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 18)

        VStack(alignment: .leading, spacing: 8) {
          Text(title)
            .font(.body.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)

          if let lastHydratedAt = status.lastHydratedAt {
            Text("Hydrated \(RelativeDateTimeFormatter().localizedString(for: lastHydratedAt, relativeTo: Date()))")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          } else {
            Text(phaseDescription)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }

          if let lastError = status.lastError, status.phase == .failed {
            Text(lastError)
              .font(.caption)
              .foregroundStyle(ADEColor.danger)
              .fixedSize(horizontal: false, vertical: true)
          }

          if status.phase == .failed {
            Button("Retry") {
              Task {
                await syncService.retry(domain: domain)
              }
            }
            .buttonStyle(.glassProminent)
            .tint(adeAccent)
            .controlSize(.small)
          }
        }

        Spacer(minLength: 8)

        if status.phase == .syncingInitialData || status.phase == .hydrating {
          ProgressView()
            .controlSize(.mini)
        }
        ADEStatusPill(text: phaseLabel, tint: tint)
      }
    }
    .adeInsetField(cornerRadius: 14, padding: 14)
    .animation(.smooth, value: status.phase)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title): \(phaseLabel). \(phaseDescription)")
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
    case .syncingInitialData:
      return "syncing initial data"
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
    case .syncingInitialData:
      return SyncHydrationMessaging.initialData
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
      return ADEColor.textSecondary
    case .syncingInitialData, .hydrating:
      return ADEColor.warning
    case .ready:
      return ADEColor.success
    case .failed:
      return ADEColor.danger
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
      .adeNavigationGlass()
    }
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
          .foregroundStyle(ADEColor.accent)
      }
    }
    .frame(width: width, height: size)
    .background(ADEColor.recessedBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .glassEffect(in: .rect(cornerRadius: 14))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.75)
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
