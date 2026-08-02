package com.ade.android.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ChatMarkdownParsingTest {

    @Test
    fun `headings lists rules and paragraphs parse into ordered blocks`() {
        val blocks = parseMarkdownBlocks(
            """
            # Title
            ### Detail

            Some prose across
            two lines.

            - alpha
            - beta

            3. third
            4. fourth

            ---
            """.trimIndent(),
        ).map(MarkdownBlock::kind)

        assertEquals(MarkdownBlockKind.Heading(1, "Title"), blocks[0])
        assertEquals(MarkdownBlockKind.Heading(3, "Detail"), blocks[1])
        assertEquals(MarkdownBlockKind.Paragraph("Some prose across\ntwo lines."), blocks[2])
        assertEquals(MarkdownBlockKind.UnorderedList(listOf("alpha", "beta")), blocks[3])
        assertEquals(MarkdownBlockKind.OrderedList(3, listOf("third", "fourth")), blocks[4])
        assertEquals(MarkdownBlockKind.Rule, blocks[5])
    }

    @Test
    fun `ordered list preserves its start number`() {
        val kind = parseMarkdownBlocks("7. seven\n8. eight").single().kind
        assertEquals(MarkdownBlockKind.OrderedList(7, listOf("seven", "eight")), kind)
    }

    @Test
    fun `task list markers become glyphs`() {
        val kind = parseMarkdownBlocks("- [ ] todo\n- [x] done\n- [X] also done").single().kind
        assertEquals(MarkdownBlockKind.UnorderedList(listOf("☐ todo", "☑ done", "☑ also done")), kind)
    }

    @Test
    fun `gfm pipe tables parse headers and rows`() {
        val kind = parseMarkdownBlocks(
            """
            | Name | Count |
            | --- | :---: |
            | a | 1 |
            | b | 2 |
            """.trimIndent(),
        ).single().kind
        assertEquals(
            MarkdownBlockKind.Table(listOf("Name", "Count"), listOf(listOf("a", "1"), listOf("b", "2"))),
            kind,
        )
    }

    @Test
    fun `fenced code keeps its language and body verbatim`() {
        val kind = parseMarkdownBlocks("```kotlin\nval x = 1\n\nval y = 2\n```").single().kind
        assertEquals(MarkdownBlockKind.Code("kotlin", "val x = 1\n\nval y = 2"), kind)
    }

    @Test
    fun `blockquotes collapse their markers`() {
        val kind = parseMarkdownBlocks("> first\n> second").single().kind
        assertEquals(MarkdownBlockKind.Blockquote(listOf("first", "second")), kind)
    }

    @Test
    fun `a line of only hashes does not spin the parser`() {
        // Streaming snapshots routinely end mid-heading; this must terminate.
        val blocks = parseMarkdownBlocks("intro\n#")
        assertTrue(blocks.isNotEmpty())
    }

    @Test
    fun `block ids are stable across identical parses`() {
        val text = "# A\n\nbody\n\n- x"
        assertEquals(parseMarkdownBlocks(text).map(MarkdownBlock::id), parseMarkdownBlocks(text).map(MarkdownBlock::id))
    }
}

class ChatMonospacedFallbackTest {

    @Test
    fun `box drawing glyphs force the monospaced fallback`() {
        assertTrue(assistantMessageUsesMonospacedPreview("┌───┐\n│ a │\n└───┘"))
    }

    @Test
    fun `two aligned column lines that dominate the prose force the fallback`() {
        assertTrue(assistantMessageUsesMonospacedPreview("name    value\ncount   12"))
    }

    @Test
    fun `aligned lines that are a minority of prose do not`() {
        val text = "name    value\nThis is ordinary prose.\nSo is this line.\nAnd this one too.\nAnd another."
        assertFalse(assistantMessageUsesMonospacedPreview(text))
    }

    @Test
    fun `fenced code and table rows are exempt`() {
        assertFalse(assistantMessageUsesMonospacedPreview("```\na    b\nc    d\n```"))
        assertFalse(assistantMessageUsesMonospacedPreview("| a    | b |\n| c    | d |"))
    }

    @Test
    fun `ordinary prose is not monospaced`() {
        assertFalse(assistantMessageUsesMonospacedPreview("Hello there.\n\nThis is a normal answer."))
    }

    @Test
    fun `interior gap detection ignores leading indentation`() {
        assertFalse(lineHasAlignedColumnGap("     indented prose"))
        assertTrue(lineHasAlignedColumnGap("a     b"))
    }
}

class ChatStreamingParseTest {

    private val document = """
        # Heading

        First paragraph with **bold**.

        - one
        - two

        ```kotlin
        val a = 1
        ```

        Closing paragraph.
    """.trimIndent()

    @Test
    fun `tail parse is byte-identical to a whole-text parse at every prefix`() {
        val parser = StreamingMarkdownParser()
        for (length in 1..document.length) {
            val snapshot = document.substring(0, length)
            assertEquals(
                parseMarkdownBlocks(snapshot),
                parser.parse(snapshot),
                "streaming parse diverged at length $length",
            )
        }
    }

    @Test
    fun `repeated parse of the same text returns the cached list`() {
        val parser = StreamingMarkdownParser()
        val first = parser.parse(document)
        assertTrue(first === parser.parse(document))
    }

    @Test
    fun `the boundary never lands inside an open fence`() {
        val text = "intro\n\n```\ncode\n\nmore code\n"
        val boundary = stableBoundaryIndex(text)
        assertNotNull(boundary)
        assertEquals("intro\n\n", text.substring(0, boundary))
    }

    @Test
    fun `text with no blank line has no stable boundary`() {
        assertNull(stableBoundaryIndex("just one growing line"))
    }
}

class ChatTruncationTest {

    @Test
    fun `short messages are not truncated`() {
        val preview = assistantMessagePreview("one\ntwo\nthree")
        assertFalse(preview.truncated)
        assertEquals(3, preview.totalLineCount)
    }

    @Test
    fun `the initial budget is 48 lines for prose`() {
        val text = (1..200).joinToString("\n") { "line $it" }
        val preview = assistantMessagePreview(text)
        assertTrue(preview.truncated)
        assertEquals(48, preview.visibleLineCount)
        assertEquals(200, preview.totalLineCount)
    }

    @Test
    fun `wide monospaced messages start at 24 lines`() {
        val text = (1..200).joinToString("\n") { "col$it     value$it" }
        val preview = assistantMessagePreview(text)
        assertTrue(preview.usesMonospacedRendering)
        assertEquals(24, preview.visibleLineCount)
    }

    @Test
    fun `each show more step adds a full budget`() {
        val text = (1..400).joinToString("\n") { "line $it" }
        assertEquals(96, assistantMessagePreview(text, ASSISTANT_INITIAL_LINE_BUDGET + ASSISTANT_LINE_BUDGET_STEP).visibleLineCount)
        assertEquals(24, assistantEffectiveLineBudget(48, wide = true))
        assertEquals(48, assistantEffectiveLineBudget(96, wide = true))
    }

    @Test
    fun `the summary reads N of M lines`() {
        val preview = assistantMessagePreview((1..100).joinToString("\n") { "line $it" })
        assertEquals("48 of 100 lines", assistantPreviewSummary(preview))
    }
}

class ChatColourTest {

    @Test
    fun `mix interpolates in srgb`() {
        assertEquals(0xFF7F7F7FL, mixArgb(0xFF000000L, 0xFFFFFFFFL, 0.5))
        assertEquals(0xFF404040L, mixArgb(0xFF000000L, 0xFF808080L, 0.5))
    }

    @Test
    fun `mix endpoints are exact`() {
        assertEquals(0xFF102030L, mixArgb(0xFF102030L, 0xFFAABBCCL, 0.0))
        assertEquals(0xFFAABBCCL, mixArgb(0xFF102030L, 0xFFAABBCCL, 1.0))
    }

    @Test
    fun `codex chats mix further toward violet than other providers`() {
        // Same accent for both sides of the comparison would hide the t change,
        // so compare each provider against its own accent distance.
        val codex = userBubbleFillArgb("codex")
        val codexAccent = chatSurfaceAccentArgb("codex")
        assertEquals(mixArgb(codexAccent, WORK_VIOLET_ARGB, 0.44), codex)
        assertEquals(mixArgb(chatSurfaceAccentArgb("claude"), WORK_VIOLET_ARGB, 0.36), userBubbleFillArgb("claude"))
    }

    @Test
    fun `gpt model ids count as codex chats even without a provider`() {
        assertTrue(isCodexChat(null, "gpt-5.6-sol"))
        assertTrue(isCodexChat(null, "openai/gpt-4"))
        assertFalse(isCodexChat("claude", "claude-opus-5"))
    }

    @Test
    fun `the bubble fill differs per provider`() {
        val fills = listOf("claude", "codex", "cursor", "opencode", "groq", "unknown")
            .map { userBubbleFillArgb(it) }
        assertEquals(fills.size, fills.distinct().size)
    }

    @Test
    fun `unknown providers fall back to the neutral grey accent`() {
        assertEquals(0xFF71717AL, chatSurfaceAccentArgb("nonesuch"))
    }

    @Test
    fun `the bubble border is accent toward white at 45 percent alpha`() {
        val border = userBubbleBorderArgb("claude")
        assertEquals(0x73L, (border ushr 24) and 0xFFL)
    }
}

class ChatFoldingTest {

    private fun event(type: String, vararg pairs: Pair<String, Any?>): ChatEvent {
        var e = ChatEvent(type = type, turnId = "turn-1")
        pairs.forEach { (key, value) ->
            e = when (key) {
                "itemId" -> e.copy(itemId = value as String?)
                "messageId" -> e.copy(messageId = value as String?)
                "text" -> e.copy(text = value as String?)
                "tool" -> e.copy(tool = value as String?)
                "argsText" -> e.copy(argsText = value as String?)
                "status" -> e.copy(status = value as String?)
                "path" -> e.copy(path = value as String?)
                "diff" -> e.copy(diff = value as String?)
                "kind" -> e.copy(kind = value as String?)
                "taskId" -> e.copy(taskId = value as String?)
                "label" -> e.copy(label = value as String?)
                "summary" -> e.copy(summary = value as String?)
                "description" -> e.copy(description = value as String?)
                "inputTokens" -> e.copy(inputTokens = value as Long?)
                "outputTokens" -> e.copy(outputTokens = value as Long?)
                "costUsd" -> e.copy(costUsd = value as Double?)
                "contextRatio" -> e.copy(contextRatio = value as Double?)
                "contextState" -> e.copy(contextState = value as String?)
                "turnId" -> e.copy(turnId = value as String?)
                else -> e
            }
        }
        return e
    }

    @Test
    fun `adjacent tool calls fold into one group and results update in place`() {
        val transcript = foldChatTranscript(
            listOf(
                event("tool_call", "itemId" to "a", "tool" to "Read", "argsText" to "main.kt"),
                event("tool_call", "itemId" to "b", "tool" to "mcp__gh__list", "argsText" to "prs"),
                event("tool_result", "itemId" to "a", "status" to "completed"),
                event("tool_result", "itemId" to "b", "status" to "failed"),
            ),
        )
        val group = transcript.items.filterIsInstance<ChatTimelineItem.ToolGroup>().single()
        assertEquals(2, group.calls.size)
        assertEquals(ToolCallStatus.COMPLETED, group.calls[0].status)
        assertEquals(ToolCallStatus.FAILED, group.calls[1].status)
        assertEquals("list", group.calls[1].slug)
    }

    @Test
    fun `file changes fold with summed diff counts`() {
        val transcript = foldChatTranscript(
            listOf(
                event("file_change", "itemId" to "f1", "path" to "a.kt", "kind" to "create", "diff" to "+one\n+two\n-old\n"),
                event("file_change", "itemId" to "f2", "path" to "b.kt", "kind" to "modify", "diff" to "+three\n"),
            ),
        )
        val files = transcript.items.filterIsInstance<ChatTimelineItem.FilesChanged>().single()
        assertEquals(2, files.files.size)
        assertEquals(3, files.additions)
        assertEquals(1, files.deletions)
        assertEquals(FileChangeKind.CREATE, files.files[0].kind)
    }

    @Test
    fun `diff file headers are not counted as additions or deletions`() {
        assertEquals(1 to 1, diffCounts("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n"))
    }

    @Test
    fun `a tool call interrupts an open file group and vice versa`() {
        val transcript = foldChatTranscript(
            listOf(
                event("file_change", "itemId" to "f1", "path" to "a.kt", "diff" to "+x\n"),
                event("tool_call", "itemId" to "t1", "tool" to "bash"),
                event("file_change", "itemId" to "f2", "path" to "b.kt", "diff" to "+y\n"),
            ),
        )
        assertEquals(2, transcript.items.filterIsInstance<ChatTimelineItem.FilesChanged>().size)
        assertEquals(1, transcript.items.filterIsInstance<ChatTimelineItem.ToolGroup>().size)
    }

    @Test
    fun `streaming assistant deltas replace rather than append`() {
        val transcript = foldChatTranscript(
            listOf(
                event("text", "messageId" to "m1", "text" to "Hel"),
                event("text", "messageId" to "m1", "text" to "Hello world"),
            ),
        )
        val message = transcript.items.filterIsInstance<ChatTimelineItem.AssistantMessage>().single()
        assertEquals("Hello world", message.text)
    }

    @Test
    fun `subagents accumulate by task id and settle on the result`() {
        val transcript = foldChatTranscript(
            listOf(
                event("subagent_started", "taskId" to "s1", "label" to "Explore", "description" to "sweep"),
                event("subagent_result", "taskId" to "s1", "status" to "completed", "summary" to "found it"),
            ),
        )
        val card = transcript.items.filterIsInstance<ChatTimelineItem.Subagent>().single()
        assertEquals(SubagentStatus.SUCCEEDED, card.snapshot.status)
        assertEquals("found it", card.snapshot.summary)
    }

    @Test
    fun `approvals are pinned separately and cleared on resolution`() {
        val pending = foldChatTranscript(
            listOf(event("approval_request", "itemId" to "i1", "description" to "run tests", "kind" to "command")),
        )
        assertEquals(1, pending.pendingApprovals.size)
        assertFalse(pending.pendingApprovals.single().plan)
        assertTrue(pending.items.none { it is ChatTimelineItem.Notice })

        val resolved = foldChatTranscript(
            listOf(
                event("approval_request", "itemId" to "i1", "description" to "run tests"),
                event("pending_input_resolved", "itemId" to "i1"),
            ),
        )
        assertTrue(resolved.pendingApprovals.isEmpty())
    }

    @Test
    fun `done emits a usage pill and a turn end`() {
        val transcript = foldChatTranscript(
            listOf(
                event("text", "messageId" to "m", "text" to "hi"),
                event("done", "inputTokens" to 100L, "outputTokens" to 20L, "costUsd" to 0.5),
            ),
        )
        assertEquals(120L, transcript.items.filterIsInstance<ChatTimelineItem.Usage>().single().summary.let {
            it.inputTokens + it.outputTokens
        })
        assertEquals(1, transcript.items.filterIsInstance<ChatTimelineItem.TurnEnd>().size)
        assertFalse(transcript.turnLive)
    }

    @Test
    fun `transport metadata never reaches the canvas`() {
        val transcript = foldChatTranscript(
            listOf("activity", "tokens", "codex_token_usage", "step_boundary", "tool_use_summary").map(::event),
        )
        assertTrue(transcript.items.isEmpty())
    }

    @Test
    fun `context usage is scanned and unknown stays unknown`() {
        assertEquals(
            0.42,
            foldChatTranscript(listOf(event("context_usage", "contextRatio" to 0.42))).contextRatio,
        )
        assertNull(foldChatTranscript(listOf(event("text", "text" to "hi"))).contextRatio)
    }

    @Test
    fun `a new turn id opens a fresh turn divider`() {
        val transcript = foldChatTranscript(
            listOf(
                event("text", "turnId" to "t1", "messageId" to "m1", "text" to "a"),
                event("text", "turnId" to "t2", "messageId" to "m2", "text" to "b"),
            ),
        )
        assertEquals(2, transcript.items.filterIsInstance<ChatTimelineItem.TurnStart>().size)
    }
}

class ChatContextRingTest {

    @Test
    fun `thresholds select the tone`() {
        assertEquals(ContextRingTone.OK, contextRingState(0.10).tone)
        assertEquals(ContextRingTone.OK, contextRingState(0.69).tone)
        assertEquals(ContextRingTone.WARNING, contextRingState(0.70).tone)
        assertEquals(ContextRingTone.DANGER, contextRingState(0.90).tone)
    }

    @Test
    fun `an unknown ratio renders a question mark and never a number`() {
        val state = contextRingState(null)
        assertEquals(ContextRingTone.UNKNOWN, state.tone)
        assertEquals("?", state.label)
        assertNull(state.ratio)
    }

    @Test
    fun `compacting and recalculating render an ellipsis`() {
        assertEquals("…", contextRingState(0.5, "compacting").label)
        assertEquals("…", contextRingState(null, "recalculating").label)
        assertTrue(contextRingState(0.5, "compacting").busy)
    }

    @Test
    fun `the label is a rounded percent`() {
        assertEquals("42", contextRingState(0.4234).label)
        assertEquals("100", contextRingState(1.0).label)
    }
}

class ChatFormattingTest {

    @Test
    fun `counts under a thousand are literal`() {
        assertEquals("0", abbreviateCount(0))
        assertEquals("999", abbreviateCount(999))
    }

    @Test
    fun `counts abbreviate with one decimal and drop trailing zero`() {
        assertEquals("1k", abbreviateCount(1_000))
        assertEquals("1.1k", abbreviateCount(1_100))
        assertEquals("19.2k", abbreviateCount(19_240))
        assertEquals("1M", abbreviateCount(1_000_000))
        assertEquals("2.5M", abbreviateCount(2_500_000))
        assertEquals("3B", abbreviateCount(3_000_000_000L))
    }

    @Test
    fun `cost uses two decimals above a cent and four below`() {
        assertEquals("$0.06", formatUsageCost(0.0642))
        assertEquals("$0.0042", formatUsageCost(0.0042))
        assertEquals("$12.50", formatUsageCost(12.5))
    }

    @Test
    fun `effort abbreviations match the iOS table`() {
        assertEquals("MIN", reasoningEffortAbbreviation("minimal"))
        assertEquals("LOW", reasoningEffortAbbreviation("low"))
        assertEquals("MED", reasoningEffortAbbreviation("Medium"))
        assertEquals("HI", reasoningEffortAbbreviation("high"))
        assertEquals("XH", reasoningEffortAbbreviation("xhigh"))
        assertEquals("XH", reasoningEffortAbbreviation("extra-high"))
        assertEquals("MAX", reasoningEffortAbbreviation("max"))
        assertEquals("ULTRA", reasoningEffortAbbreviation("ultracode"))
        assertEquals("BAL", reasoningEffortAbbreviation("balanced"))
    }

    @Test
    fun `effort display names rename low and xhigh`() {
        assertEquals("Light", reasoningEffortDisplayName("low"))
        assertEquals("Extra High", reasoningEffortDisplayName("xhigh"))
        assertEquals("Medium", reasoningEffortDisplayName("medium"))
    }

    @Test
    fun `paths are middle truncated`() {
        assertEquals("short.kt", middleTruncate("short.kt"))
        val truncated = middleTruncate("a/very/long/path/to/some/deeply/nested/File.kt", 20)
        assertEquals(20, truncated.length)
        assertTrue(truncated.contains("…"))
    }

    @Test
    fun `composer placeholders follow the pending card`() {
        assertEquals("Type to vibecode...", composerPlaceholder(emptyList()))
        assertEquals(
            "Review the plan above...",
            composerPlaceholder(listOf(ChatApproval("i", "plan", "", null, plan = true))),
        )
        assertEquals(
            "Answer the prompt above...",
            composerPlaceholder(listOf(ChatApproval("i", "command", "", null, plan = false))),
        )
    }
}

class ChatIdenticonTest {

    @Test
    fun `the hash is deterministic and seeded by djb2`() {
        assertEquals(stableSubagentHash("agent-7f3c"), stableSubagentHash("agent-7f3c"))
        assertEquals(5381L * 33 + 'a'.code, stableSubagentHash("a"))
    }

    @Test
    fun `the bit grid is deterministic for the same id`() {
        val first = (0 until 9).map { subagentGlyphBit("agent-7f3c", it) }
        val second = (0 until 9).map { subagentGlyphBit("agent-7f3c", it) }
        assertEquals(first, second)
    }

    @Test
    fun `the grid shape varies across agent ids`() {
        // INTENTIONAL DIVERGENCE FROM iOS. The Swift original derives each cell
        // from `djb2("<id>:<index>") % 3 != 0`. djb2 multiplies by 33, which is
        // divisible by 3, so every character but the last contributes a multiple
        // of 3 and the residue collapses to the trailing index digit — every
        // agent id yields the identical nine cells and only the colour differs.
        // Android avalanches the hash per cell instead, so shapes actually vary.
        val ids = listOf(
            "agent-7f3c", "agent-b1", "explore-1", "explore-2", "general-purpose",
            "Plan", "code-reviewer", "task-99", "subagent-0", "subagent-1",
        )
        val shapes = ids.map { id -> (0 until 9).map { subagentGlyphBit(id, it) } }
        assertTrue(
            shapes.distinct().size >= 8,
            "identicon shapes barely vary: ${shapes.distinct().size} distinct of ${ids.size}",
        )
        // Neighbouring ids that differ only in the last character must not collide,
        // which is exactly the case the djb2 %3 derivation got wrong.
        assertTrue(shapes[2] != shapes[3], "explore-1 and explore-2 share a shape")
    }

    @Test
    fun `the grid uses both on and off cells`() {
        val cells = listOf("agent-7f3c", "explore-1", "Plan", "task-99")
            .flatMap { id -> (0 until 9).map { subagentGlyphBit(id, it) } }
        assertTrue(cells.any { it } && cells.any { !it }, "identicon cells are all one value")
    }

    @Test
    fun `the colour index varies across ids`() {
        val indices = (1..40).map { subagentGlyphColorIndex("agent-$it") }
        assertTrue(indices.distinct().size >= 4, "identicon colours barely vary: ${indices.distinct()}")
    }

    @Test
    fun `the colour index stays inside the palette`() {
        listOf("a", "agent-7f3c", "", "task-999").forEach {
            assertTrue(subagentGlyphColorIndex(it) in 0..4)
        }
    }

    @Test
    fun `status labels rename succeeded to completed`() {
        assertEquals("Completed", subagentStatusLabel(SubagentStatus.SUCCEEDED))
        assertEquals("Running", subagentStatusLabel(SubagentStatus.RUNNING))
    }
}

class ChatModelCatalogTest {

    private val claude = ChatModelOption(
        id = "claude-opus-5",
        name = "Claude Opus 5",
        provider = "claude",
        defaultReasoningEffort = "High",
        reasoningEfforts = listOf("Low", "low", "MEDIUM", "high"),
        serviceTiers = listOf("standard", "Fast"),
    )
    private val bare = ChatModelOption(id = "gemini", name = "Gemini", provider = "google")

    @Test
    fun `efforts are host supplied lowercased and deduped`() {
        assertEquals(listOf("low", "medium", "high"), claude.efforts)
        assertTrue(bare.efforts.isEmpty())
    }

    @Test
    fun `fast mode is a service tier`() {
        assertTrue(claude.supportsFastMode)
        assertFalse(bare.supportsFastMode)
    }

    @Test
    fun `selecting a model resets effort to its default and fast mode off`() {
        val selection = selectModel(claude)
        assertEquals("high", selection.effort)
        assertFalse(selection.fastMode)
        assertNull(selectModel(bare).effort)
    }

    @Test
    fun `the rail lists favourites recents then one item per provider`() {
        val rail = modelRailItems(listOf(claude, bare), setOf("claude-opus-5"), listOf("gemini"))
        assertEquals(ModelRailKind.FAVOURITES, rail[0].kind)
        assertEquals(ModelRailKind.RECENTS, rail[1].kind)
        assertEquals(listOf("claude", "google"), rail.drop(2).map(ModelRailItem::key))
    }

    @Test
    fun `search filters within the active rail only`() {
        val options = listOf(claude, bare)
        val provider = ModelRailItem(ModelRailKind.PROVIDER, "claude", "Claude")
        assertEquals(listOf(claude), modelsForRail(provider, options, emptySet(), emptyList(), "opus"))
        assertTrue(modelsForRail(provider, options, emptySet(), emptyList(), "gemini").isEmpty())
    }

    @Test
    fun `the fast mode capsule reports unsupported models honestly`() {
        assertEquals("No fast", fastModeLabel(bare, fastMode = true))
        assertEquals("Fast on", fastModeLabel(claude, fastMode = true))
        assertEquals("Fast off", fastModeLabel(claude, fastMode = false))
    }
}

class ChatApprovalDecisionTest {

    @Test
    fun `decisions carry the host wire values`() {
        // Must match AgentChatApprovalDecision in apps/desktop/src/shared/types/chat.ts,
        // which `chat.approve` forwards verbatim to approveToolUse.
        assertEquals("accept", ApprovalDecision.ACCEPT.wire)
        assertEquals("accept_for_session", ApprovalDecision.ACCEPT_FOR_SESSION.wire)
        assertEquals("decline", ApprovalDecision.DECLINE.wire)
    }
}

class ProviderArtworkTest {

    @Test
    fun `providers with ported iOS artwork resolve to a drawable`() {
        listOf("claude", "Anthropic", "codex", "openai", "cursor", "opencode", "droid", "factory", "github")
            .forEach { assertNotNull(providerLogoRes(it), "no logo for $it") }
    }

    @Test
    fun `providers without artwork fall back to the tinted initial`() {
        listOf(null, "", "gemini", "mistral", "ollama").forEach {
            assertNull(providerLogoRes(it), "unexpected logo for $it")
        }
        assertEquals("G", providerGlyph("gemini", com.ade.android.SessionKind.CHAT))
    }
}

/**
 * Regression cover for the "output showed three things at a time, then froze"
 * report. The host streams assistant text as incremental deltas sharing one
 * `messageId`; the fold used to overwrite the body with each delta, so the
 * message rendered only the newest chunk and stalled on the last one.
 */
class ChatStreamingAccumulationTest {

    private fun delta(text: String) = ChatEvent(type = "text", text = text, messageId = "m1", turnId = "t1")

    @Test
    fun `assistant deltas accumulate into one message`() {
        // Shapes taken verbatim from a real host transcript.
        val events = listOf(
            delta("1\n2\n3\n4\n5\n6\n"),
            delta("7\n8"),
            delta("\n9\n10\n11\n12\n13"),
        )
        val items = foldChatTranscript(events).items
        val message = items.filterIsInstance<ChatTimelineItem.AssistantMessage>().single()
        assertEquals((1..13).joinToString("\n"), message.text)
    }

    @Test
    fun `cumulative snapshots replace instead of duplicating`() {
        // Sources that re-send the whole message so far must not be concatenated.
        val events = listOf(delta("Hello"), delta("Hello world"), delta("Hello world!"))
        val message = foldChatTranscript(events).items
            .filterIsInstance<ChatTimelineItem.AssistantMessage>().single()
        assertEquals("Hello world!", message.text)
    }

    @Test
    fun `replayed chunks are not appended twice`() {
        assertEquals("abc", mergeAssistantText("abc", "abc"))
        assertEquals("abc", mergeAssistantText("abc", "c"))
        assertEquals("abcd", mergeAssistantText("abc", "d"))
        assertEquals("abc", mergeAssistantText("", "abc"))
        assertEquals("abc", mergeAssistantText("abc", ""))
    }

    @Test
    fun `distinct message ids stay separate messages`() {
        val events = listOf(
            ChatEvent(type = "text", text = "first", messageId = "a"),
            ChatEvent(type = "text", text = "second", messageId = "b"),
        )
        val texts = foldChatTranscript(events).items
            .filterIsInstance<ChatTimelineItem.AssistantMessage>().map { it.text }
        assertEquals(listOf("first", "second"), texts)
    }
}
