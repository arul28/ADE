import SwiftUI
import UIKit

struct SettingsPinSheet: View {
  @Environment(\.dismiss) private var dismiss

  let preset: PinPreset
  let syncService: SyncService
  /// Called when this machine has no pairing PIN yet — either learned up front
  /// (the brain advertised `pairingPinConfigured=false`) or after the host
  /// answers a pairing attempt with `pin_not_set`. The parent swaps this sheet
  /// for the friendly "Set a PIN" screen.
  var onNeedsPinSetup: (PinSetupRoute) -> Void = { _ in }

  @State private var pin: String = ""
  @State private var isSubmitting = false
  @State private var localError: String?

  /// The "Set a PIN" route for this machine, carried so the parent can offer
  /// "Try again" back into this PIN sheet.
  private var setupRoute: PinSetupRoute {
    switch preset {
    case .discover(let host): return .host(host)
    case .manual(let host, let port): return .manual(host: host, port: port)
    }
  }

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 18) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Enter pairing PIN")
            .font(.title2.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Paired with \(preset.hostDisplayName)")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }

        HStack(spacing: 8) {
          ForEach(0..<6, id: \.self) { index in
            PinDigitBox(
              digit: digit(at: index),
              isActive: !isSubmitting && index == cursorIndex
            )
          }
        }
        .frame(maxWidth: .infinity)
        .accessibilityLabel("Pairing PIN")
        .accessibilityValue(pin.isEmpty ? "No digits entered" : "\(pin.count) of 6 digits entered")

          Text("Find this PIN in ADE's Sync settings on \(preset.hostDisplayName).")
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
      .onAppear {
        // Proactive: if the machine already told us (via discovery) that it has
        // no pairing PIN, skip the keypad and go straight to the friendly
        // "Set a PIN" screen — no point asking for a PIN that can't exist.
        if case .discover(let host) = preset, host.pairingPinConfigured == false {
          onNeedsPinSetup(setupRoute)
        }
      }
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
        let selectedHost = latestDiscoveredHost(matching: host)
        let routeCandidates = syncPinRouteCandidates(for: selectedHost)
        await syncService.pairAndConnect(
          host: routeCandidates.first ?? selectedHost.hostName,
          port: selectedHost.port,
          code: code,
          hostIdentity: selectedHost.hostIdentity,
          hostName: selectedHost.hostName,
          siteId: selectedHost.siteId,
          candidateAddresses: routeCandidates,
          tailscaleAddress: selectedHost.tailscaleAddress
        )

      case .manual(let host, let port):
        let tailscaleAddress = syncIsTailscaleRoute(host) ? host : nil
        await syncService.pairAndConnect(
          host: host,
          port: port,
          code: code,
          hostIdentity: nil,
          hostName: nil,
          candidateAddresses: [host],
          tailscaleAddress: tailscaleAddress
        )
      }

      guard isSubmitting else { return }
      if syncService.connectionState == .connected {
        ADEHaptics.medium()
        isSubmitting = false
        dismiss()
      } else if syncService.lastPairingErrorCode == SyncService.pairingPinNotSetCode {
        // Reactive fallback (for machines that don't advertise PIN state): the
        // host has no PIN set, so route to the friendly "Set a PIN" screen
        // instead of a dead-end red error.
        isSubmitting = false
        onNeedsPinSetup(setupRoute)
      } else {
        ADEHaptics.error()
        isSubmitting = false
        localError = syncService.lastError ?? "Incorrect PIN."
        pin = ""
      }
    }
  }

  private func latestDiscoveredHost(matching host: DiscoveredSyncHost) -> DiscoveredSyncHost {
    syncService.discoveredHosts.first { candidate in
      if let identity = syncPinTrimmedNonEmpty(host.hostIdentity),
         let candidateIdentity = syncPinTrimmedNonEmpty(candidate.hostIdentity),
         identity == candidateIdentity {
        return true
      }
      if candidate.id == host.id || candidate.serviceName == host.serviceName {
        return true
      }
      return candidate.hostName.localizedCaseInsensitiveCompare(host.hostName) == .orderedSame
        || candidate.serviceName.localizedCaseInsensitiveCompare(host.hostName) == .orderedSame
    } ?? host
  }
}

/// Friendly screen shown when a machine has no pairing PIN yet. Explains, in
/// plain language, the two ways to set one (a one-line command on the machine,
/// or the ADE desktop app), then offers "Try again" back into the PIN keypad.
struct SettingsPinSetupSheet: View {
  @Environment(\.dismiss) private var dismiss

  let route: PinSetupRoute
  let onTryAgain: (PinPreset) -> Void

  private let setPinCommand = "ade brain pin generate"
  @State private var didCopyCommand = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "lock.shield")
              .font(.system(size: 30, weight: .regular))
              .foregroundStyle(ADEColor.purpleAccent)
              .padding(.bottom, 2)
            Text("Set a PIN to connect")
              .font(.title2.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text("\(route.machineDisplayName) doesn't have a pairing PIN yet. Set one on that machine, then come back here to pair — it keeps your machine private.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }

          stepCard(
            number: 1,
            title: "On that machine, run this once",
            detail: "In a terminal on \(route.machineDisplayName):"
          ) {
            Button {
              UIPasteboard.general.string = setPinCommand
              didCopyCommand = true
              ADEHaptics.light()
            } label: {
              HStack(spacing: 10) {
                Text(setPinCommand)
                  .font(.system(.footnote, design: .monospaced).weight(.medium))
                  .foregroundStyle(ADEColor.textPrimary)
                  .lineLimit(1)
                  .minimumScaleFactor(0.7)
                Spacer(minLength: 8)
                Image(systemName: didCopyCommand ? "checkmark" : "doc.on.doc")
                  .font(.footnote.weight(.semibold))
                  .foregroundStyle(didCopyCommand ? ADEColor.success : ADEColor.textSecondary)
              }
              .padding(.horizontal, 12)
              .padding(.vertical, 10)
              .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .fill(ADEColor.recessedBackground.opacity(0.82))
              )
              .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .stroke(ADEColor.border.opacity(0.2), lineWidth: 0.75)
              )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(didCopyCommand ? "Command copied" : "Copy command \(setPinCommand)")
          }

          stepCard(
            number: 2,
            title: "Or use the ADE app",
            detail: "Open ADE on \(route.machineDisplayName), then go to Settings → Sync and set a pairing PIN."
          ) { EmptyView() }

          Spacer(minLength: 8)

          Button {
            onTryAgain(route.pinPreset)
          } label: {
            Text("Try again")
              .font(.subheadline.weight(.semibold))
              .frame(maxWidth: .infinity)
              .padding(.vertical, 11)
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.purpleAccent)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 22)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Pairing")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button { dismiss() } label: {
            Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))
          }
          .accessibilityLabel("Close")
        }
      }
    }
  }

  @ViewBuilder
  private func stepCard<Content: View>(
    number: Int,
    title: String,
    detail: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Text("\(number)")
        .font(.subheadline.weight(.bold))
        .foregroundStyle(ADEColor.purpleAccent)
        .frame(width: 26, height: 26)
        .background(Circle().fill(ADEColor.purpleAccent.opacity(0.14)))
      VStack(alignment: .leading, spacing: 6) {
        Text(title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(detail)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        content()
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(ADEColor.cardBackground.opacity(0.5))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 1)
    )
  }
}

private func syncPinRouteCandidates(for host: DiscoveredSyncHost) -> [String] {
  syncPinUniqueNonEmpty(host.addresses + (host.tailscaleAddress.map { [$0] } ?? []))
}

private func syncPinTrimmedNonEmpty(_ value: String?) -> String? {
  guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
    return nil
  }
  return value
}

private func syncPinUniqueNonEmpty(_ values: [String]) -> [String] {
  var seen = Set<String>()
  return values
    .compactMap(syncPinTrimmedNonEmpty)
    .filter { seen.insert($0).inserted }
}

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
    .frame(maxWidth: .infinity, minHeight: 54, maxHeight: 54)
  }
}

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
    .accessibilityLabel("Digit \(title)")
  }
}
