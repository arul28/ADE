import Foundation
import Observation
import QuartzCore
import UIKit

/// The main-actor face of one `ChatThreadEngine`. Holds the newest frame;
/// SwiftUI observes `frame` and nothing else.
///
/// Frames are applied at most once per display frame. A frame that arrives
/// while the thread is idle (nothing applied within the last display frame)
/// applies at once; frames that arrive in a burst wait for the shared
/// `ChatThreadFrameCoalescer`. Urgent frames (turn started/ended, pending
/// input appeared/resolved, local echo, optimistic steer) always apply
/// immediately.
@Observable
@MainActor
final class ChatThreadModel {
  private(set) var frame: ChatThreadFrame?
  /// `frame` without observation tracking, for reads made while the transcript
  /// collection view applies rows (see `WorkChatTranscriptCollectionView
  /// .isApplyingRows`). Always equal to `frame`.
  @ObservationIgnored private(set) var untrackedFrame: ChatThreadFrame?

  let key: ChatThreadKey
  @ObservationIgnored let engine: ChatThreadEngine
  @ObservationIgnored weak var registry: ChatThreadRegistry?
  @ObservationIgnored private var pendingFrame: ChatThreadFrame?
  /// `CACurrentMediaTime()` of the last apply, for the idle fast path.
  @ObservationIgnored private var lastAppliedAt: CFTimeInterval = 0
  @ObservationIgnored private var latestOverlays: ChatThreadOverlays?
  @ObservationIgnored private var overlayDrainTask: Task<Void, Never>?
  /// The last overlays handed to the engine. Several views own different
  /// fields (the destination owns echoes and summary, the transcript owns the
  /// paging window and answered inputs), so they edit this value in place.
  @ObservationIgnored private(set) var overlays = ChatThreadOverlays()

  init(key: ChatThreadKey, engine: ChatThreadEngine, registry: ChatThreadRegistry?) {
    self.key = key
    self.engine = engine
    self.registry = registry
  }

  /// Edit some overlay fields and send the result when anything changed.
  /// Synchronous up to the engine hop, so a send handler that calls this
  /// before its first `await` gets the echo into the next frame.
  func updateOverlays(_ mutate: (inout ChatThreadOverlays) -> Void) {
    var next = overlays
    mutate(&next)
    guard next != overlays else { return }
    setOverlays(next)
  }

  /// Overlays from the view (echoes, optimistic steers, answered inputs,
  /// summary fields, viewport). Coalesced: only the newest value is sent, and
  /// the resulting frame applies without waiting for the display link.
  func setOverlays(_ overlays: ChatThreadOverlays) {
    self.overlays = overlays
    latestOverlays = overlays
    guard overlayDrainTask == nil else { return }
    overlayDrainTask = Task { @MainActor [weak self] in
      while let self, let next = self.latestOverlays {
        self.latestOverlays = nil
        if let frame = await self.engine.setOverlays(next) {
          self.apply(frame)
        }
      }
      self?.overlayDrainTask = nil
    }
  }

  func loadOlder() async -> WorkChatOlderHistoryLoadResult {
    guard let registry else { return .failed }
    return await registry.loadOlder(key)
  }

  func retry() {
    registry?.retry(key)
  }

  // MARK: Delivery

  /// Called by the registry for every frame the engine emits.
  func receive(_ frame: ChatThreadFrame) {
    guard frame.revision > (self.frame?.revision ?? 0) else { return }
    if frame.isUrgent {
      pendingFrame = nil
      apply(frame)
      return
    }
    if let pendingFrame, pendingFrame.revision >= frame.revision { return }
    // Idle thread: waiting for the next display-link tick only adds latency,
    // so the first frame after a quiet display frame applies now. Frames in a
    // burst still coalesce to one apply per display frame.
    if pendingFrame == nil,
       CACurrentMediaTime() - lastAppliedAt >= ChatThreadFrameCoalescer.displayFrameInterval {
      apply(frame)
      return
    }
    pendingFrame = frame
    ChatThreadFrameCoalescer.shared.enqueue(self)
  }

  /// Display-link tick: apply the newest pending frame.
  func applyPendingFrame() {
    guard let pendingFrame else { return }
    self.pendingFrame = nil
    apply(pendingFrame)
  }

  var hasPendingFrame: Bool { pendingFrame != nil }

  private func apply(_ next: ChatThreadFrame) {
    guard next.revision > (frame?.revision ?? 0) else { return }
    let state = chatThreadSignposter.beginInterval("thread.apply", id: chatThreadSignposter.makeSignpostID())
    lastAppliedAt = CACurrentMediaTime()
    frame = next
    untrackedFrame = next
    chatThreadSignposter.endInterval("thread.apply", state)
    registry?.frameApplied(next, key: key)
  }
}

/// One `CADisplayLink` shared by every model. Runs only while some model has
/// a pending frame.
@MainActor
final class ChatThreadFrameCoalescer {
  static let shared = ChatThreadFrameCoalescer()

  /// One frame of the main display (8.3 ms on a 120 Hz ProMotion phone).
  static let displayFrameInterval: CFTimeInterval =
    1.0 / Double(max(60, UIScreen.main.maximumFramesPerSecond))

  private var pending: [ObjectIdentifier: ChatThreadModel] = [:]
  private var displayLink: CADisplayLink?
  private lazy var proxy = ChatThreadDisplayLinkProxy(owner: self)

  func enqueue(_ model: ChatThreadModel) {
    pending[ObjectIdentifier(model)] = model
    if let displayLink {
      displayLink.isPaused = false
      return
    }
    let link = CADisplayLink(target: proxy, selector: #selector(ChatThreadDisplayLinkProxy.tick(_:)))
    link.add(to: .main, forMode: .common)
    displayLink = link
  }

  /// Apply every pending frame now (tests, or before a synchronous read).
  func flushAll() {
    let models = pending.values
    pending.removeAll()
    for model in models { model.applyPendingFrame() }
    displayLink?.isPaused = true
  }

  fileprivate func tick() {
    flushAll()
  }
}

@MainActor
private final class ChatThreadDisplayLinkProxy: NSObject {
  weak var owner: ChatThreadFrameCoalescer?

  init(owner: ChatThreadFrameCoalescer) {
    self.owner = owner
  }

  @objc func tick(_ link: CADisplayLink) {
    owner?.tick()
  }
}
