import SwiftUI
import ImageIO
import UIKit

private let workChatRemoteImageMaxBytes = 5 * 1024 * 1024
private let workChatRemoteImageTimeoutSeconds: TimeInterval = 12
private let workChatAttachmentPreviewMinimumPixels: CGFloat = 96

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
  @Environment(\.displayScale) private var displayScale

  @State private var previewImage: UIImage?
  @State private var loadFailed = false

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
      } else {
        VStack(spacing: 4) {
          Image(systemName: loadFailed ? "photo.badge.exclamationmark" : "photo")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(Color.white.opacity(0.82))
          Text(loadFailed ? "On desktop" : "Image")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(Color.white.opacity(0.72))
            .lineLimit(1)
        }
      }
    }
    .accessibilityLabel("Image attachment \(workChatAttachmentDisplayName(attachment))")
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

  func body(content: Content) -> some View {
    content
      .environment(\.workChatProvider, provider)
      .environment(\.workChatModelId, modelId)
      .environment(\.workChatModelLabel, modelLabel)
      .environment(\.workChatLaneId, laneId)
      .environment(\.workChatRequestedCwd, requestedCwd)
  }
}

private struct WorkChatLaneIdEnvironmentKey: EnvironmentKey {
  static let defaultValue: String? = nil
}

private struct WorkChatRequestedCwdEnvironmentKey: EnvironmentKey {
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
