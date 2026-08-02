package com.ade.android.account

import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

class AccountDirectoryClientTest {
    @Test
    fun `401 retries once with a cache-bypassing token`() = runBlocking {
        val requestedTokens = mutableListOf<String>()
        val refreshModes = mutableListOf<Boolean>()
        val http = client { chain ->
            requestedTokens += chain.request().header("Authorization").orEmpty()
            response(chain, if (requestedTokens.size == 1) 401 else 200, if (requestedTokens.size == 1) {
                "{\"error\":\"token expired\"}"
            } else {
                "{\"machines\":[]}"
            })
        }
        val directory = AccountDirectoryClient("https://directory.test", http) { skipCache ->
            refreshModes += skipCache
            if (skipCache) "fresh-token" else "cached-token"
        }

        assertEquals(emptyList(), directory.machines())
        assertEquals(listOf(false, true), refreshModes)
        assertEquals(listOf("Bearer cached-token", "Bearer fresh-token"), requestedTokens)
    }

    @Test
    fun `final 401 includes only the worker safe reason`() = runBlocking {
        val http = client { chain ->
            response(chain, 401, "{\"error\":\"invalid audience\",\"detail\":\"must not escape\"}")
        }
        val directory = AccountDirectoryClient("https://directory.test", http) { "token" }

        val error = assertFailsWith<IOException> { directory.machines() }

        assertEquals("Account directory request failed (401: invalid audience).", error.message)
        assertTrue(error.message.orEmpty().contains("must not escape").not())
    }

    private fun client(handler: (Interceptor.Chain) -> Response): OkHttpClient =
        OkHttpClient.Builder().addInterceptor(handler).build()

    private fun response(chain: Interceptor.Chain, status: Int, body: String): Response =
        Response.Builder()
            .request(chain.request())
            .protocol(Protocol.HTTP_1_1)
            .code(status)
            .message("test")
            .body(body.toResponseBody())
            .build()
}
