package com.ade.sync.auth

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.Serializable
import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

enum class AdoptionAead(val wireValue: String, val transformation: String) {
    CHACHA20_POLY1305("chacha20-poly1305", "ChaCha20-Poly1305"),
    AES_256_GCM("aes-256-gcm", "AES/GCM/NoPadding");

    companion object {
        fun fromWire(value: String): AdoptionAead? = entries.firstOrNull { it.wireValue == value }
    }
}

@Serializable
data class AccountChallenge(
    val v: Int = 1,
    val nonce: String,
    val clientEphemeralPublicKey: String,
    val supportedAeads: List<String>,
)

@Serializable
data class AccountChallengeOk(
    val v: Int,
    val hostDeviceId: String,
    val ts: Long,
    val hostEphemeralPublicKey: String,
    val signature: String,
    val aead: String? = null,
)

@Serializable
data class SealedHelloOk(val v: Int, val sealed: String)

class SealedAdoption private constructor(
    val challenge: AccountChallenge,
    private val privateKey: X25519PrivateKeyParameters,
    private val nonceBytes: ByteArray,
) {
    data class Session(
        val hostDeviceId: String,
        val clientDeviceId: String,
        val key: ByteArray,
        val aead: AdoptionAead,
    ) {
        fun sealHello(plaintext: ByteArray): String = Crypto.seal(
            key,
            "$CONTEXT|$hostDeviceId|$clientDeviceId".toByteArray(),
            plaintext,
            aead,
        )

        fun openHelloOk(sealed: String): ByteArray = Crypto.open(
            key,
            "$HELLO_OK_CONTEXT|$hostDeviceId|$clientDeviceId".toByteArray(),
            sealed,
            aead,
        )
    }

    fun verifyAndDerive(
        response: AccountChallengeOk,
        expectedHostDeviceId: String,
        directorySigningPublicKeyBase64: String,
        clientDeviceId: String,
        nowMillis: Long = System.currentTimeMillis(),
    ): Session {
        require(response.v == 1) { "Unsupported account adoption response" }
        require(response.hostDeviceId == expectedHostDeviceId) { "The adoption host identity changed" }
        require(kotlin.math.abs(nowMillis - response.ts) <= MAX_CLOCK_SKEW_MILLIS) {
            "The account adoption challenge is stale"
        }
        val aead = response.aead?.let(AdoptionAead::fromWire)
            ?: throw IllegalArgumentException("The host did not bind an adoption cipher")
        require(aead.wireValue in challenge.supportedAeads) { "The host selected an unadvertised adoption cipher" }
        val hostPublic = response.hostEphemeralPublicKey.decodeCanonical(32)
        val signingPublic = directorySigningPublicKeyBase64.decodeCanonical(32)
        val signature = response.signature.decodeCanonical(64)
        val canonical = listOf(
            CONTEXT,
            response.hostDeviceId,
            challenge.nonce,
            challenge.clientEphemeralPublicKey,
            response.hostEphemeralPublicKey,
            response.ts.toString(),
            aead.wireValue,
        ).joinToString("|")
        require(Crypto.verifyEd25519(signingPublic, canonical.toByteArray(), signature)) {
            "The machine adoption signature is invalid"
        }
        val agreement = X25519Agreement()
        agreement.init(privateKey)
        val shared = ByteArray(agreement.agreementSize)
        agreement.calculateAgreement(X25519PublicKeyParameters(hostPublic, 0), shared, 0)
        val hkdf = HKDFBytesGenerator(SHA256Digest())
        hkdf.init(HKDFParameters(shared, nonceBytes, CONTEXT.toByteArray()))
        val key = ByteArray(32)
        hkdf.generateBytes(key, 0, key.size)
        shared.fill(0)
        return Session(response.hostDeviceId, clientDeviceId, key, aead)
    }

    companion object {
        const val CONTEXT = "ade-adopt-v1"
        const val HELLO_OK_CONTEXT = "ade-adopt-v1-hellook"
        const val MAX_CLOCK_SKEW_MILLIS = 120_000L

        fun create(random: SecureRandom = SecureRandom()): SealedAdoption {
            val nonce = ByteArray(32).also(random::nextBytes)
            val private = X25519PrivateKeyParameters(random)
            val public = private.generatePublicKey().encoded
            return SealedAdoption(
                challenge = AccountChallenge(
                    nonce = Base64.getEncoder().encodeToString(nonce),
                    clientEphemeralPublicKey = Base64.getEncoder().encodeToString(public),
                    supportedAeads = AdoptionAead.entries.map(AdoptionAead::wireValue),
                ),
                privateKey = private,
                nonceBytes = nonce,
            )
        }
    }
}

private object Crypto {
    fun verifyEd25519(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean = runCatching {
        val verifier = Ed25519Signer()
        verifier.init(false, Ed25519PublicKeyParameters(publicKey, 0))
        verifier.update(message, 0, message.size)
        verifier.verifySignature(signature)
    }.getOrDefault(false)

    fun seal(key: ByteArray, aad: ByteArray, plaintext: ByteArray, aead: AdoptionAead): String {
        require(key.size == 32)
        val nonce = ByteArray(12).also(SecureRandom()::nextBytes)
        val cipher = Cipher.getInstance(aead.transformation)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, keyAlgorithm(aead)), parameter(aead, nonce))
        cipher.updateAAD(aad)
        return Base64.getEncoder().encodeToString(nonce + cipher.doFinal(plaintext))
    }

    fun open(key: ByteArray, aad: ByteArray, sealed: String, aead: AdoptionAead): ByteArray {
        require(key.size == 32)
        val blob = sealed.decodeCanonical()
        require(blob.size >= 12 + 16) { "Sealed adoption payload is malformed" }
        val nonce = blob.copyOfRange(0, 12)
        val encrypted = blob.copyOfRange(12, blob.size)
        val cipher = Cipher.getInstance(aead.transformation)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, keyAlgorithm(aead)), parameter(aead, nonce))
        cipher.updateAAD(aad)
        return cipher.doFinal(encrypted)
    }

    private fun keyAlgorithm(aead: AdoptionAead): String = when (aead) {
        AdoptionAead.CHACHA20_POLY1305 -> "ChaCha20"
        AdoptionAead.AES_256_GCM -> "AES"
    }

    private fun parameter(aead: AdoptionAead, nonce: ByteArray): java.security.spec.AlgorithmParameterSpec = when (aead) {
        AdoptionAead.CHACHA20_POLY1305 -> IvParameterSpec(nonce)
        AdoptionAead.AES_256_GCM -> GCMParameterSpec(128, nonce)
    }
}

private fun String.decodeCanonical(expected: Int? = null): ByteArray {
    require(isNotEmpty())
    val decoded = Base64.getDecoder().decode(this)
    require(Base64.getEncoder().encodeToString(decoded) == this) { "Non-canonical base64" }
    if (expected != null) require(decoded.size == expected) { "Unexpected decoded key length" }
    return decoded
}
