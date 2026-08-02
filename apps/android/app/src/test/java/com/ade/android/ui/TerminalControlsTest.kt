package com.ade.android.ui

import kotlin.test.Test
import kotlin.test.assertEquals

class TerminalControlsTest {
    @Test
    fun `terminal key bar sends canonical control sequences`() {
        assertEquals("\u001B", terminalPrimaryKeys.first { it.label == "esc" }.sequence)
        assertEquals("\u001B[Z", terminalPrimaryKeys.first { it.label == "shift tab" }.sequence)
        assertEquals("\\\r", terminalPrimaryKeys.first { it.label == "soft return" }.sequence)
        assertEquals("\u0003", terminalControlKeys.first { it.label == "^C" }.sequence)
        assertEquals("\u0012", terminalControlKeys.first { it.label == "^R" }.sequence)
    }
}
