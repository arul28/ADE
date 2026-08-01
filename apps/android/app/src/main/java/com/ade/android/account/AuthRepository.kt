package com.ade.android.account

import com.ade.android.BuildConfig
import com.clerk.api.Clerk
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.network.serialization.errorMessage
import com.clerk.api.signin.SignIn
import com.clerk.api.signin.attemptFirstFactor
import kotlinx.coroutines.flow.StateFlow

class AuthRepository {
    private var signIn: SignIn? = null

    val configured: Boolean get() = BuildConfig.CLERK_PUBLISHABLE_KEY.isNotBlank()
    val session get() = if (configured) Clerk.session else null
    val sessionFlow: StateFlow<com.clerk.api.session.Session?>? get() = if (configured) Clerk.sessionFlow else null
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
        return when (val result = Clerk.auth.signInWithOtp { this.email = email.trim() }) {
            is ClerkResult.Success -> {
                signIn = result.value
                Result.success(Unit)
            }
            is ClerkResult.Failure -> Result.failure(IllegalStateException(result.errorMessage))
        }
    }

    suspend fun verifyEmailCode(code: String): Result<Unit> {
        val current = signIn ?: return Result.failure(IllegalStateException("Request a new email code first."))
        return when (val result = current.attemptFirstFactor(SignIn.AttemptFirstFactorParams.EmailCode(code.trim()))) {
            is ClerkResult.Success -> {
                signIn = result.value
                when (val refresh = Clerk.refreshClient()) {
                    is ClerkResult.Success -> Result.success(Unit)
                    is ClerkResult.Failure -> Result.failure(IllegalStateException(refresh.errorMessage))
                }
            }
            is ClerkResult.Failure -> Result.failure(IllegalStateException(result.errorMessage))
        }
    }

    suspend fun freshToken(): String? {
        if (!configured || Clerk.activeSession == null) return null
        return when (val result = Clerk.auth.getToken()) {
            is ClerkResult.Success -> result.value
            is ClerkResult.Failure -> null
        }
    }

    suspend fun signOut(): Result<Unit> {
        if (!configured) return Result.success(Unit)
        return when (val result = Clerk.auth.signOut()) {
            is ClerkResult.Success -> Result.success(Unit)
            is ClerkResult.Failure -> Result.failure(IllegalStateException(result.errorMessage))
        }
    }
}
