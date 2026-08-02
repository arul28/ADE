@file:Suppress("DEPRECATION")

package com.ade.android.security

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.ade.sync.model.DirectoryMachine
import com.ade.sync.transport.RouteCandidate
import com.ade.sync.transport.RouteKind
import java.security.MessageDigest
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class SavedEndpoint(val url: String, val kind: String)

@Serializable
data class MachineProfile(
    val machineKey: String,
    val hostDeviceId: String,
    val accountMachineKey: String? = null,
    val name: String,
    val pairedDeviceId: String,
    val siteId: String,
    val secret: String,
    val endpoints: List<SavedEndpoint>,
    val directorySigningPublicKey: String? = null,
    val connectionAuthKind: String = "paired",
    val bootstrapToken: String? = null,
    val routeMemory: Map<String, String> = emptyMap(),
    val lastConnectedAt: Long? = null,
) {
    fun matches(directory: DirectoryMachine): Boolean =
        directory.machineKey == machineKey || directory.machineKey == accountMachineKey ||
            (!directory.deviceId.isNullOrBlank() && directory.deviceId == hostDeviceId)

    fun routeCandidates(networkFingerprint: String? = null): List<RouteCandidate> = endpoints.mapNotNull { endpoint ->
        val kind = when (endpoint.kind) {
            "lan" -> RouteKind.LAN
            "tailnet", "tailscale" -> RouteKind.TAILNET
            "relay" -> RouteKind.RELAY
            else -> null
        } ?: return@mapNotNull null
        RouteCandidate(endpoint.url, kind, remembered = routeMemory[networkFingerprint] == endpoint.url)
    }
}

data class AttentionActionBinding(val ownerHash: String, val epoch: Long)

private fun encryptedPreferences(context: Context) = EncryptedSharedPreferences.create(
    context,
    "ade_machine_credentials_v1",
    MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
)

class SecureMachineStore internal constructor(
    private val preferences: android.content.SharedPreferences,
    private val deleteDpopKey: (String) -> Unit,
) {
    constructor(context: Context) : this(encryptedPreferences(context), AndroidDpopKey::delete)

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    fun list(): List<MachineProfile> = preferences.getStringSet(INDEX_KEY, emptySet()).orEmpty()
        .mapNotNull(::get)
        .sortedByDescending { it.lastConnectedAt ?: 0 }

    fun get(machineKey: String): MachineProfile? = preferences.getString(profileKey(machineKey), null)
        ?.let { runCatching { json.decodeFromString(MachineProfile.serializer(), it) }.getOrNull() }

    fun findForAccountMachine(accountMachineKey: String): MachineProfile? =
        get(accountMachineKey) ?: list().firstOrNull { profile ->
            profile.accountMachineKey == accountMachineKey || profile.hostDeviceId == accountMachineKey
        }

    fun put(profile: MachineProfile) {
        val keys = preferences.getStringSet(INDEX_KEY, emptySet()).orEmpty().toMutableSet().apply { add(profile.machineKey) }
        preferences.edit()
            .putString(profileKey(profile.machineKey), json.encodeToString(profile))
            .putStringSet(INDEX_KEY, keys)
            .apply()
    }

    fun current(): MachineProfile? = preferences.getString(CURRENT_KEY, null)?.let(::get)

    fun setCurrent(machineKey: String?) {
        preferences.edit().apply {
            if (machineKey == null) remove(CURRENT_KEY) else putString(CURRENT_KEY, machineKey)
        }.apply()
    }

    /** Sign-out deliberately does not call this. Forget is the trust-deletion boundary. */
    fun forget(machineKey: String) {
        val keys = preferences.getStringSet(INDEX_KEY, emptySet()).orEmpty().toMutableSet().apply { remove(machineKey) }
        if (preferences.getString(CURRENT_KEY, null) == machineKey) setCurrent(null)
        preferences.edit().remove(profileKey(machineKey)).putStringSet(INDEX_KEY, keys).apply()
        deleteDpopKey(dpopAlias(machineKey))
    }

    fun dpopKey(context: Context, machineKey: String): AndroidDpopKey =
        AndroidDpopKey.getOrCreate(context, dpopAlias(machineKey))

    fun localDeviceId(): String = stableId(LOCAL_DEVICE_ID_KEY, "android")
    fun localSiteId(): String = stableId(LOCAL_SITE_ID_KEY, "site")

    fun localPushEnabled(): Boolean = preferences.getBoolean(LOCAL_PUSH_ENABLED_KEY, false)

    fun setLocalPushEnabled(enabled: Boolean) {
        preferences.edit().putBoolean(LOCAL_PUSH_ENABLED_KEY, enabled).commit()
    }

    @Synchronized
    fun attentionEpochForOwner(ownerId: String): Long {
        val ownerHash = ownerHash(ownerId)
        val previousEpoch = attentionEpoch()
        val previousOwner = preferences.getString(ATTENTION_OWNER_KEY, null)
        val pendingRevocation = preferences.getBoolean(ATTENTION_REVOCATION_PENDING_KEY, false)
        if (previousOwner == ownerHash && !pendingRevocation) return previousEpoch
        val next = nextEpoch(previousEpoch)
        preferences.edit()
            .putLong(ATTENTION_EPOCH_KEY, next)
            .putString(ATTENTION_OWNER_KEY, ownerHash)
            .putBoolean(ATTENTION_REVOCATION_PENDING_KEY, false)
            .putBoolean(ATTENTION_REGISTRATION_CONFIRMED_KEY, false)
            .commit()
        return next
    }

    @Synchronized
    fun confirmAttentionRegistration(ownerId: String, epoch: Long) {
        if (
            preferences.getLong(ATTENTION_EPOCH_KEY, 0L) != epoch
            || preferences.getString(ATTENTION_OWNER_KEY, null) != ownerHash(ownerId)
        ) return
        preferences.edit().putBoolean(ATTENTION_REGISTRATION_CONFIRMED_KEY, true).commit()
    }

    @Synchronized
    fun isAttentionRegistrationConfirmed(ownerId: String): Boolean =
        preferences.getString(ATTENTION_OWNER_KEY, null) == ownerHash(ownerId) &&
            !preferences.getBoolean(ATTENTION_REVOCATION_PENDING_KEY, false) &&
            preferences.getBoolean(ATTENTION_REGISTRATION_CONFIRMED_KEY, false)

    @Synchronized
    fun attentionActionBinding(ownerId: String): AttentionActionBinding? {
        if (!isAttentionRegistrationConfirmed(ownerId)) return null
        return AttentionActionBinding(
            ownerHash = ownerHash(ownerId),
            epoch = preferences.getLong(ATTENTION_EPOCH_KEY, 0L),
        )
    }

    @Synchronized
    fun isAttentionActionCurrent(ownerId: String, expectedOwnerHash: String, expectedEpoch: Long): Boolean =
        expectedEpoch > 0 && expectedOwnerHash == ownerHash(ownerId) &&
            preferences.getLong(ATTENTION_EPOCH_KEY, 0L) == expectedEpoch &&
            preferences.getString(ATTENTION_OWNER_KEY, null) == expectedOwnerHash &&
            !preferences.getBoolean(ATTENTION_REVOCATION_PENDING_KEY, false) &&
            preferences.getBoolean(ATTENTION_REGISTRATION_CONFIRMED_KEY, false)

    /** Persist the higher revocation epoch before attempting the network call. */
    @Synchronized
    fun beginAttentionRevocation(): Long {
        val current = attentionEpoch()
        if (preferences.getBoolean(ATTENTION_REVOCATION_PENDING_KEY, false)) return current
        val next = nextEpoch(current)
        preferences.edit()
            .putLong(ATTENTION_EPOCH_KEY, next)
            .putBoolean(ATTENTION_REVOCATION_PENDING_KEY, true)
            .putBoolean(ATTENTION_REGISTRATION_CONFIRMED_KEY, false)
            .commit()
        return next
    }

    @Synchronized
    fun completeAttentionRevocation(epoch: Long) {
        if (preferences.getLong(ATTENTION_EPOCH_KEY, 0L) != epoch) return
        preferences.edit()
            .remove(ATTENTION_OWNER_KEY)
            .putBoolean(ATTENTION_REVOCATION_PENDING_KEY, false)
            .putBoolean(ATTENTION_REGISTRATION_CONFIRMED_KEY, false)
            .commit()
    }

    @Synchronized
    private fun attentionEpoch(): Long {
        val stored = preferences.getLong(ATTENTION_EPOCH_KEY, 0L)
        if (stored > 0) return stored
        val created = System.currentTimeMillis().coerceAtLeast(1)
        preferences.edit().putLong(ATTENTION_EPOCH_KEY, created).commit()
        return created
    }

    private fun nextEpoch(current: Long): Long = if (current == Long.MAX_VALUE) current else current + 1
    private fun ownerHash(ownerId: String): String = MessageDigest.getInstance("SHA-256")
        .digest(ownerId.trim().toByteArray()).joinToString("") { "%02x".format(it) }

    private fun stableId(key: String, prefix: String): String {
        preferences.getString(key, null)?.let { return it }
        val value = "$prefix-${UUID.randomUUID()}"
        preferences.edit().putString(key, value).commit()
        return value
    }

    private fun profileKey(machineKey: String) = "profile.$machineKey"

    companion object {
        private const val INDEX_KEY = "machines"
        private const val CURRENT_KEY = "current_machine"
        private const val LOCAL_DEVICE_ID_KEY = "local_device_id"
        private const val LOCAL_SITE_ID_KEY = "local_site_id"
        private const val ATTENTION_EPOCH_KEY = "attention.ownership_epoch"
        private const val ATTENTION_OWNER_KEY = "attention.owner_hash"
        private const val ATTENTION_REVOCATION_PENDING_KEY = "attention.revocation_pending"
        private const val ATTENTION_REGISTRATION_CONFIRMED_KEY = "attention.registration_confirmed"
        private const val LOCAL_PUSH_ENABLED_KEY = "attention.local_push_enabled"

        fun dpopAlias(machineKey: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(machineKey.toByteArray())
                .take(12).joinToString("") { "%02x".format(it) }
            return "ade.dpop.$digest"
        }
    }
}
