import SwiftUI


/// The Apple device card in the Work tools sheet.
///
/// A summary, not a player: device, app, who owns it, and whether it is
/// recording. Tapping it opens `AppleDeviceViewer`, which is where the live
/// stream lives — the sheet is a list of everything the Mac has open, and a
/// card that started decoding video the moment it scrolled into view would
/// spend a cellular allowance on a thumbnail.
///
/// There is deliberately no still here. `apple.status` carries no frame path
/// and no inlined image, and minting a stream ticket just to paint a thumbnail
/// would start a capture on someone's Mac for a picture nobody asked to watch.
/// The placeholder says which device it is and whether it is streaming, and the
/// first real picture is the one the viewer decodes.
struct AppleDeviceCard: View {
  let laneId: String

  @EnvironmentObject private var syncService: SyncService

  @State private var status: AppleDeviceStatus?
  @State private var loaded = false
  @State private var viewerPresented = false

  /// Poll cadence. Matches the sheet's own 3s so the card and the tab strip
  /// above it never disagree about which tool is open.
  private static let refreshInterval: Duration = .seconds(3)

  var body: some View {
    ADEGlassSection(title: "Apple", subtitle: subtitle) {
      content
    }
    .task(id: laneId) { await refresh() }
    .task(id: laneId) {
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.refreshInterval)
        guard !Task.isCancelled else { return }
        // The viewer polls `apple.status` itself while it is up, and it is the
        // authoritative surface; a second read behind it is a duplicate RPC for
        // a card nobody can see.
        guard !viewerPresented else { continue }
        await refresh()
      }
    }
    .fullScreenCover(isPresented: $viewerPresented) {
      AppleDeviceViewer(laneId: laneId, initialStatus: status)
    }
  }

  @ViewBuilder
  private var content: some View {
    if !syncService.supportsAppleDeviceStatus {
      // The one absence worded as an instruction: the phone knows exactly what
      // is wrong and exactly what fixes it.
      cardMessage(appleDeviceHostUnsupportedMessage)
    } else if !loaded {
      HStack(spacing: 10) {
        ProgressView()
        Text("Reading the simulator…")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    } else if status?.device == nil {
      cardMessage(appleDeviceUnavailableMessage(status?.unavailable))
    } else {
      VStack(alignment: .leading, spacing: 10) {
        chips
        stageButton
        streamErrorLine
        ownerRibbon
        watchButton
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func cardMessage(_ text: String) -> some View {
    Text(text)
      .font(.footnote)
      .foregroundStyle(ADEColor.textSecondary)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var chips: some View {
    HStack(spacing: 6) {
      if let device = status?.device {
        chip(
          text: device.name ?? appleDeviceFamilyLabel(device.family) ?? "Simulator",
          systemImage: appleDeviceFamilySymbol(device.family)
        )
      }
      if let app = appLabel {
        chip(text: app, systemImage: "app.dashed")
      }
      if status?.recording?.active == true {
        // Its own badge rather than a chip: a recording in progress is the one
        // fact on this card that can surprise someone.
        ADEGlassStatusBadge(text: "Recording", tint: ADEColor.danger)
      }
      Spacer(minLength: 0)
    }
  }

  private func chip(text: String, systemImage: String) -> some View {
    Label(text, systemImage: systemImage)
      .font(.caption)
      .foregroundStyle(ADEColor.textSecondary)
      .lineLimit(1)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(Capsule().fill(ADEColor.textPrimary.opacity(0.08)))
      .overlay(Capsule().stroke(ADEColor.textMuted.opacity(0.25), lineWidth: 1))
  }

  @ViewBuilder
  private var stageButton: some View {
    Button {
      ADEHaptics.light()
      viewerPresented = true
    } label: {
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(Color.black.opacity(0.35))
        VStack(spacing: 6) {
          Image(systemName: appleDeviceFamilySymbol(status?.device?.family))
            .font(.title3)
            .foregroundStyle(ADEColor.textMuted)
          Text(streamRunning ? "Tap to watch" : "Tap to start watching")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
        if streamRunning {
          VStack {
            HStack {
              Spacer(minLength: 0)
              Label("Live", systemImage: "dot.radiowaves.left.and.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.black.opacity(0.55), in: Capsule())
            }
            Spacer(minLength: 0)
          }
          .padding(8)
        }
      }
      .frame(height: 140)
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Watch the simulator")
    .accessibilityHint("Opens a view-only live stream of this lane's device")
  }

  /// The host's own last capture error, shown verbatim. The Mac knows why its
  /// helper stopped; repeating it here beats a card that looks merely idle.
  @ViewBuilder
  private var streamErrorLine: some View {
    if let message = status?.stream?.lastError, !message.isEmpty {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: "exclamationmark.triangle")
          .font(.caption2)
          .foregroundStyle(ADEColor.warning)
        Text(message)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(3)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder
  private var ownerRibbon: some View {
    if let owner = ownerLabel {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: "person.crop.square")
          .font(.caption2)
          .foregroundStyle(ADEColor.accent)
        Text("Owned by \(owner)")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder
  private var watchButton: some View {
    if syncService.supportsAppleDeviceStream {
      Button {
        ADEHaptics.light()
        viewerPresented = true
      } label: {
        Label("Watch", systemImage: "play.fill")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .frame(minHeight: 44)
          .background(Capsule().fill(ADEColor.textPrimary.opacity(0.1)))
      }
      .buttonStyle(.plain)
    } else {
      // The status read landed but the stream command did not: the device is
      // real and describable, only the video pipe is missing.
      cardMessage("Live video isn't available from this machine.")
    }
  }

  // MARK: - Data

  private var subtitle: String? {
    guard let device = status?.device else { return nil }
    var parts: [String] = []
    if let runtime = device.runtime, !runtime.isEmpty { parts.append(runtime) }
    if let bitrate = status?.stream?.bitrateKbps, bitrate > 0 {
      parts.append(appleStreamBitrateLabel(kbps: bitrate))
    }
    if let fps = status?.stream?.fps, fps > 0 {
      parts.append("\(Int(fps.rounded())) fps")
    }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  private var appLabel: String? {
    guard let app = status?.app else { return nil }
    if let name = app.name, !name.isEmpty { return name }
    if let bundleId = app.bundleId, !bundleId.isEmpty { return bundleId }
    return nil
  }

  /// The host resolves the chat's title and returns null rather than a
  /// fabricated name when it cannot, so a failed lookup costs the ribbon its
  /// name and never the claim.
  private var ownerLabel: String? {
    appleDeviceOwnerLabel(status?.owner)
  }

  private var streamRunning: Bool {
    status?.stream?.running == true
  }

  private func refresh() async {
    guard syncService.supportsAppleDeviceStatus else {
      loaded = true
      return
    }
    // A transient failure (timeout, momentary offline) must keep the last known
    // state rather than clear `status` and blank the card to "No simulator is
    // open in this lane." — the same last-known-good rule the viewer uses.
    if let next = try? await syncService.fetchAppleDeviceStatus(laneId: laneId) {
      guard !Task.isCancelled else { return }
      status = next
    }
    guard !Task.isCancelled else { return }
    loaded = true
  }

}

/// Bitrate as the card says it. Sub-megabit reads in kb/s because "0.8 Mb/s"
/// is a worse answer than "800 kb/s" for the number people are watching drop.
func appleStreamBitrateLabel(kbps: Double) -> String {
  guard kbps > 0 else { return "0 kb/s" }
  if kbps < 1000 { return "\(Int(kbps.rounded())) kb/s" }
  return String(format: "%.1f Mb/s", kbps / 1000)
}
