package com.ade.sync.auth

import com.ade.sync.model.DpopProof
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.UUID

interface DpopKey {
    /** X9.63 uncompressed P-256 key: 04 || X || Y. */
    val publicKeyX963: ByteArray
    fun signSha256Ecdsa(message: ByteArray): ByteArray
}

class JvmDpopKey private constructor(private val pair: KeyPair) : DpopKey {
    override val publicKeyX963: ByteArray = x963(pair.public as ECPublicKey)

    override fun signSha256Ecdsa(message: ByteArray): ByteArray =
        Signature.getInstance("SHA256withECDSA").run {
            initSign(pair.private)
            update(message)
            sign()
        }

    companion object {
        fun generate(): JvmDpopKey {
            val generator = KeyPairGenerator.getInstance("EC")
            generator.initialize(ECGenParameterSpec("secp256r1"))
            return JvmDpopKey(generator.generateKeyPair())
        }
    }
}

object Dpop {
    const val CONTEXT = "ade-dpop-v1"
    const val RELAY_REAUTH_CONTEXT = "ade-relay-reauth-v1"

    fun challenge(deviceId: String, pairedSecret: String, timestamp: Long, nonce: String): String = listOf(
        CONTEXT,
        deviceId,
        sha256Hex(pairedSecret),
        timestamp.toString(),
        nonce,
    ).joinToString("\n")

    fun proof(
        key: DpopKey,
        deviceId: String,
        pairedSecret: String,
        timestamp: Long = System.currentTimeMillis() / 1_000,
        nonce: String = UUID.randomUUID().toString(),
    ): DpopProof {
        require(nonce.isNotBlank() && nonce.length <= 128)
        val message = challenge(deviceId, pairedSecret, timestamp, nonce).toByteArray(Charsets.UTF_8)
        return DpopProof(
            publicKey = Base64.getEncoder().encodeToString(key.publicKeyX963),
            timestamp = timestamp,
            nonce = nonce,
            signature = Base64.getEncoder().encodeToString(key.signSha256Ecdsa(message)),
        )
    }

    fun relayReauthorizationProof(
        key: DpopKey,
        deviceId: String,
        relayAccountToken: String,
        challenge: String,
        timestamp: Long = System.currentTimeMillis() / 1_000,
        nonce: String = UUID.randomUUID().toString(),
    ): DpopProof {
        require(challenge.isNotBlank() && nonce.isNotBlank() && nonce.length <= 128)
        val canonical = listOf(
            RELAY_REAUTH_CONTEXT,
            deviceId,
            sha256Hex(relayAccountToken),
            challenge,
            timestamp.toString(),
            nonce,
        ).joinToString("\n")
        return DpopProof(
            publicKey = Base64.getEncoder().encodeToString(key.publicKeyX963),
            timestamp = timestamp,
            nonce = nonce,
            signature = Base64.getEncoder().encodeToString(key.signSha256Ecdsa(canonical.toByteArray())),
        )
    }

    fun sha256Hex(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
}

private fun x963(publicKey: ECPublicKey): ByteArray = byteArrayOf(0x04) +
    publicKey.w.affineX.toUnsignedFixed(32) +
    publicKey.w.affineY.toUnsignedFixed(32)

private fun BigInteger.toUnsignedFixed(size: Int): ByteArray {
    val raw = toByteArray()
    val unsigned = if (raw.size > size && raw.first() == 0.toByte()) raw.copyOfRange(1, raw.size) else raw
    require(unsigned.size <= size)
    return ByteArray(size - unsigned.size) + unsigned
}
