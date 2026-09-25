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
  /// "Recorded by ADE · 10:24–10:25 AM", "Captured by ADE", "Attached by the
  /// agent". Nil for a row filed before the host recorded where proof came from.
  let sourceLine: String?
  /// "Recorded at 5:19 AM, before this request." Nil unless the host flagged it.
  let olderLine: String?

  /// "Screenshot · 2m ago"
  var subtitle: String {
    "\(kindLabel) · \(relativeTime)"
  }

  /// "Screenshot, Login page, 2m ago", then the provenance lines when present.
  var accessibilityLabel: String {
    ["\(kindLabel), \(title), \(relativeTime)", sourceLine, olderLine]
      .compactMap { $0 }
      .joined(separator: ", ")
  }

  init(
    artifact: ComputerUseArtifactSummary,
    now: Date = Date(),
    formatClock: (Date) -> String = workProofClock
  ) {
    id = artifact.id
    kindLabel = workArtifactKindLabel(artifact.artifactKind)
    let trimmedTitle = artifact.title.trimmingCharacters(in: .whitespacesAndNewlines)
    title = trimmedTitle.isEmpty ? kindLabel : trimmedTitle
    relativeTime = workProofRelativeTime(artifact.createdAt, now: now)
    isVideo = workArtifactIsVideo(artifact)
    let lines = workProofProvenanceLines(artifact.metadataJson, formatClock: formatClock)
    sourceLine = lines.source
    olderLine = lines.older
  }
}

/// "10:24 AM" in the phone's locale and time zone.
func workProofClock(_ date: Date) -> String {
  date.formatted(date: .omitted, time: .shortened)
}

/// The desktop drawer's two provenance lines, read from the metadata the host
/// stamps on each proof (`proofSource`, `recordedFrom`/`recordedTo`,
/// `idleCutMs`, `mediaCreatedAt`, `recordedBeforeRequest`). Missing fields
/// print nothing. Mirrors `proofSourceLine` in proofProvenance.ts.
func workProofProvenanceLines(
  _ metadataJson: String?,
  formatClock: (Date) -> String = workProofClock
) -> (source: String?, older: String?) {
  guard let data = metadataJson?.data(using: .utf8),
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
    return (nil, nil)
  }
  func date(_ key: String) -> Date? { workParsedDate(object[key] as? String) }

  let source: String?
  switch object["proofSource"] as? String {
  case "ade-recorder":
    let suffix = workProofIdleCutLabel(object["idleCutMs"] as? Double).map { " · \($0)" } ?? ""
    if let from = date("recordedFrom"), let to = date("recordedTo") {
      source = "Recorded by ADE · \(workProofClockRange(from, to, formatClock: formatClock))\(suffix)"
    } else if let single = date("recordedFrom") ?? date("recordedTo") {
      source = "Recorded by ADE · \(formatClock(single))\(suffix)"
    } else {
      source = "Recorded by ADE\(suffix)"
    }
  case "ade-capture":
    source = "Captured by ADE"
  case "attached":
    source = "Attached by the agent"
  default:
    source = nil
  }

  var older: String?
  if object["recordedBeforeRequest"] as? Bool == true {
    older = date("mediaCreatedAt").map { "Recorded at \(formatClock($0)), before this request." }
      ?? "Recorded before this request."
  }
  return (source, older)
}

/// "0:23" / "1:04:02". Mirrors `formatProofDuration` in proofProvenance.ts.
func workProofDuration(_ ms: Double) -> String {
  let total = ms.isFinite ? max(0, Int((ms / 1000).rounded())) : 0
  let seconds = String(format: "%02d", total % 60)
  let minutes = (total / 60) % 60
  let hours = total / 3600
  return hours > 0 ? "\(hours):\(String(format: "%02d", minutes)):\(seconds)" : "\(minutes):\(seconds)"
}

/// "idle cut 1:52", or nil when less than a second was cut. Mirrors
/// `proofIdleCutLabel` in proofProvenance.ts.
func workProofIdleCutLabel(_ idleCutMs: Double?) -> String? {
  guard let idleCutMs, idleCutMs.isFinite, idleCutMs >= 1000 else { return nil }
  return "idle cut \(workProofDuration(idleCutMs))"
}

/// "10:24–10:25 AM": a day period both ends share is said once. The period is
/// everything after the last digit, so a dotted one ("a.m.") stays whole.
func workProofClockRange(_ from: Date, _ to: Date, formatClock: (Date) -> String = workProofClock) -> String {
  let start = formatClock(from)
  let end = formatClock(to)
  if start == end { return start }
  if let range = end.range(of: #"\P{Nd}+$"#, options: .regularExpression) {
    let period = String(end[range])
    if start.hasSuffix(period) {
      return "\(start.dropLast(period.count))–\(end)"
    }
  }
  return "\(start)–\(end)"
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
  /// The chat's transcript, which says what each turn's answer showed.
  var transcript: [WorkChatEnvelope] = []
  @Binding var artifactContent: [String: WorkLoadedArtifactContent]
  let isRefreshing: Bool
  let refreshError: String?
  let onRefresh: @MainActor () async -> Void
  let onLoadArtifact: WorkArtifactLoader

  @Environment(\.dismiss) private var dismiss
  @State private var viewerRequest: WorkProofViewerRequest?
  @State private var query = ""
  @State private var tab: WorkProofSheetTab = .all

  private var groups: [WorkProofDrawerGroup] {
    workProofDrawerGroups(
      artifacts: artifacts,
      transcript: transcript,
      query: query,
      media: tab.media,
      inAnswerOnly: tab == .inAnswers
    )
  }

  /// The viewer pages through the sheet's items in the order the sheet shows them.
  private func ordered(_ groups: [WorkProofDrawerGroup]) -> [ComputerUseArtifactSummary] {
    groups.flatMap { group in
      (group.inAnswer + group.other).flatMap { item -> [ComputerUseArtifactSummary] in
        switch item {
        case .single(let artifact): return [artifact]
        case .pair(let before, let after, _): return [before, after]
        }
      }
    }
  }

  private var filtered: Bool { !query.isEmpty || tab != .all }

  var body: some View {
    let groups = self.groups
    let ordered = self.ordered(groups)
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Picker("Show", selection: $tab) {
            ForEach(WorkProofSheetTab.allCases) { option in
              Text(option.rawValue).tag(option)
            }
          }
          .pickerStyle(.segmented)

          if groups.isEmpty {
            if filtered && !artifacts.isEmpty {
              Text("No proof matches.")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
                .frame(maxWidth: .infinity)
                .padding(.top, 40)
            } else {
              emptyRow
            }
          } else {
            ForEach(groups) { group in
              VStack(alignment: .leading, spacing: 8) {
                groupHeader(group)
                VStack(alignment: .leading, spacing: 12) {
                  ForEach(workProofGridRows(group.inAnswer + group.other)) { row in
                    HStack(alignment: .top, spacing: 10) {
                      ForEach(row.items) { item in gridItem(item) }
                      if row.items.count == 1, case .single = row.items[0] {
                        Color.clear.frame(maxWidth: .infinity)
                      }
                    }
                  }
                }
              }
            }
          }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
      }
      .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search proof")
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

  /// One quiet line: the request that produced this proof, and when.
  private func groupHeader(_ group: WorkProofDrawerGroup) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(group.turnId == nil ? "Earlier in this chat" : (group.prompt ?? "A turn"))
        .font(.footnote.weight(.medium))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 8)
      Text(workProofRelativeTime(group.at))
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
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
  }

  @ViewBuilder
  private func gridItem(_ item: WorkProofDrawerItem) -> some View {
    switch item {
    case .single(let artifact):
      tile(artifact, tag: nil)
    case .pair(let before, let after, let caption):
      // A pair fills the row, so before and after sit side by side, close
      // enough to compare at a glance.
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .top, spacing: 6) {
          tile(before, tag: "Before")
          tile(after, tag: "After")
        }
        if !caption.isEmpty {
          Text(caption)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func tile(_ artifact: ComputerUseArtifactSummary, tag: String?) -> some View {
    let model = WorkProofRowModel(artifact: artifact)
    return Button {
      open(artifact)
    } label: {
      VStack(alignment: .leading, spacing: 5) {
        WorkProofTileImage(content: artifactContent[artifact.id], isVideo: model.isVideo, tag: tag)
        Text(model.title)
          .font(.caption)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.tail)
        if let older = model.olderLine {
          Text(older)
            .font(.caption2)
            .foregroundStyle(ADEColor.warning)
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel([tag, model.accessibilityLabel].compactMap { $0 }.joined(separator: ": "))
    .accessibilityAddTraits(.isButton)
    .task(id: artifact.id) {
      await onLoadArtifact(artifact, .preview)
    }
  }

  private func open(_ artifact: ComputerUseArtifactSummary) {
    ADEHaptics.light()
    viewerRequest = WorkProofViewerRequest(id: artifact.id)
  }
}

/// One row of the Proof grid: a before/after pair alone, or up to two items.
struct WorkProofGridRow: Identifiable {
  let items: [WorkProofDrawerItem]
  var id: String { items.map(\.id).joined(separator: "|") }
}

/// Packs a group's items into rows. A pair fills its row, so its two pictures
/// sit side by side; single items go two to a row.
func workProofGridRows(_ items: [WorkProofDrawerItem]) -> [WorkProofGridRow] {
  var rows: [WorkProofGridRow] = []
  var pending: [WorkProofDrawerItem] = []
  for item in items {
    if case .pair = item {
      if !pending.isEmpty { rows.append(WorkProofGridRow(items: pending)); pending = [] }
      rows.append(WorkProofGridRow(items: [item]))
    } else {
      pending.append(item)
      if pending.count == 2 { rows.append(WorkProofGridRow(items: pending)); pending = [] }
    }
  }
  if !pending.isEmpty { rows.append(WorkProofGridRow(items: pending)) }
  return rows
}

/// The sheet's tabs, the same four the desktop drawer has.
enum WorkProofSheetTab: String, CaseIterable, Identifiable {
  case all = "All"
  case pictures = "Pictures"
  case videos = "Videos"
  case inAnswers = "In answers"
  var id: String { rawValue }

  var media: WorkProofMediaFilter {
    switch self {
    case .pictures: return .pictures
    case .videos: return .videos
    case .all, .inAnswers: return .all
    }
  }
}

/// A grid tile's picture: the capture at 3:2, cropped to fill, with a play
/// glyph on a video and an optional Before/After tag.
private struct WorkProofTileImage: View {
  let content: WorkLoadedArtifactContent?
  let isVideo: Bool
  let tag: String?

  var body: some View {
    Color.clear
      .aspectRatio(3.0 / 2.0, contentMode: .fit)
      .overlay {
        ZStack {
          ADEColor.recessedBackground.opacity(0.7)
          switch content {
          case .image(let image):
            Image(uiImage: image)
              .resizable()
              .scaledToFill()
          case .video, .remoteURL, .videoOnDemand:
            Image(systemName: "play.circle.fill")
              .font(.system(size: 26, weight: .semibold))
              .foregroundStyle(ADEColor.accent)
          case .text:
            Image(systemName: "doc.text")
              .foregroundStyle(ADEColor.textSecondary)
          case .error:
            Image(systemName: "exclamationmark.triangle")
              .foregroundStyle(ADEColor.textMuted)
          case .none:
            Image(systemName: isVideo ? "video" : "photo")
              .foregroundStyle(ADEColor.textMuted)
          }
        }
      }
      .overlay(alignment: .topLeading) {
        if let tag {
          Text(tag)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.black.opacity(0.55), in: Capsule())
            .padding(5)
        }
      }
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .strokeBorder(ADEColor.border.opacity(0.35))
      )
  }
}

private struct WorkProofViewerRequest: Identifiable {
  let id: String
}

// MARK: - Full-screen viewer

/// Full-screen proof viewer: one page per artifact, swipe to move between them,
/// pinch/double-tap to zoom the image on black.
struct WorkProofViewer: View {
  let artifacts: [ComputerUseArtifactSummary]
  let artifactContent: [String: WorkLoadedArtifactContent]
  let onLoadArtifact: WorkArtifactLoader

  @Environment(\.dismiss) private var dismiss
  @State private var selection: String

  init(
    artifacts: [ComputerUseArtifactSummary],
    artifactContent: [String: WorkLoadedArtifactContent],
    initialArtifactId: String,
    onLoadArtifact: @escaping WorkArtifactLoader
  ) {
    self.artifacts = artifacts
    self.artifactContent = artifactContent
    self.onLoadArtifact = onLoadArtifact
    _selection = State(initialValue: initialArtifactId)
  }

  private var current: ComputerUseArtifactSummary? {
    artifacts.first { $0.id == selection } ?? artifacts.first
  }

  /// 1-based, and 1 when the selection has gone missing, so the caption never
  /// contradicts the page actually on screen.
  private var position: Int {
    (artifacts.firstIndex { $0.id == selection } ?? 0) + 1
  }

  private var currentTitle: String {
    current.map { WorkProofRowModel(artifact: $0).title } ?? "Proof"
  }

  var body: some View {
    NavigationStack {
      TabView(selection: $selection) {
        ForEach(artifacts) { artifact in
          WorkProofPage(
            artifact: artifact,
            content: artifactContent[artifact.id],
            onPlay: { Task { await onLoadArtifact(artifact, .play) } }
          )
            .tag(artifact.id)
            .task(id: artifact.id) {
              await onLoadArtifact(artifact, .preview)
            }
        }
      }
      // Dots, whenever there is somewhere to swipe to. Opened from a row, the
      // viewer used to look like a single-artifact screen — nothing said the
      // other five captures were one swipe away. `.interactive` keeps them out
      // of the way of the capture until the page actually moves.
      .tabViewStyle(.page(indexDisplayMode: artifacts.count > 1 ? .automatic : .never))
      .indexViewStyle(.page(backgroundDisplayMode: .interactive))
      // The bar floats over the capture rather than shortening the screen it is
      // centred in: a tall screenshot was laid out below the bar and then
      // centred in what was left, which pushed its top edge under the title.
      .ignoresSafeArea(edges: .top)
      .background(Color.black.ignoresSafeArea())
      .navigationTitle(currentTitle)
      .navigationBarTitleDisplayMode(.inline)
      .adeNavigationGlass()
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
        // Dots say "there are more"; the count says WHICH — past about eight
        // captures the dots stop being countable and this is the only thing
        // that still tells you where you are in the run.
        if artifacts.count > 1 {
          ToolbarItem(placement: .principal) {
            VStack(spacing: 1) {
              Text(currentTitle)
                .font(.headline)
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .truncationMode(.tail)
              Text("\(position) of \(artifacts.count)")
                .font(.caption2)
                .foregroundStyle(Color.white.opacity(0.6))
            }
            .accessibilityElement(children: .combine)
          }
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
    case .videoOnDemand, .error, .none:
      EmptyView()
    }
  }
}

private struct WorkProofPage: View {
  let artifact: ComputerUseArtifactSummary
  let content: WorkLoadedArtifactContent?
  let onPlay: () -> Void

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      switch content {
      case .image(let image):
        // All edges: the capture is centred on the whole screen and the
        // translucent bar sits over it, which is how every photo viewer on
        // this platform behaves.
        WorkProofZoomableImage(image: image)
          .ignoresSafeArea()
          .accessibilityLabel(WorkProofRowModel(artifact: artifact).accessibilityLabel)
      case .video(let url), .remoteURL(let url):
        WorkProofVideoPage(url: url, isVideo: workArtifactIsVideo(artifact))
      case .videoOnDemand(let sizeBytes):
        WorkArtifactPlayPlaceholder(sizeBytes: sizeBytes, tint: Color.white.opacity(0.72), onPlay: onPlay)
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
      WorkArtifactVideoPlayerView(url: url)
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

// MARK: - Proof inside the answer

/// What an answer's proof citations read: the chat's proof, the bytes loaded
/// so far, and the loader. Nil on surfaces with no chat (previews, the PR
/// wizard); a citation there says it cannot show the proof.
struct WorkProofCitationContext {
  let artifactsById: [String: ComputerUseArtifactSummary]
  let content: [String: WorkLoadedArtifactContent]
  let load: WorkArtifactLoader
}

private struct WorkProofCitationEnvironmentKey: EnvironmentKey {
  static let defaultValue: WorkProofCitationContext? = nil
}

extension EnvironmentValues {
  var workProofCitations: WorkProofCitationContext? {
    get { self[WorkProofCitationEnvironmentKey.self] }
    set { self[WorkProofCitationEnvironmentKey.self] = newValue }
  }
}

/// `![caption](ade-proof://<id>)` in an answer: the picture or the video at a
/// readable size, the caption under it, and where it came from.
struct WorkProofCitationView: View {
  let artifactId: String
  let caption: String
  var compact = false

  @Environment(\.workProofCitations) private var citations
  @State private var viewerOpen = false

  private var mediaMaxHeight: CGFloat { compact ? 220 : 360 }

  var body: some View {
    if let citations, let artifact = citations.artifactsById[artifactId] {
      VStack(alignment: .leading, spacing: 6) {
        media(artifact: artifact, content: citations.content[artifactId], load: citations.load)
          .task(id: artifactId) { await citations.load(artifact, .preview) }
        captionRows(artifact)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .fullScreenCover(isPresented: $viewerOpen) {
        WorkProofViewer(
          artifacts: [artifact],
          artifactContent: citations.content,
          initialArtifactId: artifact.id,
          onLoadArtifact: citations.load
        )
      }
    } else {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: "exclamationmark.triangle")
          .foregroundStyle(ADEColor.warning)
        Text(missingText)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.recessedBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }

  private var missingText: String {
    let cited = caption.isEmpty ? "" : " It was cited as \"\(caption)\"."
    return "This chat has no proof with the id \(artifactId).\(cited)"
  }

  @ViewBuilder
  private func media(
    artifact: ComputerUseArtifactSummary,
    content: WorkLoadedArtifactContent?,
    load: @escaping WorkArtifactLoader
  ) -> some View {
    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
    switch content {
    case .image(let image):
      Button {
        viewerOpen = true
      } label: {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .frame(maxHeight: mediaMaxHeight)
          .clipShape(shape)
          .overlay(shape.strokeBorder(ADEColor.border.opacity(0.3)))
      }
      .buttonStyle(.plain)
      .accessibilityLabel(captionText(artifact))
      .accessibilityHint("Opens the proof full screen")
    case .video(let url), .remoteURL(let url):
      WorkArtifactVideoPlayerView(url: url)
        .aspectRatio(16.0 / 10.0, contentMode: .fit)
        .frame(maxHeight: mediaMaxHeight)
        .clipShape(shape)
    case .videoOnDemand(let sizeBytes):
      WorkArtifactPlayPlaceholder(
        sizeBytes: sizeBytes,
        tint: ADEColor.textSecondary,
        onPlay: { Task { await load(artifact, .play) } }
      )
      .frame(maxWidth: .infinity, minHeight: compact ? 120 : 180)
      .background(Color.black.opacity(0.85), in: shape)
    case .text:
      Text("This proof is text. Open the proof sheet to read it.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
    case .error(let message):
      Text(message)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ADEColor.recessedBackground.opacity(0.6), in: shape)
    case .none:
      ProgressView()
        .frame(maxWidth: .infinity, minHeight: compact ? 120 : 180)
        .background(ADEColor.recessedBackground.opacity(0.6), in: shape)
    }
  }

  private func captionText(_ artifact: ComputerUseArtifactSummary) -> String {
    if !caption.isEmpty { return caption }
    let description = artifact.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return description.isEmpty ? WorkProofRowModel(artifact: artifact).title : description
  }

  @ViewBuilder
  private func captionRows(_ artifact: ComputerUseArtifactSummary) -> some View {
    Text(captionText(artifact))
      .font(.footnote)
      .foregroundStyle(ADEColor.textSecondary)
    // The one provenance fact worth a line in an answer: a video older than the request.
    if let older = workProofProvenanceLines(artifact.metadataJson).older {
      Text(older)
        .font(.caption2)
        .foregroundStyle(ADEColor.warning)
    }
  }
}

/// A ```proof-compare block: before and after, side by side.
struct WorkProofCompareView: View {
  let compare: WorkProofCompare

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 8) {
        side("Before", compare.before)
        side("After", compare.after)
      }
      if !compare.caption.isEmpty {
        Text(compare.caption)
          .font(.footnote)
          .foregroundStyle(ADEColor.textPrimary)
      }
    }
  }

  private func side(_ title: String, _ entry: WorkProofCompareSide) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title.uppercased())
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      WorkProofCitationView(artifactId: entry.artifactId, caption: entry.label, compact: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// MARK: - Drawer model

/// One entry in the Proof sheet: a single item, or a before/after pair that an
/// answer's ```proof-compare block names. Mirrors `ProofDrawerItem` in
/// proofDrawerModel.ts.
enum WorkProofDrawerItem: Identifiable, Equatable {
  case single(ComputerUseArtifactSummary)
  case pair(before: ComputerUseArtifactSummary, after: ComputerUseArtifactSummary, caption: String)

  var id: String {
    switch self {
    case .single(let artifact): return artifact.id
    case .pair(let before, let after, _): return "\(before.id):\(after.id)"
    }
  }
}

/// The proof one turn filed, under its prompt; what its answer showed first.
struct WorkProofDrawerGroup: Identifiable, Equatable {
  let id: String
  let turnId: String?
  let prompt: String?
  let at: String
  let inAnswer: [WorkProofDrawerItem]
  let other: [WorkProofDrawerItem]
}

enum WorkProofMediaFilter: String, CaseIterable, Identifiable {
  case all = "All"
  case pictures = "Pictures"
  case videos = "Videos"
  var id: String { rawValue }
}

private let workProofCitationInTextPattern = try! NSRegularExpression(
  pattern: #"!\[[^\]]*\]\(\s*<?(ade-proof:[^)\s>]+)"#,
  options: [.caseInsensitive]
)
private let workProofCompareFencePattern = try! NSRegularExpression(
  pattern: #"```proof-compare[^\n]*\n([\s\S]*?)```"#,
  options: [.caseInsensitive]
)

/// Every artifact id a text cites, without repeats. Mirrors
/// `citedProofArtifactIds`.
func workCitedProofArtifactIds(_ text: String) -> [String] {
  guard text.localizedCaseInsensitiveContains("ade-proof") || text.localizedCaseInsensitiveContains("proof-compare") else { return [] }
  var ids: [String] = []
  func add(_ id: String?) {
    if let id, !ids.contains(id) { ids.append(id) }
  }
  let range = NSRange(text.startIndex..., in: text)
  for match in workProofCitationInTextPattern.matches(in: text, range: range) {
    if let tokenRange = Range(match.range(at: 1), in: text) {
      add(workProofArtifactId(fromToken: String(text[tokenRange])))
    }
  }
  for compare in workProofCompareBlocks(text) {
    add(compare.before.artifactId)
    add(compare.after.artifactId)
  }
  return ids
}

func workProofCompareBlocks(_ text: String) -> [WorkProofCompare] {
  guard text.localizedCaseInsensitiveContains("proof-compare") else { return [] }
  let range = NSRange(text.startIndex..., in: text)
  return workProofCompareFencePattern.matches(in: text, range: range).compactMap { match in
    Range(match.range(at: 1), in: text).flatMap { workParseProofCompare(String(text[$0])) }
  }
}

private struct WorkProofTurn {
  let turnId: String
  let prompt: String?
  let startedAt: String
  var answerText: String
}

private func workProofEventTurnId(_ event: WorkChatEvent) -> String? {
  switch event {
  case .userMessage(_, _, let turnId, _, _, _): return turnId
  case .assistantText(_, let turnId, _): return turnId
  case .done(_, _, _, let turnId, _, _, _): return turnId
  case .toolCall(_, _, _, _, let turnId): return turnId
  case .toolResult(_, _, _, _, let turnId, _, _, _): return turnId
  case .activity(_, _, let turnId): return turnId
  case .status(_, _, let turnId): return turnId
  default: return nil
  }
}

private func workProofArtifactTurnId(_ artifact: ComputerUseArtifactSummary) -> String? {
  guard let data = artifact.metadataJson?.data(using: .utf8),
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let turnId = object["turnId"] as? String, !turnId.isEmpty else { return nil }
  return turnId
}

/// Groups a chat's proof by the turn that filed it, newest turn first. Mirrors
/// `buildProofDrawerGroups` in proofDrawerModel.ts.
func workProofDrawerGroups(
  artifacts: [ComputerUseArtifactSummary],
  transcript: [WorkChatEnvelope],
  query: String = "",
  media: WorkProofMediaFilter = .all,
  inAnswerOnly: Bool = false
) -> [WorkProofDrawerGroup] {
  var turns: [WorkProofTurn] = []
  var turnIndex: [String: Int] = [:]
  var pendingPrompt: String?
  for envelope in transcript {
    if case .userMessage(let text, _, _, _, _, _) = envelope.event {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty { pendingPrompt = trimmed }
    }
    guard let turnId = workProofEventTurnId(envelope.event), !turnId.isEmpty else { continue }
    if turnIndex[turnId] == nil {
      turnIndex[turnId] = turns.count
      turns.append(WorkProofTurn(turnId: turnId, prompt: pendingPrompt, startedAt: envelope.timestamp, answerText: ""))
      pendingPrompt = nil
    }
    if case .assistantText(let text, _, _) = envelope.event, let index = turnIndex[turnId] {
      turns[index].answerText += text
    }
  }
  let citedByTurn = Dictionary(uniqueKeysWithValues: turns.map { ($0.turnId, workCitedProofArtifactIds($0.answerText)) })
  let citedAnywhere = Set(citedByTurn.values.flatMap { $0 })
  let pairs = turns.flatMap { workProofCompareBlocks($0.answerText) }

  let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  func matches(_ artifact: ComputerUseArtifactSummary) -> Bool {
    let video = workArtifactIsVideo(artifact)
    switch media {
    case .all: break
    case .videos: if !video { return false }
    case .pictures: if video || artifact.artifactKind != "screenshot" && !(artifact.mimeType ?? "").hasPrefix("image/") { return false }
    }
    if inAnswerOnly && !citedAnywhere.contains(artifact.id) { return false }
    guard !needle.isEmpty else { return true }
    return artifact.title.lowercased().contains(needle) || (artifact.description ?? "").lowercased().contains(needle)
  }

  func place(_ artifact: ComputerUseArtifactSummary) -> WorkProofTurn? {
    if let stamped = workProofArtifactTurnId(artifact) {
      return turnIndex[stamped].map { turns[$0] }
    }
    guard let at = workParsedDate(artifact.createdAt) else { return nil }
    var placed: WorkProofTurn?
    for turn in turns {
      guard let start = workParsedDate(turn.startedAt), start <= at else { break }
      placed = turn
    }
    return placed
  }

  func items(_ list: [ComputerUseArtifactSummary]) -> [WorkProofDrawerItem] {
    let byId = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    var used = Set<String>()
    var result: [WorkProofDrawerItem] = []
    for artifact in list where !used.contains(artifact.id) {
      if let pair = pairs.first(where: {
        ($0.before.artifactId == artifact.id || $0.after.artifactId == artifact.id)
          && $0.before.artifactId != $0.after.artifactId
          && byId[$0.before.artifactId] != nil && byId[$0.after.artifactId] != nil
          && !used.contains($0.before.artifactId) && !used.contains($0.after.artifactId)
      }), let before = byId[pair.before.artifactId], let after = byId[pair.after.artifactId] {
        used.insert(before.id)
        used.insert(after.id)
        result.append(.pair(before: before, after: after, caption: pair.caption))
        continue
      }
      used.insert(artifact.id)
      result.append(.single(artifact))
    }
    return result
  }

  var order: [String] = []
  var buckets: [String: (turn: WorkProofTurn?, artifacts: [ComputerUseArtifactSummary])] = [:]
  // One row per artifact: the host list can repeat an artifact once per owner link.
  var seen = Set<String>()
  for artifact in artifacts.sorted(by: { $0.createdAt < $1.createdAt }) where seen.insert(artifact.id).inserted && matches(artifact) {
    let turn = place(artifact)
    let key = turn.map { "turn:\($0.turnId)" } ?? "earlier"
    if buckets[key] == nil {
      buckets[key] = (turn, [])
      order.append(key)
    }
    buckets[key]?.artifacts.append(artifact)
  }

  let groups: [WorkProofDrawerGroup] = order.compactMap { key in
    guard let bucket = buckets[key], let first = bucket.artifacts.first else { return nil }
    let citedHere = bucket.turn.flatMap { citedByTurn[$0.turnId] } ?? []
    let inAnswer = bucket.artifacts
      .filter { citedAnywhere.contains($0.id) }
      .sorted { (citedHere.firstIndex(of: $0.id) ?? .max) < (citedHere.firstIndex(of: $1.id) ?? .max) }
    let other = bucket.artifacts.filter { !citedAnywhere.contains($0.id) }
    return WorkProofDrawerGroup(
      id: key,
      turnId: bucket.turn?.turnId,
      prompt: bucket.turn?.prompt,
      at: bucket.turn?.startedAt ?? first.createdAt,
      inAnswer: items(inAnswer),
      other: items(other)
    )
  }
  return groups.sorted { left, right in
    if left.id == "earlier" { return false }
    if right.id == "earlier" { return true }
    return left.at > right.at
  }
}
