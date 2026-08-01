package com.ade.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Light = lightColorScheme(
    primary = Color(0xFF9A5B00),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDDA6),
    onPrimaryContainer = Color(0xFF2F1900),
    secondary = Color(0xFF665C4C),
    background = Color(0xFFFAF8F4),
    surface = Color(0xFFFFFCF7),
    surfaceVariant = Color(0xFFEDE7DD),
    outline = Color(0xFF7E766A),
)

private val Dark = darkColorScheme(
    primary = Color(0xFFFFB94E),
    onPrimary = Color(0xFF4D2B00),
    primaryContainer = Color(0xFF6F3F00),
    onPrimaryContainer = Color(0xFFFFDDA6),
    secondary = Color(0xFFD2C4AE),
    background = Color(0xFF11100F),
    surface = Color(0xFF181715),
    surfaceVariant = Color(0xFF2C2925),
    outline = Color(0xFF9B9286),
)

@Composable
fun AdeTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) Dark else Light, content = content)
}
