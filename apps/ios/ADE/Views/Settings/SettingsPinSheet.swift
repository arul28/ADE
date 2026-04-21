import SwiftUI
import UIKit

struct SettingsPinSheet: View {
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

        Text("Shown on your Mac under Settings → Sync.")
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
