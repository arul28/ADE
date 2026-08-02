package com.ade.android

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json

/**
 * Parser tests against realistic host payloads.
 *
 * Fixtures are trimmed but field-for-field faithful to:
 *   - `work.listSessions` -> `TerminalSessionSummary[]`
 *     (apps/desktop/src/shared/types/sessions.ts:160-273; the row builder in
 *     sessionService.mapRow emits every column, using explicit nulls)
 *   - `lanes.refreshSnapshots` with `includeStatus: true` ->
 *     `{ refreshedCount, lanes, snapshots, signature, notModified }` where each
 *     snapshot is a `LaneListSnapshot` (apps/desktop/src/shared/types/lanes.ts:222-230)
 */
class WirePayloadParsingTest {
    private val json = Json { ignoreUnknownKeys = true }

    private val sessionsPayload = """
        [
          {
            "id": "sess-1",
            "laneId": "lane-1",
            "laneName": "android-companion",
            "ptyId": null,
            "tracked": true,
            "pinned": true,
            "goal": "Rewire the Work tab",
            "toolType": "codex-chat",
            "title": "Work tab rewire",
            "status": "running",
            "startedAt": "2026-08-01T10:00:00.000Z",
            "endedAt": null,
            "archivedAt": null,
            "exitCode": null,
            "transcriptPath": "/tmp/t.jsonl",
            "headShaStart": null,
            "headShaEnd": null,
            "lastOutputPreview": "Applying the parser patch",
            "lastActivityAt": "2026-08-01T10:42:00.000Z",
            "currentTurnStartedAt": "2026-08-01T10:41:00.000Z",
            "summary": "Enriching the parsed models",
            "runtimeState": "waiting-input",
            "pendingInputItemId": "item-9",
            "settledAt": null,
            "statusNote": "Waiting on approval",
            "attentionRequestedAt": "2026-08-01T10:42:00.000Z",
            "attentionMessage": "Approve the write to MainViewModel.kt?",
            "attentionSource": "agent_explicit",
            "lastTurnFailedAt": null,
            "resumeCommand": null,
            "provider": "codex"
          },
          {
            "id": "sess-2",
            "laneId": "lane-2",
            "laneName": "main",
            "tracked": true,
            "pinned": false,
            "goal": null,
            "toolType": "shell",
            "title": "gradlew test",
            "status": "completed",
            "startedAt": "2026-07-31T09:00:00.000Z",
            "endedAt": "2026-07-31T09:12:00.000Z",
            "archivedAt": "2026-07-31T10:00:00.000Z",
            "exitCode": 1,
            "transcriptPath": "/tmp/u.jsonl",
            "lastOutputPreview": null,
            "lastActivityAt": "2026-07-31T09:12:00.000Z",
            "summary": null,
            "runtimeState": "exited",
            "settledAt": "2026-07-31T09:12:30.000Z",
            "statusNote": "Tests failed",
            "attentionMessage": null,
            "lastTurnFailedAt": "2026-07-31T09:12:00.000Z"
          }
        ]
    """.trimIndent()

    private val lanesPayload = """
        {
          "refreshedCount": 2,
          "lanes": [],
          "signature": "abc",
          "notModified": false,
          "snapshots": [
            {
              "lane": {
                "id": "lane-1",
                "name": "android-companion",
                "description": "Native Android client",
                "laneType": "worktree",
                "baseRef": "refs/heads/main",
                "branchRef": "refs/heads/ade/android",
                "worktreePath": "/w/android",
                "parentLaneId": "lane-2",
                "childCount": 3,
                "stackDepth": 1,
                "parentStatus": null,
                "isEditProtected": false,
                "status": {
                  "dirty": true,
                  "ahead": 4,
                  "behind": 2,
                  "remoteBehind": -1,
                  "rebaseInProgress": false,
                  "headBranchRef": "refs/heads/ade/android"
                },
                "color": "#34d399",
                "icon": null,
                "tags": [],
                "createdAt": "2026-07-20T00:00:00.000Z",
                "archivedAt": null,
                "devicesOpen": [
                  { "deviceId": "d1", "displayName": "Pixel", "platform": "android" },
                  { "deviceId": "d2", "displayName": "Mac", "platform": "macos" }
                ],
                "linearIssue": { "id": "li-1", "identifier": "ADE-412", "title": "Android work tab" }
              },
              "runtime": {
                "bucket": "awaiting-input",
                "runningCount": 2,
                "awaitingInputCount": 1,
                "endedCount": 4,
                "sessionCount": 7
              },
              "rebaseSuggestion": null,
              "autoRebaseStatus": null,
              "conflictStatus": null,
              "stateSnapshot": null,
              "adoptableAttached": false
            },
            {
              "lane": {
                "id": "lane-2",
                "name": "main",
                "laneType": "primary",
                "baseRef": "refs/heads/main",
                "branchRef": "refs/heads/main",
                "worktreePath": "/w",
                "parentLaneId": null,
                "childCount": 0,
                "stackDepth": 0,
                "parentStatus": null,
                "isEditProtected": true,
                "status": {
                  "dirty": false,
                  "ahead": 0,
                  "behind": 0,
                  "remoteBehind": 0,
                  "rebaseInProgress": false
                },
                "color": null,
                "icon": null,
                "tags": [],
                "createdAt": "2026-01-01T00:00:00.000Z",
                "archivedAt": "2026-07-30T00:00:00.000Z"
              },
              "runtime": {
                "bucket": "none",
                "runningCount": 0,
                "awaitingInputCount": 0,
                "endedCount": 0,
                "sessionCount": 0
              },
              "rebaseSuggestion": null,
              "autoRebaseStatus": null,
              "conflictStatus": null,
              "stateSnapshot": null,
              "adoptableAttached": false
            }
          ]
        }
    """.trimIndent()

    @Test
    fun `listSessions keeps the dense fields the Work tab needs`() {
        val sessions = parseSessions(json.parseToJsonElement(sessionsPayload))
        assertEquals(2, sessions.size)

        val first = sessions[0]
        assertEquals("sess-1", first.id)
        assertEquals("lane-1", first.laneId)
        assertEquals("android-companion", first.laneName)
        assertEquals("Work tab rewire", first.title)
        assertEquals("waiting-input", first.runtimeState)
        assertEquals("running", first.status)
        assertEquals("2026-08-01T10:42:00.000Z", first.lastActivityAt)
        assertEquals("2026-08-01T10:00:00.000Z", first.startedAt)
        assertEquals("2026-08-01T10:41:00.000Z", first.currentTurnStartedAt)
        assertEquals("Waiting on approval", first.statusNote)
        assertEquals("Approve the write to MainViewModel.kt?", first.attentionMessage)
        assertEquals("2026-08-01T10:42:00.000Z", first.attentionRequestedAt)
        assertEquals("Enriching the parsed models", first.summary)
        assertEquals("Rewire the Work tab", first.goal)
        assertEquals("Applying the parser patch", first.preview)
        assertEquals("item-9", first.pendingInputItemId)
        assertTrue(first.pinned)
        assertFalse(first.archived)
        assertNull(first.settledAt)
        assertNull(first.exitCode)
        assertEquals(SessionKind.CHAT, first.kind)

        val second = sessions[1]
        assertFalse(second.pinned)
        // `archived` is derived from the wire's `archivedAt`; there is no boolean.
        assertTrue(second.archived)
        assertEquals("2026-07-31T09:12:30.000Z", second.settledAt)
        assertEquals("2026-07-31T09:12:00.000Z", second.lastTurnFailedAt)
        assertEquals(1, second.exitCode)
        assertNull(second.summary)
        assertNull(second.goal)
        assertEquals(SessionKind.TERMINAL, second.kind)
    }

    @Test
    fun `refreshSnapshots keeps colour, git status, children, Linear and devices`() {
        val lanes = parseLanes(json.parseToJsonElement(lanesPayload))
        assertEquals(2, lanes.size)

        val worktree = lanes[0]
        assertEquals("lane-1", worktree.id)
        assertEquals("android-companion", worktree.name)
        assertEquals("Native Android client", worktree.description)
        assertEquals("refs/heads/ade/android", worktree.branch)
        assertEquals("#34d399", worktree.color)
        assertTrue(worktree.dirty)
        assertEquals(4, worktree.ahead)
        assertEquals(2, worktree.behind)
        assertEquals(-1, worktree.remoteBehind)
        assertFalse(worktree.rebaseInProgress)
        assertTrue(worktree.hasStatus)
        assertEquals(3, worktree.childCount)
        assertEquals(1, worktree.stackDepth)
        assertEquals("lane-2", worktree.parentLaneId)
        assertEquals("ADE-412", worktree.linearIdentifier)
        assertEquals(2, worktree.devicesOpen)
        assertEquals("awaiting-input", worktree.state)
        assertEquals(2, worktree.running)
        assertEquals(1, worktree.awaiting)
        assertFalse(worktree.archived)

        val primary = lanes[1]
        assertEquals("primary", primary.laneType)
        assertNull(primary.color)
        assertNull(primary.linearIdentifier)
        assertFalse(primary.dirty)
        assertEquals(0, primary.devicesOpen)
        assertTrue(primary.archived)
    }

    @Test
    fun `a snapshot without a status block leaves the git chips empty`() {
        val payload = """
            { "snapshots": [ { "lane": { "id": "l", "name": "l", "childCount": 0 }, "runtime": null } ] }
        """.trimIndent()
        val lane = parseLanes(json.parseToJsonElement(payload)).single()
        assertFalse(lane.hasStatus)
        assertEquals(0, lane.ahead)
        assertEquals(0, lane.behind)
        assertFalse(lane.dirty)
    }

    @Test
    fun `a bare lanes array is still accepted`() {
        val payload = """
            [ { "id": "l1", "name": "main", "laneType": "primary", "status": { "dirty": true, "ahead": 1, "behind": 0 } } ]
        """.trimIndent()
        val lane = parseLanes(json.parseToJsonElement(payload)).single()
        assertTrue(lane.dirty)
        assertEquals(1, lane.ahead)
    }
}
