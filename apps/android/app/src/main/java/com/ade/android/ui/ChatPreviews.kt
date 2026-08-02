package com.ade.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp

/**
 * Transcript, composer and model-picker previews in both themes.
 *
 * `accent` is GREEN in light mode and purple only in dark, so every surface is
 * previewed twice — a hardcoded hue shows up immediately here.
 */

private const val SAMPLE_MARKDOWN = """
# Release notes

The parser now handles **inline** spans, `code chips`, and [links](https://ade.dev).

## What changed
- Blockquotes render with an accent bar
- Task lists: `[x]` becomes a glyph
- Tables scroll horizontally

1. First
2. Second

> Careful: this changes the wire contract.

| Column | Result |
| --- | --- |
| parse | ok |
| render | ok |

```kotlin
fun greet(name: String): String {
    return "hello ${'$'}name"
}
```
"""

private val SAMPLE_TOOL_GROUP = ChatTimelineItem.ToolGroup(
    "tools-1",
    listOf(
        ChatToolCall("t1", "Read", "Read", "apps/android/app/src/main/java/Main.kt", "…", ToolCallStatus.COMPLETED),
        ChatToolCall("t2", "bash", "bash", "./gradlew :app:test", "…", ToolCallStatus.RUNNING),
        ChatToolCall("t3", "Grep", "Grep", "foldChatTranscript", null, ToolCallStatus.FAILED),
    ),
)

private val SAMPLE_FILES = ChatTimelineItem.FilesChanged(
    "files-1",
    listOf(
        ChatFileChange(
            "f1", "apps/android/app/src/main/java/com/ade/android/ui/ChatPresentation.kt",
            FileChangeKind.CREATE, "@@ -0,0 +1,3 @@\n+package com.ade.android.ui\n+\n-removed\n", 2, 1,
        ),
        ChatFileChange("f2", "apps/android/README.md", FileChangeKind.MODIFY, "+docs\n", 1, 0),
    ),
)

private val SAMPLE_SUBAGENT = ChatTimelineItem.Subagent(
    "subagent-1",
    ChatSubagent(
        taskId = "task-1",
        agentId = "agent-7f3c",
        name = "Explore",
        agentType = "explore",
        status = SubagentStatus.SUCCEEDED,
        summary = "Located the transcript fold and the four call sites that depend on it.",
        durationLabel = "42s",
    ),
)

private val SAMPLE_MODELS = listOf(
    ChatModelOption("claude-opus-5", "Claude Opus 5", "claude", "high", listOf("low", "medium", "high"), listOf("fast")),
    ChatModelOption("gpt-5.6-sol", "GPT-5.6 Sol", "codex", "xhigh", listOf("medium", "high", "xhigh")),
    ChatModelOption("gemini-3-pro", "Gemini 3 Pro", "google"),
)

@Composable
private fun PreviewCanvas(dark: Boolean, content: @Composable () -> Unit) {
    AdeTheme(dark = dark) {
        Column(
            Modifier.fillMaxWidth().padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = { content() },
        )
    }
}

@Composable
private fun TranscriptSample() {
    TurnStartDivider(ChatTimelineItem.TurnStart("t", "2026-08-02T09:41:00Z", "claude"))
    UserMessageRow(ChatTimelineItem.UserMessage("u1", "Bring the chat transcript to parity with iOS.", "claude", null))
    AssistantMessageRow(ChatTimelineItem.AssistantMessage("a1", SAMPLE_MARKDOWN.trim(), false))
    ToolGroupRow(SAMPLE_TOOL_GROUP)
    FilesChangedRow(SAMPLE_FILES)
    SubagentCard(SAMPLE_SUBAGENT)
    UsagePill(ChatUsageSummary(18_420, 3_210, 120_000, 4_500, 0.0642))
    TurnEndDivider(ChatTimelineItem.TurnEnd("te", "2026-08-02T09:43:10Z", 130_000, true))
}

@Preview(name = "Transcript · dark", showBackground = true, heightDp = 1400)
@Composable
private fun TranscriptDarkPreview() = PreviewCanvas(dark = true) { TranscriptSample() }

@Preview(name = "Transcript · light", showBackground = true, heightDp = 1400)
@Composable
private fun TranscriptLightPreview() = PreviewCanvas(dark = false) { TranscriptSample() }

@Composable
private fun UserBubbleSample() {
    listOf("claude", "codex", "cursor", "opencode", "google", null).forEach { provider ->
        UserMessageRow(
            ChatTimelineItem.UserMessage("u-$provider", provider ?: "unknown provider", provider, null),
        )
    }
}

@Preview(name = "User bubbles per provider · dark", showBackground = true)
@Composable
private fun UserBubblesDarkPreview() = PreviewCanvas(dark = true) { UserBubbleSample() }

@Preview(name = "User bubbles per provider · light", showBackground = true)
@Composable
private fun UserBubblesLightPreview() = PreviewCanvas(dark = false) { UserBubbleSample() }

@Composable
private fun ApprovalSample() {
    ApprovalStrip(
        approval = ChatApproval("i1", "command", "Run `./gradlew :app:testDebugUnitTest`", "claude", false),
        enabled = true,
        onDecide = { _, _ -> },
        onOpenDetail = {},
    )
    ApprovalStrip(
        approval = ChatApproval("i2", "plan", "Refactor the transcript fold into three passes", "codex", true),
        enabled = true,
        onDecide = { _, _ -> },
        onOpenDetail = {},
    )
}

@Preview(name = "Approval strip · dark", showBackground = true)
@Composable
private fun ApprovalDarkPreview() = PreviewCanvas(dark = true) { ApprovalSample() }

@Preview(name = "Approval strip · light", showBackground = true)
@Composable
private fun ApprovalLightPreview() = PreviewCanvas(dark = false) { ApprovalSample() }

@Composable
private fun ComposerSample() {
    listOf(
        contextRingState(0.42),
        contextRingState(0.78),
        contextRingState(0.94),
        contextRingState(null),
        contextRingState(0.5, "compacting"),
    ).forEach { ring ->
        ChatComposer(
            text = "",
            onTextChange = {},
            placeholder = composerPlaceholder(emptyList()),
            modelLabel = "Claude Opus 5",
            modelProvider = "claude",
            effort = "xhigh",
            fastMode = true,
            accessMode = "Default",
            contextRing = ring,
            turnLive = ring.tone == ContextRingTone.DANGER,
            canSend = true,
            canAttach = true,
            onAttach = {},
            onOpenModelPicker = {},
            onCycleAccessMode = {},
            onSend = {},
            onStop = {},
        )
    }
    LoadEarlierRow(count = 50, loading = false, error = false, onLoad = {})
    LoadEarlierRow(count = null, loading = true, error = false, onLoad = {})
    LoadEarlierRow(count = null, loading = false, error = true, onLoad = {})
    JumpToLatestPill(unread = 3, onClick = {})
}

@Preview(name = "Composer · dark", showBackground = true, heightDp = 900)
@Composable
private fun ComposerDarkPreview() = PreviewCanvas(dark = true) { ComposerSample() }

@Preview(name = "Composer · light", showBackground = true, heightDp = 900)
@Composable
private fun ComposerLightPreview() = PreviewCanvas(dark = false) { ComposerSample() }

@Composable
private fun ModelPickerSample() {
    ChatModelPicker(
        options = SAMPLE_MODELS,
        selection = ChatModelSelection("claude-opus-5", "high", true),
        favouriteIds = setOf("gpt-5.6-sol"),
        recentIds = listOf("gemini-3-pro"),
        onSelect = {},
        onToggleFavourite = {},
        onClose = {},
    )
}

@Preview(name = "Model picker · dark", showBackground = true, heightDp = 700)
@Composable
private fun ModelPickerDarkPreview() = AdeTheme(dark = true) { ModelPickerSample() }

@Preview(name = "Model picker · light", showBackground = true, heightDp = 700)
@Composable
private fun ModelPickerLightPreview() = AdeTheme(dark = false) { ModelPickerSample() }

@Composable
private fun MonospacedSample() {
    AssistantMessageRow(
        ChatTimelineItem.AssistantMessage(
            "mono",
            """
            ┌─────────────┬──────────┐
            │ Component   │ Status   │
            ├─────────────┼──────────┤
            │ Transcript  │ done     │
            │ Composer    │ done     │
            └─────────────┴──────────┘
            """.trimIndent(),
            false,
        ),
    )
}

@Preview(name = "Monospaced fallback · dark", showBackground = true)
@Composable
private fun MonospacedDarkPreview() = PreviewCanvas(dark = true) { MonospacedSample() }

@Preview(name = "Monospaced fallback · light", showBackground = true)
@Composable
private fun MonospacedLightPreview() = PreviewCanvas(dark = false) { MonospacedSample() }
