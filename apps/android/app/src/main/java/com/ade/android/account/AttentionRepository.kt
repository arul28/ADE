package com.ade.android.account

import android.os.Build
import com.ade.android.BuildConfig
import com.ade.android.security.SecureMachineStore
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class StaleAttentionOwnershipException(message: String) : IOException(message)

class AttentionRepository(
    private val baseUrl: String,
    private val http: OkHttpClient,
    private val tokenProvider: suspend () -> String?,
    val deviceId: String,
    private val secureStore: SecureMachineStore,
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    suspend fun snapshot(since: String? = null, streamId: String? = null): JsonObject {
        val cursor = since?.takeIf(String::isNotBlank) ?: "0"
        val stream = streamId?.takeIf(String::isNotBlank)?.let { "&streamId=${encode(it)}" }.orEmpty()
        return request("GET", "/attention/account/snapshot?since=${encode(cursor)}$stream")
    }

    suspend fun acknowledge(itemIds: List<String>, dismiss: Boolean): JsonObject = request(
        "POST",
        "/attention/account/ack",
        buildJsonObject {
            putJsonArray("itemIds") { itemIds.distinct().take(64).forEach { add(JsonPrimitive(it)) } }
            put("seenAt", java.time.Instant.now().toString())
            if (dismiss) put("dismissedAt", java.time.Instant.now().toString())
        },
    )

    suspend fun presence(visibleItemIds: List<String>, foreground: Boolean): JsonObject = request(
        "POST",
        "/attention/account/presence",
        buildJsonObject {
            put("deviceId", deviceId)
            put("platform", "android")
            put("appForeground", foreground)
            put("observedAt", java.time.Instant.now().toString())
            putJsonArray("visibleItemIds") { visibleItemIds.take(64).forEach { add(JsonPrimitive(it)) } }
        },
    )

    suspend fun preferences(): JsonObject = request("GET", "/attention/account/preferences")

    suspend fun putPreferences(value: JsonObject): JsonObject = request(
        "PUT", "/attention/account/preferences", value,
    )

    suspend fun patchDevicePreferences(value: JsonObject): JsonObject = request(
        "PATCH",
        "/attention/account/preferences/devices/${encode(deviceId)}",
        value,
    )

    suspend fun registerFcm(token: String, notificationsEnabled: Boolean, ownerId: String): JsonObject {
        require(token.length in 20..4096) { "Invalid FCM registration token" }
        val ownershipEpoch = secureStore.attentionEpochForOwner(ownerId)
        return request(
            "PUT",
            "/attention/account/devices/${encode(deviceId)}",
            buildJsonObject {
                put("ownershipEpoch", ownershipEpoch)
                put("fcmToken", token)
                put("bundleId", BuildConfig.APPLICATION_ID)
                put("platform", "android")
                put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                putJsonObject("preferences") {
                    put("notificationsEnabled", notificationsEnabled)
                }
            },
        ).also { secureStore.confirmAttentionRegistration(ownerId, ownershipEpoch) }
    }

    suspend fun unregisterForSignOut(): JsonObject {
        val ownershipEpoch = secureStore.beginAttentionRevocation()
        return request(
            "DELETE",
            "/attention/account/devices/${encode(deviceId)}",
            buildJsonObject { put("ownershipEpoch", ownershipEpoch) },
        ).also { secureStore.completeAttentionRevocation(ownershipEpoch) }
    }

    private suspend fun request(method: String, path: String, body: JsonElement? = null): JsonObject =
        withContext(Dispatchers.IO) {
            var lastStatus = 0
            repeat(2) { attempt ->
                val token = tokenProvider() ?: throw IOException("Sign in to use account attention.")
                val builder = Request.Builder()
                    .url("${baseUrl.trimEnd('/')}$path")
                    .header("Authorization", "Bearer $token")
                val requestBody = body?.toString()?.toRequestBody(JSON_MEDIA_TYPE)
                when (method) {
                    "GET" -> builder.get()
                    "POST" -> builder.post(requestBody ?: EMPTY_BODY)
                    "PUT" -> builder.put(requestBody ?: EMPTY_BODY)
                    "PATCH" -> builder.patch(requestBody ?: EMPTY_BODY)
                    "DELETE" -> builder.delete(requestBody)
                    else -> error("Unsupported attention method")
                }
                http.newCall(builder.build()).execute().use { response ->
                    lastStatus = response.code
                    val raw = response.body.string()
                    val parsed = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
                        ?: JsonObject(emptyMap())
                    if (response.isSuccessful) return@withContext parsed
                    if (response.code == 409) {
                        throw StaleAttentionOwnershipException(
                            parsed["error"]?.toString()?.trim('"') ?: "This device registration belongs to a newer account session.",
                        )
                    }
                    if (response.code != 401 || attempt == 1) {
                        throw IOException("Attention request failed (${response.code}).")
                    }
                }
            }
            throw IOException("Attention request failed ($lastStatus).")
        }

    private fun encode(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name())

    companion object {
        private val JSON_MEDIA_TYPE = "application/json".toMediaType()
        private val EMPTY_BODY = "{}".toRequestBody(JSON_MEDIA_TYPE)
    }
}
