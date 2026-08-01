package com.ade.android.account

import com.ade.sync.model.DirectoryMachine
import com.ade.sync.model.DirectoryMachineList
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class AccountDirectoryClient(
    private val baseUrl: String,
    private val http: OkHttpClient,
    private val tokenProvider: suspend () -> String?,
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
            val token = tokenProvider() ?: throw IOException("Sign in to view your machines.")
            http.newCall(build(token)).execute().use { response ->
                lastStatus = response.code
                if (response.isSuccessful) return@withContext response.body.string()
                if (response.code != 401 || attempt == 1) {
                    throw IOException("Account directory request failed (${response.code}).")
                }
            }
        }
        throw IOException("Account directory request failed ($lastStatus).")
    }
}
