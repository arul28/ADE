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

  static func purge() {
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
        discriminator: String(UInt64(bitPattern: Int64(path.hashValue)), radix: 16)
      )
    )
    // Same bytes, same name: a re-open of a preview already fetched costs
    // nothing rather than re-downloading a 40 MB video.
    if FileManager.default.fileExists(atPath: url.path) { return url }
    FileManager.default.createFile(atPath: url.path, contents: nil)
    let handle = try FileHandle(forWritingTo: url)
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

  var body: some View {
    NavigationStack {
      Group {
        if let fileURL {
          if request.kind == .video {
            VideoPlayer(player: AVPlayer(url: fileURL))
              .ignoresSafeArea(edges: .bottom)
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
    .task(id: request.id) {
      do {
        fileURL = try await workChatMaterializeAttachmentForPreview(request, syncService: syncService)
      } catch is CancellationError {
        return
      } catch {
        failure = "This attachment could not be opened. \(error.localizedDescription)"
      }
    }
  }
}
