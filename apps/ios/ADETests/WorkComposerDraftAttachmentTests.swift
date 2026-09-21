import XCTest
@testable import ADE

/// The composer draft store gained an attachment half (v2). These cover the
/// three rules that decide whether a user's staged files come back: the v1
/// text migration, ref persistence separate from text, and the clear symmetry
/// that must drop refs and cached bytes together.
final class WorkComposerDraftAttachmentTests: XCTestCase {
  private func key() -> String {
    WorkComposerDraftStore.chatKey(sessionId: "draft-attach-\(UUID().uuidString)")
  }

  /// v1 held `{text, updatedAt}` under `ade.work.composerDrafts.v1`. The lift to
  /// v2 must keep the text: an unsent prompt is the entire reason this store
  /// exists, and dropping it on upgrade would be the regression the store was
  /// built to fix.
  func testMigratesV1TextIntoV2() throws {
    let defaults = ADESharedContainer.defaults
    let v1Key = "ade.work.composerDrafts.v1"
    let v2Key = "ade.work.composerDrafts.v2"
    let previousV1 = defaults.data(forKey: v1Key)
    let previousV2 = defaults.data(forKey: v2Key)
    defer {
      defaults.removeObject(forKey: v1Key)
      if let previousV1 { defaults.set(previousV1, forKey: v1Key) }
      if let previousV2 {
        defaults.set(previousV2, forKey: v2Key)
      } else {
        defaults.removeObject(forKey: v2Key)
      }
    }

    let migrated = key()
    defaults.removeObject(forKey: v2Key)
    let legacy = [migrated: ["text": "half-written prompt", "updatedAt": 1_700_000_000.0] as [String: Any]]
    defaults.set(try JSONSerialization.data(withJSONObject: legacy), forKey: v1Key)

    XCTAssertEqual(WorkComposerDraftStore.load(migrated), "half-written prompt")
    // One-shot: the v1 blob is removed once lifted, so a later write cannot be
    // shadowed by a stale copy.
    XCTAssertNil(defaults.object(forKey: v1Key))
  }

  /// Attachments are persisted as refs on their own axis. Saving text must not
  /// wipe them, and an emptied text field must not evict an entry that still
  /// has files staged — deleting a sentence is not abandoning three uploads.
  func testAttachmentRefsSurviveTextEdits() {
    let draftKey = key()
    defer { WorkComposerDraftStore.clear(draftKey) }

    WorkComposerDraftStore.save("look at this", for: draftKey)
    WorkComposerDraftStore.saveAttachments(
      [AgentChatFileRef(path: "/tmp/.ade/attachments/a.pdf", type: "file")],
      owner: nil,
      localFiles: [],
      for: draftKey
    )

    XCTAssertEqual(WorkComposerDraftStore.loadEntry(draftKey)?.attachments.count, 1)

    WorkComposerDraftStore.save("look at this instead", for: draftKey)
    XCTAssertEqual(WorkComposerDraftStore.loadEntry(draftKey)?.attachments.first?.path, "/tmp/.ade/attachments/a.pdf")

    WorkComposerDraftStore.save("", for: draftKey)
    let afterClearedText = WorkComposerDraftStore.loadEntry(draftKey)
    XCTAssertEqual(afterClearedText?.text, "")
    XCTAssertEqual(afterClearedText?.attachments.count, 1)
  }

  /// Refs are capped at the same per-message limit the composer enforces, so a
  /// pathological draft cannot grow the one JSON blob every keystroke rewrites.
  func testAttachmentRefsAreCappedAtTheComposerLimit() {
    let draftKey = key()
    defer { WorkComposerDraftStore.clear(draftKey) }

    let refs = (0..<(workChatInputAttachmentLimit + 5)).map {
      AgentChatFileRef(path: "/tmp/.ade/attachments/\($0).png", type: "image")
    }
    WorkComposerDraftStore.saveAttachments(refs, owner: nil, localFiles: [], for: draftKey)
    XCTAssertEqual(WorkComposerDraftStore.loadEntry(draftKey)?.attachments.count, workChatInputAttachmentLimit)
  }

  /// Send and explicit-clear paths drop the whole entry. A surviving ref would
  /// re-stage an already-sent attachment into the next message.
  func testClearDropsTextAndRefsTogether() {
    let draftKey = key()
    WorkComposerDraftStore.save("about to send", for: draftKey)
    WorkComposerDraftStore.saveAttachments(
      [AgentChatFileRef(path: "/tmp/.ade/attachments/b.mov", type: "file")],
      owner: nil,
      localFiles: [],
      for: draftKey
    )

    WorkComposerDraftStore.clear(draftKey)

    XCTAssertNil(WorkComposerDraftStore.loadEntry(draftKey))
    XCTAssertEqual(WorkComposerDraftStore.load(draftKey), "")
  }

  /// Non-image refs restore as sendable, ref-backed chips with no local bytes —
  /// that is what lets a 40 MB video survive leaving a chat without the phone
  /// re-downloading or re-uploading it.
  func testRefKindClassification() {
    XCTAssertEqual(workChatAttachmentRefKind(AgentChatFileRef(path: "/x/a.png", type: "image")), .image)
    XCTAssertEqual(workChatAttachmentRefKind(AgentChatFileRef(path: "/x/a.mov", type: "file")), .video)
    XCTAssertEqual(workChatAttachmentRefKind(AgentChatFileRef(path: "/x/a.pdf", type: "file")), .file)
  }

  /// The host ref parser accepts only `image` and `file` and drops anything
  /// else without a word, so a draft written by a build that stored `File` must
  /// still send. Normalization happens on the way out, not at rest.
  func testOutboundRefTypeIsNormalizedForTheHostParser() {
    XCTAssertEqual(
      workChatNormalizedOutboundRef(AgentChatFileRef(path: "/x/a.pdf", type: "File")).type,
      "file"
    )
    XCTAssertEqual(
      workChatNormalizedOutboundRef(AgentChatFileRef(path: "/x/a.mov", type: "video")).type,
      "file"
    )
    XCTAssertEqual(
      workChatNormalizedOutboundRef(AgentChatFileRef(path: "/x/a.png", type: "image")).type,
      "image"
    )
    XCTAssertEqual(
      workChatNormalizedOutboundRef(AgentChatFileRef(path: "/x/a.png", type: "image-url")).type,
      "image"
    )
  }

  /// A ref-only attachment carries no bytes. `isReady` has to accept it or the
  /// send button would stay dead after a draft restore.
  func testRefBackedAttachmentIsSendable() {
    let attachment = WorkChatInputAttachment(
      filename: "spec.pdf",
      kind: .file,
      hostRef: AgentChatFileRef(path: "/x/spec.pdf", type: "file"),
      state: .ready
    )
    XCTAssertTrue(attachment.isReady)
    XCTAssertTrue(workChatInputCanSend(
      text: "",
      attachments: [attachment],
      baseEnabled: true,
      canUploadAttachments: true
    ))
  }

  /// The offline leg: bytes go to a purgeable cache directory keyed by the
  /// draft, and purging is what every clear site relies on.
  func testDraftAttachmentCacheRoundTripsAndPurges() {
    let draftKey = key()
    defer { WorkComposerDraftAttachmentCache.purge(draftKey) }

    let attachment = WorkChatInputAttachment(
      uploadData: Data("hello".utf8),
      filename: "note.txt",
      mimeType: "text/plain",
      kind: .file,
      state: .ready
    )
    let stored = WorkComposerDraftAttachmentCache.write([attachment], for: draftKey)
    XCTAssertEqual(stored.count, 1)

    let restored = WorkComposerDraftAttachmentCache.read(stored, for: draftKey)
    XCTAssertEqual(restored.first?.filename, "note.txt")
    XCTAssertEqual(restored.first?.uploadData, Data("hello".utf8))
    XCTAssertEqual(restored.first?.kind, .file)

    WorkComposerDraftAttachmentCache.purge(draftKey)
    XCTAssertTrue(WorkComposerDraftAttachmentCache.read(stored, for: draftKey).isEmpty)
  }

  /// A navigation teardown persists bytes while the host upload may still be
  /// running. Restoring the same attachment id lets the singleton tracker
  /// recognize that work instead of starting a duplicate upload. Old cache
  /// records without an id remain readable and receive a new identity.
  @MainActor
  func testCachedAttachmentKeepsUploadIdentityAcrossRestore() async throws {
    let previousDraftKey = key()
    let nextDraftKey = key()
    defer {
      WorkComposerDraftStore.clear(previousDraftKey)
      WorkComposerDraftStore.clear(nextDraftKey)
    }
    let id = UUID()
    let attachment = WorkChatInputAttachment(
      id: id,
      uploadData: Data("bytes".utf8),
      filename: "note.txt",
      mimeType: "text/plain",
      kind: .file,
      state: .ready
    )

    let uploads = WorkComposerAttachmentUploads.shared
    var uploadCount = 0
    var release: CheckedContinuation<Void, Never>?
    defer {
      release?.resume()
      uploads.release([id])
    }
    uploads.begin(id: id) {
      uploadCount += 1
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        release = continuation
      }
      return AgentChatFileRef(path: "/never", type: "file")
    }
    workChatPersistComposerAttachments([attachment], for: previousDraftKey)
    // Model the session view switching to another chat: the old composer is
    // torn down, but its host task is still active and the old draft remains.
    WorkComposerDraftStore.save("next chat", for: nextDraftKey)
    guard let entry = WorkComposerDraftStore.loadEntry(previousDraftKey),
          let stored = entry.localFiles.first else {
      return XCTFail("draft did not persist the in-flight attachment")
    }

    let resolution = await uploads.resolve(id, timeoutNanoseconds: 50_000_000)
    XCTAssertEqual(resolution, .abandoned)
    let restored = WorkComposerDraftAttachmentCache.read(entry.localFiles, for: previousDraftKey)
    XCTAssertEqual(restored.first?.id, id)

    let legacyData = try JSONSerialization.data(withJSONObject: [
      "name": stored.name,
      "filename": stored.filename,
      "mimeType": stored.mimeType,
      "kind": stored.kind,
    ])
    let legacy = try JSONDecoder().decode(
      WorkComposerDraftAttachmentCache.StoredFile.self,
      from: legacyData
    )
    XCTAssertNil(legacy.id)

    guard let restoredAttachment = restored.first else {
      return XCTFail("cache restore lost the attachment")
    }
    uploads.begin(id: restoredAttachment.id) {
      uploadCount += 1
      return AgentChatFileRef(path: "/duplicate", type: "file")
    }
    XCTAssertEqual(uploadCount, 1, "restoring an in-flight attachment must not duplicate its upload")
  }

  /// Tracker capacity may evict settled refs, but it must never cancel an
  /// upload whose host command can continue after the local Task is cancelled.
  /// Otherwise a later restore could begin a second upload for the same bytes.
  @MainActor
  func testActiveUploadSurvivesTrackerCapacityEviction() async {
    let firstID = UUID()
    let uploads = WorkComposerAttachmentUploads.shared
    var uploadCount = 0
    var release: CheckedContinuation<Void, Never>?
    var settledIDs: [UUID] = []
    defer {
      release?.resume()
      uploads.release([firstID] + settledIDs)
    }

    uploads.begin(id: firstID) {
      uploadCount += 1
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        release = continuation
      }
      return AgentChatFileRef(path: "/never", type: "file")
    }
    let firstResolution = await uploads.resolve(firstID, timeoutNanoseconds: 50_000_000)
    XCTAssertEqual(firstResolution, .abandoned)

    // Add forty settled entries after the pending upload. The bounded tracker
    // must evict those settled entries first and retain the active first one.
    for index in 0..<40 {
      let id = UUID()
      settledIDs.append(id)
      uploads.adopt(
        id: id,
        ref: AgentChatFileRef(path: "/settled-\(index)", type: "file")
      )
    }

    uploads.begin(id: firstID) {
      uploadCount += 1
      return AgentChatFileRef(path: "/duplicate", type: "file")
    }
    XCTAssertEqual(uploadCount, 1, "capacity eviction must not duplicate an active upload")
  }

  /// If every tracked upload is still active, the tracker intentionally grows
  /// past the settled-entry cap until host work settles. A pending upload must
  /// remain addressable rather than being cancelled and duplicated.
  @MainActor
  func testAllActiveUploadsRemainTrackedBeyondSettledCapacity() async {
    let uploads = WorkComposerAttachmentUploads.shared
    var activeIDs: [UUID] = []
    var continuations: [UUID: CheckedContinuation<Void, Never>] = [:]
    var startedCount = 0
    defer {
      for continuation in continuations.values {
        continuation.resume()
      }
      uploads.release(activeIDs)
    }

    for _ in 0...40 {
      let id = UUID()
      activeIDs.append(id)
      uploads.begin(id: id) {
        startedCount += 1
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
          continuations[id] = continuation
        }
        return AgentChatFileRef(path: "/never-\(id)", type: "file")
      }
    }
    for _ in 0..<100 where startedCount < activeIDs.count {
      await Task.yield()
    }
    XCTAssertEqual(startedCount, activeIDs.count)

    uploads.begin(id: activeIDs[0]) {
      startedCount += 1
      return AgentChatFileRef(path: "/duplicate", type: "file")
    }
    XCTAssertEqual(
      startedCount,
      activeIDs.count,
      "the oldest active upload must survive capacity pressure"
    )
  }

  /// The cache directory token has to be the SAME on the next launch.
  ///
  /// It used to be `String(format:)` over `draftKey.hashValue`, which Swift
  /// seeds per process: after a relaunch the key resolved to a different
  /// directory, so every restore came back empty AND `purge(key)` could only
  /// ever delete the current launch's copy. This asserts the property a
  /// single-process test otherwise cannot see — the token is a pure function of
  /// the key, with no per-run entropy.
  func testDirectoryTokenIsDeterministicForAKey() {
    let draftKey = "chat:8B2A5A0E-0000-4000-8000-000000000001"
    let token = workStableFileToken(draftKey)

    XCTAssertEqual(token, workStableFileToken(draftKey))
    // SHA-256 prefix: hex, fixed width, and separator-free so it is a legal
    // single path component for a key containing ":".
    XCTAssertEqual(token.count, 24)
    XCTAssertTrue(token.allSatisfy { $0.isHexDigit })
    XCTAssertNotEqual(token, workStableFileToken(draftKey + "x"))
    // A known digest prefix, so a future "optimisation" back to a seeded hash
    // fails here rather than silently in the field.
    XCTAssertEqual(workStableFileToken("chat:example"), "003d647841f8b540e95b998e")
  }

  /// Directories no live draft key names are reclaimed. That is the only route
  /// to the copies earlier builds wrote under per-process tokens, and to keys
  /// evicted from the store while the app was not running.
  func testOrphanSweepDropsUnreferencedCacheDirectories() {
    let liveKey = key()
    let deadKey = key()
    defer {
      WorkComposerDraftAttachmentCache.purge(liveKey)
      WorkComposerDraftAttachmentCache.purge(deadKey)
    }

    let attachment = WorkChatInputAttachment(
      uploadData: Data("bytes".utf8),
      filename: "note.txt",
      mimeType: "text/plain",
      kind: .file,
      state: .ready
    )
    let liveFiles = WorkComposerDraftAttachmentCache.write([attachment], for: liveKey)
    let deadFiles = WorkComposerDraftAttachmentCache.write([attachment], for: deadKey)
    XCTAssertFalse(WorkComposerDraftAttachmentCache.read(liveFiles, for: liveKey).isEmpty)
    XCTAssertFalse(WorkComposerDraftAttachmentCache.read(deadFiles, for: deadKey).isEmpty)

    WorkComposerDraftAttachmentCache.purgeOrphans(liveKeys: [liveKey])

    XCTAssertFalse(WorkComposerDraftAttachmentCache.read(liveFiles, for: liveKey).isEmpty)
    XCTAssertTrue(WorkComposerDraftAttachmentCache.read(deadFiles, for: deadKey).isEmpty)
  }

  /// A 0-byte file is rejected before the upload, with the same reason the host
  /// gives at `finish`.
  func testEmptyAttachmentMessageNamesTheFile() {
    XCTAssertEqual(
      workChatFileAttachmentEmptyMessage("notes.txt"),
      "\"notes.txt\" is empty. Attach a file with content."
    )
  }

  // MARK: - Staged uploads and unconfirmed sends

  /// The regression this file exists for as of 2026-09-19: a message with an
  /// image sat at "Sending" forever.
  ///
  /// The send awaits the upload that started when the attachment was staged. As
  /// long as that wait was unbounded, an upload that never completed — and the
  /// image path deadlocked on itself, so it never did — held the message with
  /// no error, no retry, and the draft already cleared. The wait is now bounded
  /// and reports that it gave up.
  @MainActor
  func testAStuckStagedUploadIsAbandonedInsteadOfHangingTheSend() async {
    let id = UUID()
    let uploads = WorkComposerAttachmentUploads.shared
    var release: CheckedContinuation<Void, Never>?
    defer {
      release?.resume()
      uploads.release([id])
    }

    uploads.begin(id: id) {
      // Never lands: the wedged leg this bug was made of.
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        release = continuation
      }
      return AgentChatFileRef(path: "/never", type: "image")
    }

    let resolution = await uploads.resolve(id, timeoutNanoseconds: 50_000_000)
    XCTAssertEqual(resolution, .abandoned)
    // The original task is still running, so a retry must not fall through to
    // a second inline upload for the same attachment.
    let retryResolution = await uploads.resolve(id, timeoutNanoseconds: 50_000_000)
    XCTAssertEqual(retryResolution, .abandoned)
  }

  @MainActor
  func testTimedOutUploadBecomesInlineRetryableAfterTheOriginalFails() async {
    let id = UUID()
    let uploads = WorkComposerAttachmentUploads.shared
    defer { uploads.release([id]) }
    var release: CheckedContinuation<Void, Never>?

    uploads.begin(id: id) {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        release = continuation
      }
      throw NSError(domain: "ADE", code: 1, userInfo: [NSLocalizedDescriptionKey: "no route"])
    }
    for _ in 0..<20 where release == nil {
      await Task.yield()
    }
    XCTAssertNotNil(release)

    let firstResolution = await uploads.resolve(id, timeoutNanoseconds: 50_000_000)
    XCTAssertEqual(firstResolution, .abandoned)
    let retryWhilePending = await uploads.resolve(id, timeoutNanoseconds: 50_000_000)
    XCTAssertEqual(
      retryWhilePending,
      .abandoned,
      "an upload that is still in flight must not start a duplicate"
    )

    release?.resume()
    for _ in 0..<20 where uploads.failure(for: id) != "no route" {
      await Task.yield()
    }
    XCTAssertEqual(uploads.failure(for: id), "no route")
    let retryAfterFailure = await uploads.resolve(id, timeoutNanoseconds: 50_000_000)
    XCTAssertEqual(
      retryAfterFailure,
      .stageInline,
      "once the original upload fails, retry may stage the cached bytes inline"
    )
  }

  /// The ordinary path: a send that arrives while the upload is still moving
  /// waits for it and sends the host's ref rather than re-uploading the bytes.
  @MainActor
  func testResolveReturnsTheStagedRefWhenTheUploadLands() async {
    let id = UUID()
    let uploads = WorkComposerAttachmentUploads.shared
    defer { uploads.release([id]) }

    uploads.begin(id: id) {
      await Task.yield()
      return AgentChatFileRef(path: "/tmp/.ade/attachments/staged.jpg", type: "image")
    }

    let resolution = await uploads.resolve(id, timeoutNanoseconds: 5_000_000_000)
    XCTAssertEqual(resolution, .ref(AgentChatFileRef(path: "/tmp/.ade/attachments/staged.jpg", type: "image")))
  }

  /// Two different "no ref" answers. An untracked attachment and one whose
  /// upload failed both fall through to an inline upload — only a wait that ran
  /// out of time fails the send, because a second copy would queue behind the
  /// same stuck leg.
  @MainActor
  func testUntrackedAndFailedUploadsStageInline() async {
    let uploads = WorkComposerAttachmentUploads.shared
    let untracked = UUID()
    let untrackedResolution = await uploads.resolve(untracked, timeoutNanoseconds: 50_000_000)
    XCTAssertEqual(untrackedResolution, .stageInline)

    let failing = UUID()
    defer { uploads.release([failing]) }
    uploads.begin(id: failing) {
      throw NSError(domain: "ADE", code: 1, userInfo: [NSLocalizedDescriptionKey: "no route"])
    }
    let failedResolution = await uploads.resolve(failing, timeoutNanoseconds: 5_000_000_000)
    XCTAssertEqual(failedResolution, .stageInline)
  }

  /// A send owns the stored draft until the host confirms it. Tapping send used
  /// to clear the draft immediately, so leaving the chat while it said
  /// "Sending" destroyed the message.
  @MainActor
  func testUnconfirmedSendKeepsTheDraftAndAConfirmedOneDropsIt() {
    let draftKey = key()
    defer { WorkComposerDraftStore.clear(draftKey) }

    let draft = WorkChatComposerDraftState()
    draft.bind(persistenceKey: draftKey)
    draft.text = "look at this screenshot"

    let firstSend = draft.beginPendingSend()
    XCTAssertEqual(firstSend.text, "look at this screenshot")
    XCTAssertEqual(draft.text, "")
    // Still in flight: the stored copy is the only surviving one, so leaving the
    // chat now must find it.
    XCTAssertEqual(WorkComposerDraftStore.load(draftKey), "look at this screenshot")
    XCTAssertTrue(draft.isSendInFlight(for: draftKey))

    // A teardown flush while the send is unconfirmed must not write the emptied
    // field over it.
    draft.flushDraft()
    XCTAssertEqual(WorkComposerDraftStore.load(draftKey), "look at this screenshot")

    draft.finishPendingSend(firstSend, sent: false)
    XCTAssertFalse(draft.isSendInFlight(for: draftKey))
    XCTAssertEqual(WorkComposerDraftStore.load(draftKey), "look at this screenshot")

    draft.text = "look at this screenshot"
    let retry = draft.beginPendingSend()
    draft.finishPendingSend(retry, sent: true)
    XCTAssertEqual(WorkComposerDraftStore.load(draftKey), "", "a confirmed send consumes the draft")
  }

  /// The in-flight message owns the stored draft, but only its own key and
  /// only until it settles — text typed behind it is written the moment the
  /// send confirms, instead of being dropped with it.
  @MainActor
  func testTextTypedDuringAnUnconfirmedSendIsStoredOnceItConfirms() {
    let draftKey = key()
    defer { WorkComposerDraftStore.clear(draftKey) }

    let draft = WorkChatComposerDraftState()
    draft.bind(persistenceKey: draftKey)
    draft.text = "first message"
    let firstSend = draft.beginPendingSend()

    draft.text = "second message"
    draft.flushDraft()
    XCTAssertEqual(
      WorkComposerDraftStore.load(draftKey),
      "first message",
      "the unconfirmed send owns the stored draft"
    )

    draft.finishPendingSend(firstSend, sent: true)
    XCTAssertEqual(WorkComposerDraftStore.load(draftKey), "second message")
  }

  /// The attachment half of the same rule: the outgoing files are written under
  /// the chat's draft key before the tray is emptied, so an unconfirmed send
  /// leaves both the text and the image recoverable.
  @MainActor
  func testOutgoingAttachmentsArePersistedForAnUnconfirmedSend() {
    let draftKey = key()
    defer { WorkComposerDraftStore.clear(draftKey) }

    let staged = WorkChatInputAttachment(
      uploadData: Data("jpeg-bytes".utf8),
      filename: "screenshot.jpg",
      mimeType: "image/jpeg",
      kind: .image,
      state: .ready
    )
    let alreadyUploaded = WorkChatInputAttachment(
      filename: "clip.mov",
      kind: .video,
      hostRef: AgentChatFileRef(path: "/tmp/.ade/attachments/clip.mov", type: "file"),
      state: .ready
    )

    workChatPersistComposerAttachments([staged, alreadyUploaded], for: draftKey)

    let entry = WorkComposerDraftStore.loadEntry(draftKey)
    XCTAssertEqual(entry?.attachments.first?.path, "/tmp/.ade/attachments/clip.mov")
    XCTAssertEqual(entry?.localFiles.first?.filename, "screenshot.jpg")
    XCTAssertEqual(
      WorkComposerDraftAttachmentCache.read(entry?.localFiles ?? [], for: draftKey).first?.uploadData,
      Data("jpeg-bytes".utf8)
    )
  }

  /// Queued steering lets a second message leave the composer while the first
  /// is still unconfirmed. Both sends used to share one marker, so the first
  /// completion cleared the second one's stored text and attachments and a
  /// later failure had nothing to restore.
  @MainActor
  func testAnOlderSendConfirmingDoesNotClearANewerPendingSendsDraft() {
    let draftKey = key()
    defer { WorkComposerDraftStore.clear(draftKey) }

    let draft = WorkChatComposerDraftState()
    draft.bind(persistenceKey: draftKey)

    draft.text = "first"
    let sendA = draft.beginPendingSend()
    XCTAssertEqual(sendA.text, "first")

    draft.text = "second"
    let sendB = draft.beginPendingSend()
    XCTAssertEqual(sendB.text, "second")
    XCTAssertNotEqual(sendA.token, sendB.token, "each pending send owns its own token")

    let queued = WorkChatInputAttachment(
      uploadData: Data("png-bytes".utf8),
      filename: "second.png",
      mimeType: "image/png",
      kind: .image,
      state: .ready
    )
    workChatPersistComposerAttachments([queued], for: draftKey)
    XCTAssertEqual(WorkComposerDraftStore.load(draftKey), "second")

    // A completes. It no longer owns the stored draft, so it must leave B's
    // text and attachments alone.
    draft.finishPendingSend(sendA, sent: true)
    XCTAssertEqual(WorkComposerDraftStore.load(draftKey), "second")
    XCTAssertEqual(
      WorkComposerDraftStore.loadEntry(draftKey)?.localFiles.first?.filename,
      "second.png"
    )
    XCTAssertTrue(draft.isSendInFlight(for: draftKey), "B is still unconfirmed")

    // B fails: both halves are still there to restore.
    draft.finishPendingSend(sendB, sent: false)
    XCTAssertFalse(draft.isSendInFlight(for: draftKey))
    XCTAssertEqual(WorkComposerDraftStore.load(draftKey), "second")
    let entry = WorkComposerDraftStore.loadEntry(draftKey)
    XCTAssertEqual(entry?.localFiles.first?.filename, "second.png")
    XCTAssertEqual(
      WorkComposerDraftAttachmentCache.read(entry?.localFiles ?? [], for: draftKey).first?.uploadData,
      Data("png-bytes".utf8)
    )
  }

  /// The mirror case: the newest send is the one that owns the store, so when
  /// it confirms the draft is consumed even though an older send is still out.
  @MainActor
  func testTheNewestPendingSendOwnsTheStoredDraft() {
    let draftKey = key()
    defer { WorkComposerDraftStore.clear(draftKey) }

    let draft = WorkChatComposerDraftState()
    draft.bind(persistenceKey: draftKey)

    draft.text = "first"
    let sendA = draft.beginPendingSend()
    draft.text = "second"
    let sendB = draft.beginPendingSend()

    draft.finishPendingSend(sendB, sent: true)
    XCTAssertEqual(WorkComposerDraftStore.load(draftKey), "", "the owning send consumed the draft")
    XCTAssertTrue(draft.isSendInFlight(for: draftKey), "A has still not settled")

    draft.finishPendingSend(sendA, sent: true)
    XCTAssertFalse(draft.isSendInFlight(for: draftKey))
  }

  /// The copy the retry row shows. Short, plain, and one sentence — it is also
  /// the message the abandoned-upload error carries, so the row and the error
  /// cannot disagree.
  func testSendFailureCopyIsPlain() {
    XCTAssertEqual(workChatAttachmentUploadTimedOutMessage, "Couldn't send. Tap to retry.")
    XCTAssertEqual(
      workChatAttachmentUploadTimedOutError("screenshot.jpg").localizedDescription,
      "Couldn't send. Tap to retry."
    )
  }

  // MARK: - Preview temp files

  /// The other end of the same staging story: a PDF or video preview is
  /// materialized to `tmp` and must live exactly as long as a sheet is on
  /// screen.
  ///
  /// SwiftUI is free to repeat `onAppear`/`onDisappear` for one sheet, so the
  /// bookkeeping is a `Set` of sheet tokens rather than a counter. A counter
  /// drifts on the repeat and either drops the file under a live
  /// `QLPreviewController`/`AVPlayer` or leaks the whole directory forever;
  /// this pins the set's idempotence in both directions.
  @MainActor
  func testPreviewFilesSurviveRepeatedSheetCallbacksAndDropWithTheLastSheet() throws {
    WorkChatAttachmentPreviewFiles.sweepAtLaunch()
    let first = UUID()
    let second = UUID()
    defer { WorkChatAttachmentPreviewFiles.sweepAtLaunch() }

    WorkChatAttachmentPreviewFiles.beginPresenting(token: first)
    WorkChatAttachmentPreviewFiles.beginPresenting(token: first)
    WorkChatAttachmentPreviewFiles.beginPresenting(token: second)

    let url = WorkChatAttachmentPreviewFiles.url(forName: "probe.pdf")
    try Data("%PDF-1.7".utf8).write(to: url, options: .atomic)
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "setup precondition")

    WorkChatAttachmentPreviewFiles.endPresenting(token: first)
    WorkChatAttachmentPreviewFiles.endPresenting(token: first)
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: url.path),
      "a second sheet is still presented; its file must not be reclaimed"
    )

    WorkChatAttachmentPreviewFiles.endPresenting(token: second)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: url.path),
      "the last sheet tore down, so the previewed copies are reclaimed"
    )
  }

  /// The preview temp name is derived from the host's basename plus a stable
  /// token, so it must be a single legal path component AND identical on the
  /// next launch — that determinism is what makes re-opening a 40 MB video free
  /// instead of a second download.
  func testPreviewTempNameIsASinglePathComponentAndStableAcrossLaunches() {
    let hostPath = "/Users/someone/proj/.ade/attachments/8b2a5a0e.pdf"
    let name = WorkChatAttachmentPreviewFiles.safeName(
      for: "../../evil/report.pdf",
      discriminator: workStableFileToken(hostPath)
    )

    XCTAssertFalse(name.contains("/"))
    XCTAssertFalse(name.contains(".."))
    XCTAssertTrue(name.hasSuffix(".pdf"))
    XCTAssertEqual(
      name,
      WorkChatAttachmentPreviewFiles.safeName(
        for: "../../evil/report.pdf",
        discriminator: workStableFileToken(hostPath)
      )
    )
    // A different host path never collides onto the same cached copy.
    XCTAssertNotEqual(
      name,
      WorkChatAttachmentPreviewFiles.safeName(
        for: "../../evil/report.pdf",
        discriminator: workStableFileToken(hostPath + "x")
      )
    )
  }

  /// Launch is the only moment that can reclaim what a killed process left in
  /// `tmp` — including a `.part` from an interrupted download, which no live
  /// token names.
  @MainActor
  func testLaunchSweepDropsWhatAPreviousProcessLeftBehind() throws {
    let leftover = WorkChatAttachmentPreviewFiles.url(forName: "orphan.mp4.abc.part")
    try Data("partial".utf8).write(to: leftover, options: .atomic)
    XCTAssertTrue(FileManager.default.fileExists(atPath: leftover.path), "setup precondition")

    WorkChatAttachmentPreviewFiles.sweepAtLaunch()

    XCTAssertFalse(FileManager.default.fileExists(atPath: leftover.path))
  }
}
