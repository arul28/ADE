import SwiftUI
import ImageIO
import PhotosUI
import UIKit

private let workChatRemoteImageMaxBytes = 5 * 1024 * 1024
private let workChatRemoteImageTimeoutSeconds: TimeInterval = 12
private let workChatAttachmentPreviewMinimumPixels: CGFloat = 96
// Mirrors `LEGACY_MAX_CHAT_ATTACHMENT_BYTES` in
// apps/desktop/src/shared/chatAttachmentLimits.ts: the phone always stages
// attachments as base64 over sync, which is the leg that cap governs. Change
// both together.
private let workChatInputAttachmentMaxBytes = 10 * 1024 * 1024
private let workChatInputAttachmentInitialMaxDimension: CGFloat = 2400
private let workChatInputAttachmentMinimumMaxDimension: CGFloat = 960
let workChatInputAttachmentLimit = 10

private let workChatRemoteImageSession: URLSession = {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.timeoutIntervalForRequest = workChatRemoteImageTimeoutSeconds
  configuration.timeoutIntervalForResource = workChatRemoteImageTimeoutSeconds
  configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
  configuration.urlCache = nil
  return URLSession(configuration: configuration)
}()

private enum WorkChatRemoteImageError: Error {
  case responseTooLarge
}

/// Placeholder scheme for an image the composer has accepted but not yet saved
/// to the host. The local echo carries these refs so the user's bubble and its
/// thumbnails paint on the tap frame; `sendMessage` swaps them for the real host
/// paths once the save round-trip returns, before the message is sent.
///
/// A ref with this prefix never reaches the wire.
let workPendingUploadPathPrefix = "ade-pending-upload://"

/// Roughly one message's worth of attachments (`workChatInputAttachmentLimit`).
let workPendingUploadPreviewLimit = 10

/// Chips render at 56-72pt, so ~256px covers 3x displays. The composer's own
/// image is the *upload* render at up to 2400px — around 23 MB decoded, which
/// ten of would be a quarter-gigabyte resident for thumbnails nobody sees at
/// that size.
private let workPendingUploadPreviewMaxPixels: CGFloat = 256

func workAttachmentIsPendingUpload(_ ref: AgentChatFileRef) -> Bool {
  ref.path.hasPrefix(workPendingUploadPathPrefix)
}

/// Holds the composer's already-downscaled `UIImage` for the images a send is
/// carrying, first under a placeholder path and then under the real host path.
///
/// Keeping it past the upload is deliberate. Swapping the echo's refs replaces
/// the chip, and a fresh chip loading the host copy asynchronously would show
/// the generic placeholder in the gap — a visible flash of the image the phone
/// already has in memory. Promoting the entry to the host path also means the
/// phone never re-downloads its own upload.
///
/// Bounded by `workPendingUploadPreviewLimit` in insertion order, so it holds
/// about one message's worth of attachments rather than growing with the chat.
@MainActor
final class WorkPendingUploadPreviewStore {
  static let shared = WorkPendingUploadPreviewStore()

  private var imagesByPath: [String: UIImage] = [:]
  private var insertionOrder: [String] = []

  private init() {}

  func register(_ attachments: [WorkChatInputAttachment]) -> [AgentChatFileRef] {
    attachments.map { attachment in
      let ref = AgentChatFileRef(
        path: "\(workPendingUploadPathPrefix)\(attachment.id.uuidString)",
        type: "image"
      )
      if let thumbnail = attachment.image.map(workPendingUploadThumbnail) {
        store(thumbnail, forPath: ref.path)
      }
      return ref
    }
  }

  /// Drops every held thumbnail. Called on `didReceiveMemoryWarning` — these
  /// exist only to smooth a handoff, and the host copy can always be refetched.
  func purge() {
    imagesByPath.removeAll()
    insertionOrder.removeAll()
  }

  /// Re-keys each placeholder's image onto the host path the save returned.
  /// Positional, so it only applies when the save produced a ref for every
  /// placeholder; otherwise the placeholders are simply released, because a
  /// mismatched pairing would attach one image's bytes to another's path.
  func promote(_ placeholders: [AgentChatFileRef], to saved: [AgentChatFileRef]) {
    guard placeholders.count == saved.count else {
      release(placeholders)
      return
    }
    for (placeholder, savedRef) in zip(placeholders, saved) {
      guard workAttachmentIsPendingUpload(placeholder) else { continue }
      let image = imagesByPath[placeholder.path]
      removeEntry(forPath: placeholder.path)
      guard let image, !workAttachmentIsPendingUpload(savedRef) else { continue }
      store(image, forPath: savedRef.path)
    }
  }

  func image(forPath path: String) -> UIImage? {
    imagesByPath[path]
  }

  func release(_ refs: [AgentChatFileRef]) {
    for ref in refs {
      removeEntry(forPath: ref.path)
    }
  }

  private func store(_ image: UIImage, forPath path: String) {
    if imagesByPath[path] == nil {
      insertionOrder.append(path)
    }
    imagesByPath[path] = image
    while insertionOrder.count > workPendingUploadPreviewLimit {
      let oldest = insertionOrder.removeFirst()
      imagesByPath.removeValue(forKey: oldest)
    }
  }

  private func removeEntry(forPath path: String) {
    guard imagesByPath.removeValue(forKey: path) != nil else { return }
    insertionOrder.removeAll { $0 == path }
  }
}

/// Downscales the composer's upload-sized render to chip size. Returns the
/// original when it is already small enough.
@MainActor
private func workPendingUploadThumbnail(_ image: UIImage) -> UIImage {
  let longestSide = max(image.size.width, image.size.height)
  guard longestSide > workPendingUploadPreviewMaxPixels, longestSide > 0 else { return image }
  let scale = workPendingUploadPreviewMaxPixels / longestSide
  let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)
  let format = UIGraphicsImageRendererFormat.default()
  format.scale = 1
  return UIGraphicsImageRenderer(size: target, format: format).image { _ in
    image.draw(in: CGRect(origin: .zero, size: target))
  }
}

func workChatAttachmentIsImage(_ ref: AgentChatFileRef) -> Bool {
  let type = ref.type.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return type == "image" || type == "image-url"
}

/// The ref as the HOST will accept it.
///
/// `parseAgentChatFileRefs` matches the exact literals `image` and `file` and
/// silently drops every other spelling, so a ref that says `File` — including
/// one restored from a draft written by a build that spelled it that way —
/// vanishes from `chat.send` with no error anywhere. Normalizing on the way out
/// is the one place that cannot be forgotten by a new call site.
func workChatNormalizedOutboundRef(_ ref: AgentChatFileRef) -> AgentChatFileRef {
  var normalized = ref
  normalized.type = workChatAttachmentIsImage(ref) ? "image" : "file"
  return normalized
}

func workChatAttachmentDisplayName(_ ref: AgentChatFileRef) -> String {
  if ref.type == "image-url", let url = ref.url?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty {
    if let host = URL(string: url)?.host, !host.isEmpty {
      return host
    }
    return "Image link"
  }
  let basename = (ref.path as NSString).lastPathComponent
  return basename.isEmpty ? ref.path : basename
}

func workChatAttachmentAccessibilityLabel(_ attachments: [AgentChatFileRef]) -> String {
  let names = attachments.map(workChatAttachmentDisplayName)
  if names.count == 1 {
    return "Attachment: \(names[0])"
  }
  return "\(names.count) attachments: \(names.joined(separator: ", "))"
}

enum WorkChatInputAttachmentState: Equatable {
  case loading
  case ready
  case failed(String)
}

struct WorkChatInputAttachment: Identifiable {
  let id: UUID
  var image: UIImage?
  var uploadData: Data?
  var filename: String
  var mimeType: String
  /// Decides the chip, the preview, and which host staging route runs.
  var kind: WorkChatInputAttachmentKind
  /// Set when the host already holds these bytes — either the upload-on-attach
  /// task finished, or this attachment was restored from a persisted draft ref.
  /// A send reuses it instead of uploading the same bytes twice, and it is what
  /// lets a ref-restored attachment be sendable with no local bytes at all.
  var hostRef: AgentChatFileRef?
  var state: WorkChatInputAttachmentState

  init(
    id: UUID = UUID(),
    image: UIImage? = nil,
    uploadData: Data? = nil,
    filename: String,
    mimeType: String = "image/jpeg",
    kind: WorkChatInputAttachmentKind = .image,
    hostRef: AgentChatFileRef? = nil,
    state: WorkChatInputAttachmentState
  ) {
    self.id = id
    self.image = image
    self.uploadData = uploadData
    self.filename = filename
    self.mimeType = mimeType
    self.kind = kind
    self.hostRef = hostRef
    self.state = state
  }

  var isReady: Bool {
    if case .ready = state { return uploadData != nil || hostRef != nil }
    return false
  }

  var isLoading: Bool {
    if case .loading = state { return true }
    return false
  }

  var errorMessage: String? {
    if case .failed(let message) = state { return message }
    return nil
  }
}

func workChatOutgoingText(_ text: String, attachmentCount: Int) -> String {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if !trimmed.isEmpty { return trimmed }
  guard attachmentCount > 0 else { return "" }
  return attachmentCount == 1 ? "Attached image." : "Attached \(attachmentCount) images."
}

func workCliInitialInput(text: String, attachments: [AgentChatFileRef]) -> String {
  let manifest: String
  if attachments.isEmpty {
    manifest = ""
  } else {
    let lines = attachments.enumerated().map { index, attachment in
      if attachment.type == "image-url" {
        return "\(index + 1). Image URL: \(attachment.url ?? "")"
      }
      let label = attachment.type == "image" ? "Image file" : "File"
      return "\(index + 1). \(label): \(attachment.path)"
    }
    manifest = (["Attached files and images:"] + lines).joined(separator: "\n")
  }

  return [manifest, text.trimmingCharacters(in: .whitespacesAndNewlines)]
    .filter { !$0.isEmpty }
    .joined(separator: "\n\n")
}

func workChatInputReadyAttachments(_ attachments: [WorkChatInputAttachment]) -> [WorkChatInputAttachment] {
  attachments.filter(\.isReady)
}

func workChatInputHasLoadingAttachments(_ attachments: [WorkChatInputAttachment]) -> Bool {
  attachments.contains(where: \.isLoading)
}

func workChatInputHasFailedAttachments(_ attachments: [WorkChatInputAttachment]) -> Bool {
  attachments.contains { $0.errorMessage != nil }
}

/// Note what is deliberately absent: an "is uploading" term.
///
/// Attachments upload the moment they are staged (see
/// `WorkComposerAttachmentUploads`), so an in-flight upload is background work,
/// not a reason to grey out send. The send awaits the in-flight task instead —
/// disabling the button here would make attaching a 40 MB video block the
/// composer for seconds with no explanation. `.loading` still blocks, because
/// that is the *local* decode: those attachments have no bytes yet.
func workChatInputCanSend(
  text: String,
  attachments: [WorkChatInputAttachment],
  baseEnabled: Bool,
  canUploadAttachments: Bool
) -> Bool {
  let readyAttachments = workChatInputReadyAttachments(attachments)
  return baseEnabled
    && !workChatInputHasLoadingAttachments(attachments)
    && !workChatInputHasFailedAttachments(attachments)
    && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !readyAttachments.isEmpty)
    && (readyAttachments.isEmpty || canUploadAttachments)
}

func workChatInputAttachmentDataURL(_ attachment: WorkChatInputAttachment) -> String? {
  guard let uploadData = attachment.uploadData else { return nil }
  return "data:\(attachment.mimeType);base64,\(uploadData.base64EncodedString())"
}

@MainActor
func workChatInputAttachment(from image: UIImage, filename: String? = nil, id: UUID = UUID()) -> WorkChatInputAttachment? {
  guard let encoded = workChatJPEGDataForUpload(image) else { return nil }
  let cleanedFilename = filename?.trimmingCharacters(in: .whitespacesAndNewlines)
  let resolvedFilename: String
  if let cleanedFilename, !cleanedFilename.isEmpty {
    resolvedFilename = cleanedFilename
  } else {
    resolvedFilename = "image-\(id.uuidString.prefix(8)).jpg"
  }
  return WorkChatInputAttachment(
    id: id,
    image: encoded.image,
    uploadData: encoded.data,
    filename: resolvedFilename,
    state: .ready
  )
}

@MainActor
func workChatInputPasteImages(_ images: [UIImage], into attachments: Binding<[WorkChatInputAttachment]>) {
  guard !images.isEmpty else { return }
  var next = attachments.wrappedValue
  next.removeAll { $0.filename == "attachment-limit" }
  let availableSlots = max(0, workChatInputAttachmentLimit - next.count)
  for image in images.prefix(availableSlots) {
    let id = UUID()
    if let attachment = workChatInputAttachment(from: image, filename: "pasted-\(id.uuidString.prefix(8)).jpg", id: id) {
      next.append(attachment)
    } else {
      next.append(WorkChatInputAttachment(
        id: id,
        filename: "pasted-\(id.uuidString.prefix(8)).jpg",
        state: .failed("This image could not be prepared for upload.")
      ))
    }
  }
  if images.count > availableSlots {
    next.append(WorkChatInputAttachment(
      filename: "attachment-limit",
      state: .failed("You can attach up to \(workChatInputAttachmentLimit) images at a time.")
    ))
  }
  attachments.wrappedValue = next
}

@MainActor
func workChatSaveInputAttachments(
  _ attachments: [WorkChatInputAttachment],
  syncService: SyncService,
  chatSessionId: String? = nil,
  targetProjectId: String? = nil,
  targetProjectRootPath: String? = nil
) async throws -> [AgentChatFileRef] {
  var refs: [AgentChatFileRef] = []
  for attachment in workChatInputReadyAttachments(attachments) {
    // Already on the host: the upload-on-attach task finished, or this came
    // back from a persisted draft. Re-uploading would duplicate the bytes and,
    // for a ref-restored attachment, there are no local bytes to send.
    if let hostRef = attachment.hostRef {
      refs.append(workChatNormalizedOutboundRef(hostRef))
      continue
    }
    // The upload started when the attachment was staged; wait for it rather
    // than racing a second upload of the same bytes.
    if let resolved = await WorkComposerAttachmentUploads.shared.resolve(attachment.id) {
      refs.append(workChatNormalizedOutboundRef(resolved))
      continue
    }
    if attachment.kind != .image {
      let saved = try await syncService.saveChatFileAttachment(
        data: attachment.uploadData ?? Data(),
        filename: attachment.filename,
        chatSessionId: chatSessionId,
        targetProjectId: targetProjectId,
        targetProjectRootPath: targetProjectRootPath
      )
      // Lowercase: the host ref parser drops any `type` that is not exactly
      // `image` or `file`.
      refs.append(AgentChatFileRef(path: saved.path, type: "file"))
      continue
    }
    guard let dataUrl = workChatInputAttachmentDataURL(attachment) else { continue }
    let saved: SavedChatTempAttachment
    if let chatSessionId, !chatSessionId.isEmpty {
      saved = try await syncService.saveChatTempAttachmentForChat(
        sessionId: chatSessionId,
        dataUrl: dataUrl,
        filename: attachment.filename
      )
    } else {
      saved = try await syncService.saveChatTempAttachment(
        dataUrl: dataUrl,
        filename: attachment.filename,
        targetProjectId: targetProjectId,
        targetProjectRootPath: targetProjectRootPath
      )
    }
    refs.append(AgentChatFileRef(path: saved.path, type: "image"))
  }
  return refs
}

@MainActor
func workChatInputAttachments(
  from refs: [AgentChatFileRef],
  syncService: SyncService,
  chatSessionId: String?,
  projectId: String?,
  projectRootPath: String?
) async throws -> [WorkChatInputAttachment] {
  var restored: [WorkChatInputAttachment] = []
  for ref in refs {
    if ref.type == "image-url", let urlString = ref.url ?? Optional(ref.path),
       let url = URL(string: urlString),
       let scheme = url.scheme?.lowercased(),
       scheme == "http" || scheme == "https" {
      let data = try await workChatRemoteImageData(from: url)
      guard let image = WorkChatAttachmentImagePreview.downsampledImage(
              data: data,
              maxPixelSize: 2400
            ),
            let attachment = workChatInputAttachment(
              from: image,
              filename: workChatAttachmentDisplayName(ref)
            ) else {
        throw workChatStashImageRestoreError
      }
      restored.append(attachment)
      continue
    }
    guard ref.type == "image" else {
      // A document or a video: the host already holds it, so the composer only
      // needs a chip. Preview pulls the bytes on demand
      // (`WorkChatAttachmentPreviewSheet`) rather than eagerly downloading a
      // 40 MB video into a draft restore.
      restored.append(WorkChatInputAttachment(
        filename: workChatAttachmentDisplayName(ref),
        mimeType: "application/octet-stream",
        kind: workChatAttachmentRefKind(ref),
        hostRef: ref,
        state: .ready
      ))
      continue
    }
    let dataUrl: String
    if let chatSessionId, !chatSessionId.isEmpty {
      dataUrl = try await syncService.chatImageDataUrlForChat(sessionId: chatSessionId, path: ref.path)
    } else if syncService.canInvokeRemoteAction("chat.getImageDataUrl") {
      dataUrl = try await syncService.chatImageDataUrl(
        path: ref.path,
        targetProjectId: projectId,
        targetProjectRootPath: projectRootPath
      )
    } else {
      throw workChatStashImageRestoreError
    }
    guard let image = WorkChatAttachmentImagePreview.image(
            fromDataUrl: dataUrl,
            maxPixelSize: 2400,
            maxBytes: workChatInputAttachmentMaxBytes
          ),
          var attachment = workChatInputAttachment(
            from: image,
            filename: workChatAttachmentDisplayName(ref)
          ) else {
      throw workChatStashImageRestoreError
    }
    attachment.hostRef = ref
    restored.append(attachment)
  }
  return restored
}

private let workChatStashImageRestoreError = NSError(
  domain: "ADE",
  code: 28,
  userInfo: [NSLocalizedDescriptionKey: "Could not restore a stashed image. The prompt is still in your stash."]
)

private func workChatJPEGDataForUpload(_ image: UIImage) -> (image: UIImage, data: Data)? {
  var maxDimension = min(
    workChatInputAttachmentInitialMaxDimension,
    max(image.size.width, image.size.height)
  )
  let qualities: [CGFloat] = [0.88, 0.76, 0.64, 0.52, 0.40]
  var attempted = false

  while !attempted || maxDimension >= workChatInputAttachmentMinimumMaxDimension {
    attempted = true
    guard let rendered = workChatRenderedJPEGImage(image, maxDimension: maxDimension) else { return nil }
    for quality in qualities {
      guard let data = rendered.jpegData(compressionQuality: quality) else { continue }
      if data.count <= workChatInputAttachmentMaxBytes {
        return (rendered, data)
      }
    }
    if maxDimension <= workChatInputAttachmentMinimumMaxDimension {
      break
    }
    maxDimension *= 0.75
  }

  return nil
}

private func workChatRenderedJPEGImage(_ image: UIImage, maxDimension: CGFloat) -> UIImage? {
  guard image.size.width > 0, image.size.height > 0 else { return nil }
  let longest = max(image.size.width, image.size.height)
  let scale = min(1, maxDimension / longest)
  let targetSize = CGSize(
    width: max(1, floor(image.size.width * scale)),
    height: max(1, floor(image.size.height * scale))
  )
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  format.opaque = true
  return UIGraphicsImageRenderer(size: targetSize, format: format).image { context in
    UIColor.white.setFill()
    context.fill(CGRect(origin: .zero, size: targetSize))
    image.draw(in: CGRect(origin: .zero, size: targetSize))
  }
}

private struct WorkChatAttachmentPickerModifier: ViewModifier {
  @Binding var isPresented: Bool
  @Binding var attachments: [WorkChatInputAttachment]
  let onDismiss: () -> Void

  @State private var pickerItems: [PhotosPickerItem] = []

  func body(content: Content) -> some View {
    content
      .photosPicker(
        isPresented: $isPresented,
        selection: $pickerItems,
        maxSelectionCount: max(1, workChatInputAttachmentLimit - attachments.count),
        matching: .images,
        preferredItemEncoding: .automatic
      )
      .onChange(of: pickerItems) { _, newItems in
        guard !newItems.isEmpty else { return }
        pickerItems = []
        Task { await appendPhotoPickerItems(newItems) }
      }
      .onChange(of: isPresented) { wasPresented, nowPresented in
        if wasPresented && !nowPresented {
          onDismiss()
        }
      }
  }

  @MainActor
  private func appendPhotoPickerItems(_ items: [PhotosPickerItem]) async {
    for item in items {
      let id = UUID()
      let fallbackName = "image-\(id.uuidString.prefix(8)).jpg"
      attachments.append(WorkChatInputAttachment(
        id: id,
        filename: fallbackName,
        state: .loading
      ))
      do {
        guard let data = try await item.loadTransferable(type: Data.self),
              let image = UIImage(data: data) else {
          markAttachment(id: id, failed: "This image could not be read.")
          continue
        }
        guard let attachment = workChatInputAttachment(from: image, filename: fallbackName, id: id) else {
          markAttachment(id: id, failed: "This image is too large to upload.")
          continue
        }
        replaceAttachment(id: id, with: attachment)
      } catch is CancellationError {
        attachments.removeAll { $0.id == id }
      } catch {
        markAttachment(
          id: id,
          failed: "Could not load this image from camera roll. If it is in iCloud, check your connection and try again."
        )
      }
    }
  }

  @MainActor
  private func replaceAttachment(id: UUID, with attachment: WorkChatInputAttachment) {
    guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
    attachments[index] = attachment
  }

  @MainActor
  private func markAttachment(id: UUID, failed message: String) {
    guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
    attachments[index].state = .failed(message)
  }
}

extension View {
  func workChatAttachmentPicker(
    isPresented: Binding<Bool>,
    attachments: Binding<[WorkChatInputAttachment]>,
    onDismiss: @escaping () -> Void
  ) -> some View {
    modifier(WorkChatAttachmentPickerModifier(
      isPresented: isPresented,
      attachments: attachments,
      onDismiss: onDismiss
    ))
  }
}

struct WorkChatInputAttachmentTray: View {
  @Binding var attachments: [WorkChatInputAttachment]
  /// Collapsed composer mode: 24 pt chips in one row, no header, no remove
  /// badge. Nothing is unstaged — this is a view mode over the same array.
  var compact = false
  /// Tapping a compact chip asks the composer to expand again, so the collapsed
  /// state is never something the user has to work out how to escape.
  var onExpand: (() -> Void)?
  /// Routes a preview's byte fetch to the right project scope. Nil on the
  /// projectless "new chat" composers, which fall back to the active project.
  var chatSessionId: String?
  /// ONE presentation state, not two. Two `.sheet(item:)` modifiers on the same
  /// view are not a supported SwiftUI arrangement — whichever one loses can
  /// silently never present — and the two states are mutually exclusive anyway:
  /// a tap opens either the image sheet or the file/video sheet.
  @State private var preview: WorkChatInputTrayPreview?

  private var attachmentCountLabel: String {
    let readyCount = attachments.filter(\.isReady).count
    let loadingCount = attachments.filter(\.isLoading).count
    if loadingCount > 0 {
      return loadingCount == 1 ? "Loading attachment" : "Loading \(loadingCount) attachments"
    }
    if readyCount == 1 { return "1 attachment" }
    return "\(readyCount) attachments"
  }

  private var trayGlyph: String {
    let kinds = Set(attachments.map(\.kind))
    if kinds == [.image] { return "photo.on.rectangle" }
    if kinds == [.video] { return "film" }
    return "paperclip"
  }

  var body: some View {
    if attachments.isEmpty {
      EmptyView()
    } else if compact {
      // One control, not one per chip: every chip did the same thing (expand),
      // and a 24pt chip is far under the 44pt minimum. The row carries the hit
      // area and the spoken summary; the chips are decoration inside it. The
      // tap stays a gesture rather than a Button so the row still scrolls.
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(attachments) { attachment in
            WorkChatCompactAttachmentChip(attachment: attachment)
          }
        }
        .padding(.horizontal, 2)
        .frame(minHeight: 44)
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
      .onTapGesture { onExpand?() }
      .accessibilityElement(children: .ignore)
      .accessibilityAddTraits(.isButton)
      .accessibilityLabel(attachmentCountLabel)
      .accessibilityHint("Expands the composer")
      .accessibilityAction { onExpand?() }
    } else {
      expandedTray
    }
  }

  @ViewBuilder
  private var expandedTray: some View {
    if !attachments.isEmpty {
      VStack(alignment: .leading, spacing: 7) {
        HStack(spacing: 6) {
          Image(systemName: trayGlyph)
            .font(.system(size: 11, weight: .semibold))
          Text(attachmentCountLabel)
            .font(.caption2.weight(.semibold))
          Spacer(minLength: 0)
        }
        .foregroundStyle(ADEColor.textMuted)

        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(attachments) { attachment in
              WorkChatInputAttachmentThumb(attachment: attachment) {
                open(attachment)
              } onRemove: {
                attachments.removeAll { $0.id == attachment.id }
              }
            }
          }
        }
      }
      .padding(.horizontal, 2)
      .sheet(item: $preview) { item in
        switch item {
        case let .image(attachment):
          WorkChatInputAttachmentPreview(
            attachment: attachment,
            onRemove: {
              attachments.removeAll { $0.id == attachment.id }
              preview = nil
            }
          )
        case let .file(request):
          WorkChatAttachmentPreviewSheet(request: request)
        }
      }
    }
  }

  /// Images keep the existing full-screen image sheet; documents and videos get
  /// QuickLook / `VideoPlayer` without leaving the thread.
  private func open(_ attachment: WorkChatInputAttachment) {
    guard attachment.kind != .image else {
      preview = .image(attachment)
      return
    }
    let source: WorkChatAttachmentPreviewSource
    if let data = attachment.uploadData, !data.isEmpty {
      source = .localBytes(data)
    } else if let hostRef = attachment.hostRef {
      source = .hostPath(hostRef.path)
    } else {
      return
    }
    preview = .file(WorkChatAttachmentPreviewRequest(
      filename: attachment.filename,
      kind: attachment.kind,
      source: source,
      chatSessionId: chatSessionId
    ))
  }
}

/// The one thing an input tray can have open: the image sheet or the
/// file/video sheet.
private enum WorkChatInputTrayPreview: Identifiable {
  case image(WorkChatInputAttachment)
  case file(WorkChatAttachmentPreviewRequest)

  var id: String {
    switch self {
    case let .image(attachment): return "image:\(attachment.id.uuidString)"
    case let .file(request): return "file:\(request.id.uuidString)"
    }
  }
}

/// 24 pt chip for the collapsed composer. No remove badge on purpose: collapsing
/// must not put a destructive control under the user's thumb.
struct WorkChatCompactAttachmentChip: View {
  let attachment: WorkChatInputAttachment

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 6, style: .continuous)
        .fill(ADEColor.surfaceBackground.opacity(0.42))
        .frame(width: 24, height: 24)
        .overlay(
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .stroke(ADEColor.border.opacity(0.34), lineWidth: 0.7)
        )
      if let image = attachment.image {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
          .frame(width: 24, height: 24)
          .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
      } else {
        Image(systemName: attachment.errorMessage == nil ? attachment.kind.glyph : "exclamationmark.triangle")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(attachment.errorMessage == nil ? ADEColor.textSecondary : ADEColor.warning)
      }
    }
    .accessibilityLabel("Attachment \(attachment.filename)")
  }
}

private struct WorkChatInputAttachmentThumb: View {
  let attachment: WorkChatInputAttachment
  let onOpen: () -> Void
  let onRemove: () -> Void

  var body: some View {
    ZStack(alignment: .topTrailing) {
      Button(action: onOpen) {
        ZStack {
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(ADEColor.surfaceBackground.opacity(0.42))
            .frame(width: 72, height: 72)
            .overlay(
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(ADEColor.border.opacity(0.34), lineWidth: 0.8)
            )

          if let image = attachment.image {
            Image(uiImage: image)
              .resizable()
              .scaledToFill()
              .frame(width: 72, height: 72)
              .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
          } else if attachment.kind != .image, attachment.errorMessage == nil, !attachment.isLoading {
            documentFace
          } else {
            placeholder
          }
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel(accessibilityLabel)

      Button(action: onRemove) {
        Image(systemName: "xmark")
          .font(.system(size: 8, weight: .bold))
          .foregroundStyle(Color.white)
          .frame(width: 18, height: 18)
          .background(Color.black.opacity(0.62), in: Circle())
      }
      .buttonStyle(.plain)
      .padding(4)
      // The tray now stages videos and documents too, so the label follows the
      // chip's kind rather than always saying "image".
      .accessibilityLabel("Remove \(attachment.kind.rawValue)")
    }
  }

  /// Non-image chips carry a glyph and their name — a video or a PDF has no
  /// thumbnail the composer can render without decoding the whole file.
  private var documentFace: some View {
    VStack(spacing: 5) {
      Image(systemName: attachment.kind.glyph)
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Text(attachment.filename)
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
        .truncationMode(.middle)
        .padding(.horizontal, 4)
    }
    .frame(width: 72, height: 72)
  }

  @ViewBuilder
  private var placeholder: some View {
    switch attachment.state {
    case .loading:
      ProgressView()
        .controlSize(.small)
        .tint(ADEColor.textSecondary)
    case .ready:
      Image(systemName: "photo")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
    case .failed:
      VStack(spacing: 4) {
        Image(systemName: "photo.badge.exclamationmark")
          .font(.system(size: 17, weight: .semibold))
        Text("Failed")
          .font(.system(size: 9, weight: .semibold))
      }
      .foregroundStyle(ADEColor.warning)
    }
  }

  private var accessibilityLabel: String {
    switch attachment.state {
    case .loading:
      return "Image loading"
    case .ready:
      return "Open attached image"
    case .failed(let message):
      return "Image failed. \(message)"
    }
  }
}

private struct WorkChatInputAttachmentPreview: View {
  let attachment: WorkChatInputAttachment
  let onRemove: () -> Void

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      VStack(spacing: 16) {
        if let image = attachment.image {
          Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        } else if attachment.isLoading {
          ProgressView("Loading image…")
            .foregroundStyle(ADEColor.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          VStack(spacing: 10) {
            Image(systemName: "photo.badge.exclamationmark")
              .font(.system(size: 34, weight: .semibold))
              .foregroundStyle(ADEColor.warning)
            Text(attachment.errorMessage ?? "This image could not be loaded.")
              .font(.body)
              .foregroundStyle(ADEColor.textSecondary)
              .multilineTextAlignment(.center)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .padding(16)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Attached image")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Done") { dismiss() }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button {
            if let image = attachment.image {
              UIPasteboard.general.image = image
              ADEHaptics.success()
            }
          } label: {
            Label("Copy", systemImage: "doc.on.doc")
          }
          .disabled(attachment.image == nil)

          Button(role: .destructive) {
            onRemove()
          } label: {
            Label("Remove", systemImage: "trash")
          }
        }
      }
    }
  }
}

private func workChatAttachmentStableIdentity(_ ref: AgentChatFileRef) -> String {
  let type = ref.type.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let path = ref.path.trimmingCharacters(in: .whitespacesAndNewlines)
  let url = ref.url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return "\(type.count):\(type)|\(path.count):\(path)|\(url.count):\(url)"
}

private struct WorkChatAttachmentItem: Identifiable {
  let id: String
  let attachment: AgentChatFileRef
}

private func workChatAttachmentItems(_ attachments: [AgentChatFileRef]) -> [WorkChatAttachmentItem] {
  var seen: [String: Int] = [:]
  return attachments.map { attachment in
    let baseId = workChatAttachmentStableIdentity(attachment)
    let occurrence = seen[baseId, default: 0]
    seen[baseId] = occurrence + 1
    let id = occurrence == 0 ? baseId : "\(baseId)#\(occurrence)"
    return WorkChatAttachmentItem(id: id, attachment: attachment)
  }
}

enum WorkChatAttachmentTrayStyle {
  /// Standalone tray below the bubble (composer / legacy layout).
  case standalone
  /// Thumbnails live inside the user bubble, matching desktop `ChatAttachmentTray`.
  case embeddedInBubble
}

/// Compact attachment tray for user messages — mirrors desktop's
/// `ChatAttachmentTray` with mobile-friendly placeholders when image bytes
/// have not synced from the desktop host yet.
struct WorkChatAttachmentTray: View {
  let attachments: [AgentChatFileRef]
  var alignment: HorizontalAlignment = .trailing
  var style: WorkChatAttachmentTrayStyle = .standalone

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.workChatLaneId) private var laneId
  @Environment(\.workChatRequestedCwd) private var requestedCwd

  private var chipSize: CGFloat {
    style == .embeddedInBubble ? 56 : 72
  }

  var body: some View {
    VStack(alignment: alignment, spacing: 6) {
      if style == .standalone, attachments.count > 1 {
        Text("\(attachments.count) attachments")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
      }

      if style == .embeddedInBubble {
        LazyVGrid(
          columns: [GridItem(.adaptive(minimum: chipSize, maximum: chipSize), spacing: 8)],
          alignment: alignment,
          spacing: 8
        ) {
          ForEach(workChatAttachmentItems(attachments)) { item in
            WorkChatAttachmentChip(attachment: item.attachment, size: chipSize)
          }
        }
      } else {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(workChatAttachmentItems(attachments)) { item in
              WorkChatAttachmentChip(attachment: item.attachment, size: chipSize)
            }
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: alignment == .trailing ? .trailing : .leading)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(workChatAttachmentAccessibilityLabel(attachments))
  }
}

private struct WorkChatAttachmentChip: View {
  let attachment: AgentChatFileRef
  var size: CGFloat = 72

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.workChatLaneId) private var laneId
  @Environment(\.workChatRequestedCwd) private var requestedCwd
  @Environment(\.workChatIsPersonal) private var isPersonalChat
  @Environment(\.workChatSessionId) private var chatSessionId
  @Environment(\.displayScale) private var displayScale

  @State private var previewImage: UIImage?
  @State private var loadFailed = false
  @State private var filePreview: WorkChatAttachmentPreviewRequest?

  private var isUploading: Bool {
    workAttachmentIsPendingUpload(attachment)
  }

  var body: some View {
    Group {
      if workChatAttachmentIsImage(attachment) {
        imageChip
      } else {
        fileChip
      }
    }
    .task(id: workChatAttachmentStableIdentity(attachment)) {
      await loadPreviewIfNeeded()
    }
  }

  private var imageChip: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(Color.white.opacity(0.08))
        .frame(width: size, height: size)
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(Color.white.opacity(0.16), lineWidth: 0.8)
        )

      if let previewImage {
        Image(uiImage: previewImage)
          .resizable()
          .scaledToFill()
          .frame(width: size, height: size)
          .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
          .opacity(isUploading ? 0.55 : 1)
          .overlay {
            if isUploading {
              ProgressView()
                .controlSize(.small)
                .tint(Color.white)
            }
          }
      } else {
        VStack(spacing: 4) {
          Image(systemName: loadFailed ? "photo.badge.exclamationmark" : "photo")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(Color.white.opacity(0.82))
          Text(loadFailed ? "On desktop" : (isUploading ? "Sending" : "Image"))
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(Color.white.opacity(0.72))
            .lineLimit(1)
        }
      }
    }
    .accessibilityLabel(
      isUploading
        ? "Image attachment, sending"
        : "Image attachment \(workChatAttachmentDisplayName(attachment))"
    )
  }

  private var fileChip: some View {
    Button {
      filePreview = WorkChatAttachmentPreviewRequest(
        filename: workChatAttachmentDisplayName(attachment),
        kind: workChatAttachmentRefKind(attachment),
        source: .hostPath(attachment.path),
        // Without the owning session the host resolves this path against
        // whichever project is active, so a file from another project's chat
        // fails to load.
        chatSessionId: chatSessionId
      )
    } label: {
      fileChipFace
    }
    .buttonStyle(.plain)
    .sheet(item: $filePreview) { request in
      WorkChatAttachmentPreviewSheet(request: request)
    }
  }

  private var fileChipFace: some View {
    HStack(spacing: 6) {
      Image(systemName: workChatAttachmentRefKind(attachment).glyph)
        .font(.system(size: 11, weight: .bold))
      Text(workChatAttachmentDisplayName(attachment))
        .font(.caption2.weight(.semibold))
        .lineLimit(1)
        .truncationMode(.middle)
    }
    .foregroundStyle(Color.white.opacity(0.9))
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(Color.white.opacity(0.10), in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(Color.white.opacity(0.18), lineWidth: 0.8)
    )
    .frame(maxWidth: 220)
    .accessibilityLabel("File attachment \(workChatAttachmentDisplayName(attachment))")
  }

  @MainActor
  private func loadPreviewIfNeeded() async {
    guard workChatAttachmentIsImage(attachment) else { return }
    // The phone already holds this image if it is the one being sent — while it
    // uploads under a placeholder path, and afterwards under the host path it
    // was promoted to. Resolving locally avoids both a placeholder flash across
    // the swap and a re-download of our own upload.
    if let local = WorkPendingUploadPreviewStore.shared.image(forPath: attachment.path) {
      previewImage = local
      loadFailed = false
      return
    }
    if workAttachmentIsPendingUpload(attachment) {
      previewImage = nil
      loadFailed = false
      return
    }
    let maxPixelSize = max(workChatAttachmentPreviewMinimumPixels, ceil(size * displayScale))
    if attachment.type == "image-url", let urlString = attachment.url,
       let url = URL(string: urlString), let scheme = url.scheme?.lowercased(),
       scheme == "http" || scheme == "https" {
      do {
        let data = try await workChatRemoteImageData(from: url)
        if let image = WorkChatAttachmentImagePreview.downsampledImage(data: data, maxPixelSize: maxPixelSize) {
          previewImage = image
          loadFailed = false
          return
        }
      } catch {
        loadFailed = true
        return
      }
    }

    if isPersonalChat {
      guard syncService.canInvokeRemoteAction("personalChats.getImageDataUrl") else {
        loadFailed = true
        return
      }
      do {
        let dataUrl = try await syncService.personalChatImageDataUrl(path: attachment.path)
        if let image = WorkChatAttachmentImagePreview.image(fromDataUrl: dataUrl, maxPixelSize: maxPixelSize) {
          previewImage = image
          loadFailed = false
          return
        }
        loadFailed = true
        return
      } catch {
        loadFailed = true
        return
      }
    }

    guard let laneId, !laneId.isEmpty else {
      loadFailed = true
      return
    }

    do {
      let workspaces = try await syncService.listWorkspaces()
      guard let workspace = workFilesWorkspace(for: laneId, in: workspaces) else {
        loadFailed = true
        return
      }
      let relativePath = normalizeWorkFileReference(
        attachment.path,
        workspaceRoot: workspace.rootPath,
        requestedCwd: requestedCwd
      )
      guard !relativePath.isEmpty else {
        loadFailed = true
        return
      }
      let blob = try await syncService.readFile(workspaceId: workspace.id, path: relativePath)
      if let dataUrl = blob.dataUrl,
         let image = WorkChatAttachmentImagePreview.image(fromDataUrl: dataUrl, maxPixelSize: maxPixelSize) {
        previewImage = image
        loadFailed = false
        return
      }
      if blob.isBinary,
         !blob.content.isEmpty,
         let data = WorkChatAttachmentImagePreview.base64DecodedImageData(blob.content, maxBytes: workChatRemoteImageMaxBytes),
         let image = WorkChatAttachmentImagePreview.downsampledImage(data: data, maxPixelSize: maxPixelSize) {
        previewImage = image
        loadFailed = false
        return
      }
      loadFailed = true
    } catch {
      loadFailed = true
    }
  }
}

private func workChatRemoteImageData(from url: URL) async throws -> Data {
  let (bytes, response) = try await workChatRemoteImageSession.bytes(from: url)
  if response.expectedContentLength > Int64(workChatRemoteImageMaxBytes) {
    throw WorkChatRemoteImageError.responseTooLarge
  }

  var data = Data()
  if response.expectedContentLength > 0 {
    data.reserveCapacity(min(Int(response.expectedContentLength), workChatRemoteImageMaxBytes))
  }
  for try await byte in bytes {
    guard data.count < workChatRemoteImageMaxBytes else {
      throw WorkChatRemoteImageError.responseTooLarge
    }
    data.append(byte)
  }
  return data
}

struct WorkChatTranscriptEnvironmentModifier: ViewModifier {
  let provider: String?
  let modelId: String?
  let modelLabel: String?
  let laneId: String
  let requestedCwd: String?
  let isPersonalChat: Bool
  /// The session these messages belong to. Attachment reads are routed by it,
  /// so a chat from another project resolves against ITS project rather than
  /// whichever one happens to be active on the host.
  let sessionId: String?

  func body(content: Content) -> some View {
    content
      .environment(\.workChatProvider, provider)
      .environment(\.workChatModelId, modelId)
      .environment(\.workChatModelLabel, modelLabel)
      .environment(\.workChatLaneId, laneId)
      .environment(\.workChatRequestedCwd, requestedCwd)
      .environment(\.workChatIsPersonal, isPersonalChat)
      .environment(\.workChatSessionId, sessionId)
  }
}

private struct WorkChatLaneIdEnvironmentKey: EnvironmentKey {
  static let defaultValue: String? = nil
}

private struct WorkChatRequestedCwdEnvironmentKey: EnvironmentKey {
  static let defaultValue: String? = nil
}

private struct WorkChatIsPersonalEnvironmentKey: EnvironmentKey {
  static let defaultValue = false
}

private struct WorkChatSessionIdEnvironmentKey: EnvironmentKey {
  static let defaultValue: String? = nil
}

extension EnvironmentValues {
  var workChatLaneId: String? {
    get { self[WorkChatLaneIdEnvironmentKey.self] }
    set { self[WorkChatLaneIdEnvironmentKey.self] = newValue }
  }

  var workChatRequestedCwd: String? {
    get { self[WorkChatRequestedCwdEnvironmentKey.self] }
    set { self[WorkChatRequestedCwdEnvironmentKey.self] = newValue }
  }


  var workChatIsPersonal: Bool {
    get { self[WorkChatIsPersonalEnvironmentKey.self] }
    set { self[WorkChatIsPersonalEnvironmentKey.self] = newValue }
  }

  var workChatSessionId: String? {
    get { self[WorkChatSessionIdEnvironmentKey.self] }
    set { self[WorkChatSessionIdEnvironmentKey.self] = newValue }
  }
}

enum WorkChatAttachmentImagePreview {
  static func base64DecodedImageData(_ base64: String, maxBytes: Int) -> Data? {
    let encodedBytes = base64.utf8.count
    let decodedUpperBound = ((encodedBytes + 3) / 4) * 3
    guard decodedUpperBound <= maxBytes,
          let data = Data(base64Encoded: base64),
          data.count <= maxBytes else {
      return nil
    }
    return data
  }

  static func downsampledImage(data: Data, maxPixelSize: CGFloat) -> UIImage? {
    guard !data.isEmpty, maxPixelSize > 0 else { return nil }
    let sourceOptions = [
      kCGImageSourceShouldCache: false
    ] as CFDictionary
    guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
    let thumbnailOptions = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: Int(ceil(maxPixelSize))
    ] as CFDictionary
    guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions) else { return nil }
    return UIImage(cgImage: cgImage)
  }

  static func image(
    fromDataUrl dataUrl: String,
    maxPixelSize: CGFloat,
    maxBytes: Int = workChatRemoteImageMaxBytes
  ) -> UIImage? {
    guard let commaIndex = dataUrl.firstIndex(of: ",") else { return nil }
    let base64 = String(dataUrl[dataUrl.index(after: commaIndex)...])
    guard let data = base64DecodedImageData(base64, maxBytes: maxBytes) else { return nil }
    return downsampledImage(data: data, maxPixelSize: maxPixelSize)
  }
}
