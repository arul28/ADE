package com.ade.android.ui

import com.ade.android.SessionKind
import com.ade.android.UiSession
import com.ade.android.UiLane
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val ACCENT = 0xFFA78BFAL
private val NOW = Instant.parse("2026-08-01T12:00:00Z").toEpochMilli()

private fun agoIso(seconds: Long) = Instant.ofEpochMilli(NOW - seconds * 1000).toString()

class WorkPresentationTest {
    // -- provider derivation ------------------------------------------------

    /**
     * `work.listSessions` returns `TerminalSessionSummary`, which has no
     * `provider` column at all (see terminal_sessions DDL in kvDb.ts) -- only
     * `toolType`. Without this derivation every real session card falls back to
     * the generic tile and the accent tint.
     */
    @Test
    fun `provider is derived from toolType for every tracked CLI variant`() {
        assertEquals("codex", providerFromToolType("codex"))
        assertEquals("codex", providerFromToolType("codex-chat"))
        assertEquals("codex", providerFromToolType("codex-orchestrated"))
        assertEquals("claude", providerFromToolType("claude"))
        assertEquals("claude", providerFromToolType("claude-chat"))
        assertEquals("claude", providerFromToolType("claude-orchestrated"))
        assertEquals("cursor", providerFromToolType("cursor-cli"))
        assertEquals("droid", providerFromToolType("droid"))
        assertEquals("opencode", providerFromToolType("opencode"))
        assertEquals("codex", providerFromToolType("  CODEX-Chat  "))
    }

    /**
     * Unknown tool types must stay null so a plain shell keeps the "Shell"
     * label instead of being relabelled after its binary.
     */
    @Test
    fun `provider derivation yields null for shells and blanks`() {
        assertNull(providerFromToolType(null))
        assertNull(providerFromToolType(""))
        assertNull(providerFromToolType("   "))
        assertNull(providerFromToolType("bash"))
        assertNull(providerFromToolType("run-shell"))
    }

    /** The derived provider must reach the tint and the logo, not just the label. */
    @Test
    fun `derived provider drives the codex tint and logo`() {
        val derived = providerFromToolType("codex-chat")
        assertEquals(0xFF0A84FFL, providerTintArgb(derived, ACCENT))
        assertEquals("Codex", providerShortLabel(derived, SessionKind.CHAT))
        assertTrue(providerLogoRes(derived) != null)
        // Control: without derivation this is what every card rendered.
        assertEquals(ACCENT, providerTintArgb(null, ACCENT))
        assertNull(providerLogoRes(null))
    }

    // -- provider tint ------------------------------------------------------

    @Test
    fun `provider tint uses the iOS system palette not the brand palette`() {
        assertEquals(0xFFFF9F0AL, providerTintArgb("claude", ACCENT))
        assertEquals(0xFFFF9F0AL, providerTintArgb("Anthropic", ACCENT))
        assertEquals(0xFF0A84FFL, providerTintArgb("codex", ACCENT))
        assertEquals(0xFF0A84FFL, providerTintArgb("openai", ACCENT))
        assertEquals(0xFF40C8E0L, providerTintArgb("opencode", ACCENT))
        assertEquals(0xFF5E5CE6L, providerTintArgb("cursor", ACCENT))
        assertEquals(0xFF8E8E93L, providerTintArgb("droid", ACCENT))
        assertEquals(0xFF8E8E93L, providerTintArgb("factory", ACCENT))
        assertEquals(0xFF30D158L, providerTintArgb("ollama", ACCENT))
        assertEquals(0xFFFF9F0AL, providerTintArgb("lmstudio", ACCENT))
        assertEquals(0xFFFFD60AL, providerTintArgb("google", ACCENT))
    }

    @Test
    fun `unknown and missing providers fall back to the theme accent`() {
        assertEquals(ACCENT, providerTintArgb(null, ACCENT))
        assertEquals(ACCENT, providerTintArgb("some-new-agent", ACCENT))
        // The light-mode accent is green; the tint must follow whatever is passed.
        assertEquals(0xFF049068L, providerTintArgb(null, 0xFF049068L))
    }

    @Test
    fun `short provider labels match the roster card vocabulary`() {
        assertEquals("Claude", providerShortLabel("claude", SessionKind.CHAT))
        assertEquals("Codex", providerShortLabel("openai", SessionKind.CHAT))
        assertEquals("OpenCode", providerShortLabel("opencode", SessionKind.CHAT))
        assertEquals("Cursor", providerShortLabel("cursor", SessionKind.CHAT))
        assertEquals("Shell", providerShortLabel(null, SessionKind.TERMINAL))
        assertEquals("Agent", providerShortLabel(null, SessionKind.CHAT))
    }

    // -- timestamps ---------------------------------------------------------

    @Test
    fun `relative timestamps collapse to now m h and d`() {
        assertEquals("now", relativeWorkTimestamp(agoIso(0), NOW))
        assertEquals("now", relativeWorkTimestamp(agoIso(59), NOW))
        assertEquals("1m", relativeWorkTimestamp(agoIso(60), NOW))
        assertEquals("59m", relativeWorkTimestamp(agoIso(59 * 60), NOW))
        assertEquals("1h", relativeWorkTimestamp(agoIso(3_600), NOW))
        assertEquals("23h", relativeWorkTimestamp(agoIso(23 * 3_600), NOW))
        assertEquals("1d", relativeWorkTimestamp(agoIso(86_400), NOW))
        assertEquals("9d", relativeWorkTimestamp(agoIso(9 * 86_400), NOW))
    }

    @Test
    fun `unparseable timestamps are dropped rather than rendered`() {
        assertNull(relativeWorkTimestamp(null, NOW))
        assertNull(relativeWorkTimestamp("not-a-date", NOW))
    }

    // -- preview precedence -------------------------------------------------

    @Test
    fun `attention message beats every other preview source`() {
        assertEquals(
            "Approve the file write?",
            workPreviewText(
                title = "Session",
                attentionMessage = "Approve the file write?",
                statusNote = "note",
                chatPreview = "chat preview",
                sessionPreview = "session preview",
            ),
        )
    }

    @Test
    fun `status note wins over previews and gains a Done prefix when settled`() {
        assertEquals(
            "Done: Rebased onto main",
            workPreviewText(title = "S", statusNote = "Rebased onto main", settled = true, chatPreview = "p"),
        )
        assertEquals(
            "Rebased onto main",
            workPreviewText(title = "S", statusNote = "Rebased onto main", settled = false, chatPreview = "p"),
        )
    }

    @Test
    fun `preview falls through chat then session then summary then goal`() {
        assertEquals("chat preview", workPreviewText("S", chatPreview = "chat preview", sessionPreview = "s"))
        assertEquals("session preview", workPreviewText("S", sessionPreview = "session preview", chatSummary = "cs"))
        assertEquals("chat summary", workPreviewText("S", chatSummary = "chat summary", sessionSummary = "ss"))
        assertEquals("session summary", workPreviewText("S", sessionSummary = "session summary", chatGoal = "cg"))
        assertEquals("chat goal", workPreviewText("S", chatGoal = "chat goal", sessionGoal = "sg"))
        assertEquals("session goal", workPreviewText("S", sessionGoal = "session goal"))
        assertNull(workPreviewText("S"))
    }

    @Test
    fun `preview inlines newlines clips to 120 chars and drops title duplicates`() {
        assertEquals("one two three", workPreviewText("S", chatPreview = "one\n  two\r\nthree"))
        val long = "x".repeat(200)
        val clipped = workPreviewText("S", chatPreview = long)!!
        assertEquals(WORK_PREVIEW_MAX_CHARS + 1, clipped.length)
        assertTrue(clipped.endsWith("…"))
        assertNull(workPreviewText("Fix the parser", chatPreview = "fix the parser"))
    }

    // -- status semantics ---------------------------------------------------

    @Test
    fun `row tint follows archived then status`() {
        assertEquals(WorkRowTint.WARNING, workRowTint("active", archived = true))
        assertEquals(WorkRowTint.WARNING, workRowTint("awaiting-input", archived = false))
        assertEquals(WorkRowTint.SUCCESS, workRowTint("running", archived = false))
        assertEquals(WorkRowTint.WARNING, workRowTint("idle", archived = false))
        assertEquals(WorkRowTint.SECONDARY, workRowTint("done", archived = false))
        assertEquals(WorkRowTint.SECONDARY, workRowTint(null, archived = false))
    }

    @Test
    fun `status capsule prefers needs-you then failed then stale`() {
        assertEquals(
            WorkStatusCapsule.NEEDS_YOU,
            workStatusCapsule("idle", awaitingInput = true, failed = true, settled = false, lastActivityAgeSeconds = 99_999),
        )
        assertEquals(
            WorkStatusCapsule.FAILED,
            workStatusCapsule("idle", awaitingInput = false, failed = true, settled = false, lastActivityAgeSeconds = 99_999),
        )
        assertEquals(
            WorkStatusCapsule.STALE,
            workStatusCapsule("idle", awaitingInput = false, failed = false, settled = false, lastActivityAgeSeconds = STALE_AFTER_SECONDS),
        )
        assertNull(
            workStatusCapsule("idle", awaitingInput = false, failed = false, settled = false, lastActivityAgeSeconds = 60),
        )
        assertNull(
            workStatusCapsule("idle", awaitingInput = false, failed = false, settled = true, lastActivityAgeSeconds = 99_999),
        )
    }

    // -- lane colours -------------------------------------------------------

    @Test
    fun `lane palette parses the twelve iOS hexes`() {
        assertEquals(12, LANE_PALETTE_HEXES.size)
        assertEquals(0xFFA78BFAL, parseLaneColorArgb("#a78bfa"))
        assertEquals(0xFF22D3EEL, parseLaneColorArgb("22d3ee"))
        assertEquals(0x80A78BFAL, parseLaneColorArgb("#a78bfa80"))
    }

    @Test
    fun `invalid lane colours are rejected so the fallback hue applies`() {
        assertNull(parseLaneColorArgb(null))
        assertNull(parseLaneColorArgb(""))
        assertNull(parseLaneColorArgb("#abc"))
        assertNull(parseLaneColorArgb("not-a-colour"))
        val fallback = laneFallbackColorArgb("lane-42")
        assertTrue(LANE_PALETTE_HEXES.take(8).map { parseLaneColorArgb(it) }.contains(fallback))
        assertEquals(fallback, laneFallbackColorArgb("lane-42"))
    }

    @Test
    fun `branch names drop ref prefixes`() {
        assertEquals("main", shortBranchName("refs/heads/main"))
        assertEquals("feature/x", shortBranchName("refs/remotes/origin/feature/x"))
        assertEquals("feature/x", shortBranchName("origin/feature/x"))
        assertEquals("plain", shortBranchName("  plain  "))
        assertNull(shortBranchName(null))
    }

    // -- PR badge -----------------------------------------------------------

    @Test
    fun `pr badge labels and tints match the iOS chip`() {
        assertEquals("MERGED #12", lanePrBadgeLabel(LanePrTag(12, "merged")))
        assertEquals("CLOSED #12", lanePrBadgeLabel(LanePrTag(12, "closed")))
        assertEquals("DRAFT #12", lanePrBadgeLabel(LanePrTag(12, "open", draft = true)))
        assertEquals("DRAFT #12", lanePrBadgeLabel(LanePrTag(12, "draft")))
        assertEquals("PR #12", lanePrBadgeLabel(LanePrTag(12, "open")))
        assertEquals(LanePrTint.ACCENT, lanePrTint(LanePrTag(1, "merged")))
        assertEquals(LanePrTint.DANGER, lanePrTint(LanePrTag(1, "closed")))
        assertEquals(LanePrTint.WARNING, lanePrTint(LanePrTag(1, "open", draft = true)))
        assertEquals(LanePrTint.SUCCESS, lanePrTint(LanePrTag(1, "open")))
    }

    // -- live pill ----------------------------------------------------------

    @Test
    fun `live pill counts exclude archived and prefer the waiting label`() {
        val cards = listOf(
            card("a", status = "awaiting-input"),
            card("b", status = "running"),
            card("c", status = "idle"),
            card("d", status = "done"),
            card("e", status = "running", archived = true),
        )
        val counts = workLiveCounts(cards)
        assertEquals(3, counts.live)
        assertEquals(1, counts.waiting)
        assertEquals("1 waiting", counts.label)
        assertTrue(counts.attention)
        assertEquals("2 live", workLiveCounts(cards.filter { it.id in setOf("b", "c") }).label)
    }

    // -- grouping -----------------------------------------------------------

    @Test
    fun `lane grouping emits primary first and buckets unknown lanes as orphans`() {
        val lanes = listOf(
            UiLane(id = "l2", name = "feature", color = "#34d399", laneType = "worktree"),
            UiLane(id = "l1", name = "main", color = "#a78bfa", laneType = "primary"),
        )
        val cards = listOf(
            card("a", laneId = "l2"),
            card("b", laneId = "l1"),
            card("c", laneId = "gone", laneName = "deleted-lane"),
        )
        val groups = groupWorkByLane(cards, lanes)
        assertEquals(listOf("l1", "l2", "orphan:gone"), groups.map { it.id })
        assertEquals(0xFFA78BFAL, groups[0].colorArgb)
        assertTrue(groups[2].orphan)
        assertEquals("Orphaned sessions: deleted-lane", groups[2].label)
    }

    @Test
    fun `a group is quiet only when every session is settled or archived`() {
        val lanes = listOf(UiLane(id = "l1", name = "main", laneType = "primary"))
        val quiet = groupWorkByLane(
            listOf(card("a", laneId = "l1", settled = true), card("b", laneId = "l1", archived = true)),
            lanes,
        )
        assertTrue(quiet.single().quiet)
        val loud = groupWorkByLane(
            listOf(card("a", laneId = "l1", settled = true), card("b", laneId = "l1", status = "running")),
            lanes,
        )
        assertTrue(!loud.single().quiet)
    }

    @Test
    fun `status and time grouping keep a stable bucket order`() {
        val cards = listOf(
            card("a", status = "done"),
            card("b", status = "awaiting-input"),
            card("c", status = "running"),
        )
        assertEquals(listOf("Needs you", "Active", "Done"), groupWorkByStatus(cards).map { it.label })
        assertEquals(
            listOf("Last hour", "Today", "Older"),
            groupWorkByTime(
                listOf(
                    card("a", timestamp = "3h"),
                    card("b", timestamp = "5m"),
                    card("c", timestamp = null),
                ),
            ).map { it.label },
        )
    }

    @Test
    fun `search matches title lane preview and provider`() {
        val subject = card("a", laneName = "android-lane").copy(preview = "compiled cleanly", title = "Roster card")
        assertTrue(matchesWorkSearch(subject, ""))
        assertTrue(matchesWorkSearch(subject, "ROSTER"))
        assertTrue(matchesWorkSearch(subject, "android"))
        assertTrue(matchesWorkSearch(subject, "cleanly"))
        assertTrue(!matchesWorkSearch(subject, "nothing-here"))
    }

    // -- card assembly ------------------------------------------------------

    @Test
    fun `card model reads everything off the enriched listSessions row`() {
        val model = workCardModel(
            session = UiSession(
                id = "s1",
                laneId = "l1",
                laneName = "stale-name",
                title = "Wire the roster card",
                provider = "codex",
                toolType = "codex-chat",
                runtimeState = "awaiting-input",
                preview = "session preview",
                kind = SessionKind.CHAT,
                pinned = true,
                lastActivityAt = agoIso(120),
                attentionMessage = "Approve the write?",
                attentionRequestedAt = agoIso(100),
            ),
            lane = UiLane(
                id = "l1",
                name = "android-companion",
                color = "#34d399",
                laneType = "worktree",
                dirty = true,
                ahead = 2,
                behind = 1,
                childCount = 3,
                linearIdentifier = "ADE-412",
            ),
            accentArgb = ACCENT,
            nowMs = NOW,
        )
        assertEquals(0xFF0A84FFL, model.providerTintArgb)
        assertEquals("Codex", model.providerLabel)
        assertEquals("Approve the write?", model.preview)
        assertEquals("2m", model.timestamp)
        assertEquals(WorkStatusCapsule.NEEDS_YOU, model.capsule)
        assertEquals(WorkRowTint.WARNING, model.rowTint)
        assertEquals("android-companion", model.laneName)
        assertEquals(0xFF34D399L, model.laneColorArgb)
        assertTrue(model.pinned)
        assertTrue(!model.settled)
        // Git chips come from the lane snapshot, with no lanes.getDetail call.
        assertEquals(LaneGitState(dirty = true, ahead = 2, behind = 1, children = 3, linearIdentifier = "ADE-412"), model.laneGit)
    }

    @Test
    fun `a settled session renders hollow and dims the card`() {
        val model = workCardModel(
            session = UiSession(
                id = "s2",
                laneId = null,
                laneName = null,
                title = "Migrate parser",
                provider = "claude",
                toolType = "claude-chat",
                runtimeState = "done",
                preview = null,
                kind = SessionKind.CHAT,
                settledAt = agoIso(600),
                statusNote = "Parser migrated",
                lastActivityAt = agoIso(600),
            ),
            lane = null,
            accentArgb = ACCENT,
            nowMs = NOW,
        )
        assertTrue(model.settled)
        assertEquals("Done: Parser migrated", model.preview)
        assertNull(model.capsule)
        assertNull(model.laneGit)
    }

    @Test
    fun `preview falls back through summary and goal`() {
        fun preview(vararg pairs: Pair<String, String?>): String? {
            val map = pairs.toMap()
            return workCardModel(
                session = UiSession(
                    id = "s3",
                    laneId = null,
                    laneName = null,
                    title = "Untitled",
                    provider = null,
                    toolType = null,
                    runtimeState = "running",
                    preview = map["preview"],
                    kind = SessionKind.TERMINAL,
                    summary = map["summary"],
                    goal = map["goal"],
                ),
                lane = null,
                accentArgb = ACCENT,
                nowMs = NOW,
            ).preview
        }
        assertEquals("live output", preview("preview" to "live output", "summary" to "a summary", "goal" to "a goal"))
        assertEquals("a summary", preview("summary" to "a summary", "goal" to "a goal"))
        assertEquals("a goal", preview("goal" to "a goal"))
        assertNull(preview())
    }

    @Test
    fun `exit code and last turn failure raise the failed capsule`() {
        fun capsule(exitCode: Int?, lastTurnFailedAt: String?) = workCardModel(
            session = UiSession(
                id = "s4",
                laneId = null,
                laneName = null,
                title = "Build",
                provider = null,
                toolType = null,
                runtimeState = "running",
                preview = null,
                kind = SessionKind.TERMINAL,
                exitCode = exitCode,
                lastTurnFailedAt = lastTurnFailedAt,
            ),
            lane = null,
            accentArgb = ACCENT,
            nowMs = NOW,
        ).capsule
        assertEquals(WorkStatusCapsule.FAILED, capsule(1, null))
        assertEquals(WorkStatusCapsule.FAILED, capsule(null, agoIso(30)))
        assertNull(capsule(0, null))
    }
}

private fun card(
    id: String,
    status: String? = "running",
    laneId: String? = "l1",
    laneName: String? = "main",
    settled: Boolean = false,
    archived: Boolean = false,
    timestamp: String? = "1m",
) = WorkCardModel(
    id = id,
    title = "Session $id",
    preview = null,
    provider = "claude",
    providerLabel = "Claude",
    providerTintArgb = 0xFFFF9F0AL,
    kind = SessionKind.CHAT,
    status = status,
    rowTint = workRowTint(status, archived),
    capsule = null,
    timestamp = timestamp,
    settled = settled || normalizeWorkStatus(status) == "settled",
    pinned = false,
    archived = archived,
    laneId = laneId,
    laneName = laneName,
    laneColorArgb = null,
    laneGit = null,
)
