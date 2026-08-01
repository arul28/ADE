package com.ade.android

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ForegroundServicePolicyTest {
    @Test
    fun `selected or live work keeps the connection service active`() {
        val idle = session("idle", "idle")
        val waiting = session("waiting", "waiting-input")

        assertTrue(needsForegroundService(idle.id, listOf(idle)))
        assertTrue(needsForegroundService(null, listOf(waiting)))
        assertFalse(needsForegroundService(null, listOf(idle)))
        assertTrue(isActiveWorkState("needs_you"))
        assertTrue(isActiveWorkState("awaiting-input"))
        assertFalse(isActiveWorkState("stopped"))
    }

    private fun session(id: String, runtimeState: String) = UiSession(
        id = id,
        laneId = "lane",
        laneName = "Lane",
        title = id,
        provider = "codex",
        toolType = "codex-chat",
        runtimeState = runtimeState,
        preview = null,
        kind = SessionKind.CHAT,
    )
}
