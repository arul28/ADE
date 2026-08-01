package com.ade.android.security

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import com.ade.sync.auth.DpopKey
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.ProviderException
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

class DpopKeyInvalidatedException(cause: Throwable) :
    IllegalStateException("This device security key was invalidated. Pair the machine again.", cause)

class AndroidDpopKey private constructor(private val alias: String) : DpopKey {
    private val store: KeyStore get() = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    override val publicKeyX963: ByteArray
        get() {
            val key = store.getCertificate(alias)?.publicKey as? ECPublicKey
                ?: throw IllegalStateException("The Android DPoP key is missing")
            return byteArrayOf(0x04) + key.w.affineX.fixed(32) + key.w.affineY.fixed(32)
        }

    override fun signSha256Ecdsa(message: ByteArray): ByteArray = try {
        val privateKey = store.getKey(alias, null)
            ?: throw IllegalStateException("The Android DPoP key is missing")
        Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey as java.security.PrivateKey)
            update(message)
            sign()
        }
    } catch (error: Throwable) {
        val invalidated = generateSequence(error as Throwable?) { it.cause }
            .filterIsInstance<KeyPermanentlyInvalidatedException>()
            .firstOrNull()
        if (invalidated != null) {
            delete(alias)
            throw DpopKeyInvalidatedException(invalidated)
        }
        throw error
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"

        fun getOrCreate(context: Context, alias: String): AndroidDpopKey {
            val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            if (!store.containsAlias(alias)) generate(alias, preferStrongBox = Build.VERSION.SDK_INT >= 28)
            return AndroidDpopKey(alias)
        }

        fun delete(alias: String) {
            KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }.deleteEntry(alias)
        }

        private fun generate(alias: String, preferStrongBox: Boolean) {
            if (!preferStrongBox) return generateOnce(alias, false)
            try {
                generateOnce(alias, true)
            } catch (_: ProviderException) {
                // Some providers create a partial entry before reporting that
                // StrongBox is unavailable. Remove it before the normal retry.
                delete(alias)
                generateOnce(alias, false)
            }
        }

        private fun generateOnce(alias: String, strongBox: Boolean) {
            val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
            if (Build.VERSION.SDK_INT >= 28) builder.setIsStrongBoxBacked(strongBox)
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE).apply {
                initialize(builder.build())
                generateKeyPair()
            }
        }
    }
}

private fun BigInteger.fixed(size: Int): ByteArray {
    val raw = toByteArray()
    val unsigned = if (raw.size > size && raw.first() == 0.toByte()) raw.copyOfRange(1, raw.size) else raw
    require(unsigned.size <= size)
    return ByteArray(size - unsigned.size) + unsigned
}
