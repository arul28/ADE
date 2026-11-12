import SwiftUI
import UIKit

/// The live picture of one desktop browser tab in the Work tools sheet, and
/// "Take control": while it is on, a tap clicks the page, a vertical drag
/// scrolls it, and the field under the picture types into it.
///
/// The sheet owns the poll (`workTools.readBrowserTabFrame`) and hands this
/// view the newest picture; this view only draws it and turns a finger into
/// `WorkToolsBrowserTabInputEvent`s. Coordinates go out as fractions of the
/// picture, so its size on the phone never matters to the desktop.
struct WorkToolsBrowserLiveCard: View {
  let image: UIImage
  let title: String?
  let url: String?
  let isLoading: Bool
  /// The host lets this phone send input (controller, newer desktop).
  let canControl: Bool
  @Binding var inControl: Bool
  let send: (WorkToolsBrowserTabInputEvent) -> Void

  @State private var typed = ""
  @State private var dragIsScroll = false
  @State private var lastDragY: CGFloat?
  @State private var pendingScroll: CGFloat = 0
  @State private var lastScrollSentAt = Date.distantPast
  @FocusState private var fieldFocused: Bool

  /// About ten scroll events a second while a finger drags the page.
  private static let scrollInterval: TimeInterval = 0.1
  /// Movement under this many points is a tap, not a scroll.
  private static let tapSlop: CGFloat = 8

  var body: some View {
    ADEKitCard(title: "Live", hint: hint) {
      if canControl {
        controlToggle
      }
    } content: {
      VStack(alignment: .leading, spacing: 10) {
        picture
        if inControl {
          typingRow
        }
      }
    }
    .onChange(of: canControl) { _, allowed in
      if !allowed { inControl = false }
    }
  }

  private var hint: String? {
    if let title = title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
    if let url, !url.isEmpty { return url }
    return nil
  }

  private var controlToggle: some View {
    Button {
      ADEHaptics.light()
      inControl.toggle()
      if !inControl { fieldFocused = false }
    } label: {
      Label(
        inControl ? "In control" : "Take control",
        systemImage: inControl ? "hand.point.up.left.fill" : "hand.point.up.left"
      )
      .font(.caption.weight(.semibold))
      .foregroundStyle(inControl ? Color.white : ADEColor.accent)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .background(
        inControl ? AnyShapeStyle(ADEColor.accent) : AnyShapeStyle(ADEColor.accent.opacity(0.12)),
        in: Capsule()
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel(inControl ? "Stop controlling the browser" : "Take control of the browser")
  }

  private var picture: some View {
    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
    return Image(uiImage: image)
      .resizable()
      .scaledToFit()
      .frame(maxWidth: .infinity)
      .overlay {
        if inControl {
          GeometryReader { proxy in
            let rect = workToolsAspectFitRect(imageSize: image.size, in: proxy.size)
            Color.clear
              .contentShape(Rectangle())
              .highPriorityGesture(controlGesture(imageRect: rect))
          }
        }
      }
      .background(Color.black.opacity(0.12), in: shape)
      .clipShape(shape)
      .overlay {
        if inControl {
          shape.strokeBorder(ADEColor.accent, lineWidth: 2)
        }
      }
      .overlay(alignment: .topLeading) {
        HStack(spacing: 6) {
          AppControlLiveTag(live: true)
          if isLoading {
            ProgressView()
              .controlSize(.mini)
              .tint(.white)
              .padding(5)
              .background(.black.opacity(0.55), in: Circle())
          }
        }
        .padding(8)
        .allowsHitTesting(false)
      }
      .accessibilityLabel(hint.map { "Live picture of \($0)" } ?? "Live picture of the browser tab")
  }

  private var typingRow: some View {
    HStack(spacing: 8) {
      TextField("Type into the page", text: $typed)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.send)
        .focused($fieldFocused)
        .font(.subheadline)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .onSubmit(submitTyped)
      Button {
        ADEHaptics.light()
        send(.key("Backspace"))
      } label: {
        Image(systemName: "delete.left")
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 38, height: 36)
          .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Backspace")
      Button {
        ADEHaptics.light()
        if typed.isEmpty { send(.key("Enter")) } else { submitTyped() }
      } label: {
        Image(systemName: "return")
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(ADEColor.accent)
          .frame(width: 38, height: 36)
          .background(ADEColor.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Return")
    }
  }

  /// Types what is in the field, then presses Enter, and keeps the keyboard up
  /// for the next line.
  private func submitTyped() {
    let text = typed
    typed = ""
    if !text.isEmpty { send(.text(text)) }
    send(.key("Enter"))
    fieldFocused = true
  }

  /// One finger: a tap clicks where it landed, a drag scrolls the page under it.
  private func controlGesture(imageRect: CGRect) -> some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .local)
      .onChanged { value in
        if !dragIsScroll {
          guard hypot(value.translation.width, value.translation.height) > Self.tapSlop else { return }
          dragIsScroll = true
          lastDragY = value.location.y
          return
        }
        let previous = lastDragY ?? value.location.y
        pendingScroll += value.location.y - previous
        lastDragY = value.location.y
        if Date().timeIntervalSince(lastScrollSentAt) >= Self.scrollInterval {
          flushScroll(at: value.startLocation, imageRect: imageRect)
        }
      }
      .onEnded { value in
        if dragIsScroll {
          flushScroll(at: value.startLocation, imageRect: imageRect)
        } else if let point = workToolsFraction(of: value.location, in: imageRect) {
          ADEHaptics.light()
          fieldFocused = false
          send(.click(x: point.x, y: point.y))
        }
        dragIsScroll = false
        lastDragY = nil
        pendingScroll = 0
      }
  }

  /// Sends the drag gathered since the last scroll event. A finger moving up
  /// scrolls the page down, the way a touch screen does, and the distance is
  /// scaled from the phone's picture to the frame's pixels so the page tracks
  /// the finger.
  private func flushScroll(at location: CGPoint, imageRect: CGRect) {
    defer { lastScrollSentAt = Date() }
    guard pendingScroll != 0, imageRect.width > 0 else { return }
    let clamped = CGPoint(
      x: min(max(location.x, imageRect.minX), imageRect.maxX),
      y: min(max(location.y, imageRect.minY), imageRect.maxY)
    )
    guard let point = workToolsFraction(of: clamped, in: imageRect) else { return }
    let pixelsPerPoint = image.size.width * image.scale / imageRect.width
    let deltaY = Double(-pendingScroll * pixelsPerPoint).rounded()
    pendingScroll = 0
    guard deltaY != 0 else { return }
    send(.scroll(x: point.x, y: point.y, deltaY: deltaY))
  }
}

/// Where an image of `imageSize` lands when fit (aspect kept) inside `size`,
/// centred: the letterbox bars are outside the returned rect.
func workToolsAspectFitRect(imageSize: CGSize, in size: CGSize) -> CGRect {
  guard imageSize.width > 0, imageSize.height > 0, size.width > 0, size.height > 0 else {
    return CGRect(origin: .zero, size: size)
  }
  let scale = min(size.width / imageSize.width, size.height / imageSize.height)
  let fitted = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
  return CGRect(
    x: (size.width - fitted.width) / 2,
    y: (size.height - fitted.height) / 2,
    width: fitted.width,
    height: fitted.height
  )
}

/// `point` as fractions (0–1) of `rect`, or nil when it falls outside it (a
/// tap on the letterbox clicks nothing).
func workToolsFraction(of point: CGPoint, in rect: CGRect) -> (x: Double, y: Double)? {
  guard rect.width > 0, rect.height > 0,
        (rect.minX...rect.maxX).contains(point.x), (rect.minY...rect.maxY).contains(point.y)
  else { return nil }
  let x = min(max((point.x - rect.minX) / rect.width, 0), 1)
  let y = min(max((point.y - rect.minY) / rect.height, 0), 1)
  return (Double(x), Double(y))
}

/// Ceiling on one live frame. These are JPEGs a few hundred KB at most; the cap
/// bounds what a malformed payload can make the phone allocate several times a
/// second.
private let workToolsLiveFrameMaxBytes = 6 * 1024 * 1024

/// Turns a `data:image/jpeg;base64,…` URL into a display-ready image. Runs off
/// the main thread: the poll decodes a few of these every second.
func workToolsDecodeLiveFrame(_ dataUrl: String) -> UIImage? {
  guard dataUrl.hasPrefix("data:"), let comma = dataUrl.firstIndex(of: ",") else { return nil }
  let payload = dataUrl[dataUrl.index(after: comma)...]
  guard ((payload.utf8.count + 3) / 4) * 3 <= workToolsLiveFrameMaxBytes,
        let data = Data(base64Encoded: String(payload)),
        let image = UIImage(data: data)
  else { return nil }
  return image.preparingForDisplay() ?? image
}
