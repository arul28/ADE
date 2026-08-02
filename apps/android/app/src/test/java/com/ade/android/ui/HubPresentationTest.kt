package com.ade.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HubPresentationTest {
    @Test
    fun `pluralize handles zero one and many`() {
        assertEquals("0 lanes", pluralize(0, "lane"))
        assertEquals("1 lane", pluralize(1, "lane"))
        assertEquals("2 lanes", pluralize(2, "lane"))
    }

    @Test
    fun `lane chat summary pluralises both halves independently`() {
        assertEquals("1 lane · 0 chats", laneChatSummary(1, 0))
        assertEquals("0 lanes · 1 chat", laneChatSummary(0, 1))
        assertEquals("3 lanes · 12 chats", laneChatSummary(3, 12))
    }

    @Test
    fun `hub reuses the shared middle truncation for long project names`() {
        // Long worktree names must keep their distinguishing tail rather than
        // wrapping to a second line. `middleTruncate` lives in
        // ChatPresentation.kt and is shared, not duplicated, by the Hub.
        assertEquals("ADE", middleTruncate("ADE", 38))
        val long = "ade-win-smoke-" + "x".repeat(60) + "-fd060be1323"
        val truncated = middleTruncate(long, 38)
        assertEquals(38, truncated.length)
        assertTrue(truncated.startsWith("ade-win-"))
        assertTrue(truncated.endsWith("fd060be1323"))
        assertTrue("…" in truncated)
    }

    @Test
    fun `project monogram distinguishes hyphenated worktrees`() {
        assertEquals("AW", projectMonogram("ade-win-smoke-9f2"))
        assertEquals("AD", projectMonogram("ADE"))
        assertEquals("AC", projectMonogram("ade companion"))
        assertEquals("MR", projectMonogram("my_repo"))
        assertNotEquals(projectMonogram("ade-win-smoke-9f2"), projectMonogram("ADE"))
    }

    @Test
    fun `project monogram survives odd names`() {
        assertEquals("?", projectMonogram(""))
        assertEquals("?", projectMonogram("---"))
        assertEquals("2A", projectMonogram("2024-alpha"))
    }

    @Test
    fun `project tint is deterministic and in palette`() {
        val first = projectTintArgb("project-a")
        assertEquals(first, projectTintArgb("project-a"))
        assertTrue(first in projectTintPalette)
        assertTrue(projectTintArgb("project-b") in projectTintPalette)
    }

    @Test
    fun `lane colours are darkened for light mode only`() {
        val amber = 0xFFF59E0BL
        assertEquals(amber, readableOnLightArgb(amber, isDark = true))
        val darkened = readableOnLightArgb(amber, isDark = false)
        assertNotEquals(amber, darkened)
        assertEquals(0xFF000000L, darkened and 0xFF000000L)
        fun lum(argb: Long) = (0.2126 * ((argb shr 16) and 0xFF) +
            0.7152 * ((argb shr 8) and 0xFF) + 0.0722 * (argb and 0xFF)) / 255.0
        assertTrue(lum(darkened) <= 0.35)
    }

    @Test
    fun `already dark lane colours pass through light mode untouched`() {
        val deepBlue = 0xFF1D4ED8L
        assertEquals(deepBlue, readableOnLightArgb(deepBlue, isDark = false))
    }
}
