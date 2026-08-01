package com.ade.android.connection

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.ade.android.AdeApplication
import com.ade.android.MainActivity
import com.ade.android.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class AdeConnectionService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var reconnectJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        createChannel()
    }

    override fun onDestroy() {
        running = false
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            (application as AdeApplication).graph.sync.disconnect()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_IDLE) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val notification = notification(intent?.getStringExtra(EXTRA_MACHINE_NAME))
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        reconnectIfNeeded()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun reconnectIfNeeded() {
        if (reconnectJob?.isActive == true) return
        val graph = (application as AdeApplication).graph
        if (graph.sync.status.value.state == "connected") return
        val profile = graph.machineStore.current() ?: return
        reconnectJob = serviceScope.launch {
            runCatching {
                graph.pairing.connect(profile)
                if (!remoteWorkNeedsForeground(graph)) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
                .onFailure { ReconnectWorker.enqueue(applicationContext) }
        }
    }

    private fun notification(machineName: String?): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, AdeConnectionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_ade)
            .setContentTitle(getString(R.string.connection_notification_title))
            .setContentText(machineName?.let { "Active sessions on $it" } ?: "Keeping active sessions connected")
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(0, "Disconnect", stop)
            .build()
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.connection_channel_name), NotificationManager.IMPORTANCE_LOW),
        )
    }

    companion object {
        private const val CHANNEL_ID = "ade_connection"
        private const val NOTIFICATION_ID = 7001
        private const val EXTRA_MACHINE_NAME = "machine_name"
        private const val ACTION_STOP = "com.ade.android.STOP_CONNECTION"
        private const val ACTION_IDLE = "com.ade.android.IDLE_CONNECTION"
        @Volatile private var running = false

        fun start(context: Context, machineName: String?) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, AdeConnectionService::class.java).putExtra(EXTRA_MACHINE_NAME, machineName),
            )
        }

        fun stop(context: Context) {
            context.startService(Intent(context, AdeConnectionService::class.java).setAction(ACTION_STOP))
        }

        fun stopForegroundOnly(context: Context) {
            if (running) context.startService(Intent(context, AdeConnectionService::class.java).setAction(ACTION_IDLE))
        }
    }
}
