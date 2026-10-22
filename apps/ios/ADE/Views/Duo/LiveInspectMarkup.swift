import SwiftUI
import UIKit

// Inspect and markup on a frozen live view (Simulator, App Control, Mac
// Desktop).
//
// Watching stays the default and is untouched. Inspect is a step away from it:
// the stream stops, one still plus the elements on it arrive from the machine
// that owns the lane, and the person taps an element and draws on the picture.
// Leaving resumes the stream. The handoff back to a chat is a notification so a
// viewer does not need a composer of its own — see LiveInspectComposerHandoff.
//
// Geometry mirrors `appleInspectGeometry.ts`: hit-testing keeps the smallest
// element under the point, and the packet is formatted like
// `visualContextFormatting.ts` (preamble, numbered row, pretty JSON).

// MARK: - Composer handoff

/// What one Send hands the chat composer: the annotated picture and the packet
/// describing the elements picked while inspecting.
///
/// Posted on `.liveInspectComposerHandoff` with this object. The receiver (the
/// chat that mounts the composer) turns `image` into a `WorkChatInputAttachment`
/// and prepends `text` to the draft. `laneId` is always set; `sessionId` is set
/// only for a viewer that was opened from a chat.
final class LiveInspectComposerHandoff: NSObject {
  let sessionId: String?
  let laneId: String
  let image: UIImage
  let text: String

  init(sessionId: String?, laneId: String, image: UIImage, text: String) {
    self.sessionId = sessionId
    self.laneId = laneId
    self.image = image
    self.text = text
  }
}

extension Notification.Name {
  /// Carries a `LiveInspectComposerHandoff` in `object`.
  static let liveInspectComposerHandoff = Notification.Name("com.ade.ios.liveInspectComposerHandoff")
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

// MARK: - Wire models

/// A rect on the wire. Kept as doubles so one type fits every surface: the
/// simulator sends pixels, App Control screenshot pixels, Mac Desktop global
/// display points.
struct LiveInspectFrame: Codable, Equatable {
  var x: Double
  var y: Double
  var width: Double
  var height: Double

  var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }

  init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  init(_ rect: CGRect) {
    self.init(
      x: Double(rect.origin.x),
      y: Double(rect.origin.y),
      width: Double(rect.width),
      height: Double(rect.height)
    )
  }

  /// The same rect scaled into another pixel space.
  func scaled(by factor: CGSize) -> CGRect {
    CGRect(
      x: x * Double(factor.width),
      y: y * Double(factor.height),
      width: width * Double(factor.width),
      height: height * Double(factor.height)
    )
  }
}

/// The screen the element frames are in. `viewport` is App Control's CSS
/// viewport; nil for the other surfaces.
struct LiveInspectScreen: Equatable {
  var width: Double
  var height: Double
  var scale: Double
  var viewportWidth: Double?
  var viewportHeight: Double?

  var size: CGSize { CGSize(width: width, height: height) }

  var label: String {
    let w = Int(width.rounded())
    let h = Int(height.rounded())
    return "\(w) × \(h)"
  }

  var packet: [String: Any] {
    var out: [String: Any] = ["width": width, "height": height, "scale": scale]
    if let viewportWidth { out["viewportWidth"] = viewportWidth }
    if let viewportHeight { out["viewportHeight"] = viewportHeight }
    return out
  }
}

/// One element on the frozen picture.
///
/// `frame` is the surface's own frame (what the desktop packet reports as
/// `screenshotFrame`), `pointFrame` the device-point frame the simulator
/// inspector also carries, and `imageFrame` the rect on the frozen image the
/// overlay and hit-test use. They differ whenever the frozen image is not the
/// host's full-fidelity screenshot, which is always true for App Control.
struct LiveInspectElement: Identifiable, Equatable {
  var id: String
  var label: String?
  var value: String?
  var role: String?
  var elementType: String?
  var subrole: String?
  var identifier: String?
  var componentId: String?
  var sourceFile: String?
  var sourceLine: Int?
  var sourceConfidence: String?
  var enabled: Bool?
  var focused: Bool?
  var frame: LiveInspectFrame
  var pointFrame: LiveInspectFrame?
  var imageFrame: CGRect

  var sourceLabel: String? {
    guard let file = sourceFile?.liveInspectTrimmed else { return nil }
    if let sourceLine { return "\(file):\(sourceLine)" }
    return file
  }

  /// The strongest name this element has, matching `describeElement`.
  var displayTitle: String {
    for candidate in [label, identifier, componentId, value, elementType, role] {
      if let text = candidate?.liveInspectTrimmed { return text }
    }
    return id
  }

  var displaySubtitle: String {
    var parts: [String] = []
    if let role = (role ?? elementType)?.liveInspectTrimmed {
      parts.append(role)
    }
    if let subrole = subrole?.liveInspectTrimmed {
      parts.append(subrole)
    }
    if let identifier = identifier?.liveInspectTrimmed, identifier != displayTitle {
      parts.append("#\(identifier)")
    }
    return parts.joined(separator: " · ")
  }

  var frameLabel: String {
    LiveInspectGeometry.frameText(pointFrame ?? frame)
  }

  var hasIdentity: Bool {
    identifier?.liveInspectTrimmed != nil || componentId?.liveInspectTrimmed != nil
  }
}

/// The `ios_simulator.getScreenSnapshot` reply, only the fields the frozen
/// inspector draws. Everything else on the wire is ignored by Codable.
struct LiveInspectIosSnapshot: Decodable {
  struct Screenshot: Decodable {
    var dataUrl: String
    var width: Double?
    var height: Double?
  }

  struct Screen: Decodable {
    var width: Double?
    var height: Double?
    var scale: Double?
  }

  struct Element: Decodable {
    var id: String
    var label: String?
    var value: String?
    var role: String?
    var elementType: String?
    var identifier: String?
    var componentId: String?
    var sourceFile: String?
    var sourceLine: Int?
    var frame: LiveInspectFrame
    var pixelFrame: LiveInspectFrame?
  }

  var screenshot: Screenshot
  var screen: Screen?
  var elements: [Element]
}

/// The phone-sized projection of `appControl.inspectPoint`.
struct LiveInspectAppControlReply: Decodable {
  struct Item: Decodable {
    var id: String?
    var provider: String?
    var componentId: String?
    var sourceFile: String?
    var sourceLine: Int?
    var frame: LiveInspectFrame?
    var selectedAt: String?
    var label: String?
    var value: String?
    var role: String?
    var tagName: String?
    var selector: String?
    var testId: String?
    var sourceConfidence: String?
  }

  struct Screen: Decodable {
    var width: Double?
    var height: Double?
    var scale: Double?
    var viewportWidth: Double?
    var viewportHeight: Double?
    var scaleX: Double?
    var scaleY: Double?
  }

  struct Snapshot: Decodable {
    var screen: Screen?
    var url: String?
    var title: String?
  }

  var source: String?
  var item: Item?
  var snapshot: Snapshot?
}

/// The phone-sized projection of `macDesktop.observe`.
struct LiveInspectMacDesktopReply: Decodable {
  struct Display: Decodable {
    var width: Double
    var height: Double
    var scale: Double?
    var originX: Double?
    var originY: Double?
  }

  struct Element: Decodable {
    var index: Int?
    var role: String?
    var subrole: String?
    var title: String?
    var label: String?
    var value: String?
    var identifier: String?
    var enabled: Bool?
    var focused: Bool?
    var frame: LiveInspectFrame
  }

  struct Observation: Decodable {
    var id: String?
    var capturedAt: String?
    var screenshotPath: String
    var display: Display
    var elements: [Element]
    var elementCount: Int?
    var truncated: Bool?
    var truncatedReason: String?
    var caption: String?
  }

  var observation: Observation
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
/// strokes, and the handoff.
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
  /// Elements the person added to the message. Send includes all of them, or
  /// the current selection when nothing was added.
  @Published private(set) var staged: [LiveInspectElement] = []
  @Published var tool: LiveInspectTool = .select
  @Published private(set) var strokes: [LiveInspectStroke] = []
  @Published private(set) var draft: LiveInspectStroke?
  @Published private(set) var busy = false
  @Published private(set) var errorText: String?
  @Published private(set) var note: String?

  private weak var syncService: SyncService?
  private var plan: LiveInspectLoadPlan?
  private var didSend = false
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
    self.staged = []
    self.strokes = []
    self.draft = nil
    self.errorText = nil
    self.phase = .ready
  }

  private func fail(_ error: Error) {
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
      Task { await selectAppControl(atImagePoint: point, generation: generation) }
      return
    }
    let hit = LiveInspectGeometry.hitTest(elements, point: point)
    selected = hit
    errorText = nil
    note = hit == nil ? "Nothing on this screen is under that point." : nil
    if hit != nil { ADEHaptics.light() }
  }

  private func selectAppControl(atImagePoint point: CGPoint, generation: Int) async {
    guard generation == selectionGeneration,
          let syncService, pixelSize.width > 0, pixelSize.height > 0 else { return }
    let viewport = appControlViewport()
    guard let viewport else {
      errorText = "This host didn't send the frame's scale, so taps can't be placed."
      return
    }
    busy = true
    errorText = nil
    defer {
      if generation == selectionGeneration { busy = false }
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

  // MARK: Staging

  func isStaged(_ element: LiveInspectElement) -> Bool {
    staged.contains { $0.id == element.id }
  }

  func stageSelection() {
    guard let selected else { return }
    if let index = staged.firstIndex(where: { $0.id == selected.id }) {
      staged.remove(at: index)
    } else {
      staged.append(selected)
    }
    ADEHaptics.light()
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
  }

  var canUndo: Bool { !strokes.isEmpty }

  func undo() {
    guard !strokes.isEmpty else { return }
    strokes.removeLast()
    ADEHaptics.light()
  }

  func clearMarkup() {
    guard !strokes.isEmpty else { return }
    strokes.removeAll()
    ADEHaptics.light()
  }

  private func clamped(_ point: CGPoint) -> CGPoint {
    CGPoint(
      x: min(max(point.x, 0), pixelSize.width),
      y: min(max(point.y, 0), pixelSize.height)
    )
  }

  // MARK: Export

  var canSend: Bool {
    phase == .ready && image != nil && !didSend
  }

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

  /// The packet for the elements that go with the picture. Empty when nothing
  /// was picked: the picture alone is still worth sending.
  func packetText() -> String {
    var picked = staged
    if let selected, !picked.contains(where: { $0.id == selected.id }) {
      picked.append(selected)
    }
    guard !picked.isEmpty else {
      let header = [
        surface.packetName,
        "The attached picture is the frozen \(surface.title) screen"
          + (strokes.isEmpty ? "." : " with the user's markup drawn on it."),
      ]
      return header.joined(separator: "\n") + "\n"
    }
    var lines: [String] = []
    let preamble = packetPreamble
    lines.append(preamble)
    for (index, element) in picked.enumerated() {
      lines.append("")
      lines.append("\(index + 1). \(element.displayTitle) (\(sourceText(element)), frame=\(element.frameLabel))")
      lines.append("Packet:")
      lines.append(LiveInspectPacket.json(packet(for: element)))
    }
    return lines.joined(separator: "\n") + "\n"
  }

  private var packetPreamble: String {
    switch surface {
    case .simulator:
      return [
        surface.packetName,
        "Each packet came from the user clicking a UI element in the real iOS Simulator. Image attachments are visual evidence for the same packet and use the same screenshot coordinate space.",
        "Use exactSource when sourceConfidence is exact. Treat sourceCandidates as ranked best guesses, not proof; prefer nearbyElements and the screenshot when the source is missing or only candidate quality.",
        "The attached picture is the frozen screen" + (strokes.isEmpty ? "." : " with the user's markup drawn on it."),
      ].joined(separator: "\n")
    case .appControl:
      return [
        surface.packetName,
        "Each packet came from a developer-owned app session, usually Electron launched or connected through ADE CLI with a local CDP port. Image attachments are visual evidence for the same packet and use the frozen frame's pixel space.",
        "Use exactSource when sourceConfidence is exact. Treat sourceCandidates as ranked guesses from DOM text/test ids/selectors and source search, not proof. Prefer the screenshot, DOM selector, and exact source when available.",
        "The attached picture is the frozen frame" + (strokes.isEmpty ? "." : " with the user's markup drawn on it."),
      ].joined(separator: "\n")
    case .macDesktop:
      return [
        surface.packetName,
        "Each packet came from the user clicking an accessibility element on the lane's private macOS screen while the picture was frozen. Image attachments use the same screen-pixel space as the element frames.",
        "Accessibility elements carry no source file. Prefer the picture and the element's role, title, and frame; a truncated walk means the element under the finger may be missing.",
        "The attached picture is the frozen screen" + (strokes.isEmpty ? "." : " with the user's markup drawn on it."),
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

  // MARK: Send

  @discardableResult
  func sendToComposer() -> Bool {
    guard canSend, let image = exportedImage() else { return false }
    didSend = true
    NotificationCenter.default.post(
      name: .liveInspectComposerHandoff,
      object: LiveInspectComposerHandoff(
        sessionId: chatSessionId,
        laneId: laneId,
        image: image,
        text: packetText()
      )
    )
    return true
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
    self.staged = []
    self.strokes = strokes
    self.draft = nil
    self.phase = .ready
  }
  #endif
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

// MARK: - Geometry (port of appleInspectGeometry.ts)

enum LiveInspectGeometry {
  static func frameText(_ frame: LiveInspectFrame) -> String {
    "x=\(Int(frame.x.rounded())), y=\(Int(frame.y.rounded())), w=\(Int(frame.width.rounded())), h=\(Int(frame.height.rounded()))"
  }

  static func contains(_ frame: CGRect, point: CGPoint) -> Bool {
    guard frame.width > 0, frame.height > 0 else { return false }
    return point.x >= frame.minX && point.x <= frame.maxX
      && point.y >= frame.minY && point.y <= frame.maxY
  }

  static func contains(_ outer: CGRect, _ inner: CGRect) -> Bool {
    guard outer.width * outer.height > inner.width * inner.height else { return false }
    return inner.minX >= outer.minX && inner.minY >= outer.minY
      && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY
  }

  /// Smallest-area hit under a point. Equal areas keep the later snapshot
  /// index, so a later sibling painted on top of an equal-size peer wins.
  static func hitTest(_ elements: [LiveInspectElement], point: CGPoint) -> LiveInspectElement? {
    var best: LiveInspectElement?
    var bestArea = CGFloat.infinity
    var bestIndex = -1
    for (index, element) in elements.enumerated() {
      guard contains(element.imageFrame, point: point) else { continue }
      let area = max(0, element.imageFrame.width) * max(0, element.imageFrame.height)
      if area < bestArea || (area == bestArea && index > bestIndex) {
        best = element
        bestArea = area
        bestIndex = index
      }
    }
    return best
  }

  /// Ancestors nearest-first, by containment: the smallest enclosing frame is
  /// the parent. The simulator snapshot carries no parent ids.
  static func ancestors(of element: LiveInspectElement, in elements: [LiveInspectElement]) -> [LiveInspectElement] {
    var chain: [LiveInspectElement] = []
    var seen: Set<String> = [element.id]
    var current = element
    while true {
      var parent: LiveInspectElement?
      var parentArea = CGFloat.infinity
      for candidate in elements where candidate.id != current.id {
        guard contains(candidate.imageFrame, current.imageFrame) else { continue }
        let area = candidate.imageFrame.width * candidate.imageFrame.height
        if area < parentArea {
          parent = candidate
          parentArea = area
        }
      }
      guard let next = parent, !seen.contains(next.id) else { break }
      chain.append(next)
      seen.insert(next.id)
      current = next
    }
    return chain
  }

  static func relation(of other: LiveInspectElement, to element: LiveInspectElement) -> String {
    if contains(other.imageFrame, element.imageFrame) { return "ancestor-or-container" }
    if contains(element.imageFrame, other.imageFrame) { return "descendant" }
    return "nearby"
  }

  static func nearbyByOverlap(_ element: LiveInspectElement, in elements: [LiveInspectElement]) -> [LiveInspectElement] {
    elements
      .filter { $0.id != element.id }
      .sorted { left, right in
        intersection(left.imageFrame, element.imageFrame) > intersection(right.imageFrame, element.imageFrame)
      }
      .prefix(8)
      .map { $0 }
  }

  static func nearbyByDistance(_ element: LiveInspectElement, in elements: [LiveInspectElement]) -> [LiveInspectElement] {
    let center = CGPoint(x: element.imageFrame.midX, y: element.imageFrame.midY)
    return elements
      .filter { $0.id != element.id }
      .sorted { left, right in
        distance(left.imageFrame, center) < distance(right.imageFrame, center)
      }
      .prefix(8)
      .map { $0 }
  }

  private static func distance(_ frame: CGRect, _ point: CGPoint) -> CGFloat {
    hypot(frame.midX - point.x, frame.midY - point.y)
  }

  private static func intersection(_ a: CGRect, _ b: CGRect) -> CGFloat {
    let rect = a.intersection(b)
    guard !rect.isNull else { return 0 }
    return max(0, rect.width) * max(0, rect.height)
  }

  /// The aspect-fit rect a picture of `pixelSize` takes inside `container`.
  static func fit(pixelSize: CGSize, in container: CGSize) -> CGRect {
    guard container.width > 0, container.height > 0,
          pixelSize.width > 0, pixelSize.height > 0 else { return .zero }
    let scale = min(container.width / pixelSize.width, container.height / pixelSize.height)
    let size = CGSize(width: pixelSize.width * scale, height: pixelSize.height * scale)
    return CGRect(
      x: (container.width - size.width) / 2,
      y: (container.height - size.height) / 2,
      width: size.width,
      height: size.height
    )
  }

  /// A point on the displayed picture, back to frozen-image pixels.
  static func imagePoint(_ point: CGPoint, in rect: CGRect, pixelSize: CGSize) -> CGPoint? {
    guard rect.width > 0, rect.height > 0, pixelSize.width > 0, pixelSize.height > 0 else { return nil }
    guard rect.insetBy(dx: -1, dy: -1).contains(point) else { return nil }
    return CGPoint(
      x: (point.x - rect.minX) / rect.width * pixelSize.width,
      y: (point.y - rect.minY) / rect.height * pixelSize.height
    )
  }
}

// MARK: - Drawing

enum LiveInspectDrawing {
  static func lineWidth(for imageSize: CGSize) -> CGFloat {
    max(3, imageSize.width * 0.006)
  }

  /// The path of one stroke, in image pixels.
  static func path(for stroke: LiveInspectStroke, imageSize: CGSize) -> Path {
    var path = Path()
    guard let first = stroke.points.first else { return path }
    switch stroke.tool {
    case .pen:
      if stroke.points.count == 1 {
        let radius = lineWidth(for: imageSize) / 2
        path.addEllipse(in: CGRect(x: first.x - radius, y: first.y - radius, width: radius * 2, height: radius * 2))
        return path
      }
      path.move(to: first)
      for point in stroke.points.dropFirst() {
        path.addLine(to: point)
      }
    case .arrow:
      guard let last = stroke.points.last else { return path }
      path.move(to: first)
      path.addLine(to: last)
      let angle = atan2(last.y - first.y, last.x - first.x)
      let length = max(18, lineWidth(for: imageSize) * 3.4)
      for offset in [CGFloat.pi * 0.78, -CGFloat.pi * 0.78] {
        path.move(to: last)
        path.addLine(to: CGPoint(
          x: last.x + cos(angle + offset) * length,
          y: last.y + sin(angle + offset) * length
        ))
      }
    case .circle:
      guard let last = stroke.points.last else { return path }
      let rect = CGRect(
        x: min(first.x, last.x),
        y: min(first.y, last.y),
        width: abs(last.x - first.x),
        height: abs(last.y - first.y)
      )
      path.addEllipse(in: rect)
    case .select:
      break
    }
    return path
  }

  /// Draws one stroke into a UIKit context, in the context's own pixels.
  static func stroke(_ stroke: LiveInspectStroke, in context: CGContext, imageSize: CGSize) {
    let path = path(for: stroke, imageSize: imageSize)
    guard !path.isEmpty else { return }
    let width = lineWidth(for: imageSize)
    let cgPath = path.cgPath
    context.saveGState()
    context.setLineCap(.round)
    context.setLineJoin(.round)
    // A pale halo under the ink so a mark reads on a white Settings screen and
    // on a dark editor alike.
    context.setStrokeColor(UIColor.white.withAlphaComponent(0.9).cgColor)
    context.setLineWidth(width + max(2, width * 0.5))
    context.addPath(cgPath)
    context.strokePath()
    context.setStrokeColor(LiveInspectInk.uiColor.cgColor)
    context.setLineWidth(width)
    context.addPath(cgPath)
    context.strokePath()
    context.restoreGState()
  }
}

enum LiveInspectImage {
  static func image(fromDataURL dataUrl: String) -> UIImage? {
    let base64: String
    if let comma = dataUrl.firstIndex(of: ",") {
      base64 = String(dataUrl[dataUrl.index(after: comma)...])
    } else {
      base64 = dataUrl
    }
    guard let data = Data(base64Encoded: base64), !data.isEmpty else { return nil }
    return UIImage(data: data)
  }

  static func pixelSize(of image: UIImage) -> CGSize {
    if let cgImage = image.cgImage {
      return CGSize(width: cgImage.width, height: cgImage.height)
    }
    return CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
  }
}

enum LiveInspectPacket {
  static var now: String {
    ISO8601DateFormatter().string(from: Date())
  }

  /// `JSON.stringify(packet, null, 2)`'s shape: sorted keys keep two sends of
  /// the same element identical, which is what makes a packet diffable.
  static func json(_ packet: [String: Any]) -> String {
    guard JSONSerialization.isValidJSONObject(packet),
          let data = try? JSONSerialization.data(
            withJSONObject: packet,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
          ),
          let text = String(data: data, encoding: .utf8) else {
      return "{}"
    }
    return text
  }
}

// MARK: - Sync commands

extension SyncService {
  /// One still plus every element the lane's simulator can name, for the frozen
  /// inspect view.
  ///
  /// `getScreenSnapshot` and not `inspectPoint`: the latter is ownership-guarded
  /// and opens the inspector drawer on the Mac that owns the device, which a
  /// phone that is only looking should not do. `proof: false` keeps an inspect
  /// from filing a proof row nobody asked for.
  func fetchLiveInspectSimulatorSnapshot(laneId: String) async throws -> LiveInspectIosSnapshot {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard supportsAppleDeviceControl(laneId: trimmed) else {
      throw NSError(
        domain: "ADE",
        code: 17,
        userInfo: [
          NSLocalizedDescriptionKey: "Update ADE on your Mac to inspect its simulator from here.",
          "ADEErrorCode": "unsupported_action",
        ]
      )
    }
    return try decode(
      try await sendCommand(
        action: "apple.invoke",
        args: [
          "method": "getScreenSnapshot",
          "laneId": trimmed,
          "args": ["proof": false],
        ],
        disconnectOnTimeout: false,
        timeoutNanoseconds: 20_000_000_000
      ),
      as: LiveInspectIosSnapshot.self
    )
  }

  /// One host-side hit-test on the lane's App Control frame.
  func appControlInspectPoint(laneId: String, x: Double, y: Double) async throws -> LiveInspectAppControlReply {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard supportsViewerRemoteAction("appControl.inspectPoint") else {
      throw NSError(
        domain: "ADE",
        code: 17,
        userInfo: [
          NSLocalizedDescriptionKey: "Update ADE on your Mac to inspect its app from here.",
          "ADEErrorCode": "unsupported_action",
        ]
      )
    }
    return try decode(
      try await sendCommand(
        action: "appControl.inspectPoint",
        args: [
          "laneId": trimmed,
          "x": x,
          "y": y,
          "coordinateSpace": "viewport",
        ],
        disconnectOnTimeout: false,
        timeoutNanoseconds: 20_000_000_000
      ),
      as: LiveInspectAppControlReply.self
    )
  }

  /// One accessibility observation of the lane's desktop, for the frozen
  /// inspect view. The picture follows through `readWorkToolsObservationPreview`
  /// with the path in the reply.
  func macDesktopObserve(laneId: String, limit: Int = 200) async throws -> LiveInspectMacDesktopReply {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard supportsViewerRemoteAction("macDesktop.observe") else {
      throw NSError(
        domain: "ADE",
        code: 17,
        userInfo: [
          NSLocalizedDescriptionKey: "Update ADE on your Mac to inspect its desktop from here.",
          "ADEErrorCode": "unsupported_action",
        ]
      )
    }
    return try decode(
      try await sendCommand(
        action: "macDesktop.observe",
        args: ["laneId": trimmed, "limit": limit],
        disconnectOnTimeout: false,
        timeoutNanoseconds: 25_000_000_000
      ),
      as: LiveInspectMacDesktopReply.self
    )
  }
}

// MARK: - Stage

/// The frozen inspector: the picture, its elements, the markup tools, and the
/// send. Wide splits around the fold (picture on one page, card and tools on
/// the other); compact keeps the picture full and puts the panel at the bottom.
struct LiveInspectStage: View {
  @ObservedObject var model: LiveInspectMarkupModel
  var onClose: () -> Void

  @Environment(\.duoLayout) private var duo

  var body: some View {
    VStack(spacing: 0) {
      topBar
      DuoLocalFoldReader { fold, size in
        if duo.isWide {
          wideLayout(fold: fold, size: size)
        } else {
          compactLayout(size: size)
        }
      }
    }
    .background(Color.black.ignoresSafeArea())
    .preferredColorScheme(.dark)
    .accessibilityIdentifier("LiveInspect.Stage")
  }

  // MARK: Chrome

  private var topBar: some View {
    HStack(spacing: 12) {
      Button {
        ADEHaptics.light()
        onClose()
      } label: {
        Image(systemName: "xmark")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(.white)
          .frame(width: 38, height: 38)
          .background(Color.white.opacity(0.12), in: Circle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Stop inspecting")
      .accessibilityIdentifier("LiveInspect.Close")

      VStack(alignment: .leading, spacing: 1) {
        Label("Inspect · \(model.surface.title)", systemImage: model.surface.symbolName)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.white)
          .lineLimit(1)
        Text(topBarSubtitle)
          .font(.caption2)
          .foregroundStyle(.white.opacity(0.62))
          .lineLimit(1)
      }
      Spacer(minLength: 0)
      if model.phase == .ready {
        Label("Frozen", systemImage: "pause.fill")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.white)
          .padding(.horizontal, 9)
          .padding(.vertical, 4)
          .background(Color.white.opacity(0.14), in: Capsule())
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .background(Color.black.opacity(0.82))
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(Color.white.opacity(0.08))
        .frame(height: 0.5)
    }
  }

  private var topBarSubtitle: String {
    switch model.phase {
    case .loading:
      return "Freezing the picture…"
    case .failed:
      return "Couldn't freeze the picture"
    case .ready:
      guard let screen = model.screen else { return "The stream is paused." }
      switch model.surface {
      case .simulator:
        return "\(screen.label) pt · \(screen.scale.formatted(.number.precision(.fractionLength(0...1))))× · \(model.elements.count) elements"
      case .appControl:
        return "\(screen.label) px · the app keeps running"
      case .macDesktop:
        return "\(screen.label) pt · the desktop keeps running"
      }
    }
  }

  // MARK: Layouts

  @ViewBuilder
  private func compactLayout(size: CGSize) -> some View {
    VStack(spacing: 0) {
      LiveInspectPicture(model: model)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
      panel
        .frame(height: min(max(220, size.height * 0.42), 420))
        .background(.ultraThinMaterial)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22, style: .continuous))
        .overlay(alignment: .top) {
          Capsule()
            .fill(Color.white.opacity(0.22))
            .frame(width: 36, height: 4)
            .padding(.top, 8)
            .accessibilityHidden(true)
        }
    }
  }

  @ViewBuilder
  private func wideLayout(fold: DuoFold, size: CGSize) -> some View {
    switch fold {
    case .none:
      flatWideLayout(size: size)
    case .stacked(let rect) where rect.minY > 200 && size.height - rect.minY > 240:
      VStack(spacing: 0) {
        canvasPage
          .frame(height: max(200, rect.minY - DuoWorkMetrics.hingeGutter / 2))
        DuoHingeGutter(axis: .horizontal)
        panelPage
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    case .sideBySide(let rect) where rect.minX > 240 && size.width - rect.minX > 260:
      HStack(spacing: 0) {
        canvasPage
        DuoHingeGutter(axis: .vertical)
        panelPage
          .frame(width: max(280, size.width - rect.minX - DuoWorkMetrics.hingeGutter))
      }
    default:
      HStack(spacing: 0) {
        canvasPage
        DuoHingeGutter(axis: .vertical)
        panelPage
          .frame(width: min(max(320, size.width * 0.36), 460))
      }
    }
  }

  /// Flat open (or an iPad): the system's own split arrangement, which is the
  /// native two-column feel. A folded display keeps the boundary exactly on
  /// the hinge instead — see `wideLayout`.
  @ViewBuilder
  private func flatWideLayout(size: CGSize) -> some View {
    if #available(iOS 27.1, *) {
      ArrangementView {
        canvasPage
          .frame(minWidth: 320, idealWidth: size.width * 0.64, maxWidth: .infinity)
      } secondary: {
        panelPage
          .frame(minWidth: 320, idealWidth: size.width * 0.36, maxWidth: 520)
      }
      .arrangementViewStyle(.split)
    } else {
      HStack(spacing: 0) {
        canvasPage
        DuoHingeGutter(axis: .vertical)
        panelPage
          .frame(width: min(max(320, size.width * 0.36), 460))
      }
    }
  }

  private var canvasPage: some View {
    LiveInspectPicture(model: model)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color.black)
      .accessibilityIdentifier("LiveInspect.Canvas")
  }

  private var panelPage: some View {
    panel
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color.black.opacity(0.55))
  }

  // MARK: Panel

  private var panel: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        panelHeader
        tools
        if let errorText = model.errorText {
          LiveInspectBanner(text: errorText, symbol: "exclamationmark.triangle", tint: ADEColor.warning)
        }
        if let note = model.note {
          Text(note)
            .font(.caption)
            .foregroundStyle(.white.opacity(0.62))
            .fixedSize(horizontal: false, vertical: true)
        }
        if let selected = model.selected {
          elementCard(selected)
        } else {
          emptySelection
        }
        sendButton
      }
      .padding(14)
    }
    .scrollBounceBehavior(.basedOnSize, axes: .vertical)
  }

  private var panelHeader: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(model.surface.title)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.white)
      if let screen = model.screen {
        Text(screen.label)
          .font(.caption.monospacedDigit())
          .foregroundStyle(.white.opacity(0.55))
      }
      Spacer(minLength: 0)
      if !model.elements.isEmpty {
        Text("\(model.elements.count) elements")
          .font(.caption)
          .foregroundStyle(.white.opacity(0.45))
      }
    }
  }

  private var tools: some View {
    HStack(spacing: 6) {
      ForEach(LiveInspectTool.allCases) { tool in
        toolButton(tool)
      }
      Spacer(minLength: 8)
      iconButton(symbol: "arrow.uturn.backward", label: "Undo", enabled: model.canUndo) {
        model.undo()
      }
      iconButton(symbol: "trash", label: "Clear markup", enabled: model.canUndo) {
        model.clearMarkup()
      }
    }
    .padding(5)
    .background(Color.white.opacity(0.08), in: Capsule(style: .continuous))
  }

  private func toolButton(_ tool: LiveInspectTool) -> some View {
    let selected = model.tool == tool
    return Button {
      ADEHaptics.light()
      model.tool = tool
    } label: {
      Label(tool.title, systemImage: tool.symbolName)
        .labelStyle(.iconOnly)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(selected ? Color.black : Color.white.opacity(0.85))
        .frame(width: 40, height: 34)
        .background(selected ? Color.white.opacity(0.9) : Color.clear, in: Capsule(style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(tool.title)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("LiveInspect.Tool.\(tool.rawValue)")
  }

  private func iconButton(
    symbol: String,
    label: String,
    enabled: Bool,
    action: @escaping () -> Void
  ) -> some View {
    Button {
      guard enabled else { return }
      action()
    } label: {
      Image(systemName: symbol)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(enabled ? Color.white.opacity(0.85) : Color.white.opacity(0.25))
        .frame(width: 40, height: 34)
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
    .accessibilityLabel(label)
  }

  private var emptySelection: some View {
    HStack(spacing: 10) {
      Image(systemName: model.busy ? "hourglass" : "hand.tap")
        .font(.system(size: 16, weight: .medium))
        .foregroundStyle(.white.opacity(0.55))
        .frame(width: 34, height: 34)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
      VStack(alignment: .leading, spacing: 2) {
        Text(model.busy ? "Looking up the element…" : "Tap an element on the picture")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.white)
        Text(model.phase == .loading ? "The picture is arriving." : "Its label, role and source land here.")
          .font(.caption)
          .foregroundStyle(.white.opacity(0.55))
      }
      Spacer(minLength: 0)
      if case .failed = model.phase {
        Button("Retry") { model.reload() }
          .font(.caption.weight(.semibold))
          .buttonStyle(.plain)
          .foregroundStyle(ADEColor.accent)
      }
    }
    .padding(10)
    .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }

  private func elementCard(_ element: LiveInspectElement) -> some View {
    let staged = model.isStaged(element)
    return VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: model.surface.symbolName)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
        Text(element.displayTitle)
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.white)
          .lineLimit(2)
        Spacer(minLength: 0)
        Button {
          model.stageSelection()
        } label: {
          Label(
            staged ? "Added" : "Add to message",
            systemImage: staged ? "checkmark.circle.fill" : "plus.circle"
          )
          .font(.caption2.weight(.semibold))
          .foregroundStyle(staged ? ADEColor.accent : .white.opacity(0.8))
          .padding(.horizontal, 9)
          .padding(.vertical, 5)
          .background(Color.white.opacity(0.09), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("LiveInspect.AddToMessage")
      }
      if !element.displaySubtitle.isEmpty {
        Text(element.displaySubtitle)
          .font(.caption)
          .foregroundStyle(.white.opacity(0.62))
      }
      let ancestors = LiveInspectGeometry.ancestors(of: element, in: model.elements)
      if !ancestors.isEmpty {
        Text(ancestors.prefix(3).map(\.displayTitle).joined(separator: " › "))
          .font(.caption2)
          .foregroundStyle(.white.opacity(0.42))
          .lineLimit(1)
      }
      HStack(spacing: 6) {
        chip(element.frameLabel, symbol: "rectangle.dashed")
        if let source = element.sourceLabel {
          chip(source, symbol: "link")
        }
      }
      if let enabled = element.enabled, enabled == false {
        Label("Disabled", systemImage: "nosign")
          .font(.caption2)
          .foregroundStyle(.white.opacity(0.5))
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(Color.white.opacity(0.07))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .strokeBorder(Color.white.opacity(0.1), lineWidth: 0.5)
    )
    .accessibilityIdentifier("LiveInspect.ElementCard")
  }

  private func chip(_ text: String, symbol: String) -> some View {
    Label(text, systemImage: symbol)
      .font(.system(size: 10, weight: .medium))
      .foregroundStyle(.white.opacity(0.68))
      .lineLimit(1)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(Color.white.opacity(0.08), in: Capsule())
  }

  private var sendButton: some View {
    Button {
      ADEHaptics.success()
      if model.sendToComposer() { onClose() }
    } label: {
      Label("Send to chat", systemImage: "paperplane.fill")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.black)
        .frame(maxWidth: .infinity)
        .frame(height: 46)
        .background(ADEColor.accent, in: Capsule(style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(!model.canSend)
    .opacity(model.canSend ? 1 : 0.45)
    .accessibilityHint("Attaches the annotated picture and its element packet to the chat")
    .accessibilityIdentifier("LiveInspect.Send")
  }
}

// MARK: - Picture

/// The frozen picture with its element highlight, its markup, and the one
/// gesture that draws or selects.
struct LiveInspectPicture: View {
  @ObservedObject var model: LiveInspectMarkupModel

  var body: some View {
    GeometryReader { proxy in
      let rect = LiveInspectGeometry.fit(pixelSize: model.pixelSize, in: proxy.size)
      ZStack(alignment: .topLeading) {
        if let image = model.image {
          Image(uiImage: image)
            .resizable()
            .interpolation(.high)
            .frame(width: rect.width, height: rect.height)
            .position(x: rect.midX, y: rect.midY)
          if let selected = model.selected {
            selectionBox(selected, in: rect)
          }
          LiveInspectMarkupLayer(model: model, imageRect: rect)
        } else if case .failed = model.phase {
          VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
              .font(.title3)
              .foregroundStyle(ADEColor.warning)
            Text("The picture couldn't be frozen.")
              .font(.footnote)
              .foregroundStyle(.white.opacity(0.8))
            Button("Retry") { model.reload() }
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.accent)
              .buttonStyle(.plain)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          ProgressView().tint(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
      .contentShape(Rectangle())
      .gesture(gesture(rect: rect))
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("The frozen \(model.surface.title) screen")
      .accessibilityHint("Tap to inspect an element, or draw with a markup tool.")
      .accessibilityIdentifier("LiveInspect.Picture")
    }
  }

  private func selectionBox(_ element: LiveInspectElement, in rect: CGRect) -> some View {
    let scale = CGSize(
      width: rect.width / max(1, model.pixelSize.width),
      height: rect.height / max(1, model.pixelSize.height)
    )
    let frame = CGRect(
      x: rect.minX + element.imageFrame.minX * scale.width,
      y: rect.minY + element.imageFrame.minY * scale.height,
      width: element.imageFrame.width * scale.width,
      height: element.imageFrame.height * scale.height
    )
    return ZStack(alignment: .topLeading) {
      RoundedRectangle(cornerRadius: 4, style: .continuous)
        .fill(ADEColor.accent.opacity(0.14))
      RoundedRectangle(cornerRadius: 4, style: .continuous)
        .strokeBorder(ADEColor.accent, lineWidth: 1.5)
      Circle()
        .fill(ADEColor.accent)
        .frame(width: 7, height: 7)
        .offset(x: -3.5, y: -3.5)
    }
    .frame(width: max(1, frame.width), height: max(1, frame.height))
    .position(x: frame.midX, y: frame.midY)
    .allowsHitTesting(false)
  }

  private func gesture(rect: CGRect) -> some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .local)
      .onChanged { value in
        guard model.tool.draws,
              let point = LiveInspectGeometry.imagePoint(
                value.location,
                in: rect,
                pixelSize: model.pixelSize
              ) else { return }
        if model.draft == nil {
          model.beginStroke(at: point)
        } else {
          model.extendStroke(to: point)
        }
      }
      .onEnded { value in
        if model.tool.draws {
          model.endStroke()
          return
        }
        guard let point = LiveInspectGeometry.imagePoint(
          value.location,
          in: rect,
          pixelSize: model.pixelSize
        ) else { return }
        model.select(atImagePoint: point)
      }
  }
}

/// The in-progress and finished marks over the picture.
struct LiveInspectMarkupLayer: View {
  @ObservedObject var model: LiveInspectMarkupModel
  let imageRect: CGRect

  var body: some View {
    let scale = imageRect.width / max(1, model.pixelSize.width)
    Canvas { context, _ in
      var all = model.strokes
      if let draft = model.draft { all.append(draft) }
      guard scale > 0 else { return }
      for stroke in all {
        let path = LiveInspectDrawing.path(for: stroke, imageSize: model.pixelSize)
          .applying(CGAffineTransform(scaleX: scale, y: scale))
        guard !path.isEmpty else { continue }
        let width = LiveInspectDrawing.lineWidth(for: model.pixelSize) * scale
        context.stroke(
          path,
          with: .color(.white.opacity(0.9)),
          style: StrokeStyle(lineWidth: width + max(1.5, width * 0.5), lineCap: .round, lineJoin: .round)
        )
        context.stroke(
          path,
          with: .color(LiveInspectInk.color),
          style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
        )
      }
    }
    .frame(width: imageRect.width, height: imageRect.height)
    .offset(x: imageRect.minX, y: imageRect.minY)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// One inline warning line, the viewer's own styling rather than a new banner
/// surface (this is inside a full-screen viewer, not a page).
private struct LiveInspectBanner: View {
  let text: String
  let symbol: String
  let tint: Color

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Image(systemName: symbol)
        .font(.caption2)
        .foregroundStyle(tint)
      Text(text)
        .font(.caption)
        .foregroundStyle(.white.opacity(0.75))
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .padding(9)
    .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}

// MARK: - Small helpers

private extension String {
  var liveInspectTrimmed: String? {
    let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

// MARK: - Fixtures

#if DEBUG
/// Fixture screens for this area, routed by `DuoPreviewRouter`.
enum LiveInspectMarkupPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-inspect-sim":
      return AnyView(LiveInspectFixtureScreen())
    default:
      return nil
    }
  }
}

/// The wide showcase: a frozen simulator still with a selected row and two
/// marks. The stage itself adapts by width, so folding the device closed shows
/// the same state in the compact layout.
@MainActor
private struct LiveInspectFixtureScreen: View {
  @StateObject private var model: LiveInspectMarkupModel

  init() {
    _model = StateObject(wrappedValue: LiveInspectFixtureData.model())
  }

  var body: some View {
    LiveInspectStage(model: model, onClose: {})
  }
}

@MainActor
private enum LiveInspectFixtureData {
  /// The drawn simulator stand-in from the Apple viewer fixture, rendered at
  /// the iPhone's pixel size so the frames and strokes are in real pixels.
  static func picture() -> UIImage {
    let renderer = ImageRenderer(
      content: AppleViewerPreviewPicture()
        .frame(width: 402, height: 874)
    )
    renderer.scale = 3
    return renderer.uiImage ?? UIImage()
  }

  static func model() -> LiveInspectMarkupModel {
    let model = LiveInspectMarkupModel(surface: .simulator, laneId: "fixture-lane", chatSessionId: nil)
    let image = picture()
    let elements = rows()
    let selected = elements.first { $0.identifier == "settings.accessibility" }
    model.installPreview(
      image: image,
      elements: elements,
      selected: selected,
      strokes: [
        LiveInspectStroke(tool: .pen, points: [
          CGPoint(x: 150, y: 352),
          CGPoint(x: 430, y: 342),
          CGPoint(x: 720, y: 356),
          CGPoint(x: 1010, y: 344),
        ]),
        LiveInspectStroke(tool: .circle, points: [
          CGPoint(x: 40, y: 520),
          CGPoint(x: 1166, y: 668),
        ]),
      ]
    )
    return model
  }

  /// The six rows `AppleViewerPreviewPicture` draws, in its own point space
  /// (16 pt inset, 44 pt rows, 10 pt apart from y=121), scaled to pixels.
  private static func rows() -> [LiveInspectElement] {
    let labels = ["General", "Accessibility", "Appearance", "Camera", "Control Center", "Display"]
    let identifiers = [
      "settings.general",
      "settings.accessibility",
      "settings.appearance",
      "settings.camera",
      "settings.control-center",
      "settings.display",
    ]
    var elements: [LiveInspectElement] = []
    for (index, label) in labels.enumerated() {
      let pointFrame = LiveInspectFrame(x: 16, y: 121 + Double(index) * 54, width: 370, height: 44)
      elements.append(
        LiveInspectElement(
          id: "fixture-\(index)",
          label: label,
          value: nil,
          role: "Button",
          elementType: "UITableViewCell",
          subrole: nil,
          identifier: identifiers[index],
          componentId: "SettingsRow",
          sourceFile: "Views/SettingsView.swift",
          sourceLine: 40 + index * 8,
          sourceConfidence: "exact",
          enabled: true,
          focused: false,
          frame: LiveInspectFrame(
            x: pointFrame.x * 3,
            y: pointFrame.y * 3,
            width: pointFrame.width * 3,
            height: pointFrame.height * 3
          ),
          pointFrame: pointFrame,
          imageFrame: CGRect(
            x: pointFrame.x * 3,
            y: pointFrame.y * 3,
            width: pointFrame.width * 3,
            height: pointFrame.height * 3
          )
        )
      )
    }
    return elements
  }
}
#endif
