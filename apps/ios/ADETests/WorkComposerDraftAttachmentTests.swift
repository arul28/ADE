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
      [AgentChatFileRef(path: "/tmp/.ade/attachments/a.pdf", type: "File")],
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
      [AgentChatFileRef(path: "/tmp/.ade/attachments/b.mov", type: "File")],
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
    XCTAssertEqual(workChatAttachmentRefKind(AgentChatFileRef(path: "/x/a.mov", type: "File")), .video)
    XCTAssertEqual(workChatAttachmentRefKind(AgentChatFileRef(path: "/x/a.pdf", type: "File")), .file)
  }

  /// A ref-only attachment carries no bytes. `isReady` has to accept it or the
  /// send button would stay dead after a draft restore.
  func testRefBackedAttachmentIsSendable() {
    let attachment = WorkChatInputAttachment(
      filename: "spec.pdf",
      kind: .file,
      hostRef: AgentChatFileRef(path: "/x/spec.pdf", type: "File"),
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
}
