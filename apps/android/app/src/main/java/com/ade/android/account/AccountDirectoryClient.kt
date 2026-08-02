package com.ade.android.account

import com.ade.sync.model.DirectoryMachine
import com.ade.sync.model.DirectoryMachineList
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class AccountDirectoryClient(
    private val baseUrl: String,
    private val http: OkHttpClient,
    private val tokenProvider: suspend (skipCache: Boolean) -> String?,
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    suspend fun machines(): List<DirectoryMachine> = requestWithRetry { token ->
        Request.Builder().url("${baseUrl.trimEnd('/')}/account/machines")
            .header("Authorization", "Bearer $token")
            .get().build()
    }.let { json.decodeFromString(DirectoryMachineList.serializer(), it).machines }

    suspend fun rename(machineKey: String, customName: String) {
        require(customName.trim().length in 1..80)
        val body = json.encodeToString(buildJsonObject { put("customName", customName.trim()) })
            .toRequestBody("application/json".toMediaType())
        requestWithRetry { token ->
            Request.Builder().url("${baseUrl.trimEnd('/')}/account/machines/$machineKey")
                .header("Authorization", "Bearer $token")
                .patch(body).build()
        }
    }

    private suspend fun requestWithRetry(build: (String) -> Request): String = withContext(Dispatchers.IO) {
        var lastStatus = 0
        repeat(2) { attempt ->
            val token = tokenProvider(attempt > 0) ?: throw IOException("Sign in to view your machines.")
            http.newCall(build(token)).execute().use { response ->
                lastStatus = response.code
                if (response.isSuccessful) return@withContext response.body.string()
                if (response.code != 401 || attempt == 1) {
                    val reason = response.body.string().let(::safeErrorReason)
                    throw IOException(buildFailureMessage(response.code, reason))
                }
            }
        }
        throw IOException("Account directory request failed ($lastStatus).")
    }

    private fun safeErrorReason(body: String): String? = runCatching {
        json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.content
            ?.trim()
            ?.takeIf { it.matches(Regex("[a-zA-Z0-9 _-]{1,80}")) }
    }.getOrNull()

    private fun buildFailureMessage(status: Int, reason: String?): String =
        if (reason == null) "Account directory request failed ($status)."
        else "Account directory request failed ($status: $reason)."
}
