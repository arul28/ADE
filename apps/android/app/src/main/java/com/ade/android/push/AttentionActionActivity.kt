package com.ade.android.push

import android.app.Activity
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import com.ade.android.AdeApplication
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Unlock gate for notification actions that can authorize agent commands. */
class AttentionActionActivity : ComponentActivity() {
    private val confirmCredential = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) dispatchAuthenticatedAction()
        else finish()
    }

    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return
        val keyguard = getSystemService(KeyguardManager::class.java)
        if (!keyguard.isDeviceSecure) {
            finish()
            return
        }
        val prompt = keyguard.createConfirmDeviceCredentialIntent(
            "Confirm ADE action",
            "Unlock this device before approving or denying the agent request.",
        )
        if (prompt == null) finish() else confirmCredential.launch(prompt)
    }

    private fun dispatchAuthenticatedAction() {
        val sessionId = intent.getStringExtra(AdeMessagingService.EXTRA_SESSION_ID) ?: return finish()
        val itemId = intent.getStringExtra(AdeMessagingService.EXTRA_ITEM_ID) ?: return finish()
        val attentionItemId = intent.getStringExtra(AdeMessagingService.EXTRA_ATTENTION_ITEM_ID) ?: itemId
        val accountMachineKey = intent.getStringExtra(AdeMessagingService.EXTRA_ACCOUNT_MACHINE_KEY) ?: return finish()
        val expectedOwnerHash = intent.getStringExtra(AdeMessagingService.EXTRA_OWNER_HASH) ?: return finish()
        val expectedEpoch = intent.getLongExtra(AdeMessagingService.EXTRA_OWNERSHIP_EPOCH, 0L)
        val decision = when (intent.action) {
            AdeMessagingService.ACTION_APPROVE -> "accept"
            AdeMessagingService.ACTION_DENY -> "decline"
            else -> return finish()
        }
        val graph = (application as AdeApplication).graph
        lifecycleScope.launch {
            withContext(Dispatchers.IO) {
                runCatching {
                    graph.attentionActionMutex.withLock {
                        val ownerId = graph.auth.userId ?: error("Sign in again to respond")
                        check(graph.machineStore.isAttentionActionCurrent(ownerId, expectedOwnerHash, expectedEpoch)) {
                            "This notification belongs to an earlier account session"
                        }
                        var machine = graph.machineStore.findForAccountMachine(accountMachineKey)
                        if (machine == null) {
                            val directoryMachine = graph.directory.machines().firstOrNull {
                                it.machineKey == accountMachineKey
                            }
                            val hostDeviceId = directoryMachine?.deviceId
                            machine = graph.machineStore.list().firstOrNull {
                                hostDeviceId != null && it.hostDeviceId == hostDeviceId
                            }?.copy(accountMachineKey = accountMachineKey)?.also(graph.machineStore::put)
                        }
                        val resolvedMachine = machine ?: error("Reconnect the notification's machine in ADE")
                        if (graph.machineStore.current()?.machineKey != resolvedMachine.machineKey) {
                            graph.sync.seedCached(null, null)
                        }
                        graph.pairing.connect(resolvedMachine)
                        val rosterProject = withTimeout(8_000) {
                            graph.sync.requestRosterSnapshot(null)
                            graph.sync.roster.filterNotNull().first { snapshot ->
                                snapshot.projects.any { project -> project.chats.any { it.id == sessionId } }
                            }.projects.first { project -> project.chats.any { it.id == sessionId } }
                        }
                        val switchResult = graph.sync.request(
                            "project_switch_request",
                            buildJsonObject {
                                put("projectId", rosterProject.projectId)
                                rosterProject.rootPath?.let { put("rootPath", it) }
                            },
                        ).jsonObject
                        check(switchResult["ok"]?.jsonPrimitive?.contentOrNull == "true") {
                            switchResult.string("message") ?: "The session's project could not be opened"
                        }
                        if (switchResult["connection"] != null && switchResult["connection"] !is JsonNull) {
                            graph.pairing.reconnectProject(switchResult["connection"]!!.jsonObject)
                        }
                        graph.sync.selectProject(rosterProject.projectId, rosterProject.rootPath)
                        check(graph.machineStore.isAttentionActionCurrent(ownerId, expectedOwnerHash, expectedEpoch)) {
                            "This notification was revoked while ADE reconnected"
                        }
                        graph.sync.sendCommand("chat.approve", buildJsonObject {
                            put("sessionId", sessionId)
                            put("itemId", itemId)
                            put("decision", decision)
                        })
                        graph.attention.acknowledge(listOf(attentionItemId), dismiss = true)
                        getSystemService(NotificationManager::class.java).cancel(attentionItemId.hashCode())
                    }
                }
            }
            finish()
        }
    }

    private fun JsonObject.string(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull
        ?.takeIf(String::isNotBlank)
}
