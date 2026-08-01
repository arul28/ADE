package com.ade.android.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.KeyguardManager
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import com.ade.android.MainActivity
import com.ade.android.R
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.ade.android.AdeApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import java.security.MessageDigest

class AdeMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val graph = (application as AdeApplication).graph
        if (!graph.machineStore.localPushEnabled()) return
        // A failed server revocation must never surface the previous account's
        // content after local sign-out.
        val ownerId = graph.auth.userId ?: return
        if (!graph.machineStore.isAttentionRegistrationConfirmed(ownerId)) return
        val data = message.data
        val category = data["category"] ?: "attention"
        val sessionId = data["sessionId"].orEmpty()
        val accountMachineKey = data["accountMachineKey"].orEmpty()
        val approvalItemId = data["itemId"].orEmpty()
        val attentionItemId = data["attentionItemId"] ?: approvalItemId
        val deepLink = data["deepLink"]
        val openIntent = Intent(this, MainActivity::class.java).apply {
            if (!deepLink.isNullOrBlank()) putExtra("ade_deep_link", deepLink)
        }
        val channelId = if (data["sound"] == "default") CHANNEL_ID else SILENT_CHANNEL_ID
        val builder = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_ade)
            .setContentTitle(data["title"] ?: "An agent needs you")
            .setContentText(data["body"] ?: "Open ADE to continue.")
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(PendingIntent.getActivity(
                this, attentionItemId.hashCode(), openIntent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            ))
        if (
            category == "approval" && sessionId.isNotBlank() && approvalItemId.isNotBlank()
            && accountMachineKey.isNotBlank()
            && getSystemService(KeyguardManager::class.java).isDeviceSecure
        ) {
            graph.machineStore.attentionActionBinding(ownerId)?.let { binding ->
                builder.addAction(NotificationCompat.Action.Builder(
                    0, "Approve", actionIntent(ACTION_APPROVE, sessionId, approvalItemId, attentionItemId, accountMachineKey, binding.ownerHash, binding.epoch, 1),
                ).setAuthenticationRequired(true).setShowsUserInterface(true).build())
                builder.addAction(NotificationCompat.Action.Builder(
                    0, "Deny", actionIntent(ACTION_DENY, sessionId, approvalItemId, attentionItemId, accountMachineKey, binding.ownerHash, binding.epoch, 2),
                ).setAuthenticationRequired(true).setShowsUserInterface(true).build())
            }
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, getString(R.string.attention_channel_name), NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel(SILENT_CHANNEL_ID, getString(R.string.attention_silent_channel_name), NotificationManager.IMPORTANCE_HIGH).apply {
            setSound(null, null)
            enableVibration(false)
        })
        manager.notify(attentionItemId.ifBlank { message.messageId.orEmpty() }.hashCode(), builder.build())
    }

    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onNewToken(token: String) {
        val graph = (application as AdeApplication).graph
        if (graph.auth.signedIn) CoroutineScope(Dispatchers.IO).launch {
            val ownerId = graph.auth.userId ?: return@launch
            runCatching {
                graph.attentionActionMutex.withLock {
                    val enabled = graph.preferences.pushEnabled.first()
                    graph.machineStore.setLocalPushEnabled(enabled)
                    graph.attention.registerFcm(token, enabled, ownerId)
                }
            }
        }
    }

    private fun actionIntent(
        action: String,
        sessionId: String,
        itemId: String,
        attentionItemId: String,
        accountMachineKey: String,
        ownerHash: String,
        ownershipEpoch: Long,
        request: Int,
    ): PendingIntent =
        PendingIntent.getActivity(
            this,
            request xor itemId.hashCode(),
            Intent(this, AttentionActionActivity::class.java)
                .setAction(action)
                .setData(Uri.parse("ade-internal://attention-action/${actionIdentity(action, sessionId, itemId, accountMachineKey, ownerHash, ownershipEpoch)}"))
                .putExtra(EXTRA_SESSION_ID, sessionId)
                .putExtra(EXTRA_ITEM_ID, itemId)
                .putExtra(EXTRA_ATTENTION_ITEM_ID, attentionItemId)
                .putExtra(EXTRA_ACCOUNT_MACHINE_KEY, accountMachineKey)
                .putExtra(EXTRA_OWNER_HASH, ownerHash)
                .putExtra(EXTRA_OWNERSHIP_EPOCH, ownershipEpoch),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    private fun actionIdentity(vararg values: Any): String = MessageDigest.getInstance("SHA-256")
        .digest(values.joinToString("\u0000").toByteArray())
        .take(16).joinToString("") { "%02x".format(it) }

    companion object {
        const val ACTION_APPROVE = "ADE_APPROVE"
        const val ACTION_DENY = "ADE_DENY"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_ITEM_ID = "item_id"
        const val EXTRA_ATTENTION_ITEM_ID = "attention_item_id"
        const val EXTRA_ACCOUNT_MACHINE_KEY = "account_machine_key"
        const val EXTRA_OWNER_HASH = "owner_hash"
        const val EXTRA_OWNERSHIP_EPOCH = "ownership_epoch"
        private const val CHANNEL_ID = "ade_attention"
        private const val SILENT_CHANNEL_ID = "ade_attention_silent"
    }
}
