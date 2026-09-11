import AVKit
import QuickLook
import SwiftUI
import UIKit

/// In-thread preview for the attachments an image viewer cannot open: PDFs and
/// other documents through QuickLook, videos through `VideoPlayer`.
///
/// Both need a *file URL*, not bytes in memory, so everything here funnels
/// through one materializer that either uses the local staged bytes (the
/// composer already has them) or pulls the host copy in bounded chunks
/// (`chat.getAttachmentChunk`) into a temp file. The chunked read is the only
/// route that works for these: `chat.getImageDataUrl` sniffs for an image MIME
/// and rejects a PDF outright.

/// QuickLook wrapped for SwiftUI. `QLPreviewController` owns its own navigation
/// chrome, so it is presented bare in a sheet.
struct WorkQuickLookPreview: UIViewControllerRepresentable {
  let url: URL

  func makeCoordinator() -> Coordinator { Coordinator(url: url) }

  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: QLPreviewController, context: Context) {
    context.coordinator.url = url
    controller.reloadData()
  }

  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    var url: URL

    init(url: URL) {
      self.url = url
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
      url as QLPreviewItem
    }
  }
}

/// Where a preview's bytes come from.
enum WorkChatAttachmentPreviewSource: Equatable {
  /// The composer already holds these bytes (just-staged file or video).
  case localBytes(Data)
  /// The host holds them; pull with `chat.getAttachmentChunk`.
  case hostPath(String)
}

struct WorkChatAttachmentPreviewRequest: Identifiable, Equatable {
  let id = UUID()
  var filename: String
  var kind: WorkChatInputAttachmentKind
  var source: WorkChatAttachmentPreviewSource
  var chatSessionId: String?

  static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
}

/// Temp files for preview, scoped to one directory so the whole set can be
/// dropped at once. Bounded by reusing a deterministic name per host path: a
/// second preview of the same PDF re-reads the file already on disk.
enum WorkChatAttachmentPreviewFiles {
  private static var directory: URL {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("ade-attachment-previews", isDirectory: true)
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base
  }

  static func url(forName name: String) -> URL {
    directory.appendingPathComponent(name)
  }

  /// Sanitized so a host-supplied basename cannot contribute a path fragment.
  static func safeName(for filename: String, discriminator: String) -> String {
    let base = (filename as NSString).lastPathComponent
    let ext = (base as NSString).pathExtension
    let token = String(discriminator.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.prefix(24))
    let stem = token.isEmpty ? UUID().uuidString : token
    return ext.isEmpty ? stem : "\(stem).\(ext)"
  }

  /// Identity of every preview sheet currently on screen. A materialized URL is
  /// live for exactly as long as one of them is: `QLPreviewController` and
  /// `AVPlayer` both read the file lazily, long after the sheet's `task`
  /// returned, so the file can only be dropped once none are presented.
  ///
  /// A set keyed by the sheet's own token rather than a counter because SwiftUI
  /// is free to repeat `onAppear`/`onDisappear` for the same sheet: inserting
  /// and removing the same token twice is a no-op, where a counter would drift
  /// and either leak the temp directory forever or drop it under a live player.
  @MainActor private static var presentedTokens: Set<UUID> = []

  /// A preview sheet appeared. Balanced by `endPresenting(token:)`.
  @MainActor
  static func beginPresenting(token: UUID) {
    presentedTokens.insert(token)
  }

  /// A preview sheet tore down. Drops every materialized preview once the last
  /// one is gone — a full copy of every previewed attachment, 40 MB videos
  /// included, otherwise sits in `tmp` until iOS decides to reclaim it.
  @MainActor
  static func endPresenting(token: UUID) {
    presentedTokens.remove(token)
    guard presentedTokens.isEmpty else { return }
    try? FileManager.default.removeItem(at: directory)
  }

  /// Launch-time sweep. Anything left behind by a previous process — a sheet
  /// that was on screen when the app was killed, a `.part` from an interrupted
  /// download — has no owner in this one.
  static func sweepAtLaunch() {
    try? FileManager.default.removeItem(at: directory)
  }
}

/// Pulls a staged attachment to a temp file in bounded slices. Returns the file
/// URL a `QLPreviewController` or an `AVPlayer` can open.
@MainActor
func workChatMaterializeAttachmentForPreview(
  _ request: WorkChatAttachmentPreviewRequest,
  syncService: SyncService
) async throws -> URL {
  switch request.source {
  case .localBytes(let data):
    let url = WorkChatAttachmentPreviewFiles.url(
      forName: WorkChatAttachmentPreviewFiles.safeName(
        for: request.filename,
        discriminator: request.id.uuidString
      )
    )
    try data.write(to: url, options: .atomic)
    return url
  case .hostPath(let path):
    let url = WorkChatAttachmentPreviewFiles.url(
      forName: WorkChatAttachmentPreviewFiles.safeName(
        for: path,
        // Deterministic, so "same bytes, same name" actually holds across
        // launches. `hashValue` is seeded per process, which made the reuse
        // below fire only within one launch while the files piled up anyway.
        discriminator: workStableFileToken(path)
      )
    )
    // Same bytes, same name: a re-open of a preview already fetched costs
    // nothing rather than re-downloading a 40 MB video. Only a file that
    // reached its final name is complete — see the `.part` staging below.
    if FileManager.default.fileExists(atPath: url.path) { return url }
    // Download into `<name>.part` and move it into place only once the host
    // reports EOF. Writing straight to the final name meant any mid-stream
    // failure — a dropped relay, a cancelled task, a throwing chunk — left a
    // TRUNCATED file that the `fileExists` check above would then serve
    // forever: a PDF that will not open, with no way for the user to force a
    // refetch. Same `.part`-then-rename rule the host side uses.
    // Unique per attempt. A deterministic `<name>.part` is shared by every
    // concurrent or retried fetch of the same host path — two sheets opened on
    // one PDF, or a retry racing a cancelled task — so one attempt's
    // `removeItem`/`createFile` truncates the other's in-flight handle and the
    // survivor publishes interleaved bytes under the final name.
    let partURL = url.appendingPathExtension("\(UUID().uuidString).part")
    FileManager.default.createFile(atPath: partURL.path, contents: nil)
    do {
      let handle = try FileHandle(forWritingTo: partURL)
      defer { try? handle.close() }
      var offset = 0
      while true {
        let chunk = try await syncService.chatAttachmentChunk(
          path: path,
          offset: offset,
          length: nil,
          chatSessionId: request.chatSessionId
        )
        if let data = Data(base64Encoded: chunk.base64), !data.isEmpty {
          try handle.write(contentsOf: data)
        }
        offset = chunk.offset + chunk.byteLength
        if chunk.eof || chunk.byteLength == 0 { break }
        if offset >= chunk.totalBytes { break }
        try Task.checkCancellation()
      }
      try handle.close()
    } catch {
      try? FileManager.default.removeItem(at: partURL)
      throw error
    }
    do {
      try FileManager.default.moveItem(at: partURL, to: url)
    } catch {
      try? FileManager.default.removeItem(at: partURL)
      // Another attempt published the same bytes first. The destination only
      // ever appears under a completed download, so losing the race is a
      // success: serve what is already there rather than failing the sheet.
      guard !FileManager.default.fileExists(atPath: url.path) else { return url }
      throw error
    }
    return url
  }
}

/// The sheet itself: fetch, then hand off to QuickLook or `VideoPlayer`.
struct WorkChatAttachmentPreviewSheet: View {
  let request: WorkChatAttachmentPreviewRequest

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  @State private var fileURL: URL?
  @State private var failure: String?
  /// Built once, when the file lands. Constructing it inside `body` handed
  /// `VideoPlayer` a NEW player on every re-evaluation — playback restarted
  /// from zero and each discarded player kept its `AVURLAsset` alive.
  @State private var player: AVPlayer?
  /// Identity of *this* sheet for the presentation registry. Stable for the
  /// lifetime of the view, independent of which request it is showing.
  @State private var presentationToken = UUID()

  var body: some View {
    NavigationStack {
      Group {
        if let fileURL {
          if request.kind == .video {
            if let player {
              VideoPlayer(player: player)
                .ignoresSafeArea(edges: .bottom)
            } else {
              ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
          } else {
            WorkQuickLookPreview(url: fileURL)
              .ignoresSafeArea(edges: .bottom)
          }
        } else if let failure {
          VStack(spacing: 10) {
            Image(systemName: "doc.badge.exclamationmark")
              .font(.system(size: 34, weight: .semibold))
              .foregroundStyle(ADEColor.warning)
            Text(failure)
              .font(.body)
              .foregroundStyle(ADEColor.textSecondary)
              .multilineTextAlignment(.center)
          }
          .padding(24)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          ProgressView("Loading \(request.kind == .video ? "video" : "file")…")
            .foregroundStyle(ADEColor.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle(request.filename)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Done") { dismiss() }
        }
      }
    }
    .onAppear { WorkChatAttachmentPreviewFiles.beginPresenting(token: presentationToken) }
    .onDisappear { WorkChatAttachmentPreviewFiles.endPresenting(token: presentationToken) }
    .task(id: request.id) {
      do {
        let url = try await workChatMaterializeAttachmentForPreview(request, syncService: syncService)
        fileURL = url
        player = request.kind == .video ? AVPlayer(url: url) : nil
      } catch is CancellationError {
        return
      } catch {
        failure = "This attachment could not be opened. \(error.localizedDescription)"
      }
    }
  }
}
