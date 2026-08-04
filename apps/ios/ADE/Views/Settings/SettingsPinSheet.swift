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
  /// True when this machine has no pairing code configured — shown as a friendly
  /// message instead of the keypad (proactively from the QR payload/discovery
  /// hint, or reactively after the host answers `pin_not_set`).
  @State private var noPairingCode = false
  /// Bumped to shake the digit boxes when the host rejects an entered code.
  @State private var shakeTrigger: CGFloat = 0
  /// Briefly true after a successful connect so a checkmark beat plays before
  /// the sheet dismisses.
  @State private var didConnect = false

  /// The "Set a PIN" route for this machine, carried so the parent can offer
  /// "Try again" back into this PIN sheet.
  private var setupRoute: PinSetupRoute {
    switch preset {
    case .discover(let host): return .host(host)
    case .qr(let payload): return .qr(payload)
    }
  }

  /// Whether the paired machine already told us (via QR payload or discovery)
  /// that no pairing code is configured — used to open straight into the
  /// "no code set" message rather than the keypad.
  private var presetSaysNoPairingCode: Bool {
    switch preset {
    case .discover(let host): return host.pairingPinConfigured == false
    case .qr(let payload): return payload.pinConfigured == false
    }
  }

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 18) {
        VStack(alignment: .leading, spacing: 4) {
          Text(noPairingCode ? "No pairing code set" : "Enter pairing PIN")
            .font(.title2.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Connecting to \(preset.hostDisplayName)")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }

        if noPairingCode {
          noPairingCodeCard
          // Escape hatch: a PIN may have been set on that computer *after* its QR was
          // scanned (or after discovery reported no code). Let the user flip back
          // to the keypad and try a code anyway instead of dead-ending here.
          Button {
            withAnimation(.easeInOut(duration: 0.2)) { noPairingCode = false }
          } label: {
            Text("Enter code anyway")
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.accent)
              .frame(maxWidth: .infinity)
              .frame(minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityHint("Shows the keypad in case a pairing code was set after this computer was scanned.")
        } else {
          pinEntry
        }

        if let error = localError {
          Text(error)
            .font(.footnote)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
        }

        Spacer(minLength: 0)

        footerButtons
      }
      .padding(.horizontal, 20)
      .padding(.vertical, 24)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationBarTitleDisplayMode(.inline)
      .interactiveDismissDisabled(isSubmitting)
      .overlay {
        if didConnect { ConnectSuccessBeat() }
      }
      .onAppear {
        // Proactive: if the machine already told us (via discovery or the
        // scanned payload) that it has no pairing code, skip the keypad and
        // show the "set one on that computer" message — no point asking for a code
        // that can't exist.
        if presetSaysNoPairingCode { noPairingCode = true }
      }
    }
  }

  // MARK: - Keypad entry

  @ViewBuilder
  private var pinEntry: some View {
    HStack(spacing: 8) {
      ForEach(0..<6, id: \.self) { index in
        PinDigitBox(
          digit: digit(at: index),
          isActive: !isSubmitting && index == cursorIndex
        )
      }
    }
    .frame(maxWidth: .infinity)
    .modifier(PinShakeEffect(animatableData: shakeTrigger))
    .accessibilityLabel("Pairing PIN")
    .accessibilityValue(pin.isEmpty ? "No digits entered" : "\(pin.count) of 6 digits entered")

    Text("You haven't connected to this computer before. Enter the pairing code shown in ADE on that computer.")
      .font(.footnote)
      .foregroundStyle(ADEColor.textSecondary)

    PinKeypad(
      isDisabled: isSubmitting,
      onDigit: appendDigit,
      onDelete: deleteDigit
    )
    .padding(.top, 2)
  }

  // MARK: - No pairing code message (M10)

  private var noPairingCodeCard: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "key.slash")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(ADEColor.warning)
        .frame(width: 30, height: 30)
        .background(ADEColor.warning.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      Text("That computer has no pairing code set — set one in ADE on that computer.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(ADEColor.warning.opacity(0.28), lineWidth: 0.75)
    )
    .accessibilityElement(children: .combine)
  }

  // MARK: - Footer

  @ViewBuilder
  private var footerButtons: some View {
    HStack(spacing: 10) {
      Button {
        if isSubmitting {
          isSubmitting = false
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

      if noPairingCode {
        Button {
          onNeedsPinSetup(setupRoute)
        } label: {
          Text("How to set one")
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.purpleAccent)
      } else {
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
    // Auto-submit the moment the sixth digit lands — no separate Connect tap.
    if pin.count == 6 { submit() }
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

      case .qr(let payload):
        let directCandidates = payload.directCandidateHosts
        let relayCandidates = payload.relayCandidateHosts
        let tailscaleAddress = directCandidates.first(where: syncIsTailscaleRoute)
        await syncService.pairAndConnect(
          host: directCandidates.first ?? relayCandidates.first ?? payload.hostIdentity.name,
          port: payload.port,
          code: code,
          hostIdentity: payload.hostIdentity.deviceId,
          hostName: payload.hostIdentity.name,
          siteId: payload.hostIdentity.siteId,
          candidateAddresses: directCandidates,
          tailscaleAddress: tailscaleAddress,
          relayCandidates: relayCandidates
        )
      }

      guard isSubmitting else { return }
      // Success is "attached to the machine". `isAttached` is the canonical
      // predicate for that across the app — go through it rather than
      // re-deriving a comparison here.
      if syncService.isAttached {
        // Success beat: haptic + a brief checkmark before the sheet dismisses.
        ADEHaptics.success()
        isSubmitting = false
        withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) { didConnect = true }
        try? await Task.sleep(nanoseconds: 620_000_000)
        dismiss()
      } else if syncService.lastPairingFailure == .pinNotSet
                  || syncService.lastPairingErrorCode == SyncService.pairingPinNotSetCode {
        // The host has no pairing code — swap the keypad for the friendly
        // "set one on that computer" message (M10) rather than a dead-end red error.
        ADEHaptics.warning()
        isSubmitting = false
        pin = ""
        withAnimation(.easeInOut(duration: 0.2)) { noPairingCode = true }
      } else if syncService.lastPairingFailure == .invalidPin {
        // Wrong code: shake the boxes and say where the real one lives.
        ADEHaptics.error()
        isSubmitting = false
        localError = "That code didn't match — it's shown in ADE on that computer."
        pin = ""
        withAnimation(.default) { shakeTrigger += 1 }
      } else {
        ADEHaptics.error()
        isSubmitting = false
        localError = syncService.lastError ?? "Incorrect PIN."
        pin = ""
        withAnimation(.default) { shakeTrigger += 1 }
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
            Text("Set a pairing PIN in ADE on \(route.machineDisplayName), then return here.")
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
            detail: "Open ADE on \(route.machineDisplayName), open Connections, choose Mobile, then create a six-digit pairing code."
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

  private let digitRows = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
  ]

  var body: some View {
    // One 3-column grid so every key lines up on a single set of column
    // guides: 0 sits under the middle column (below 2/5/8) and delete under
    // the right column (below 3/6/9), with an invisible placeholder holding
    // the left column.
    Grid(horizontalSpacing: 8, verticalSpacing: 8) {
      ForEach(digitRows, id: \.self) { row in
        GridRow {
          ForEach(row, id: \.self) { digit in
            PinKeyButton(title: digit, isDisabled: isDisabled) {
              onDigit(digit)
            }
          }
        }
      }
      GridRow {
        Color.clear
          .frame(maxWidth: .infinity, minHeight: 48)
          .accessibilityHidden(true)

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

/// Horizontal shake used to signal a rejected pairing code. `animatableData`
/// is bumped by an integer each time, driving a short damped wobble.
private struct PinShakeEffect: GeometryEffect {
  var animatableData: CGFloat
  var travel: CGFloat = 8
  var shakes: CGFloat = 3

  func effectValue(size: CGSize) -> ProjectionTransform {
    let translation = travel * sin(animatableData * .pi * shakes)
    return ProjectionTransform(CGAffineTransform(translationX: translation, y: 0))
  }
}

/// A brief centered checkmark shown after a successful connect. Purely a
/// success "beat" — the presenting sheet dismisses immediately after.
struct ConnectSuccessBeat: View {
  var body: some View {
    ZStack {
      Circle()
        .fill(ADEColor.success.opacity(0.16))
        .frame(width: 92, height: 92)
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 56, weight: .semibold))
        .foregroundStyle(ADEColor.success)
        .shadow(color: ADEColor.success.opacity(0.4), radius: 16)
    }
    .transition(.scale(scale: 0.6).combined(with: .opacity))
    .accessibilityLabel("Connected")
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
