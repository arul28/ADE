package com.ade.android.account

import com.ade.android.BuildConfig
import com.clerk.api.Clerk
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.network.serialization.errorMessage
import com.clerk.api.session.GetTokenOptions
import com.clerk.api.signin.SignIn
import com.clerk.api.signin.verifyCode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow

class AuthRepository {
    private var signIn: SignIn? = null

    val configured: Boolean get() = BuildConfig.CLERK_PUBLISHABLE_KEY.isNotBlank()
    val session get() = if (configured) Clerk.session else null
    val sessionFlow: Flow<com.clerk.api.session.Session?>? get() = if (!configured) null else flow {
        awaitInitialized()
        // Initialization restores the native device credential but can finish
        // before the server-backed client/session snapshot is populated.
        // Refresh once before exposing auth state so a process restart does not
        // briefly or permanently look signed out.
        Clerk.refreshClient()
        emitAll(Clerk.sessionFlow)
    }
    val signedIn: Boolean get() = configured && Clerk.activeSession != null
    val userId: String? get() = if (configured) Clerk.activeSession?.user?.id else null
    val displayName: String? get() = if (!configured) null else Clerk.activeSession?.user?.let { user ->
        listOfNotNull(user.firstName, user.lastName).joinToString(" ").trim().takeIf(String::isNotBlank)
            ?: user.username?.trim()?.takeIf(String::isNotBlank)
            ?: user.primaryEmailAddress?.emailAddress?.trim()?.takeIf(String::isNotBlank)
            ?: user.id
    }
    val emailAddress: String? get() = if (configured) Clerk.activeSession?.user?.primaryEmailAddress?.emailAddress else null

    suspend fun sendEmailCode(email: String): Result<Unit> {
        if (!configured) return Result.failure(IllegalStateException("Set ADE_CLERK_PUBLISHABLE_KEY to enable account sign-in."))
        awaitInitialized()
        return when (val result = Clerk.auth.signInWithOtp { this.email = email.trim() }) {
            is ClerkResult.Success -> {
                signIn = result.value
                Result.success(Unit)
            }
            is ClerkResult.Failure -> Result.failure(IllegalStateException(result.errorMessage))
        }
    }

    suspend fun verifyEmailCode(code: String): Result<Unit> {
        awaitInitialized()
        val current = signIn ?: return Result.failure(IllegalStateException("Request a new email code first."))
        return when (val result = current.verifyCode(code.trim())) {
            is ClerkResult.Success -> {
                signIn = result.value
                val sessionId = result.value.createdSessionId?.trim().orEmpty()
                if (result.value.status != SignIn.Status.COMPLETE || sessionId.isBlank()) {
                    Result.failure(IllegalStateException("Clerk sign-in did not create an active session."))
                } else when (val activation = Clerk.auth.setActive(sessionId = sessionId)) {
                    is ClerkResult.Success -> Result.success(Unit)
                    is ClerkResult.Failure -> Result.failure(IllegalStateException(activation.errorMessage))
                }
            }
            is ClerkResult.Failure -> Result.failure(IllegalStateException(result.errorMessage))
        }
    }

    suspend fun freshToken(skipCache: Boolean = false): String? {
        if (!configured) return null
        awaitInitialized()
        if (Clerk.activeSession == null) return null
        return when (val result = Clerk.auth.getToken(GetTokenOptions(skipCache = skipCache))) {
            is ClerkResult.Success -> result.value
            is ClerkResult.Failure -> null
        }
    }

    suspend fun signOut(): Result<Unit> {
        if (!configured) return Result.success(Unit)
        awaitInitialized()
        return when (val result = Clerk.auth.signOut()) {
            is ClerkResult.Success -> Result.success(Unit)
            is ClerkResult.Failure -> Result.failure(IllegalStateException(result.errorMessage))
        }
    }

    private suspend fun awaitInitialized() {
        Clerk.isInitialized.first { it }
    }
}
