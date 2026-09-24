import AVFoundation
import SwiftUI
import UIKit

/// Full-screen, view-only mirror of the Mac's simulator.
///
/// View only is the whole design, not a limitation waiting to be lifted: the
/// phone has no ownership over the lane's device, and a touch that travelled to
/// someone's Mac from a pocket would be worse than useless. Touching the
/// picture shows a "View only" chip and nothing else. There is no toolbar, no
/// take-over, no drawer — Close, Rotate and Reconnect are the entire control
/// surface.
///
/// Video never rides the JSON sync envelope. The host mints a ticket over sync,
/// and this opens a second WebSocket to the address that ticket names —
/// directly to the brain when the phone can reach it, through the tunnel relay
/// when it cannot. The relay forwards binary frames verbatim, so the same
/// socket, parser and decoder serve both.
struct AppleDeviceViewer: View {
  let laneId: String
  /// The card's last status, so the ribbon and the aspect are right on the
  /// first frame rather than after the viewer's own first poll.
  var initialStatus: AppleDeviceStatus?

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  @StateObject private var model = AppleDeviceViewerModel()
  @State private var showsViewOnlyChip = false
  @State private var viewOnlyChipTask: Task<Void, Never>?
  @State private var rotated = false

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      VStack(spacing: 0) {
        controls
        Spacer(minLength: 0)
        stage
        Spacer(minLength: 0)
        footer
      }
    }
    .preferredColorScheme(.dark)
    .task(id: laneId) {
      model.attach(syncService: syncService, laneId: laneId, status: initialStatus)
      await model.start()
    }
    .task(id: laneId) {
      // Two timers in one loop: the health watchdogs, and the status poll that
      // keeps the owner ribbon and the recording dot honest. 1s is fast enough
      // for a 3s watchdog to fire on time and cheap enough to leave running
      // behind a full-screen view the user is actively watching.
      var tickCount = 0
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard !Task.isCancelled else { return }
        model.tick()
        tickCount += 1
        if tickCount % 5 == 0 {
          await model.refreshStatus()
        }
      }
    }
    .onChange(of: scenePhase) { _, phase in
      // `.inactive` counts as away: the app switcher card is a screenshot, and
      // holding a capture open on someone's Mac to feed it is not worth the
      // battery on either machine.
      model.setVisible(phase == .active)
    }
    .onDisappear {
      viewOnlyChipTask?.cancel()
      model.stop()
    }
  }

  // MARK: - Pieces

  private var controls: some View {
    HStack(spacing: 14) {
      controlButton(systemName: "xmark", label: "Close") {
        model.stop()
        dismiss()
      }
      Spacer(minLength: 0)
      if model.health.offersReconnect {
        controlButton(systemName: "arrow.clockwise", label: "Reconnect") {
          Task { await model.reconnect() }
        }
      }
      controlButton(
        systemName: rotated ? "rotate.left" : "rotate.right",
        label: rotated ? "Show upright" : "Rotate"
      ) {
        withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) { rotated.toggle() }
      }
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 12)
  }

  private func controlButton(systemName: String, label: String, action: @escaping () -> Void) -> some View {
    Button {
      ADEHaptics.light()
      action()
    } label: {
      Image(systemName: systemName)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: 44, height: 44)
        .background(Color.white.opacity(0.12), in: Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }

  @ViewBuilder
  private var stage: some View {
    ZStack {
      AppleStreamLayerView(layer: model.decoder.layer)
        .aspectRatio(model.aspectRatio, contentMode: .fit)
        // Display-only rotation: nothing about the device on the Mac changes,
        // this is a person turning a picture so they can read it one-handed.
        .rotationEffect(.degrees(rotated ? 90 : 0))
        .padding(.horizontal, rotated ? 0 : 18)
        .opacity(model.health.phase == .streaming ? 1 : 0.35)
        .contentShape(Rectangle())
        .onTapGesture { flashViewOnlyChip() }
        .accessibilityLabel("The simulator's screen. View only.")

      if let message = model.overlayMessage {
        statusOverlay(message)
      }

      if showsViewOnlyChip {
        Label("View only", systemImage: "eye")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.white)
          .padding(.horizontal, 12)
          .padding(.vertical, 7)
          .background(.black.opacity(0.62), in: Capsule())
          .transition(.opacity)
          .allowsHitTesting(false)
      }
    }
    .animation(.easeOut(duration: 0.18), value: showsViewOnlyChip)
  }

  private func statusOverlay(_ message: String) -> some View {
    VStack(spacing: 12) {
      if model.health.phase == .connecting || model.health.phase == .requestingTicket {
        ProgressView().tint(.white)
      }
      Text(message)
        .font(.footnote)
        .foregroundStyle(.white.opacity(0.85))
        .multilineTextAlignment(.center)
        .padding(.horizontal, 32)
      if model.health.offersReconnect {
        Button {
          ADEHaptics.light()
          Task { await model.reconnect() }
        } label: {
          Text("Reconnect")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .padding(.vertical, 9)
            .background(Color.white.opacity(0.16), in: Capsule())
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.vertical, 18)
    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .padding(.horizontal, 24)
  }

  private var footer: some View {
    VStack(spacing: 6) {
      Text(ribbon)
        .font(.caption)
        .foregroundStyle(.white.opacity(0.7))
        .lineLimit(2)
        .multilineTextAlignment(.center)
      if model.status?.recording?.active == true {
        Label("Recording", systemImage: "record.circle")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.danger)
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 18)
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }

  /// "Watching · owned by <chat>" — the one sentence that stops a viewer from
  /// mistaking a device an agent is driving for one that is idle.
  ///
  /// The host resolves the title, and hands back null rather than a fabricated
  /// name when it cannot, so a missing title costs the ribbon its name and
  /// never the claim itself.
  private var ribbon: String {
    var parts = ["Watching"]
    if let owner = appleDeviceOwnerLabel(model.status?.owner) {
      parts.append("owned by \(owner)")
    }
    if let device = model.status?.device?.name, !device.isEmpty {
      parts.append(device)
    }
    return parts.joined(separator: " · ")
  }

  /// The only answer a touch on the picture gets. 1.5s, restarted on each tap
  /// rather than queued, so hammering the screen does not stack timers.
  private func flashViewOnlyChip() {
    ADEHaptics.light()
    showsViewOnlyChip = true
    viewOnlyChipTask?.cancel()
    viewOnlyChipTask = Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(1500))
      guard !Task.isCancelled else { return }
      showsViewOnlyChip = false
    }
  }
}

// MARK: - Model

/// Owns the ticket, the socket, the decoder and the health clock.
///
/// An `ObservableObject` rather than view state because all four outlive a
/// SwiftUI body evaluation and must be torn down exactly once, on dismiss.
@MainActor
final class AppleDeviceViewerModel: ObservableObject {
  @Published private(set) var health = AppleStreamHealth()
  @Published private(set) var status: AppleDeviceStatus?
  /// Bumped on every decoded frame so the aspect recomputes when the device
  /// rotates on the Mac and the format description changes underneath us.
  @Published private(set) var frameCount = 0

  let decoder = AppleStreamDecoder()

  private let socket = AppleStreamSocket()
  private weak var syncService: SyncService?
  private var laneId: String = ""
  private(set) var ticket: AppleStreamTicket?
  private var visible = true
  private var started = false

  func attach(syncService: SyncService, laneId: String, status: AppleDeviceStatus?) {
    self.syncService = syncService
    self.laneId = laneId
    if self.status == nil { self.status = status }
    socket.onOpen = { [weak self] in
      self?.health.socketOpened(at: Date())
    }
    socket.onRecord = { [weak self] record in
      self?.handle(record)
    }
    socket.onError = { [weak self] message in
      guard let self else { return }
      // A failure after frames were flowing is a stall the user can retry;
      // before any frame it is a connection that never worked. Both offer
      // Reconnect, but only the second names the host's own reason.
      self.health.fail(message)
    }
  }

  func start() async {
    guard !started else { return }
    started = true
    await connect()
  }

  func stop() {
    started = false
    socket.setVisible(false)
    socket.close()
    decoder.reset()
    health.reset()
  }

  func reconnect() async {
    // A fresh ticket, not a redial: tickets are short-lived and single-use by
    // design, so reusing one would fail in a way that reads like a broken Mac.
    socket.close()
    decoder.reset()
    ticket = nil
    await connect()
  }

  func setVisible(_ nextVisible: Bool) {
    guard visible != nextVisible else { return }
    visible = nextVisible
    socket.setVisible(nextVisible)
    if !nextVisible { return }
    // Coming back: the brain stopped forwarding while we were away, and the
    // capture may have been stopped entirely, so a redial is the only way to
    // be sure of a keyframe.
    Task { await reconnect() }
  }

  func tick() {
    health.tick(now: Date())
  }

  /// What the overlay says. The host's own capture error wins over the phone's
  /// "no frames arrived", because the Mac knows why its helper stopped and this
  /// end only knows that nothing showed up.
  var overlayMessage: String? {
    guard let message = health.statusMessage else { return nil }
    if case .stalled = health.phase, let hostError = status?.stream?.lastError, !hostError.isEmpty {
      return hostError
    }
    return message
  }

  func refreshStatus() async {
    guard let syncService, syncService.supportsAppleDeviceStatus else { return }
    guard let next = try? await syncService.fetchAppleDeviceStatus(laneId: laneId) else { return }
    status = next
  }

  /// Aspect of the picture, most-authoritative first: what the decoder actually
  /// built, then the running stream's geometry, then the ticket's. The final
  /// fallback is a modern iPhone, which is only ever seen for the moment before
  /// the first keyframe lands.
  var aspectRatio: CGFloat {
    if let size = decoder.presentedSize, size.width > 0, size.height > 0 {
      return size.width / size.height
    }
    // The status carries no separate screen size; the stream's own device
    // pixels are the only geometry the phone gets, and the ticket makes them
    // real by starting capture before it answers.
    if let stream = status?.stream, let width = stream.width, let height = stream.height, width > 0, height > 0 {
      return CGFloat(width / height)
    }
    if let ticket, let width = ticket.width, let height = ticket.height, width > 0, height > 0 {
      return CGFloat(width / height)
    }
    return 9.0 / 19.5
  }

  private func connect() async {
    guard started else { return }
    guard let syncService else { return }
    guard syncService.supportsAppleDeviceStream else {
      health.markUnsupported()
      return
    }
    health.requestTicket()
    let ticket: AppleStreamTicket
    do {
      ticket = try await syncService.requestAppleStreamTicket(laneId: laneId)
    } catch {
      health.fail(appleStreamTicketFailureMessage((error as NSError).localizedDescription))
      return
    }
    // The view may have been dismissed while the ticket round-trip was in
    // flight. Connecting now would reopen the socket `stop()` just closed and
    // leave a live WebSocket (and the Mac's capture) with no teardown.
    guard started, !Task.isCancelled else { return }
    self.ticket = ticket
    guard
      let url = appleStreamSocketURL(
        ticketURL: ticket.url,
        path: ticket.path,
        token: ticket.token,
        connectedAddress: syncService.currentAddress,
        fallbackPort: syncService.appleStreamFallbackPort
      )
    else {
      health.fail("Your Mac sent an address this phone can't reach.")
      return
    }
    health.connecting()
    decoder.reset()
    socket.connect(url: url, token: ticket.token)
    socket.setVisible(visible)
  }

  private func handle(_ record: AppleStreamRecord) {
    switch record {
    case .config(_, _, _, let annexB):
      guard annexB else {
        // The decoder is built from inline SPS/PPS, so a stream that is not
        // Annex-B would configure cleanly and then show nothing. Saying so is
        // better than a blank rectangle.
        health.fail("This Mac is sending video this phone can't decode.")
        socket.close()
        return
      }
    case .accessUnit(let keyframe, let bytes):
      guard decoder.decode(accessUnit: bytes, keyframe: keyframe) else { return }
      frameCount &+= 1
      health.frameDecoded(at: Date())
    }
  }
}

// MARK: - Layer host

/// Hosts the decoder's `AVSampleBufferDisplayLayer`.
///
/// The layer belongs to the decoder, not to this view: SwiftUI rebuilds a
/// representable freely, and a layer recreated on a rebuild would drop the
/// format description and stall until the next keyframe.
struct AppleStreamLayerView: UIViewRepresentable {
  let layer: AVSampleBufferDisplayLayer

  func makeUIView(context: Context) -> AppleStreamLayerHostView {
    let view = AppleStreamLayerHostView()
    view.install(layer)
    return view
  }

  func updateUIView(_ uiView: AppleStreamLayerHostView, context: Context) {
    uiView.install(layer)
  }
}

final class AppleStreamLayerHostView: UIView {
  private weak var installed: AVSampleBufferDisplayLayer?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    isUserInteractionEnabled = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func install(_ next: AVSampleBufferDisplayLayer) {
    guard installed !== next else { return }
    installed?.removeFromSuperlayer()
    layer.addSublayer(next)
    installed = next
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // No implicit animation: the layer is resized on rotation and on the first
    // frame, and an animated bounds change makes the picture visibly swim.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    installed?.frame = bounds
    CATransaction.commit()
  }
}
