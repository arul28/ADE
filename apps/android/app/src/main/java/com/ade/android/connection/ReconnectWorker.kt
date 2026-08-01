package com.ade.android.connection

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.ade.android.AdeApplication
import com.ade.android.AppGraph
import com.ade.android.isActiveWorkState
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class ReconnectWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = (applicationContext as AdeApplication).graph
        val profile = graph.machineStore.current() ?: return Result.success()
        return runCatching {
            graph.pairing.connect(profile)
            if (remoteWorkNeedsForeground(graph)) AdeConnectionService.start(applicationContext, profile.name)
            else AdeConnectionService.stopForegroundOnly(applicationContext)
        }.fold(onSuccess = { Result.success() }, onFailure = { Result.retry() })
    }

    companion object {
        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<ReconnectWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("ade_reconnect", ExistingWorkPolicy.KEEP, request)
        }
    }
}

internal suspend fun remoteWorkNeedsForeground(graph: AppGraph): Boolean {
    val actions = buildList {
        if (graph.sync.hasSelectedProject() && graph.sync.canInvokeRemoteAction("work.listSessions")) {
            add("work.listSessions")
        }
        if (graph.sync.canInvokeRemoteAction("personalChats.list")) add("personalChats.list")
    }
    return actions.any { action ->
        val args = if (action == "personalChats.list") {
            kotlinx.serialization.json.buildJsonObject { put("includeArchived", false) }
        } else JsonObject(emptyMap())
        val sessions = graph.sync.sendCommand(action, args) as? JsonArray
        sessions.orEmpty().any { element ->
            val session = element as? JsonObject ?: return@any false
            val state = session["runtimeState"]?.jsonPrimitive?.contentOrNull
                ?: session["status"]?.jsonPrimitive?.contentOrNull
            isActiveWorkState(state)
        }
    }
}
