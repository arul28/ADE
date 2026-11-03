import SwiftUI
import UIKit

// Inspect and markup on a frozen live view (Simulator, App Control, Mac
// Desktop).
//
// Watching stays the default and is untouched. Inspect is a step away from it:
// the stream stops, one still plus the elements on it arrive from the machine
// that owns the lane, and the person taps an element and draws on the picture.
// Leaving resumes the stream. "Add to chat" puts an element straight into the
// chat's draft (nothing is sent); the handoff is a request the composer
// answers, so a viewer needs no composer of its own and a failure is visible —
// see LiveInspectComposerHandoff.
//
// Geometry mirrors `appleInspectGeometry.ts`: hit-testing keeps the smallest
// element under the point, and the packet is formatted like
// `visualContextFormatting.ts` (preamble, numbered row, pretty JSON).

// MARK: - Composer handoff

/// What the chat composer answered to one handoff.
enum LiveInspectHandoffResult: Equatable {
  /// An insert or a picture replacement landed in the draft.
  case attached
  /// An undo ran. Whatever the add inserted and is still there verbatim is
  /// gone; text the person has since edited is left alone.
  case removed
  /// No composer for this chat answered within `replyWindow`.
  case noComposer
  /// The draft already holds `workChatInputAttachmentLimit` attachments.
  case attachmentLimit
  /// This chat takes no attachments, or the picture couldn't be encoded.
  case attachmentsUnavailable

  /// The sentence the stage shows for a failed handoff; nil on success.
  var failureMessage: String? {
    switch self {
    case .attached, .removed:
      return nil
    case .noComposer:
      return "Couldn't reach this chat's composer"
    case .attachmentLimit:
      return "The message already has \(workChatInputAttachmentLimit) attachments. Remove one and try again."
    case .attachmentsUnavailable:
      return "This chat can't take pictures"
    }
  }
}

/// One request from Inspect to a chat composer, posted on
/// `.liveInspectComposerHandoff` with this object.
///
/// Every request is answered once: the composer that takes it calls `reply`,
/// and the sender treats silence past `replyWindow` as `.noComposer`. An
/// insert is all-or-nothing, so a failure leaves the draft as it was. The
/// composer keeps no bookkeeping of its own: undo carries the exact text block
/// the insert added (removed only while it is still in the draft verbatim) and
/// the attachment id the sender chose, so it works across a remount.
///
/// A handoff names its chat (`sessionId`), or only its lane for a viewer opened
/// outside a chat; then the lane's chat on screen takes it. The first composer
/// to `claim()` it is the only one that acts, so a chat mounted twice (a split)
/// does not insert twice.
@MainActor
final class LiveInspectComposerHandoff: NSObject {
  enum Request {
    /// Append `text` to the draft as its own block and, with an image, attach
    /// it under `attachmentId`.
    case insert(text: String, image: UIImage?, attachmentId: UUID?)
    /// Remove a block an insert added, and its attachment.
    case remove(text: String?, attachmentId: UUID?)
    /// Swap the attachment `replacing` for `image` under `attachmentId` (the
    /// picture with the markup finished after the first add). A missing old
    /// attachment just means the new one is appended.
    case replaceImage(replacing: UUID, image: UIImage, attachmentId: UUID)
  }

  /// How long a sender waits for a composer before calling it unreachable.
  /// Composers answer synchronously from the notification, so this only runs
  /// out when none is mounted for the chat.
  static var replyWindow: Duration = .milliseconds(1500)

  let id = UUID()
  let sessionId: String?
  let laneId: String
  let request: Request
  private var claimed = false
  private var onReply: ((LiveInspectHandoffResult) -> Void)?

  init(
    sessionId: String?,
    laneId: String,
    request: Request,
    onReply: @escaping (LiveInspectHandoffResult) -> Void
  ) {
    self.sessionId = sessionId
    self.laneId = laneId
    self.request = request
    self.onReply = onReply
  }

  /// True for the first composer that asks; it then owns the reply.
  func claim() -> Bool {
    guard !claimed else { return false }
    claimed = true
    return true
  }

  func reply(_ result: LiveInspectHandoffResult) {
    let callback = onReply
    onReply = nil
    callback?(result)
  }

  /// Posts a request and waits for its answer, or `.noComposer` once
  /// `replyWindow` passes with none.
  static func deliver(
    _ request: Request,
    sessionId: String?,
    laneId: String
  ) async -> LiveInspectHandoffResult {
    await withCheckedContinuation { (continuation: CheckedContinuation<LiveInspectHandoffResult, Never>) in
      let once = LiveInspectReplyOnce(continuation)
      let handoff = LiveInspectComposerHandoff(
        sessionId: sessionId,
        laneId: laneId,
        request: request,
        onReply: { once.finish($0) }
      )
      let window = replyWindow
      Task { @MainActor in
        try? await Task.sleep(for: window)
        once.finish(.noComposer)
      }
      NotificationCenter.default.post(name: .liveInspectComposerHandoff, object: handoff)
    }
  }
}

/// Resumes a handoff's continuation once: the reply or the timeout, whichever
/// comes first.
@MainActor
private final class LiveInspectReplyOnce {
  private var continuation: CheckedContinuation<LiveInspectHandoffResult, Never>?

  init(_ continuation: CheckedContinuation<LiveInspectHandoffResult, Never>) {
    self.continuation = continuation
  }

  func finish(_ result: LiveInspectHandoffResult) {
    continuation?.resume(returning: result)
    continuation = nil
  }
}

/// `text` without one block an insert added, and the blank line that joined
/// it to its neighbour. The latest copy wins (an element added, undone, and
/// added again). Text with no verbatim copy is returned unchanged: an edited
/// block is the person's now.
func liveInspectTextRemovingBlock(_ block: String, from text: String) -> String {
  guard !block.isEmpty, let range = text.range(of: block, options: .backwards) else { return text }
  var lower = range.lowerBound
  var upper = range.upperBound
  if text[..<lower].hasSuffix("\n\n") {
    lower = text.index(lower, offsetBy: -2)
  } else if text[upper...].hasPrefix("\n\n") {
    upper = text.index(upper, offsetBy: 2)
  }
  var result = text
  result.removeSubrange(lower..<upper)
  return result
}

extension Notification.Name {
  /// Carries a `LiveInspectComposerHandoff` in `object`.
  static let liveInspectComposerHandoff = Notification.Name("com.ade.ios.liveInspectComposerHandoff")
}

/// The one transient line at the bottom of the stage.
struct LiveInspectToast: Equatable, Identifiable {
  enum Kind: Equatable {
    case attached
    case error
  }

  let id = UUID()
  var kind: Kind
  var message: String
  /// The add an Undo on this toast takes back; nil when it can't be undone.
  var undoAddId: UUID?
}

// MARK: - Surfaces

/// The live viewer an inspect session froze.
enum LiveInspectSurface: String, Equatable {
  case simulator
  case appControl
  case macDesktop

  var title: String {
    switch self {
    case .simulator: return "Simulator"
    case .appControl: return "App Control"
    case .macDesktop: return "Mac Desktop"
    }
  }

  var symbolName: String {
    switch self {
    case .simulator: return "iphone"
    case .appControl: return "macwindow"
    case .macDesktop: return "desktopcomputer"
    }
  }

  /// What the packet preamble calls this surface.
  var packetName: String {
    switch self {
    case .simulator: return "iOS visual inspect context attached by the user."
    case .appControl: return "App Control visual inspect context attached by the user."
    case .macDesktop: return "Mac Desktop visual inspect context attached by the user."
    }
  }
}

// MARK: - Markup model

enum LiveInspectTool: String, CaseIterable, Identifiable {
  case select
  case pen
  case arrow
  case circle

  var id: String { rawValue }

  var title: String {
    switch self {
    case .select: return "Select"
    case .pen: return "Pen"
    case .arrow: return "Arrow"
    case .circle: return "Circle"
    }
  }

  var symbolName: String {
    switch self {
    case .select: return "cursorarrow"
    case .pen: return "pencil.tip"
    case .arrow: return "arrow.up.right"
    case .circle: return "circle.dashed"
    }
  }

  var draws: Bool { self != .select }
}

/// One drawn mark, in the frozen image's pixels.
struct LiveInspectStroke: Identifiable, Equatable {
  let id = UUID()
  var tool: LiveInspectTool
  var points: [CGPoint]

  var bounds: CGRect {
    guard let first = points.first else { return .zero }
    var rect = CGRect(origin: first, size: .zero)
    for point in points.dropFirst() {
      rect = rect.union(CGRect(origin: point, size: .zero))
    }
    if tool == .circle, let last = points.last {
      return CGRect(
        x: min(first.x, last.x),
        y: min(first.y, last.y),
        width: abs(last.x - first.x),
        height: abs(last.y - first.y)
      )
    }
    return rect
  }
}

/// The ink every mark is drawn in. One colour for all three tools: markup is a
/// pointer at the picture, and a legend of colours would be one more thing to
/// read.
enum LiveInspectInk {
  static let color = Color(red: 1, green: 0.33, blue: 0.28)
  static let uiColor = UIColor(red: 1, green: 0.33, blue: 0.28, alpha: 1)
}

// MARK: - Async plan

/// Where the frozen picture and its elements come from.
enum LiveInspectLoadPlan {
  case simulator
  case appControl(image: UIImage, scaleX: CGFloat?, viewportWidth: CGFloat?, viewportHeight: CGFloat?)
  case macDesktop
}

/// One inspect session: the frozen picture, its elements, the selection, the
/// strokes, and what it added to the chat's draft.
///
/// Owned by the viewer that froze, so leaving can resume exactly what was
/// stopped. Nothing here fetches on a timer: one load per entry, one host call
/// per tap on App Control.
@MainActor
final class LiveInspectMarkupModel: ObservableObject {
  enum Phase: Equatable {
    case loading
    case ready
    case failed(String)
  }

  let surface: LiveInspectSurface
  let laneId: String
  let chatSessionId: String?

  @Published private(set) var phase: Phase = .loading
  @Published private(set) var image: UIImage?
  @Published private(set) var pixelSize: CGSize = .zero
  @Published private(set) var screen: LiveInspectScreen?
  @Published private(set) var elements: [LiveInspectElement] = []
  @Published private(set) var selected: LiveInspectElement?
  /// Where the last App Control tap landed, in image pixels, while the host
  /// looks the element up: the card shows its spinner there.
  @Published private(set) var pendingTapPoint: CGPoint?
  @Published var tool: LiveInspectTool = .select
  @Published private(set) var strokes: [LiveInspectStroke] = []
  @Published private(set) var draft: LiveInspectStroke?
  @Published private(set) var busy = false
  @Published private(set) var errorText: String?
  @Published private(set) var note: String?
  /// How many adds landed in the draft this session, after undos. A viewer
  /// reads it on close to decide whether to land on the chat.
  @Published private(set) var attachedCount = 0
  /// Elements whose packet is in the draft now; their card reads "Added".
  @Published private(set) var addedElementIds: Set<String> = []
  /// An add, an undo, or Done's picture is waiting on the composer.
  @Published private(set) var handingOff = false
  @Published private(set) var toast: LiveInspectToast?
  /// False until the first selection or stroke; the first-run hint shows
  /// until then.
  @Published private(set) var hasInteracted = false

  private weak var syncService: SyncService?
  private var plan: LiveInspectLoadPlan?
  /// Every add still in the draft, oldest first.
  private var adds: [LiveInspectAdd] = []
  /// The attachment carrying the frozen picture, once one landed.
  private var pictureAttachmentId: UUID?
  /// `markupRevision` when that picture was rendered, so Done knows whether
  /// the draft's picture is missing marks drawn (or cleared) since.
  private var pictureMarkupRevision: Int?
  /// Bumped on every finished stroke, undo, and clear.
  private var markupRevision = 0
  private var toastGeneration = 0
  /// Bumped by every load and every tap so an older answer cannot land on a
  /// newer state (a retry pressed twice, or two taps in one second).
  private var loadGeneration = 0
  private var selectionGeneration = 0

  init(surface: LiveInspectSurface, laneId: String, chatSessionId: String?) {
    self.surface = surface
    self.laneId = laneId
    self.chatSessionId = chatSessionId
  }

  // MARK: Loading

  func begin(plan: LiveInspectLoadPlan, using syncService: SyncService) {
    self.plan = plan
    self.syncService = syncService
    reload()
  }

  func reload() {
    guard let syncService, let plan else { return }
    loadGeneration += 1
    let generation = loadGeneration
    phase = .loading
    errorText = nil
    Task { await load(plan: plan, using: syncService, generation: generation) }
  }

  private func load(plan: LiveInspectLoadPlan, using syncService: SyncService, generation: Int) async {
    switch plan {
    case .simulator:
      await loadSimulator(using: syncService, generation: generation)
    case .appControl(let image, let scaleX, let viewportWidth, let viewportHeight):
      installAppControl(
        image: image,
        scaleX: scaleX,
        viewportWidth: viewportWidth,
        viewportHeight: viewportHeight
      )
    case .macDesktop:
      await loadMacDesktop(using: syncService, generation: generation)
    }
  }

  private func loadSimulator(using syncService: SyncService, generation: Int) async {
    do {
      let snapshot = try await syncService.fetchLiveInspectSimulatorSnapshot(laneId: laneId)
      guard !Task.isCancelled, generation == loadGeneration else { return }
      guard let image = LiveInspectImage.image(fromDataURL: snapshot.screenshot.dataUrl) else {
        throw LiveInspectFailure("The simulator sent a picture this phone couldn't read.")
      }
      let pixel = LiveInspectImage.pixelSize(of: image)
      let shotWidth = snapshot.screenshot.width.flatMap { $0 > 0 ? $0 : nil } ?? Double(pixel.width)
      let shotHeight = snapshot.screenshot.height.flatMap { $0 > 0 ? $0 : nil } ?? Double(pixel.height)
      // The element frames are the host's full-fidelity screenshot pixels. If
      // the decoded PNG is a different size (an older host, a rotated device),
      // scale into the image we actually hold so a tap lands on its element.
      let factor = CGSize(
        width: pixel.width / CGFloat(max(1, shotWidth)),
        height: pixel.height / CGFloat(max(1, shotHeight))
      )
      let elements = snapshot.elements.map { element in
        let screenshotFrame = element.pixelFrame ?? element.frame
        return LiveInspectElement(
          id: element.id,
          label: element.label,
          value: element.value,
          role: element.role,
          elementType: element.elementType,
          subrole: nil,
          identifier: element.identifier,
          componentId: element.componentId,
          sourceFile: element.sourceFile,
          sourceLine: element.sourceLine,
          sourceConfidence: element.sourceFile != nil ? "exact" : nil,
          enabled: nil,
          focused: nil,
          frame: screenshotFrame,
          pointFrame: element.frame,
          imageFrame: screenshotFrame.scaled(by: factor)
        )
      }
      let screen = LiveInspectScreen(
        width: snapshot.screen?.width.flatMap { $0 > 0 ? $0 : nil } ?? Double(pixel.width),
        height: snapshot.screen?.height.flatMap { $0 > 0 ? $0 : nil } ?? Double(pixel.height),
        scale: snapshot.screen?.scale.flatMap { $0 > 0 ? $0 : nil } ?? 1,
        viewportWidth: nil,
        viewportHeight: nil
      )
      guard generation == loadGeneration else { return }
      apply(image: image, pixel: pixel, screen: screen, elements: elements)
      note = elements.isEmpty ? "This screen exposed no elements. Is an app in the foreground on the simulator?" : nil
    } catch {
      guard generation == loadGeneration else { return }
      fail(error)
    }
  }

  private func installAppControl(
    image: UIImage,
    scaleX: CGFloat?,
    viewportWidth: CGFloat?,
    viewportHeight: CGFloat?
  ) {
    let pixel = LiveInspectImage.pixelSize(of: image)
    let viewport = LiveInspectMarkupModel.appControlViewport(
      imagePixelWidth: pixel.width,
      imagePixelHeight: pixel.height,
      scaleX: scaleX,
      viewportWidth: viewportWidth,
      viewportHeight: viewportHeight
    )
    let screen = LiveInspectScreen(
      width: Double(pixel.width),
      height: Double(pixel.height),
      scale: Double(scaleX ?? 1),
      viewportWidth: viewport.map { Double($0.width) },
      viewportHeight: viewport.map { Double($0.height) }
    )
    apply(image: image, pixel: pixel, screen: screen, elements: [])
    note = viewport == nil
      ? "Tap to pick an element. This host didn't send the frame's scale."
      : "Tap an element to inspect it."
  }

  private func loadMacDesktop(using syncService: SyncService, generation: Int) async {
    do {
      let reply = try await syncService.macDesktopObserve(laneId: laneId)
      guard !Task.isCancelled, generation == loadGeneration else { return }
      let observation = reply.observation
      guard let preview = try await syncService.readWorkToolsObservationPreview(path: observation.screenshotPath),
            let data = WorkToolsSheet.decodeDataUrl(preview.dataUrl),
            let image = UIImage(data: data) else {
        throw LiveInspectFailure("The desktop captured a frame this phone couldn't read.")
      }
      guard !Task.isCancelled, generation == loadGeneration else { return }
      let pixel = LiveInspectImage.pixelSize(of: image)
      let display = LiveInspectScreen(
        width: observation.display.width,
        height: observation.display.height,
        scale: observation.display.scale.flatMap { $0 > 0 ? $0 : nil } ?? 1,
        viewportWidth: nil,
        viewportHeight: nil
      )
      let factor = CGSize(
        width: pixel.width / CGFloat(max(1, display.width)),
        height: pixel.height / CGFloat(max(1, display.height))
      )
      let elements = observation.elements.map { element in
        LiveInspectElement(
          id: "ax:\(element.index ?? 0)",
          label: element.label ?? element.title,
          value: element.value,
          role: element.role,
          elementType: element.subrole,
          subrole: element.subrole,
          identifier: element.identifier,
          componentId: nil,
          sourceFile: nil,
          sourceLine: nil,
          sourceConfidence: "none",
          enabled: element.enabled,
          focused: element.focused,
          frame: element.frame,
          pointFrame: nil,
          imageFrame: element.frame.scaled(by: factor)
        )
      }
      guard generation == loadGeneration else { return }
      apply(image: image, pixel: pixel, screen: display, elements: elements)
      if observation.truncated == true {
        note = "The element walk stopped early (\(observation.truncatedReason ?? "limit")); some elements may be missing."
      } else if elements.isEmpty {
        note = "No accessibility elements were found on this screen."
      } else {
        note = nil
      }
    } catch {
      guard generation == loadGeneration else { return }
      fail(error)
    }
  }

  private func apply(
    image: UIImage,
    pixel: CGSize,
    screen: LiveInspectScreen,
    elements: [LiveInspectElement]
  ) {
    self.image = image
    self.pixelSize = pixel
    self.screen = screen
    self.elements = elements
    self.selected = nil
    self.pendingTapPoint = nil
    self.strokes = []
    self.draft = nil
    self.errorText = nil
    self.markupRevision += 1
    self.phase = .ready
  }

  private func fail(_ error: Error) {
    // A reply this phone cannot read means the host and the app disagree on
    // the format: a bug, not a machine that is away. The rest (offline,
    // timeouts, an older host) are states the user sees and can fix.
    if error is DecodingError {
      CrashReporting.capture(error, context: ["area": "live_inspect", "surface": surface.rawValue])
    }
    phase = .failed(LiveInspectFailure.visibleMessage(for: error))
  }

  // MARK: Selection

  /// A tap on the frozen picture, in image pixels. Simulator and Mac Desktop
  /// hit-test locally (the element list is already here); App Control asks the
  /// host, because the DOM is not on this phone.
  func select(atImagePoint point: CGPoint) {
    guard phase == .ready, pixelSize.width > 0, pixelSize.height > 0 else { return }
    if surface == .appControl {
      selectionGeneration += 1
      let generation = selectionGeneration
      selected = nil
      pendingTapPoint = point
      Task { await selectAppControl(atImagePoint: point, generation: generation) }
      return
    }
    let hit = LiveInspectGeometry.hitTest(elements, point: point)
    selected = hit
    errorText = nil
    note = hit == nil ? "Nothing on this screen is under that point." : nil
    if hit != nil {
      hasInteracted = true
      ADEHaptics.light()
    }
  }

  /// Drops the selection (a tap outside the picture).
  func clearSelection() {
    selectionGeneration += 1
    selected = nil
    pendingTapPoint = nil
    busy = false
  }

  private func selectAppControl(atImagePoint point: CGPoint, generation: Int) async {
    guard generation == selectionGeneration,
          let syncService, pixelSize.width > 0, pixelSize.height > 0 else { return }
    let viewport = appControlViewport()
    guard let viewport else {
      pendingTapPoint = nil
      errorText = "This host didn't send the frame's scale, so taps can't be placed."
      return
    }
    busy = true
    errorText = nil
    defer {
      if generation == selectionGeneration {
        busy = false
        pendingTapPoint = nil
      }
    }
    let x = point.x / pixelSize.width * CGFloat(viewport.width)
    let y = point.y / pixelSize.height * CGFloat(viewport.height)
    do {
      let reply = try await syncService.appControlInspectPoint(laneId: laneId, x: Double(x), y: Double(y))
      guard !Task.isCancelled, generation == selectionGeneration else { return }
      guard let item = reply.item else {
        selected = nil
        note = "No element matched that point."
        return
      }
      let element = appControlElement(item, snapshot: reply.snapshot)
      selected = element
      hasInteracted = true
      note = element.hasIdentity ? nil : "This element carries no identifier."
      ADEHaptics.light()
    } catch {
      guard generation == selectionGeneration else { return }
      errorText = LiveInspectFailure.visibleMessage(for: error)
    }
  }

  /// The CSS viewport of the frozen frame. The frame's own numbers win; the
  /// screen's scale is the fallback when an older host sends no viewport.
  private func appControlViewport() -> CGSize? {
    guard let screen else { return nil }
    if let width = screen.viewportWidth, let height = screen.viewportHeight, width > 0, height > 0 {
      return CGSize(width: width, height: height)
    }
    guard screen.scale > 0 else { return nil }
    return CGSize(width: screen.width / screen.scale, height: screen.height / screen.scale)
  }

  private static func appControlViewport(
    imagePixelWidth: CGFloat,
    imagePixelHeight: CGFloat,
    scaleX: CGFloat?,
    viewportWidth: CGFloat?,
    viewportHeight: CGFloat?
  ) -> CGSize? {
    if let viewportWidth, let viewportHeight, viewportWidth > 0, viewportHeight > 0 {
      return CGSize(width: viewportWidth, height: viewportHeight)
    }
    guard let scaleX, scaleX > 0, imagePixelWidth > 0 else { return nil }
    let width = imagePixelWidth / scaleX
    // The viewport keeps the picture's aspect, so a host that omits the height
    // still gets a usable tap space instead of none.
    let height = imagePixelHeight > 0 ? width * imagePixelHeight / imagePixelWidth : width * 9 / 16
    return CGSize(width: width, height: max(1, height))
  }

  private func appControlElement(
    _ item: LiveInspectAppControlReply.Item,
    snapshot: LiveInspectAppControlReply.Snapshot?
  ) -> LiveInspectElement {
    let screen = snapshot?.screen
    let hostScaleX = screen?.scaleX.flatMap { $0 > 0 ? $0 : nil }
      ?? screen?.scale.flatMap { $0 > 0 ? $0 : nil }
    let hostViewportWidth = screen?.viewportWidth.flatMap { $0 > 0 ? $0 : nil }
    let hostViewportHeight = screen?.viewportHeight.flatMap { $0 > 0 ? $0 : nil }
    let frame = item.frame ?? LiveInspectFrame(x: 0, y: 0, width: 1, height: 1)
    // Screenshot px -> CSS viewport px -> frozen frame px.
    let imageFrame: CGRect
    if let hostScaleX, let viewport = appControlViewport(), hostViewportWidth == nil {
      let viewX = frame.x / hostScaleX
      let viewY = frame.y / hostScaleX
      let width = frame.width / hostScaleX
      let height = frame.height / hostScaleX
      let sx = pixelSize.width / CGFloat(viewport.width)
      let sy = pixelSize.height / CGFloat(viewport.height)
      imageFrame = CGRect(x: viewX * Double(sx), y: viewY * Double(sy), width: width * Double(sx), height: height * Double(sy))
    } else if let hostScaleX, let hostViewportWidth, let hostViewportHeight {
      let sx = pixelSize.width / CGFloat(hostViewportWidth)
      let sy = pixelSize.height / CGFloat(hostViewportHeight)
      imageFrame = CGRect(
        x: frame.x / hostScaleX * Double(sx),
        y: frame.y / hostScaleX * Double(sy),
        width: frame.width / hostScaleX * Double(sx),
        height: frame.height / hostScaleX * Double(sy)
      )
    } else {
      imageFrame = frame.scaled(by: CGSize(
        width: pixelSize.width / CGFloat(max(1, screen?.width ?? Double(pixelSize.width))),
        height: pixelSize.height / CGFloat(max(1, screen?.height ?? Double(pixelSize.height)))
      ))
    }
    let resolvedScreen = LiveInspectScreen(
      width: screen?.width ?? Double(pixelSize.width),
      height: screen?.height ?? Double(pixelSize.height),
      scale: hostScaleX ?? 1,
      viewportWidth: hostViewportWidth,
      viewportHeight: hostViewportHeight
    )
    if self.screen == nil || hostScaleX != nil {
      // The reply's screen is the host's own screenshot geometry, which is the
      // space `element.frame` is in. Keeping it makes the packet's
      // `screenshotFrame` and `screen` agree, and the next tap maps through the
      // host's viewport rather than a guess.
      self.screen = resolvedScreen
    }
    return LiveInspectElement(
      id: item.id ?? "app-control-element",
      label: item.label,
      value: item.value,
      role: item.role,
      elementType: item.tagName,
      subrole: nil,
      identifier: item.testId,
      componentId: item.componentId,
      sourceFile: item.sourceFile,
      sourceLine: item.sourceLine,
      sourceConfidence: item.sourceConfidence,
      enabled: nil,
      focused: nil,
      frame: frame,
      pointFrame: nil,
      imageFrame: imageFrame
    )
  }

  // MARK: Adding to the chat

  func isAdded(_ element: LiveInspectElement) -> Bool {
    addedElementIds.contains(element.id)
  }

  /// Puts the selected element straight into the chat's draft: its packet as
  /// a text block, plus the frozen picture the first time. Nothing is sent.
  func addSelectionToChat() {
    guard phase == .ready, !handingOff, let element = selected, !isAdded(element) else { return }
    let carriesPreamble = !adds.contains { $0.carriesPreamble }
    let picture: UIImage?
    if pictureAttachmentId == nil {
      guard let rendered = exportedImage() else {
        showToast(.error, LiveInspectHandoffResult.attachmentsUnavailable.failureMessage ?? "")
        return
      }
      picture = rendered
    } else {
      picture = nil
    }
    let add = LiveInspectAdd(
      elementId: element.id,
      text: elementBlock(element, number: adds.count + 1, preamble: carriesPreamble),
      attachmentId: picture == nil ? nil : UUID(),
      carriesPreamble: carriesPreamble
    )
    let revision = markupRevision
    handingOff = true
    Task {
      let result = await deliver(.insert(text: add.text, image: picture, attachmentId: add.attachmentId))
      handingOff = false
      guard result == .attached else {
        fail(handoff: result)
        return
      }
      record(add, pictureRevision: revision)
      ADEHaptics.success()
      showToast(.attached, "Attached to chat", undo: add.id)
    }
  }

  /// Takes back the latest add: its text block (while still verbatim in the
  /// draft) and the picture if that add attached it.
  func undoAdd(_ addId: UUID) {
    guard !handingOff, let add = adds.last, add.id == addId else { return }
    handingOff = true
    Task {
      let result = await deliver(.remove(text: add.text, attachmentId: add.attachmentId))
      handingOff = false
      guard result == .removed else {
        fail(handoff: result)
        return
      }
      adds.removeLast()
      if let attachmentId = add.attachmentId, attachmentId == pictureAttachmentId {
        pictureAttachmentId = nil
        pictureMarkupRevision = nil
      }
      if let elementId = add.elementId { addedElementIds.remove(elementId) }
      attachedCount = max(0, attachedCount - 1)
      dismissToast()
      ADEHaptics.light()
    }
  }

  /// Done: makes the draft's picture carry the markup as it stands. Replaces
  /// the picture an add attached when marks changed since, or attaches the
  /// marked-up picture now when nothing was added. A failure keeps the stage
  /// open with the error showing.
  func finish() async -> LiveInspectFinishOutcome {
    guard !handingOff else { return .failed }
    guard phase == .ready, image != nil else { return .unchanged }
    let replacing = pictureAttachmentId.flatMap { id in pictureMarkupRevision == markupRevision ? nil : id }
    let attachingMarkup = pictureAttachmentId == nil && !strokes.isEmpty
    guard replacing != nil || attachingMarkup else { return .unchanged }
    guard let picture = exportedImage() else {
      fail(handoff: .attachmentsUnavailable)
      return .failed
    }
    let attachmentId = UUID()
    let revision = markupRevision
    handingOff = true
    defer { handingOff = false }
    if let replacing {
      let result = await deliver(.replaceImage(replacing: replacing, image: picture, attachmentId: attachmentId))
      guard result == .attached else {
        fail(handoff: result)
        return .failed
      }
      if let index = adds.firstIndex(where: { $0.attachmentId == replacing }) {
        adds[index].attachmentId = attachmentId
      }
      pictureAttachmentId = attachmentId
      pictureMarkupRevision = revision
      ADEHaptics.success()
      showToast(.attached, "Markup attached to chat")
      return .attached
    }
    let add = LiveInspectAdd(
      elementId: nil,
      text: markupBlock,
      attachmentId: attachmentId,
      carriesPreamble: true
    )
    let result = await deliver(.insert(text: add.text, image: picture, attachmentId: attachmentId))
    guard result == .attached else {
      fail(handoff: result)
      return .failed
    }
    record(add, pictureRevision: revision)
    ADEHaptics.success()
    showToast(.attached, "Attached to chat")
    return .attached
  }

  func dismissToast() {
    toastGeneration += 1
    toast = nil
  }

  private func record(_ add: LiveInspectAdd, pictureRevision: Int) {
    adds.append(add)
    if let attachmentId = add.attachmentId {
      pictureAttachmentId = attachmentId
      pictureMarkupRevision = pictureRevision
    }
    if let elementId = add.elementId { addedElementIds.insert(elementId) }
    attachedCount += 1
  }

  private func deliver(_ request: LiveInspectComposerHandoff.Request) async -> LiveInspectHandoffResult {
    await LiveInspectComposerHandoff.deliver(request, sessionId: chatSessionId, laneId: laneId)
  }

  private func fail(handoff result: LiveInspectHandoffResult) {
    ADEHaptics.error()
    showToast(.error, result.failureMessage ?? "Couldn't reach this chat's composer")
  }

  private func showToast(_ kind: LiveInspectToast.Kind, _ message: String, undo: UUID? = nil) {
    toastGeneration += 1
    let generation = toastGeneration
    toast = LiveInspectToast(kind: kind, message: message, undoAddId: undo)
    Task {
      try? await Task.sleep(for: .seconds(undo == nil ? 3 : 5))
      guard generation == toastGeneration else { return }
      toast = nil
    }
  }

  // MARK: Markup

  func beginStroke(at point: CGPoint) {
    guard tool.draws else { return }
    draft = LiveInspectStroke(tool: tool, points: [clamped(point)])
  }

  func extendStroke(to point: CGPoint) {
    guard tool.draws, var stroke = draft else { return }
    let next = clamped(point)
    if stroke.tool == .pen {
      stroke.points.append(next)
    } else {
      // Arrow and circle are two points: where it started and where it is now.
      if stroke.points.count == 1 {
        stroke.points.append(next)
      } else {
        stroke.points[stroke.points.count - 1] = next
      }
    }
    draft = stroke
  }

  func endStroke() {
    guard let stroke = draft else { return }
    draft = nil
    if stroke.tool != .pen {
      guard stroke.points.count == 2 else { return }
      let a = stroke.points[0]
      let b = stroke.points[1]
      if abs(a.x - b.x) < 8, abs(a.y - b.y) < 8 { return }
    } else if stroke.points.count < 2 {
      return
    }
    strokes.append(stroke)
    markupRevision += 1
    hasInteracted = true
  }

  var canUndo: Bool { !strokes.isEmpty }

  func undo() {
    guard !strokes.isEmpty else { return }
    strokes.removeLast()
    markupRevision += 1
    ADEHaptics.light()
  }

  func clearMarkup() {
    guard !strokes.isEmpty else { return }
    strokes.removeAll()
    markupRevision += 1
    ADEHaptics.light()
  }

  private func clamped(_ point: CGPoint) -> CGPoint {
    CGPoint(
      x: min(max(point.x, 0), pixelSize.width),
      y: min(max(point.y, 0), pixelSize.height)
    )
  }

  // MARK: Export

  /// The still with every stroke drawn on it, at the picture's own pixel size.
  func exportedImage() -> UIImage? {
    guard let image, pixelSize.width > 0, pixelSize.height > 0 else { return nil }
    guard !strokes.isEmpty else { return image }
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: pixelSize, format: format)
    return renderer.image { context in
      image.draw(in: CGRect(origin: .zero, size: pixelSize))
      let cg = context.cgContext
      for stroke in strokes {
        LiveInspectDrawing.stroke(stroke, in: cg, imageSize: pixelSize)
      }
    }
  }

  /// One add's text block, in `visualContextFormatting.ts`'s shape: the
  /// surface preamble (first add of a session only), then the numbered row and
  /// its pretty JSON packet.
  func elementBlock(_ element: LiveInspectElement, number: Int, preamble: Bool) -> String {
    var lines: [String] = []
    if preamble {
      lines.append(packetPreamble)
      lines.append("")
    }
    lines.append("\(number). \(element.displayTitle) (\(sourceText(element)), frame=\(element.frameLabel))")
    lines.append("Packet:")
    lines.append(LiveInspectPacket.json(packet(for: element)))
    return lines.joined(separator: "\n")
  }

  /// The text that goes with a marked-up picture attached at Done when no
  /// element was added.
  var markupBlock: String {
    [
      surface.packetName,
      "The attached picture is the frozen \(surface.title) screen with the user's markup drawn on it.",
    ].joined(separator: "\n")
  }

  private var packetPreamble: String {
    switch surface {
    case .simulator:
      return [
        surface.packetName,
        "Each packet came from the user clicking a UI element in the real iOS Simulator. Image attachments are visual evidence for the same packet and use the same screenshot coordinate space.",
        "Use exactSource when sourceConfidence is exact. Treat sourceCandidates as ranked best guesses, not proof; prefer nearbyElements and the screenshot when the source is missing or only candidate quality.",
        "The attached picture is the frozen screen; any marks drawn on it are the user's markup.",
      ].joined(separator: "\n")
    case .appControl:
      return [
        surface.packetName,
        "Each packet came from a developer-owned app session, usually Electron launched or connected through ADE CLI with a local CDP port. Image attachments are visual evidence for the same packet and use the frozen frame's pixel space.",
        "Use exactSource when sourceConfidence is exact. Treat sourceCandidates as ranked guesses from DOM text/test ids/selectors and source search, not proof. Prefer the screenshot, DOM selector, and exact source when available.",
        "The attached picture is the frozen frame; any marks drawn on it are the user's markup.",
      ].joined(separator: "\n")
    case .macDesktop:
      return [
        surface.packetName,
        "Each packet came from the user clicking an accessibility element on the lane's private macOS screen while the picture was frozen. Image attachments use the same screen-pixel space as the element frames.",
        "Accessibility elements carry no source file. Prefer the picture and the element's role, title, and frame; a truncated walk means the element under the finger may be missing.",
        "The attached picture is the frozen screen; any marks drawn on it are the user's markup.",
      ].joined(separator: "\n")
    }
  }

  private func sourceText(_ element: LiveInspectElement) -> String {
    if let source = element.sourceLabel { return source }
    return element.sourceConfidence == "candidate"
      ? "no exact source; ranked candidates below"
      : "no source match"
  }

  private func packet(for element: LiveInspectElement) -> [String: Any] {
    var packet: [String: Any] = [:]
    packet["contextId"] = "\(surface.rawValue):\(element.id)"
    packet["surface"] = surface.rawValue
    packet["visualAttachmentPath"] = NSNull()
    packet["selectedAt"] = LiveInspectPacket.now
    packet["screen"] = screen?.packet ?? [:]
    packet["sourceConfidence"] = element.sourceConfidence ?? (element.sourceFile != nil ? "exact" : "none")
    if let source = element.sourceLabel {
      var exact: [String: Any] = ["sourceFile": element.sourceFile ?? source]
      if let line = element.sourceLine { exact["sourceLine"] = line }
      packet["exactSource"] = exact
    } else {
      packet["exactSource"] = NSNull()
    }
    packet["sourceCandidates"] = []
    packet["nearbyElements"] = nearbyElements(for: element)
    switch surface {
    case .simulator:
      var selected: [String: Any] = [
        "componentId": element.componentId ?? element.id,
        "accessibilityIdentifier": element.identifier ?? NSNull(),
      ]
      selected["label"] = element.label ?? NSNull()
      selected["value"] = element.value ?? NSNull()
      selected["role"] = element.role ?? NSNull()
      selected["elementType"] = element.elementType ?? NSNull()
      selected["screenshotFrame"] = packetFrame(element.frame)
      packet["selectedElement"] = selected
    case .appControl:
      packet["appKind"] = "electron"
      packet["provider"] = element.role ?? "cdp"
      packet["url"] = NSNull()
      packet["title"] = NSNull()
      var selected: [String: Any] = [
        "componentId": element.componentId ?? element.id,
        "tagName": element.elementType ?? NSNull(),
      ]
      selected["label"] = element.label ?? NSNull()
      selected["value"] = element.value ?? NSNull()
      selected["role"] = element.role ?? NSNull()
      selected["screenshotFrame"] = packetFrame(element.frame)
      packet["selectedElement"] = selected
    case .macDesktop:
      var selected: [String: Any] = [
        "role": element.role ?? NSNull(),
        "subrole": element.subrole ?? NSNull(),
        "label": element.label ?? NSNull(),
        "value": element.value ?? NSNull(),
        "identifier": element.identifier ?? NSNull(),
      ]
      if let enabled = element.enabled { selected["enabled"] = enabled }
      selected["screenshotFrame"] = packetFrame(element.frame)
      packet["selectedElement"] = selected
    }
    return packet
  }

  private func packetFrame(_ frame: LiveInspectFrame) -> [String: Any] {
    [
      "x": frame.x,
      "y": frame.y,
      "width": frame.width,
      "height": frame.height,
    ]
  }

  private func nearbyElements(for element: LiveInspectElement) -> [[String: Any]] {
    let nearby: [LiveInspectElement]
    switch surface {
    case .simulator:
      nearby = LiveInspectGeometry.nearbyByOverlap(element, in: elements)
    case .appControl, .macDesktop:
      nearby = LiveInspectGeometry.nearbyByDistance(element, in: elements)
    }
    return nearby.prefix(8).map { other in
      var row: [String: Any] = [
        "label": other.label ?? NSNull(),
        "value": other.value ?? NSNull(),
        "role": other.role ?? NSNull(),
        "elementType": other.elementType ?? NSNull(),
        "identifier": other.identifier ?? NSNull(),
        "componentId": other.componentId ?? NSNull(),
        "source": other.sourceLabel ?? NSNull(),
        "screenshotFrame": packetFrame(other.frame),
      ]
      if surface == .simulator {
        row["relation"] = LiveInspectGeometry.relation(of: other, to: element)
      }
      return row
    }
  }

  #if DEBUG
  /// Fixture seam: a ready model with everything already in place, no sync.
  func installPreview(
    image: UIImage,
    elements: [LiveInspectElement],
    selected: LiveInspectElement?,
    strokes: [LiveInspectStroke]
  ) {
    let pixel = LiveInspectImage.pixelSize(of: image)
    self.image = image
    self.pixelSize = pixel
    self.screen = LiveInspectScreen(
      width: 402,
      height: 874,
      scale: 3,
      viewportWidth: nil,
      viewportHeight: nil
    )
    self.elements = elements
    self.selected = selected
    self.strokes = strokes
    self.draft = nil
    self.markupRevision += 1
    self.hasInteracted = selected != nil || !strokes.isEmpty
    self.phase = .ready
  }
  #endif
}

/// What Done did before the stage closes.
enum LiveInspectFinishOutcome {
  /// Nothing to bring up to date; close now.
  case unchanged
  /// The marked-up picture landed; the toast is showing.
  case attached
  /// The composer refused or never answered; the error toast is showing.
  case failed
}

/// What one add put in the draft, so Undo and Done can find it again.
private struct LiveInspectAdd {
  let id = UUID()
  /// Nil for the marked-up picture Done attaches on its own.
  let elementId: String?
  /// The block exactly as inserted.
  let text: String
  /// Set when this add attached the picture (replaced in place by Done).
  var attachmentId: UUID?
  let carriesPreamble: Bool
}

struct LiveInspectFailure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }

  /// The host's own sentence, without the machine code ahead of it. Used for
  /// every surface: a Mac Desktop error reworded as a Mac Desktop error would
  /// be wrong on the simulator, and the screens each send plain sentences.
  static func visibleMessage(for error: Error) -> String {
    let nsError = error as NSError
    if (nsError.userInfo["ADEErrorCode"] as? String) == "unsupported_action" {
      return "Update ADE on your Mac to inspect its screens from here."
    }
    let raw = nsError.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let colon = raw.firstIndex(of: ":") else {
      return raw.isEmpty ? "The picture couldn't be frozen." : raw
    }
    let code = String(raw[..<colon])
    guard !code.isEmpty,
          code.allSatisfy({ $0.isLetter || $0 == "_" || $0 == "-" }) else {
      return raw
    }
    let detail = String(raw[raw.index(after: colon)...]).trimmingCharacters(in: .whitespacesAndNewlines)
    return detail.isEmpty ? raw : detail
  }
}
