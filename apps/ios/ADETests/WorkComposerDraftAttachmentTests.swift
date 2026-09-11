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
