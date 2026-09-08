import AVKit
import SwiftUI
import UIKit

// MARK: - Row model

/// Everything the Proof sheet writes on one row, derived from the artifact and
/// nothing else. Kept free of view types so the wording — title fallback, kind
/// label, relative time, VoiceOver phrasing — is unit-testable.
struct WorkProofRowModel: Equatable {
  let id: String
  let title: String
  let kindLabel: String
  let relativeTime: String
  let isVideo: Bool

  /// "Screenshot · 2m ago"
  var subtitle: String {
    "\(kindLabel) · \(relativeTime)"
  }

  /// "Screenshot, Login page, 2m ago"
  var accessibilityLabel: String {
    "\(kindLabel), \(title), \(relativeTime)"
  }

  init(artifact: ComputerUseArtifactSummary, now: Date = Date()) {
    id = artifact.id
    kindLabel = workArtifactKindLabel(artifact.artifactKind)
    let trimmedTitle = artifact.title.trimmingCharacters(in: .whitespacesAndNewlines)
    title = trimmedTitle.isEmpty ? kindLabel : trimmedTitle
    relativeTime = workProofRelativeTime(artifact.createdAt, now: now)
    isVideo = workArtifactIsVideo(artifact)
  }
}

/// "now", "2m ago", "3h ago", "4d ago". Hand-rolled rather than
/// `RelativeDateTimeFormatter` so the row reads the same short way at every
/// Dynamic Type size and stays deterministic under test.
func workProofRelativeTime(_ value: String, now: Date = Date()) -> String {
  guard let date = workParsedDate(value) else { return value }
  // Host clocks run slightly ahead often enough that a negative delta is not an
  // error; it just means "just now".
  let delta = max(0, now.timeIntervalSince(date))
  let minutes = Int(delta / 60)
  if minutes < 1 { return "now" }
  if minutes < 60 { return "\(minutes)m ago" }
  let hours = minutes / 60
  if hours < 24 { return "\(hours)h ago" }
  return "\(hours / 24)d ago"
}

// MARK: - Sheet

/// The Proof sheet: a list of captured artifacts, newest first. A row is a
/// thumbnail, a title, and one line of "kind · when". Tapping one opens the
/// full-screen viewer. Refresh is pull-to-refresh only.
struct WorkProofSheet: View {
  let artifacts: [ComputerUseArtifactSummary]
  @Binding var artifactContent: [String: WorkLoadedArtifactContent]
  let isRefreshing: Bool
  let refreshError: String?
  let onRefresh: @MainActor () async -> Void
  let onLoadArtifact: @MainActor (ComputerUseArtifactSummary) async -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var viewerRequest: WorkProofViewerRequest?

  /// Newest first — the host appends new proof to the tail.
  private var ordered: [ComputerUseArtifactSummary] {
    Array(artifacts.reversed())
  }

  var body: some View {
    NavigationStack {
      List {
        if ordered.isEmpty {
          emptyRow
        } else {
          ForEach(ordered) { artifact in
            Button {
              open(artifact)
            } label: {
              WorkProofRow(
                model: WorkProofRowModel(artifact: artifact),
                content: artifactContent[artifact.id]
              )
            }
            .buttonStyle(.plain)
            .listRowBackground(Color.clear)
            .listRowSeparatorTint(ADEColor.border.opacity(0.28))
            .task(id: artifact.id) {
              await onLoadArtifact(artifact)
            }
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .refreshable {
        await onRefresh()
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Proof")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
      }
      .fullScreenCover(item: $viewerRequest) { request in
        WorkProofViewer(
          artifacts: ordered,
          artifactContent: artifactContent,
          initialArtifactId: request.id,
          onLoadArtifact: onLoadArtifact
        )
      }
    }
  }

  @ViewBuilder
  private var emptyRow: some View {
    Group {
      if isRefreshing {
        ProgressView()
      } else if let refreshError {
        Text(refreshError)
          .font(.subheadline)
          .foregroundStyle(ADEColor.danger)
          .multilineTextAlignment(.center)
      } else {
        // A lone sentence on an otherwise black screen reads as a screen that
        // failed to load. The glyph and the second line say what proof is and
        // where it comes from, so an empty lane looks empty rather than broken.
        VStack(spacing: 10) {
          Image(systemName: "photo.on.rectangle.angled")
            .font(.system(size: 30, weight: .regular))
            .foregroundStyle(ADEColor.textMuted)
          Text("No proof yet.")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(ADEColor.textSecondary)
          Text("Screenshots and recordings the agent captures in this lane land here.")
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
        }
      }
    }
    // Tall enough that the block sits in the upper third of the sheet rather
    // than hugging the navigation bar, and still reachable by pull-to-refresh.
    .frame(maxWidth: .infinity, minHeight: 360)
    .padding(.vertical, 24)
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)
  }

  private func open(_ artifact: ComputerUseArtifactSummary) {
    ADEHaptics.light()
    viewerRequest = WorkProofViewerRequest(id: artifact.id)
  }
}

private struct WorkProofViewerRequest: Identifiable {
  let id: String
}

// MARK: - Row

private struct WorkProofRow: View {
  let model: WorkProofRowModel
  let content: WorkLoadedArtifactContent?

  var body: some View {
    HStack(spacing: 12) {
      WorkProofThumbnail(content: content, isVideo: model.isVideo)

      VStack(alignment: .leading, spacing: 2) {
        Text(model.title)
          .font(.body)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.tail)
        Text(model.subtitle)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }

      Spacer(minLength: 0)
    }
    .padding(.vertical, 6)
    .frame(minHeight: 44)
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(model.accessibilityLabel)
    .accessibilityAddTraits(.isButton)
  }
}

private struct WorkProofThumbnail: View {
  let content: WorkLoadedArtifactContent?
  let isVideo: Bool

  // Landscape, not square: proof is almost always a browser or desktop capture,
  // and a 1:1 centre crop of one throws away the window chrome and the URL —
  // the two things that tell two screenshots of the same app apart. At 3:2 the
  // whole frame survives at thumbnail size.
  private static let width: CGFloat = 72
  private static let height: CGFloat = 52

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(ADEColor.recessedBackground.opacity(0.7))

      switch content {
      case .image(let image):
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
      case .video, .remoteURL:
        Image(systemName: "play.circle.fill")
          .font(.system(size: 22, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
      case .text:
        Image(systemName: "doc.text")
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
      case .error:
        Image(systemName: "exclamationmark.triangle")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      case .none:
        Image(systemName: isVideo ? "video" : "photo")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .frame(width: Self.width, height: Self.height)
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .accessibilityHidden(true)
  }
}

// MARK: - Full-screen viewer

/// Full-screen proof viewer: one page per artifact, swipe to move between them,
/// pinch/double-tap to zoom the image on black.
struct WorkProofViewer: View {
  let artifacts: [ComputerUseArtifactSummary]
  let artifactContent: [String: WorkLoadedArtifactContent]
  let onLoadArtifact: @MainActor (ComputerUseArtifactSummary) async -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var selection: String

  init(
    artifacts: [ComputerUseArtifactSummary],
    artifactContent: [String: WorkLoadedArtifactContent],
    initialArtifactId: String,
    onLoadArtifact: @escaping @MainActor (ComputerUseArtifactSummary) async -> Void
  ) {
    self.artifacts = artifacts
    self.artifactContent = artifactContent
    self.onLoadArtifact = onLoadArtifact
    _selection = State(initialValue: initialArtifactId)
  }

  private var current: ComputerUseArtifactSummary? {
    artifacts.first { $0.id == selection } ?? artifacts.first
  }

  var body: some View {
    NavigationStack {
      TabView(selection: $selection) {
        ForEach(artifacts) { artifact in
          WorkProofPage(artifact: artifact, content: artifactContent[artifact.id])
            .tag(artifact.id)
            .task(id: artifact.id) {
              await onLoadArtifact(artifact)
            }
        }
      }
      .tabViewStyle(.page(indexDisplayMode: .never))
      .background(Color.black.ignoresSafeArea())
      .navigationTitle(current.map { WorkProofRowModel(artifact: $0).title } ?? "Proof")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          shareControl
        }
      }
    }
  }

  @ViewBuilder
  private var shareControl: some View {
    let title = current.map { WorkProofRowModel(artifact: $0).title } ?? "Proof"
    switch artifactContent[selection] {
    case .image(let image):
      ShareLink(
        item: Image(uiImage: image),
        preview: SharePreview(title, image: Image(uiImage: image))
      )
    case .video(let url), .remoteURL(let url):
      ShareLink(item: url)
    case .text(let text):
      ShareLink(item: text, preview: SharePreview(title))
    case .error, .none:
      EmptyView()
    }
  }
}

private struct WorkProofPage: View {
  let artifact: ComputerUseArtifactSummary
  let content: WorkLoadedArtifactContent?

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      switch content {
      case .image(let image):
        WorkProofZoomableImage(image: image)
          .ignoresSafeArea(edges: .bottom)
          .accessibilityLabel(WorkProofRowModel(artifact: artifact).accessibilityLabel)
      case .video(let url), .remoteURL(let url):
        WorkProofVideoPage(url: url, isVideo: workArtifactIsVideo(artifact))
      case .text(let text):
        ScrollView {
          Text(text)
            .font(.system(.footnote, design: .monospaced))
            .foregroundStyle(Color.white)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
      case .error(let message):
        errorMessage(message)
      case .none:
        ProgressView()
          .tint(Color.white)
      }
    }
  }

  private func errorMessage(_ text: String) -> some View {
    Text(text)
      .font(.subheadline)
      .foregroundStyle(Color.white.opacity(0.72))
      .multilineTextAlignment(.center)
      .padding(24)
  }
}

/// Videos reuse the chat transcript's AVKit player, which brings its own play
/// control. Anything else at a media URL just says what it is.
private struct WorkProofVideoPage: View {
  let url: URL
  let isVideo: Bool

  var body: some View {
    if isVideo {
      WorkProofVideoPlayer(url: url)
    } else {
      VStack(spacing: 12) {
        Image(systemName: "play.rectangle")
          .font(.system(size: 34, weight: .semibold))
          .foregroundStyle(Color.white.opacity(0.72))
        Text("Video")
          .font(.subheadline)
          .foregroundStyle(Color.white.opacity(0.72))
      }
    }
  }
}

private struct WorkProofVideoPlayer: View {
  let url: URL
  @StateObject private var model: WorkArtifactVideoPlayerModel

  init(url: URL) {
    self.url = url
    _model = StateObject(wrappedValue: WorkArtifactVideoPlayerModel(url: url))
  }

  var body: some View {
    VideoPlayer(player: model.player)
      .onChange(of: url) { _, newValue in
        model.update(url: newValue)
      }
  }
}

// MARK: - Zoom

/// `UIScrollView`-backed zoom: pinch between 1× and 4×, pan when zoomed in,
/// double-tap to toggle 2×. SwiftUI's own magnification gesture leaves the pan
/// origin drifting once the image is larger than the screen, which is exactly
/// the state a reader inspecting proof lives in.
struct WorkProofZoomableImage: UIViewRepresentable {
  let image: UIImage

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  func makeUIView(context: Context) -> UIScrollView {
    let scrollView = UIScrollView()
    scrollView.delegate = context.coordinator
    scrollView.minimumZoomScale = 1
    scrollView.maximumZoomScale = 4
    scrollView.bouncesZoom = true
    scrollView.showsHorizontalScrollIndicator = false
    scrollView.showsVerticalScrollIndicator = false
    scrollView.backgroundColor = .black
    scrollView.contentInsetAdjustmentBehavior = .never

    let imageView = UIImageView(image: image)
    imageView.contentMode = .scaleAspectFit
    imageView.frame = scrollView.bounds
    imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    imageView.isUserInteractionEnabled = true
    scrollView.addSubview(imageView)
    context.coordinator.imageView = imageView

    let doubleTap = UITapGestureRecognizer(
      target: context.coordinator,
      action: #selector(Coordinator.handleDoubleTap(_:))
    )
    doubleTap.numberOfTapsRequired = 2
    scrollView.addGestureRecognizer(doubleTap)

    return scrollView
  }

  func updateUIView(_ scrollView: UIScrollView, context: Context) {
    guard let imageView = context.coordinator.imageView else { return }
    if imageView.image !== image {
      imageView.image = image
      scrollView.setZoomScale(1, animated: false)
    }
  }

  final class Coordinator: NSObject, UIScrollViewDelegate {
    weak var imageView: UIImageView?

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
      imageView
    }

    @objc func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
      guard let scrollView = gesture.view as? UIScrollView else { return }
      if scrollView.zoomScale > scrollView.minimumZoomScale {
        scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
        return
      }
      let target: CGFloat = min(2, scrollView.maximumZoomScale)
      let point = gesture.location(in: imageView ?? scrollView)
      let width = scrollView.bounds.width / target
      let height = scrollView.bounds.height / target
      let rect = CGRect(
        x: point.x - width / 2,
        y: point.y - height / 2,
        width: width,
        height: height
      )
      scrollView.zoom(to: rect, animated: true)
    }
  }
}
