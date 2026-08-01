package com.ade.android.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.security.MessageDigest
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.adeDataStore by preferencesDataStore("ade_android_preferences_v1")

enum class Appearance { SYSTEM, LIGHT, DARK }

class AppPreferences(private val context: Context) {
    val appearance: Flow<Appearance> = context.adeDataStore.data.map { preferences ->
        runCatching { Appearance.valueOf(preferences[APPEARANCE] ?: Appearance.SYSTEM.name) }
            .getOrDefault(Appearance.SYSTEM)
    }

    // Product analytics follows ADE's existing default-on mobile policy. The
    // Android setting is a durable opt-out and is reasserted for every host.
    val analyticsEnabled: Flow<Boolean> = context.adeDataStore.data.map { it[ANALYTICS_ENABLED] ?: true }
    val pushEnabled: Flow<Boolean> = context.adeDataStore.data.map { it[PUSH_ENABLED] ?: false }

    suspend fun setAppearance(value: Appearance) = context.adeDataStore.edit { it[APPEARANCE] = value.name }
    suspend fun setAnalyticsEnabled(value: Boolean) = context.adeDataStore.edit { it[ANALYTICS_ENABLED] = value }
    suspend fun setPushEnabled(value: Boolean) = context.adeDataStore.edit { it[PUSH_ENABLED] = value }

    fun cached(machineKey: String, domain: String): Flow<String?> = context.adeDataStore.data.map {
        it[cacheKey(machineKey, domain)]
    }

    suspend fun cache(machineKey: String, domain: String, json: String) = context.adeDataStore.edit {
        it[cacheKey(machineKey, domain)] = json
    }

    fun hubOrder(machineKey: String): Flow<String?> = context.adeDataStore.data.map { it[hubKey(machineKey, "order")] }
    fun hubCollapsed(machineKey: String): Flow<String?> = context.adeDataStore.data.map { it[hubKey(machineKey, "collapsed")] }
    fun hubCollapsedLanes(machineKey: String): Flow<String?> = context.adeDataStore.data.map { it[hubKey(machineKey, "collapsed_lanes")] }
    fun composerDraft(machineKey: String): Flow<String> = context.adeDataStore.data.map { it[hubKey(machineKey, "draft")] ?: "" }
    fun composerPreferences(machineKey: String): Flow<String?> = context.adeDataStore.data.map { it[hubKey(machineKey, "composer_preferences")] }

    suspend fun setHubOrder(machineKey: String, value: String) = put(hubKey(machineKey, "order"), value)
    suspend fun setHubCollapsed(machineKey: String, value: String) = put(hubKey(machineKey, "collapsed"), value)
    suspend fun setHubCollapsedLanes(machineKey: String, value: String) = put(hubKey(machineKey, "collapsed_lanes"), value)
    suspend fun setComposerDraft(machineKey: String, value: String) = put(hubKey(machineKey, "draft"), value)
    suspend fun setComposerPreferences(machineKey: String, value: String) = put(hubKey(machineKey, "composer_preferences"), value)

    suspend fun clearMachine(machineKey: String) {
        val suffix = safe(machineKey)
        context.adeDataStore.edit { preferences ->
            preferences.asMap().keys.filter { key ->
                key.name.startsWith("cache.$suffix.") || key.name.startsWith("hub.$suffix.")
            }.forEach { key -> preferences.remove(key) }
        }
    }

    private suspend fun put(key: Preferences.Key<String>, value: String) = context.adeDataStore.edit { it[key] = value }

    private fun cacheKey(machineKey: String, domain: String) = stringPreferencesKey("cache.${safe(machineKey)}.$domain")
    private fun hubKey(machineKey: String, name: String) = stringPreferencesKey("hub.${safe(machineKey)}.$name")

    private fun safe(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray()).take(8).joinToString("") { "%02x".format(it) }

    companion object {
        private val APPEARANCE = stringPreferencesKey("appearance")
        private val ANALYTICS_ENABLED = booleanPreferencesKey("analytics_enabled")
        private val PUSH_ENABLED = booleanPreferencesKey("push_enabled")
    }
}
