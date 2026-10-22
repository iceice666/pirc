package dev.pirc.pirc_mobile

import android.Manifest
import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import dev.pirc.android.core.*
import dev.pirc.android.push.PushRegistration
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Notifications that are not about a room (plans/rewrite/12-android.md):
 * a session in the engine, what pirc remembered. Rooms have their own
 * ([RoomNotifications]); questions are asked in rooms now, so sessions no
 * longer notify questions, progress or answers.
 */
object GatewayNotifications {
    const val CHANNEL = "pirc_live"
    private val categories = mapOf("deleg" to "委派的工作", "done" to "完成或失敗")

    fun intent(context: Context, session: String?, page: String? = null) = Intent(context, MainActivity::class.java)
        .putExtra("gatewaySession", session).putExtra("gatewayRoute", page)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)

    fun manager(context: Context) = context.getSystemService(NotificationManager::class.java).apply {
        createNotificationChannel(NotificationChannel(CHANNEL, "pirc 工作通知", NotificationManager.IMPORTANCE_DEFAULT))
        for ((id, label) in categories) createNotificationChannel(
            NotificationChannel("pirc_$id", label, NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    private fun open(context: Context, intent: Intent, key: String) = PendingIntent.getActivity(
        context, key.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /** A notification opening [session] in the engine, or the app's [page]. */
    internal fun show(
        context: Context,
        title: String,
        body: String,
        session: String?,
        page: String? = null,
        category: String = "q",
        tag: String = session ?: page ?: title,
    ) {
        val history = context.getSharedPreferences("recent_activity", Context.MODE_PRIVATE)
        val items = runCatching { org.json.JSONArray(history.getString("items", "[]")) }.getOrDefault(org.json.JSONArray())
        val next = org.json.JSONArray().put(
            org.json.JSONObject().put("title", title).put("body", body).put("sessionId", session).put("page", page)
                .put("at", System.currentTimeMillis()),
        )
        for (i in 0 until minOf(items.length(), 99)) next.put(items.get(i))
        history.edit().putString("items", next.toString()).apply()
        if (!NotificationPreferences(context).allows(category)) return
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val prefs = NotificationPreferences(context)
        val channel = if (category in categories) "pirc_$category" else CHANNEL
        val public = Notification.Builder(context, channel).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (prefs.lock == "hide") "pirc" else title)
            .setContentText(if (prefs.lock == "all") body else "解鎖後查看內容").build()
        val notification = Notification.Builder(context, channel).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title).setContentText(body).setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(open(context, intent(context, session, page), "open:$session:$page"))
            .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(public).setAutoCancel(true)
            .build()
        manager(context).notify(tag.hashCode(), notification)
    }

    /** Another account: the old one's notifications go. */
    fun clear(context: Context) {
        runCatching { manager(context).cancelAll() }
    }
}

class GatewayPushService : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) =
        PushRegistration.onEndpoint(applicationContext, instance, endpoint)

    override fun onMessage(message: PushMessage, instance: String) {
        if (!message.decrypted || !PushRegistration.acceptsMessage(applicationContext, instance)) return
        val note = PushNote.parse(message.content) ?: return
        val runtime = GatewayRuntime.get(applicationContext)
        runtime.scope.launch {
            runtime.withCurrentPairingStampForPush {
                if (!PushRegistration.acceptsMessage(applicationContext, instance)) return@withCurrentPairingStampForPush
                when (val target = note.target) {
                    // A room: notified unless muted here or on screen (decision 1).
                    is PushTarget.OpenRoom ->
                        RoomNotifications.show(applicationContext, note, target.roomId, runtime.rooms.isShowing(target.roomId))
                    // What pirc remembered: the engine's memory page.
                    PushTarget.OpenMemory ->
                        GatewayNotifications.show(applicationContext, note.title, note.body, null, "memory", tag = note.tag)
                    else -> {
                        val session = (target as? PushTarget.OpenSession)?.sessionId ?: note.sessionId
                        // Session questions are asked in rooms now; their pushes say nothing here.
                        if (note.kind != null && note.kind.startsWith("interaction_")) return@withCurrentPairingStampForPush
                        if (note.title.isBlank()) return@withCurrentPairingStampForPush
                        if (shouldSuppressVisibleSessionPush(session, runtime.sessions::hasVisibleSessionSubscriber)) {
                            return@withCurrentPairingStampForPush
                        }
                        val category = if (note.tag.startsWith("delegation:")) "deleg" else "q"
                        GatewayNotifications.show(applicationContext, note.title, note.body, session, null, category, tag = note.tag)
                    }
                }
            }
        }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) =
        PushRegistration.fail(applicationContext, instance, reason.toString())

    override fun onUnregistered(instance: String) = PushRegistration.onUnregistered(applicationContext, instance)
}

internal fun shouldSuppressVisibleSessionPush(
    sessionId: String?,
    hasVisibleSession: (String) -> Boolean,
): Boolean = sessionId != null && hasVisibleSession(sessionId)

/** Push delivery is best-effort; pairing may be absent or change after the SDK callback is queued. */
private suspend fun GatewayRuntime.withCurrentPairingStampForPush(action: (String) -> Unit) {
    try {
        withCurrentPairingStamp(action)
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        // Do not turn a pairing race or a local notification failure into a process crash.
    }
}
