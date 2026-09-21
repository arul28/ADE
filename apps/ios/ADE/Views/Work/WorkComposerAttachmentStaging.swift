import AVFoundation
import CryptoKit
import Foundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// What a staged composer attachment *is*, which decides its chip, its preview,
/// and which host route stages it.
///
/// `image` keeps the historical base64 `chat.saveTempAttachment` route (the host
/// sniffs the bytes and re-encodes the name from them). `video` and `file` go
/// through the chunked route, which accepts any type at the product ceiling.
enum WorkChatInputAttachmentKind: String, Codable, Equatable {
  case image
  case video
  case file

  var glyph: String {
    switch self {
    case .image: return "photo"
    case .video: return "film"
    case .file: return "doc"
    }
  }
}

/// Product ceiling for a file-shaped attachment, mirroring
/// `MAX_CHAT_ATTACHMENT_BYTES` in apps/desktop/src/shared/chatAttachmentLimits.ts.
/// Change both together.
let workChatFileAttachmentMaxBytes = 50 * 1024 * 1024

func workChatFileAttachmentTooLargeMessage(_ name: String) -> String {
  "\"\(name)\" is larger than 50 MB. Attach a smaller file."
}

/// The host rejects a 0-byte upload at `finish` — it would reach the agent as a
/// path with nothing behind it. Saying so here costs no round trip.
func workChatFileAttachmentEmptyMessage(_ name: String) -> String {
  "\"\(name)\" is empty. Attach a file with content."
}

/// Whether a composer may offer the file/video routes at all.
///
/// The chunked route is five host actions (`chat.beginTempFileAttachment` and
/// friends) that only a brain built after this change advertises, and personal
/// chats refuse anything that is not an image regardless of host version. Both
/// facts are knowable before the picker opens, so the composer decides there —
/// letting the user pick a 40 MB video and only then failing the upload is the
/// outcome this exists to prevent.
enum WorkChatFileAttachmentAvailability: Equatable {
  /// The host advertises the chunked route and the chat accepts files.
  case available
  /// The connected computer predates the chunked route. Images still work.
  case unsupportedHost
  /// Personal chats are an images-only surface; no host version changes that.
  case imagesOnly

  var isAvailable: Bool { self == .available }

  /// Menu-level explanation, or nil when there is nothing to explain.
  ///
  /// `imagesOnly` returns nil on purpose: the file routes are hidden there, and
  /// a hint about an absent control is noise.
  var menuHint: String? {
    switch self {
    case .available, .imagesOnly: return nil
    case .unsupportedHost: return "Update ADE on your computer to attach files and videos."
    }
  }
}

/// Personal scope wins over host version: the images-only rule is the chat's,
/// so a fully up-to-date brain does not turn it off.
func workChatFileAttachmentAvailability(
  hostSupportsChunkedUpload: Bool,
  isPersonalChat: Bool
) -> WorkChatFileAttachmentAvailability {
  if isPersonalChat { return .imagesOnly }
  return hostSupportsChunkedUpload ? .available : .unsupportedHost
}

/// Best-effort kind for a UTI or a filename, used by both pickers.
func workChatInputAttachmentKind(forFilename filename: String, contentType: UTType?) -> WorkChatInputAttachmentKind {
  if let contentType {
    if contentType.conforms(to: .movie) || contentType.conforms(to: .video) { return .video }
    if contentType.conforms(to: .image) { return .image }
    return .file
  }
  return workChatInputAttachmentKind(forExtension: (filename as NSString).pathExtension)
}

/// One list per kind, so the picker and the already-staged-ref classifier cannot
/// disagree about whether `.webm` is a video.
private let workChatVideoExtensions: Set<String> = ["mov", "mp4", "m4v", "avi", "mkv", "webm"]
private let workChatImageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "heic", "webp", "bmp"]

private func workChatInputAttachmentKind(forExtension rawExtension: String) -> WorkChatInputAttachmentKind {
  let ext = rawExtension.lowercased()
  if workChatVideoExtensions.contains(ext) { return .video }
  if workChatImageExtensions.contains(ext) { return .image }
  return .file
}

/// Kind of an already-staged host ref, for chips in sent messages and previews.
func workChatAttachmentRefKind(_ ref: AgentChatFileRef) -> WorkChatInputAttachmentKind {
  if workChatAttachmentIsImage(ref) { return .image }
  let ext = (ref.path as NSString).pathExtension.lowercased()
  return workChatVideoExtensions.contains(ext) ? .video : .file
}

/// A stable, separator-free directory/file token for an arbitrary key.
///
/// `String.hashValue` is seeded per process (only `SWIFT_DETERMINISTIC_HASHING`
/// pins it), so a name derived from it resolves to a DIFFERENT directory after
/// every relaunch — which for a cache that exists precisely to survive a
/// relaunch means the bytes are never found and the old directory is never
/// purged. SHA-256 of the UTF-8 key is stable across launches and OS versions.
///
/// Not to be confused with `workStableDigest` (WorkMarkdownParsing.swift), the
/// other cross-launch-stable hash in this app. That one is FNV-1a and feeds
/// in-memory render caches, where the only requirements are "cheap enough to
/// run on every markdown block of every frame" and "stable within a build".
/// This one names things on DISK — directories and files that outlive the
/// process and are attacker-influenced (host-supplied paths and filenames) —
/// so it wants SHA-256's collision resistance and pays for it once per key.
func workStableFileToken(_ key: String) -> String {
  SHA256.hash(data: Data(key.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
}

/// The one signature that says "these attachments changed in a way worth
/// persisting": identity plus readiness, nothing about bytes.
func workChatAttachmentSignature(_ attachments: [WorkChatInputAttachment]) -> String {
  attachments.map { "\($0.id.uuidString):\($0.isReady ? 1 : 0)" }.joined(separator: ",")
}

// MARK: - Upload on attach

/// How long a send waits for an upload that started when the attachment was
/// staged, before it gives up and fails visibly.
///
/// Matches `SyncRequestTimeout.chatSendTimeoutNanoseconds`: the same budget the
/// message itself gets, which is long enough for a 50 MB video on a slow relay
/// leg and short enough that a wedged upload becomes an error the user can act
/// on instead of a permanent "Sending".
let workComposerAttachmentUploadTimeoutNanoseconds: UInt64 = SyncRequestTimeout.chatSendTimeoutNanoseconds

/// Plain-language failure for an upload that never landed. Deliberately the
/// same sentence the composer's retry row shows, so the banner and the chip
/// cannot say two different things about one message.
let workChatAttachmentUploadTimedOutMessage = "Couldn't send. Tap to retry."

func workChatAttachmentUploadTimedOutError(_ filename: String) -> NSError {
  NSError(
    domain: "ADE",
    code: 32,
    userInfo: [
      NSLocalizedDescriptionKey: workChatAttachmentUploadTimedOutMessage,
      "attachmentFilename": filename,
    ]
  )
}

/// What the staged-upload tracker knows about one attachment at send time.
enum WorkComposerAttachmentUploadResolution: Equatable {
  /// The host holds the bytes; send this ref.
  case ref(AgentChatFileRef)
  /// Nothing usable is tracked — no upload was started, or the one that ran
  /// failed. The caller stages the bytes itself.
  case stageInline
  /// A tracked upload passed its deadline. Retrying inline would queue a second
  /// copy behind the same wedged leg, so the send fails instead.
  case abandoned
}

/// Awaits `work`, giving up after `timeoutNanoseconds` and returning nil.
///
/// Deliberately not a task group: a group only returns once *every* child has
/// finished, so a child parked in a non-cancellable continuation makes the
/// deadline a lie. This abandons the wait without touching the work, which is
/// the semantics a send needs — the upload may still land and be reused, but
/// the user is not held behind it.
@MainActor
func workAwaitWithDeadline<T>(
  timeoutNanoseconds: UInt64,
  work: @escaping @MainActor () async -> T
) async -> T? {
  let box = WorkDeadlineBox<T>()
  return await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
    box.continuation = continuation
    box.timer = Task { @MainActor in
      try? await Task.sleep(nanoseconds: timeoutNanoseconds)
      guard !Task.isCancelled else { return }
      box.settle(nil)
    }
    Task { @MainActor in
      let value = await work()
      box.settle(value)
    }
  }
}

/// One-shot resume guard for `workAwaitWithDeadline`. Both racers call
/// `settle`; the first one wins and the continuation is dropped, so the loser
/// cannot resume it twice.
@MainActor
private final class WorkDeadlineBox<T> {
  var continuation: CheckedContinuation<T?, Never>?
  var timer: Task<Void, Never>?

  func settle(_ value: T?) {
    guard let continuation else { return }
    self.continuation = nil
    timer?.cancel()
    timer = nil
    continuation.resume(returning: value)
  }
}

/// Writes one composer's staged attachments under a draft key: host refs for
/// everything already uploaded, purgeable cached bytes for everything else.
///
/// Shared by the in-chat composer's autosave and by its send path, which has to
/// write the outgoing set BEFORE it clears the tray — a send that never
/// confirms must leave the user their attachments, not an empty composer.
@MainActor
func workChatPersistComposerAttachments(
  _ attachments: [WorkChatInputAttachment],
  for key: String
) {
  guard !key.isEmpty else { return }
  let uploads = WorkComposerAttachmentUploads.shared
  var refs: [AgentChatFileRef] = []
  var unsaved: [WorkChatInputAttachment] = []
  for attachment in attachments where attachment.isReady {
    if let ref = attachment.hostRef ?? uploads.ref(for: attachment.id) {
      refs.append(ref)
    } else {
      unsaved.append(attachment)
    }
  }
  let localFiles = WorkComposerDraftAttachmentCache.write(unsaved, for: key)
  WorkComposerDraftStore.saveAttachments(refs, owner: nil, localFiles: localFiles, for: key)
}

/// Tracks the host upload that starts the moment an attachment becomes `.ready`,
/// keyed by the attachment's id.
///
/// This is the seam that makes both halves of the composer contract work:
///
/// - **Leaving a chat keeps attachments.** A finished upload leaves an
///   `AgentChatFileRef`, which is a short string the draft store can persist —
///   exactly what desktop's `ComposerDraftStorageSnapshot` does. Bytes never go
///   into `UserDefaults`.
/// - **Send is never disabled by an upload.** Because the upload starts on
///   attach rather than on send, the send button stays live and the send simply
///   awaits the in-flight task. A `Task` handle survives the composer's `@State`
///   array being snapshotted and cleared by the send, which a per-element flag
///   would not.
///
/// Settled entries are trimmed to `maxEntries` oldest-first. Active entries may
/// temporarily take the map over that cap: cancelling one is not a reliable
/// host abort, and evicting it would let a restored draft duplicate its upload.
/// They become eligible for pruning as soon as their host task settles.
@MainActor
final class WorkComposerAttachmentUploads {
  static let shared = WorkComposerAttachmentUploads()

  private struct Entry {
    var task: Task<AgentChatFileRef, Error>
    var ref: AgentChatFileRef?
    var failure: String?
    var abandoned: Bool
    var settled: Bool
    var startedAt: Date
  }

  private static let maxEntries = 40

  private var entries: [UUID: Entry] = [:]
  private var order: [UUID] = []

  private init() {}

  /// Already-resolved ref for an attachment, if its upload finished. Used by the
  /// draft save path, which must never block.
  func ref(for id: UUID) -> AgentChatFileRef? {
    entries[id]?.ref
  }

  func failure(for id: UUID) -> String? {
    entries[id]?.failure
  }

  func isUploading(_ id: UUID) -> Bool {
    guard let entry = entries[id] else { return false }
    return !entry.settled
  }

  /// Ref for a restored attachment that was uploaded in a previous session, so
  /// a send after a restore does not re-upload the same bytes.
  func adopt(id: UUID, ref: AgentChatFileRef) {
    guard entries[id] == nil else { return }
    insert(
      id,
      Entry(task: Task { ref }, ref: ref, failure: nil, abandoned: false, settled: true, startedAt: Date())
    )
  }

  /// Starts the upload for one ready attachment. No-op when one is already
  /// tracked, so it is safe to call from an `onChange` that fires on every
  /// composer edit.
  func begin(
    _ attachment: WorkChatInputAttachment,
    syncService: SyncService,
    chatSessionId: String?,
    projectId: String?,
    projectRootPath: String?
  ) {
    begin(id: attachment.id, isReady: attachment.isReady) {
      // The RAW host call, never `workChatSaveInputAttachments`: that wrapper
      // asks this tracker to resolve the same id, so routing the upload through
      // it made this task await itself and hang forever.
      try await workChatStageAttachmentOnHost(
        attachment,
        syncService: syncService,
        chatSessionId: chatSessionId,
        targetProjectId: projectId,
        targetProjectRootPath: projectRootPath
      )
    }
  }

  /// Tracking half of `begin`, with the upload itself injected. The only seam a
  /// test can use to pin the "a stuck upload must not wedge a send" contract
  /// without a live host.
  func begin(
    id: UUID,
    isReady: Bool = true,
    upload: @escaping @MainActor () async throws -> AgentChatFileRef
  ) {
    guard entries[id] == nil, isReady else { return }
    let task = Task { @MainActor () throws -> AgentChatFileRef in
      try await upload()
    }
    insert(
      id,
      Entry(task: task, ref: nil, failure: nil, abandoned: false, settled: false, startedAt: Date())
    )
    Task { @MainActor in
      do {
        let ref = try await task.value
        entries[id]?.abandoned = false
        entries[id]?.settled = true
        entries[id]?.ref = ref
      } catch is CancellationError {
        entries[id] = nil
        order.removeAll { $0 == id }
      } catch {
        // A failed upload is not fatal: the send path retries inline, and the
        // draft falls back to the on-disk byte cache.
        entries[id]?.abandoned = false
        entries[id]?.settled = true
        entries[id]?.failure = error.localizedDescription
      }
    }
  }

  /// The ref for an attachment, waiting for an in-flight upload — for at most
  /// `timeoutNanoseconds`.
  ///
  /// The deadline is the reason this returns a case rather than an optional. A
  /// send awaits this before it can put anything on the wire, so an upload that
  /// never completes used to hold the message at "Sending" for the life of the
  /// process: no error, no retry, and the draft already cleared. Waiting is now
  /// always bounded, and "nothing is tracked" is told apart from "we gave up".
  func resolve(
    _ id: UUID,
    timeoutNanoseconds: UInt64 = workComposerAttachmentUploadTimeoutNanoseconds
  ) async -> WorkComposerAttachmentUploadResolution {
    guard let entry = entries[id] else { return .stageInline }
    if let ref = entry.ref { return .ref(ref) }
    if entry.abandoned {
      // The deadline already passed once for this upload, so this call is the
      // user's retry and the original leg is presumed dead. Cancel it, record
      // the failure, and let the send stage the bytes inline.
      //
      // The earlier rule — never a second upload while the first is in flight
      // — still holds for the whole timeout window: the first `resolve` waits
      // it out before anything is marked abandoned. What changed is what
      // happens after. A leg that never settles left every later retry
      // returning `.abandoned`, so the message could never be sent at all. A
      // duplicate host upload is a temp file the send references once; an
      // unsendable message is not recoverable.
      entry.task.cancel()
      entries[id]?.abandoned = false
      entries[id]?.settled = true
      entries[id]?.failure = workChatAttachmentUploadTimedOutMessage
      return .stageInline
    }
    if entry.failure != nil { return .stageInline }
    let task = entry.task
    let settled = await workAwaitWithDeadline(timeoutNanoseconds: timeoutNanoseconds) {
      try? await task.value
    }
    switch settled {
    case .some(.some(let ref)):
      return .ref(ref)
    case .some(.none):
      // The upload finished by failing. An inline retry is the cheap recovery
      // for a transient network error.
      return .stageInline
    case .none:
      entries[id]?.failure = workChatAttachmentUploadTimedOutMessage
      entries[id]?.abandoned = true
      return .abandoned
    }
  }

  func release(_ ids: [UUID]) {
    for id in ids {
      entries[id]?.task.cancel()
      entries[id] = nil
      order.removeAll { $0 == id }
    }
  }

  private func insert(_ id: UUID, _ entry: Entry) {
    entries[id] = entry
    order.append(id)
    while order.count > Self.maxEntries {
      guard let index = order.firstIndex(where: { entries[$0]?.settled == true }) else { break }
      let oldest = order.remove(at: index)
      entries[oldest]?.task.cancel()
      entries[oldest] = nil
    }
  }
}

// MARK: - Offline byte cache

/// Purgeable on-disk home for staged bytes whose host upload has not landed —
/// the phone is offline, or the host is unreachable.
///
/// `Caches` is the right durability tier for an unsent staged file: the OS may
/// reclaim it, which for a draft attachment is an acceptable loss and a far
/// better trade than putting megabytes in the App Group `UserDefaults` blob the
/// draft store rewrites whole on every keystroke.
enum WorkComposerDraftAttachmentCache {
  /// Matches the draft store's per-entry attachment cap.
  static let maxFilesPerKey = 5
  static let maxBytesPerKey = 10 * 1024 * 1024

  struct StoredFile: Codable, Equatable {
    /// The composer's identity, persisted so a navigation restore can reuse an
    /// upload that is still in flight. Optional for files written before this
    /// field existed; `read` gives those legacy records a fresh identity.
    var id: UUID?
    var name: String
    var filename: String
    var mimeType: String
    var kind: String

    init(
      id: UUID? = nil,
      name: String,
      filename: String,
      mimeType: String,
      kind: String
    ) {
      self.id = id
      self.name = name
      self.filename = filename
      self.mimeType = mimeType
      self.kind = kind
    }

    private enum CodingKeys: String, CodingKey {
      case id
      case name
      case filename
      case mimeType
      case kind
    }

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      id = try container.decodeIfPresent(UUID.self, forKey: .id)
      name = try container.decode(String.self, forKey: .name)
      filename = try container.decode(String.self, forKey: .filename)
      mimeType = try container.decode(String.self, forKey: .mimeType)
      kind = try container.decode(String.self, forKey: .kind)
    }
  }

  private static var root: URL? {
    guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
      return nil
    }
    return caches.appendingPathComponent("ade-composer-drafts", isDirectory: true)
  }

  /// Draft keys contain `:` (`chat:<id>`), which is legal on APFS but a
  /// path-shaped value from an id we did not mint. Digesting it keeps the
  /// directory name a fixed, separator-free token — and, unlike `hashValue`,
  /// the SAME token on the next launch, which is the only thing that makes this
  /// cache a cache rather than a leak.
  private static func directory(for draftKey: String) -> URL? {
    guard !draftKey.isEmpty, let root else { return nil }
    return root.appendingPathComponent(workStableFileToken(draftKey), isDirectory: true)
  }

  /// Drop directories no live draft key names any more.
  ///
  /// Every launch before the token became deterministic wrote under a different
  /// name, and `purge(key)` could only ever reach the current launch's. This is
  /// what reclaims those, plus any directory whose draft entry has since been
  /// evicted. Best-effort: a cache sweep must never fail a composer.
  static func purgeOrphans(liveKeys: [String]) {
    guard let root else { return }
    let live = Set(liveKeys.filter { !$0.isEmpty }.map { workStableFileToken($0) })
    guard let entries = try? FileManager.default.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: nil
    ) else { return }
    for entry in entries where !live.contains(entry.lastPathComponent) {
      try? FileManager.default.removeItem(at: entry)
    }
  }

  @discardableResult
  static func write(_ attachments: [WorkChatInputAttachment], for draftKey: String) -> [StoredFile] {
    guard let directory = directory(for: draftKey) else { return [] }
    purge(draftKey)
    var stored: [StoredFile] = []
    var totalBytes = 0
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    } catch {
      return []
    }
    for attachment in attachments.prefix(maxFilesPerKey) {
      guard let data = attachment.uploadData else { continue }
      // `continue`, not `break`: one oversized attachment must not also strand
      // every smaller one behind it. The bytes that do not fit are still lost
      // on leave — this tier is a best-effort cache the OS may reclaim — but
      // the ones that fit are kept.
      guard totalBytes + data.count <= maxBytesPerKey else { continue }
      let name = UUID().uuidString
      do {
        try data.write(to: directory.appendingPathComponent(name), options: .atomic)
      } catch {
        continue
      }
      totalBytes += data.count
      stored.append(StoredFile(
        id: attachment.id,
        name: name,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        kind: attachment.kind.rawValue
      ))
    }
    return stored
  }

  static func read(_ files: [StoredFile], for draftKey: String) -> [WorkChatInputAttachment] {
    guard let directory = directory(for: draftKey) else { return [] }
    return files.compactMap { file in
      guard let data = try? Data(contentsOf: directory.appendingPathComponent(file.name)),
            data.count <= maxBytesPerKey else { return nil }
      let kind = WorkChatInputAttachmentKind(rawValue: file.kind) ?? .file
      return WorkChatInputAttachment(
        id: file.id ?? UUID(),
        image: kind == .image ? UIImage(data: data) : nil,
        uploadData: data,
        filename: file.filename,
        mimeType: file.mimeType,
        kind: kind,
        state: .ready
      )
    }
  }

  /// Drops every cached byte for one draft key. Called on send, on an explicit
  /// clear, and whenever the draft store evicts the key.
  static func purge(_ draftKey: String) {
    guard let directory = directory(for: draftKey) else { return }
    try? FileManager.default.removeItem(at: directory)
  }
}

// MARK: - Document and video pickers

/// Which attachment picker a composer currently has open.
///
/// One mode, not three booleans. The three are mutually exclusive — a composer
/// cannot present a photo sheet, a document browser, and a video sheet at once
/// — and three sibling `Bool`s are that invariant with nothing enforcing it,
/// threaded through five files as six separate props.
enum WorkComposerPicker: Equatable {
  case photos
  case files
  case videos
}

extension Binding where Value == WorkComposerPicker? {
  /// The `isPresented` binding SwiftUI's sheet modifiers want, for one picker.
  ///
  /// Dismissal only clears the mode when this picker is still the open one, so
  /// a late `false` from a sheet that is already being replaced cannot close
  /// the picker that replaced it.
  func isPresenting(_ picker: WorkComposerPicker) -> Binding<Bool> {
    Binding<Bool>(
      get: { wrappedValue == picker },
      set: { isPresented in
        if isPresented {
          wrappedValue = picker
        } else if wrappedValue == picker {
          wrappedValue = nil
        }
      }
    )
  }
}

/// Adds "Attach file…" and "Attach video…" to a composer. The photo picker's
/// `.images` filter lives in `workChatAttachmentPicker`; these are the two
/// routes it cannot serve.
private struct WorkChatFileAttachmentPickerModifier: ViewModifier {
  @Binding var presentedPicker: WorkComposerPicker?
  @Binding var attachments: [WorkChatInputAttachment]
  let onDismiss: () -> Void

  @State private var videoItems: [PhotosPickerItem] = []

  private var remainingSlots: Int {
    max(1, workChatInputAttachmentLimit - attachments.count)
  }

  func body(content: Content) -> some View {
    content
      .fileImporter(
        isPresented: $presentedPicker.isPresenting(.files),
        allowedContentTypes: [.item, .data, .pdf, .movie, .audio, .plainText],
        allowsMultipleSelection: true
      ) { result in
        switch result {
        case .success(let urls):
          appendFiles(Array(urls.prefix(remainingSlots)))
        case .failure(let error):
          appendFailure("Could not read that file. \(error.localizedDescription)")
        }
        onDismiss()
      }
      .photosPicker(
        isPresented: $presentedPicker.isPresenting(.videos),
        selection: $videoItems,
        maxSelectionCount: remainingSlots,
        matching: .videos,
        preferredItemEncoding: .automatic
      )
      .onChange(of: videoItems) { _, newItems in
        guard !newItems.isEmpty else { return }
        videoItems = []
        Task { await appendVideos(newItems) }
      }
      .onChange(of: presentedPicker) { previous, current in
        if previous == .videos && current != .videos { onDismiss() }
      }
  }

  @MainActor
  private func appendFailure(_ message: String) {
    attachments.append(WorkChatInputAttachment(
      filename: "attachment-error",
      kind: .file,
      state: .failed(message)
    ))
  }

  @MainActor
  private func appendFiles(_ urls: [URL]) {
    for url in urls {
      let id = UUID()
      let name = url.lastPathComponent
      let scoped = url.startAccessingSecurityScopedResource()
      defer { if scoped { url.stopAccessingSecurityScopedResource() } }
      let contentType = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType)
      let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      guard size <= workChatFileAttachmentMaxBytes else {
        attachments.append(WorkChatInputAttachment(
          id: id,
          filename: name,
          kind: workChatInputAttachmentKind(forFilename: name, contentType: contentType),
          state: .failed(workChatFileAttachmentTooLargeMessage(name))
        ))
        continue
      }
      guard let data = try? Data(contentsOf: url, options: .mappedIfSafe),
            data.count <= workChatFileAttachmentMaxBytes else {
        attachments.append(WorkChatInputAttachment(
          id: id,
          filename: name,
          kind: .file,
          state: .failed("Could not read \"\(name)\".")
        ))
        continue
      }
      guard !data.isEmpty else {
        attachments.append(WorkChatInputAttachment(
          id: id,
          filename: name,
          kind: workChatInputAttachmentKind(forFilename: name, contentType: contentType),
          state: .failed(workChatFileAttachmentEmptyMessage(name))
        ))
        continue
      }
      let kind = workChatInputAttachmentKind(forFilename: name, contentType: contentType)
      if kind == .image, let image = UIImage(data: data),
         let prepared = workChatInputAttachment(from: image, filename: name, id: id) {
        attachments.append(prepared)
        continue
      }
      attachments.append(WorkChatInputAttachment(
        id: id,
        uploadData: Data(data),
        filename: name,
        mimeType: contentType?.preferredMIMEType ?? "application/octet-stream",
        kind: kind,
        state: .ready
      ))
    }
  }

  @MainActor
  private func appendVideos(_ items: [PhotosPickerItem]) async {
    for item in items {
      let id = UUID()
      // The picked asset is not always QuickTime — an MP4 or an HEVC-in-MP4
      // recording comes back as one. The host takes its extension and MIME from
      // what we send, so guessing `.mov`/`video/quicktime` for everything
      // stages an MP4 under a name that lies about its bytes. The item's own
      // content type is the answer; the QuickTime pair stays as the fallback
      // for an asset that reports no usable type at all.
      let contentType = item.supportedContentTypes.first { $0.preferredMIMEType != nil }
        ?? item.supportedContentTypes.first
      let fileExtension = contentType?.preferredFilenameExtension ?? "mov"
      let mimeType = contentType?.preferredMIMEType ?? "video/quicktime"
      let name = "video-\(id.uuidString.prefix(8)).\(fileExtension)"
      attachments.append(WorkChatInputAttachment(id: id, filename: name, kind: .video, state: .loading))
      do {
        guard let data = try await item.loadTransferable(type: Data.self) else {
          mark(id, failed: "This video could not be read.")
          continue
        }
        guard data.count <= workChatFileAttachmentMaxBytes else {
          mark(id, failed: workChatFileAttachmentTooLargeMessage(name))
          continue
        }
        guard !data.isEmpty else {
          mark(id, failed: workChatFileAttachmentEmptyMessage(name))
          continue
        }
        replace(id, with: WorkChatInputAttachment(
          id: id,
          uploadData: data,
          filename: name,
          mimeType: mimeType,
          kind: .video,
          state: .ready
        ))
      } catch is CancellationError {
        attachments.removeAll { $0.id == id }
      } catch {
        mark(id, failed: "Could not load this video. If it is in iCloud, check your connection and try again.")
      }
    }
  }

  @MainActor
  private func replace(_ id: UUID, with attachment: WorkChatInputAttachment) {
    guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
    attachments[index] = attachment
  }

  @MainActor
  private func mark(_ id: UUID, failed message: String) {
    guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
    attachments[index].state = .failed(message)
  }
}

extension View {
  func workChatFileAttachmentPickers(
    presentedPicker: Binding<WorkComposerPicker?>,
    attachments: Binding<[WorkChatInputAttachment]>,
    onDismiss: @escaping () -> Void
  ) -> some View {
    modifier(WorkChatFileAttachmentPickerModifier(
      presentedPicker: presentedPicker,
      attachments: attachments,
      onDismiss: onDismiss
    ))
  }
}

// MARK: - Draft persistence for the projectless composers

/// Keeps the Hub and New Chat composers' staged attachments across a teardown.
///
/// These two differ from the in-chat composer in one way that matters: their
/// destination project is not chosen until send, so there is no scope to upload
/// against on attach. They therefore persist *bytes* to the purgeable cache
/// rather than host refs, and keep their existing send-time upload. The draft
/// store entry is the same shape either way — `attachments` is simply empty.
private struct WorkPersistedDraftAttachmentsModifier: ViewModifier {
  @Binding var attachments: [WorkChatInputAttachment]
  let key: String

  @State private var restored = false

  private var signature: String { workChatAttachmentSignature(attachments) }

  func body(content: Content) -> some View {
    content
      .task {
        guard !restored, !key.isEmpty, attachments.isEmpty else { return }
        restored = true
        guard let entry = WorkComposerDraftStore.loadEntry(key), !entry.localFiles.isEmpty else { return }
        let recovered = WorkComposerDraftAttachmentCache.read(entry.localFiles, for: key)
        guard !recovered.isEmpty, attachments.isEmpty else { return }
        attachments = Array(recovered.prefix(workChatInputAttachmentLimit))
      }
      .task(id: signature) {
        // Match the text autosave debounce: staging three files in a row should
        // cost one cache rewrite, not three.
        try? await Task.sleep(for: workDraftAutosaveDebounce)
        guard !Task.isCancelled else { return }
        persist()
      }
      .onDisappear { persist() }
  }

  @MainActor
  private func persist() {
    guard !key.isEmpty else { return }
    let ready = attachments.filter(\.isReady)
    let files = WorkComposerDraftAttachmentCache.write(ready, for: key)
    WorkComposerDraftStore.saveAttachments([], owner: nil, localFiles: files, for: key)
  }
}

extension View {
  func workPersistedDraftAttachments(
    _ attachments: Binding<[WorkChatInputAttachment]>,
    key: String
  ) -> some View {
    modifier(WorkPersistedDraftAttachmentsModifier(attachments: attachments, key: key))
  }
}
