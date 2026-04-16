import SwiftUI
import UIKit
import VisionKit

// MARK: - Root view

struct ConnectionSettingsView: View {
  @EnvironmentObject private var syncService: SyncService

  @State private var presentedSheet: PairSheetRoute?
  @State private var pinPreset: PinPreset?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 22) {
          ConnectionStatusCard()
            .environmentObject(syncService)
            .padding(.horizontal, 16)
            .padding(.top, 4)

          VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
              Circle()
                .fill(ADEColor.purpleAccent.opacity(0.55))
                .frame(width: 4, height: 4)
              Text("PAIR A NEW COMPUTER")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.purpleAccent.opacity(0.85))
                .tracking(0.7)
            }
            .padding(.horizontal, 4)

            GlassEffectContainer(spacing: 8) {
              VStack(spacing: 8) {
                PairActionRow(
                  icon: "dot.radiowaves.left.and.right",
                  title: "Discover on network",
                  subtitle: discoverSubtitle,
                  shimmerSubtitle: syncService.discoveredHosts.isEmpty
                ) {
                  presentedSheet = .discover
                }

                PairActionRow(
                  icon: "qrcode.viewfinder",
                  title: "Scan QR code",
                  subtitle: nil,
                  shimmerSubtitle: false
                ) {
                  presentedSheet = .qr
                }

                PairActionRow(
                  icon: "keyboard",
                  title: "Enter details",
                  subtitle: nil,
                  shimmerSubtitle: false
                ) {
                  presentedSheet = .manual
                }
              }
            }
          }
          .padding(.horizontal, 16)

          if let error = syncService.lastError,
             syncService.connectionState != .connected,
             syncService.connectionState != .syncing {
            Text(error)
              .font(.footnote)
              .foregroundStyle(ADEColor.danger)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 20)
              .fixedSize(horizontal: false, vertical: true)
          }

          AppearanceSection()
            .padding(.horizontal, 16)

          Spacer(minLength: 20)
        }
        .padding(.vertical, 12)
      }
      .background(SyncAuroraBackground().ignoresSafeArea())
      .adeNavigationGlass()
      .navigationTitle("Sync")
      .sheet(item: $presentedSheet) { route in
        switch route {
        case .discover:
          DiscoverHostsSheet { host in
            presentedSheet = nil
            pinPreset = .discover(host)
          }
          .environmentObject(syncService)
          .presentationDetents([.medium, .large])

        case .qr:
          ScanQRSheet { payload in
            presentedSheet = nil
            pinPreset = .qr(payload)
          }
          .environmentObject(syncService)
          .presentationDetents([.large])

        case .manual:
          ManualEntrySheet { host, port in
            presentedSheet = nil
            pinPreset = .manual(host: host, port: port)
          }
          .presentationDetents([.medium])
        }
      }
      .sheet(item: $pinPreset) { preset in
        PinSheet(preset: preset, syncService: syncService)
          .presentationDetents([.large])
      }
    }
  }

  private var discoverSubtitle: String? {
    let count = syncService.discoveredHosts.count
    if count == 0 {
      return "Looking nearby"
    }
    return count == 1 ? "1 nearby" : "\(count) nearby"
  }
}

// MARK: - Sheet route + PIN preset

private enum PairSheetRoute: Identifiable {
  case discover
  case qr
  case manual

  var id: String {
    switch self {
    case .discover: return "discover"
    case .qr: return "qr"
    case .manual: return "manual"
    }
  }
}

enum PinPreset: Identifiable {
  case discover(DiscoveredSyncHost)
  case qr(SyncPairingQrPayload)
  case manual(host: String, port: Int)

  var id: String {
    switch self {
    case .discover(let host):
      return "discover-\(host.id)"
    case .qr(let payload):
      return "qr-\(payload.hostIdentity.deviceId)"
    case .manual(let host, let port):
      return "manual-\(host)-\(port)"
    }
  }

  var hostDisplayName: String {
    switch self {
    case .discover(let host):
      return host.hostName
    case .qr(let payload):
      return payload.hostIdentity.name
    case .manual(let host, _):
      return host
    }
  }
}

// MARK: - Connection status card

private struct ConnectionStatusCard: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  @State private var pulsing = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .center, spacing: 12) {
        statusDot
        Text(statusTitle)
          .font(.system(.body, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
      }

      if syncService.connectionState == .connected {
        VStack(alignment: .leading, spacing: 6) {
          if let hostName = displayHostName {
            Text(hostName)
              .font(.title3.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
          }
          if let routeLine {
            Text(routeLine)
              .font(.footnote.monospaced())
              .foregroundStyle(ADEColor.textSecondary)
          }
        }

        HStack {
          Spacer()
          Button {
            syncService.disconnect()
          } label: {
            Text("Disconnect")
              .font(.subheadline.weight(.semibold))
              .padding(.horizontal, 16)
              .padding(.vertical, 8)
          }
          .buttonStyle(.glass)
          .tint(ADEColor.purpleAccent)
        }
      } else if syncService.connectionState == .connecting || syncService.connectionState == .syncing {
        Text(connectingSubtitle)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
      } else {
        Text("Pair a computer to sync.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .fill(
          LinearGradient(
            colors: [
              ADEColor.purpleAccent.opacity(0.10),
              ADEColor.purpleAccent.opacity(0.02),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
    )
    .glassEffect(in: .rect(cornerRadius: 20))
    .overlay(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .strokeBorder(
          LinearGradient(
            colors: [
              statusBorderColor.opacity(0.55),
              statusBorderColor.opacity(0.10),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          ),
          lineWidth: 0.9
        )
    )
    .shadow(color: statusGlowColor.opacity(0.28), radius: 22, y: 8)
    .animation(.spring(response: 0.4, dampingFraction: 0.8), value: syncService.connectionState)
    .onAppear {
      pulsing = syncService.connectionState == .connecting
    }
    .onChange(of: syncService.connectionState) { _, newValue in
      pulsing = newValue == .connecting
    }
  }

  private var statusDot: some View {
    ZStack {
      Circle()
        .fill(statusDotColor.opacity(0.45))
        .frame(width: 24, height: 24)
        .blur(radius: 6)

      Circle()
        .fill(
          RadialGradient(
            colors: [
              statusDotColor,
              statusDotColor.opacity(0.55),
            ],
            center: .init(x: 0.35, y: 0.32),
            startRadius: 0.5,
            endRadius: 8
          )
        )
        .frame(width: 14, height: 14)
        .overlay(
          Circle().strokeBorder(.white.opacity(0.45), lineWidth: 0.6)
        )
    }
    .scaleEffect(shouldPulse && pulsing ? 1.18 : 1.0)
    .animation(pulseAnimation, value: pulsing)
  }

  private var shouldPulse: Bool {
    (syncService.connectionState == .connecting || syncService.connectionState == .syncing) && !reduceMotion
  }

  private var pulseAnimation: Animation? {
    guard !reduceMotion else { return nil }
    return .smooth(duration: 1.0).repeatForever(autoreverses: true)
  }

  private var statusDotColor: Color {
    switch syncService.connectionState {
    case .connected:
      return ADEColor.purpleAccent
    case .connecting, .syncing:
      return ADEColor.warning
    case .error:
      return ADEColor.danger
    case .disconnected:
      return Color(red: 156.0 / 255.0, green: 145.0 / 255.0, blue: 200.0 / 255.0)
    }
  }

  private var statusBorderColor: Color {
    switch syncService.connectionState {
    case .connected:
      return ADEColor.purpleAccent
    case .connecting, .syncing:
      return ADEColor.warning
    case .error:
      return ADEColor.danger
    case .disconnected:
      return ADEColor.purpleAccent
    }
  }

  private var statusGlowColor: Color {
    switch syncService.connectionState {
    case .connected:
      return ADEColor.purpleGlow
    case .disconnected:
      return ADEColor.purpleAccent.opacity(0.18)
    default:
      return .clear
    }
  }

  private var statusTitle: String {
    switch syncService.connectionState {
    case .connected:
      return "Connected"
    case .connecting:
      return "Connecting"
    case .syncing:
      return "Syncing"
    case .error:
      return "Connection error"
    case .disconnected:
      return "Not connected"
    }
  }

  private var connectingSubtitle: String {
    if let hostName = displayHostName {
      return "Reaching \(hostName)..."
    }
    return "Reaching host..."
  }

  private var displayHostName: String? {
    if let name = syncService.hostName, !name.isEmpty {
      return name
    }
    return syncService.activeHostProfile?.hostName
  }

  private var routeLine: String? {
    guard let address = syncService.currentAddress ?? syncService.activeHostProfile?.lastSuccessfulAddress else {
      return nil
    }
    if let port = syncService.activeHostProfile?.port {
      return "\(address) · :\(port)"
    }
    return address
  }
}

// MARK: - Pair action row

private struct PairActionRow: View {
  let icon: String
  let title: String
  let subtitle: String?
  let shimmerSubtitle: Bool
  let action: () -> Void

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
          .glassEffect(in: .rect(cornerRadius: 12))
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

private struct DiscoverHostsSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let onPick: (DiscoveredSyncHost) -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 10) {
          if syncService.discoveredHosts.isEmpty {
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
            ForEach(syncService.discoveredHosts) { host in
              Button {
                onPick(host)
              } label: {
                HStack(spacing: 14) {
                  Image(systemName: "desktopcomputer")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(ADEColor.purpleAccent)
                    .frame(width: 36, height: 36)
                    .background(
                      RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(ADEColor.purpleAccent.opacity(0.14))
                    )
                    .glassEffect(in: .rect(cornerRadius: 12))

                  VStack(alignment: .leading, spacing: 2) {
                    Text(host.hostName)
                      .font(.body.weight(.medium))
                      .foregroundStyle(ADEColor.textPrimary)
                    Text(host.addresses.first ?? "No route")
                      .font(.caption.monospaced())
                      .foregroundStyle(ADEColor.textSecondary)
                  }

                  Spacer(minLength: 8)

                  Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ADEColor.textMuted)
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

// MARK: - Scan QR sheet

private struct ScanQRSheet: View {
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

private struct ManualEntrySheet: View {
  @Environment(\.dismiss) private var dismiss

  @State private var host: String = ""
  @State private var port: String = "8787"

  let onConnect: (String, Int) -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text("Enter host details")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .padding(.horizontal, 4)

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
        .padding(.horizontal, 16)
        .padding(.vertical, 20)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Enter details")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
    }
  }
}

// MARK: - PIN sheet

private struct PinSheet: View {
  @Environment(\.dismiss) private var dismiss

  let preset: PinPreset
  let syncService: SyncService

  @State private var pin: String = ""
  @State private var isSubmitting = false
  @State private var localError: String?

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 18) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Enter PIN")
            .font(.title2.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Paired with \(preset.hostDisplayName)")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }

        HStack(spacing: 10) {
          ForEach(0..<6, id: \.self) { index in
            PinDigitBox(
              digit: digit(at: index),
              isActive: !isSubmitting && index == cursorIndex
            )
          }
        }
        .accessibilityLabel("Pairing PIN")
        .accessibilityValue(pin.isEmpty ? "No digits entered" : "\(pin.count) of 6 digits entered")

        Text("Shown on your Mac under Settings, then Sync.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)

        PinKeypad(
          isDisabled: isSubmitting,
          onDigit: appendDigit,
          onDelete: deleteDigit
        )
        .padding(.top, 2)

        if let error = localError {
          Text(error)
            .font(.footnote)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
        }

        Spacer(minLength: 0)

        HStack(spacing: 10) {
          Button {
            if isSubmitting {
              syncService.disconnect(clearCredentials: false)
            }
            dismiss()
          } label: {
            Text("Cancel")
              .font(.subheadline.weight(.semibold))
              .frame(maxWidth: .infinity)
              .padding(.vertical, 10)
          }
          .buttonStyle(.glass)

          Button {
            submit()
          } label: {
            HStack {
              if isSubmitting {
                ProgressView().controlSize(.small)
              }
              Text("Connect")
                .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.purpleAccent)
          .disabled(!isComplete || isSubmitting)
        }
      }
      .padding(.horizontal, 20)
      .padding(.vertical, 24)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationBarTitleDisplayMode(.inline)
      .interactiveDismissDisabled(isSubmitting)
    }
  }

  private var isComplete: Bool { pin.count == 6 }

  private var cursorIndex: Int { min(pin.count, 5) }

  private func digit(at index: Int) -> String {
    let chars = Array(pin)
    return index < chars.count ? String(chars[index]) : ""
  }

  private func appendDigit(_ digit: String) {
    guard !isSubmitting, pin.count < 6 else { return }
    localError = nil
    pin.append(digit)
  }

  private func deleteDigit() {
    guard !isSubmitting, !pin.isEmpty else { return }
    localError = nil
    pin.removeLast()
  }

  private func submit() {
    guard isComplete, !isSubmitting else { return }
    isSubmitting = true
    localError = nil
    let code = pin

    Task { @MainActor in
      switch preset {
      case .discover(let host):
        await syncService.pairAndConnect(
          host: host.addresses.first ?? host.hostName,
          port: host.port,
          code: code,
          hostIdentity: host.hostIdentity,
          hostName: host.hostName,
          candidateAddresses: host.addresses,
          tailscaleAddress: host.tailscaleAddress
        )

      case .qr(let payload):
        let candidateAddresses = payload.addressCandidates.map(\.host)
        await syncService.pairAndConnect(
          host: candidateAddresses.first ?? "127.0.0.1",
          port: payload.port,
          code: code,
          hostIdentity: payload.hostIdentity.deviceId,
          hostName: payload.hostIdentity.name,
          candidateAddresses: candidateAddresses,
          tailscaleAddress: payload.addressCandidates.first(where: { $0.kind == "tailscale" })?.host
        )

      case .manual(let host, let port):
        await syncService.pairAndConnect(
          host: host,
          port: port,
          code: code,
          hostIdentity: nil,
          hostName: nil,
          candidateAddresses: [host],
          tailscaleAddress: nil
        )
      }

      guard isSubmitting else { return }
      if syncService.connectionState == .connected {
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.impactOccurred()
        isSubmitting = false
        dismiss()
      } else {
        ADEHaptics.error()
        isSubmitting = false
        localError = syncService.lastError ?? "Incorrect PIN."
        pin = ""
      }
    }
  }
}

// MARK: - PIN digit box

private struct PinDigitBox: View {
  let digit: String
  let isActive: Bool

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(ADEColor.recessedBackground.opacity(0.82))

      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(
          isActive ? ADEColor.purpleAccent : ADEColor.border.opacity(0.25),
          lineWidth: isActive ? 1.5 : 0.75
        )

      Text(digit)
        .font(.system(size: 28, weight: .semibold, design: .rounded))
        .foregroundStyle(ADEColor.textPrimary)
    }
    .frame(width: 44, height: 54)
  }
}

// MARK: - PIN keypad

private struct PinKeypad: View {
  let isDisabled: Bool
  let onDigit: (String) -> Void
  let onDelete: () -> Void

  private let rows = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
  ]

  var body: some View {
    VStack(spacing: 8) {
      ForEach(rows, id: \.self) { row in
        HStack(spacing: 8) {
          ForEach(row, id: \.self) { digit in
            PinKeyButton(title: digit, isDisabled: isDisabled) {
              onDigit(digit)
            }
          }
        }
      }

      HStack(spacing: 8) {
        Color.clear
          .frame(maxWidth: .infinity, minHeight: 48)

        PinKeyButton(title: "0", isDisabled: isDisabled) {
          onDigit("0")
        }

        Button(action: onDelete) {
          Image(systemName: "delete.left")
            .font(.headline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .foregroundStyle(isDisabled ? ADEColor.textMuted.opacity(0.5) : ADEColor.textPrimary)
        .background(
          RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(ADEColor.recessedBackground.opacity(isDisabled ? 0.35 : 0.78))
        )
        .overlay(
          RoundedRectangle(cornerRadius: 14, style: .continuous)
            .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.75)
        )
        .accessibilityLabel("Delete digit")
      }
    }
  }
}

private struct PinKeyButton: View {
  let title: String
  let isDisabled: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity, minHeight: 48)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(isDisabled)
    .foregroundStyle(isDisabled ? ADEColor.textMuted.opacity(0.5) : ADEColor.textPrimary)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(ADEColor.recessedBackground.opacity(isDisabled ? 0.35 : 0.78))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.75)
    )
  }
}

// MARK: - Aurora background

private struct SyncAuroraBackground: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var driftPhase: CGFloat = 0

  var body: some View {
    ZStack {
      ADEColor.pageBackground

      RadialGradient(
        colors: [
          ADEColor.purpleAccent.opacity(0.35),
          ADEColor.purpleAccent.opacity(0.0),
        ],
        center: UnitPoint(x: 0.5, y: -0.05),
        startRadius: 30,
        endRadius: 420
      )

      RadialGradient(
        colors: [
          Color(red: 99.0 / 255.0, green: 102.0 / 255.0, blue: 241.0 / 255.0).opacity(0.22),
          .clear,
        ],
        center: UnitPoint(
          x: 0.92 + (reduceMotion ? 0 : sin(driftPhase) * 0.06),
          y: 0.18
        ),
        startRadius: 8,
        endRadius: 280
      )

      RadialGradient(
        colors: [
          Color(red: 236.0 / 255.0, green: 72.0 / 255.0, blue: 153.0 / 255.0).opacity(0.14),
          .clear,
        ],
        center: UnitPoint(
          x: 0.05 + (reduceMotion ? 0 : cos(driftPhase) * 0.05),
          y: 0.32
        ),
        startRadius: 6,
        endRadius: 240
      )
    }
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.linear(duration: 18).repeatForever(autoreverses: true)) {
        driftPhase = .pi
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

// MARK: - Appearance

private struct AppearanceSection: View {
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  private var choice: ADEColorSchemeChoice {
    ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 6) {
        Circle()
          .fill(ADEColor.purpleAccent.opacity(0.55))
          .frame(width: 4, height: 4)
        Text("APPEARANCE")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.purpleAccent.opacity(0.85))
          .tracking(0.7)
      }
      .padding(.horizontal, 4)

      GlassEffectContainer(spacing: 8) {
        HStack(spacing: 8) {
          ForEach(ADEColorSchemeChoice.allCases) { option in
            ThemeChoiceTile(
              option: option,
              isSelected: choice == option,
              onTap: { colorSchemeRaw = option.rawValue }
            )
          }
        }
      }
    }
  }
}

private struct ThemeChoiceTile: View {
  let option: ADEColorSchemeChoice
  let isSelected: Bool
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      VStack(spacing: 10) {
        Image(systemName: option.symbol)
          .font(.system(size: 22, weight: .semibold))
          .foregroundStyle(isSelected ? ADEColor.purpleAccent : ADEColor.textSecondary)
          .frame(height: 28)
        Text(option.label)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 16)
      .background(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(ADEColor.surfaceBackground.opacity(0.5))
      )
      .glassEffect(in: .rect(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(
            isSelected ? ADEColor.purpleAccent.opacity(0.6) : ADEColor.border.opacity(0.18),
            lineWidth: isSelected ? 1.4 : 0.75
          )
      )
      .shadow(color: isSelected ? ADEColor.purpleAccent.opacity(0.18) : .clear, radius: 10, y: 2)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(option.label) appearance")
    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
  }
}
