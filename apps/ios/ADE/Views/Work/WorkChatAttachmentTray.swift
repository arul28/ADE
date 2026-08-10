import SwiftUI
import ImageIO
import PhotosUI
import UIKit

private let workChatRemoteImageMaxBytes = 5 * 1024 * 1024
private let workChatRemoteImageTimeoutSeconds: TimeInterval = 12
private let workChatAttachmentPreviewMinimumPixels: CGFloat = 96
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

func workAttachmentIsPendingUpload(_ ref: AgentChatFileRef) -> Bool {
  ref.path.hasPrefix(workPendingUploadPathPrefix)
}

/// Holds the composer's already-downscaled `UIImage` for each in-flight upload
/// so the echo's thumbnail resolves without touching the host. Entries are
/// released as soon as the save returns (or the send fails) — a handoff buffer,
/// not a cache.
@MainActor
final class WorkPendingUploadPreviewStore {
  static let shared = WorkPendingUploadPreviewStore()

  private var imagesByPath: [String: UIImage] = [:]

  private init() {}

  func register(_ attachments: [WorkChatInputAttachment]) -> [AgentChatFileRef] {
    attachments.map { attachment in
      let ref = AgentChatFileRef(
        path: "\(workPendingUploadPathPrefix)\(attachment.id.uuidString)",
        type: "image"
      )
      if let image = attachment.image {
        imagesByPath[ref.path] = image
      }
      return ref
    }
  }

  func image(forPath path: String) -> UIImage? {
    imagesByPath[path]
  }

  func release(_ refs: [AgentChatFileRef]) {
    for ref in refs where workAttachmentIsPendingUpload(ref) {
      imagesByPath.removeValue(forKey: ref.path)
    }
  }
}

func workChatAttachmentIsImage(_ ref: AgentChatFileRef) -> Bool {
  let type = ref.type.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return type == "image" || type == "image-url"
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
  var state: WorkChatInputAttachmentState

  init(
    id: UUID = UUID(),
    image: UIImage? = nil,
    uploadData: Data? = nil,
    filename: String,
    mimeType: String = "image/jpeg",
    state: WorkChatInputAttachmentState
  ) {
    self.id = id
    self.image = image
    self.uploadData = uploadData
    self.filename = filename
    self.mimeType = mimeType
    self.state = state
  }

  var isReady: Bool {
    if case .ready = state { return uploadData != nil }
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

struct WorkChatAttachmentAddButton: View {
  @Binding var pickerPresented: Bool
  let attachmentCount: Int
  var disabled = false

  private var isDisabled: Bool {
    disabled || attachmentCount >= workChatInputAttachmentLimit
  }

  var body: some View {
    Button {
      pickerPresented = true
    } label: {
      Image(systemName: "plus")
        .font(.system(size: 14, weight: .bold))
        .foregroundStyle(isDisabled ? ADEColor.textMuted.opacity(0.35) : ADEColor.textPrimary)
        .frame(width: 28, height: 28)
        .background(ADEColor.surfaceBackground.opacity(isDisabled ? 0.18 : 0.38), in: Circle())
        .overlay(Circle().stroke(ADEColor.border.opacity(isDisabled ? 0.16 : 0.28), lineWidth: 0.6))
        .frame(width: 44, height: 44)
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .disabled(isDisabled)
    .accessibilityLabel("Attach from camera roll")
    .accessibilityHint("Opens the photo picker.")
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
  @State private var expandedAttachment: WorkChatInputAttachment?

  private var attachmentCountLabel: String {
    let readyCount = attachments.filter(\.isReady).count
    let loadingCount = attachments.filter(\.isLoading).count
    if loadingCount > 0 {
      return loadingCount == 1 ? "Loading image" : "Loading \(loadingCount) images"
    }
    if readyCount == 1 { return "1 image attached" }
    return "\(readyCount) images attached"
  }

  var body: some View {
    if !attachments.isEmpty {
      VStack(alignment: .leading, spacing: 7) {
        HStack(spacing: 6) {
          Image(systemName: "photo.on.rectangle")
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
                expandedAttachment = attachment
              } onRemove: {
                attachments.removeAll { $0.id == attachment.id }
              }
            }
          }
        }
      }
      .padding(.horizontal, 2)
      .sheet(item: $expandedAttachment) { attachment in
        WorkChatInputAttachmentPreview(
          attachment: attachment,
          onRemove: {
            attachments.removeAll { $0.id == attachment.id }
            expandedAttachment = nil
          }
        )
      }
    }
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
      .accessibilityLabel("Remove image")
    }
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
  @Environment(\.displayScale) private var displayScale

  @State private var previewImage: UIImage?
  @State private var loadFailed = false

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
    HStack(spacing: 6) {
      Image(systemName: "paperclip")
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
    // Still uploading: the composer's downscaled image is already in memory, so
    // the echo's thumbnail resolves without a host round-trip.
    if workAttachmentIsPendingUpload(attachment) {
      previewImage = WorkPendingUploadPreviewStore.shared.image(forPath: attachment.path)
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

  func body(content: Content) -> some View {
    content
      .environment(\.workChatProvider, provider)
      .environment(\.workChatModelId, modelId)
      .environment(\.workChatModelLabel, modelLabel)
      .environment(\.workChatLaneId, laneId)
      .environment(\.workChatRequestedCwd, requestedCwd)
      .environment(\.workChatIsPersonal, isPersonalChat)
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

  static func image(fromDataUrl dataUrl: String, maxPixelSize: CGFloat) -> UIImage? {
    guard let commaIndex = dataUrl.firstIndex(of: ",") else { return nil }
    let base64 = String(dataUrl[dataUrl.index(after: commaIndex)...])
    guard let data = base64DecodedImageData(base64, maxBytes: workChatRemoteImageMaxBytes) else { return nil }
    return downsampledImage(data: data, maxPixelSize: maxPixelSize)
  }
}
