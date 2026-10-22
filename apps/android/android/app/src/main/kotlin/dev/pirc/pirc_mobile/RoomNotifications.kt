package dev.pirc.pirc_mobile

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import dev.pirc.android.core.PushNote
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/**
 * Rooms muted on this phone (plans/rewrite/12-android.md, decision 1): the
 * same as the web's `relay.muted-rooms`, kept here and never sent to the
 * gateway. A muted room still shows its messages; it only stops notifying.
 */
object RoomMutes {
    private const val PREFS = "room_mutes"
    private const val KEY = "muted"

    fun muted(context: Context): Set<String> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(KEY, emptySet())!!.toSet()

    fun isMuted(context: Context, roomId: String) = roomId in muted(context)

    /** Mute or unmute [roomId]; the rooms muted afterwards. */
    fun set(context: Context, roomId: String, muted: Boolean): Set<String> {
        val next = if (muted) muted(context) + roomId else muted(context) - roomId
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet(KEY, next).commit()
        return next
    }

    /** Another gateway: its rooms are not these. */
    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit()
    }
}

/**
 * Whether a room's push becomes a notification: not when the room is muted
 * here, not while it is on screen, and not when room notifications are off
 * or it is quiet hours.
 */
internal fun shouldNotifyRoom(muted: Boolean, showing: Boolean, allowed: Boolean): Boolean =
    !muted && !showing && allowed

/**
 * Notifications about rooms: they open the room, and "Reply" sends the
 * words as a message in it, which waits the usual three seconds before the
 * brain answers (decision #16), like any message.
 */
object RoomNotifications {
    const val CHANNEL = "pirc_rooms"
    internal const val REPLY = "dev.pirc.mobile.ROOM_REPLY"
    internal const val EXTRA_ROOM = "roomId"
    internal const val EXTRA_TAG = "tag"
    internal const val EXTRA_TITLE = "title"
    internal const val INPUT = "reply"

    /** One notification per room, replaced by the next (the gateway's `room:<id>`). */
    fun tag(roomId: String) = "room:$roomId"

    fun openIntent(context: Context, roomId: String): Intent = Intent(context, MainActivity::class.java)
        .putExtra("gatewayRoom", roomId)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)

    private fun channel(context: Context) = GatewayNotifications.manager(context).also { manager ->
        manager.createNotificationChannel(
            android.app.NotificationChannel(CHANNEL, "Rooms", android.app.NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    private fun permitted(context: Context) = Build.VERSION.SDK_INT < 33 ||
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** A room's push, unless muted, on screen or not wanted now. */
    fun show(context: Context, note: PushNote, roomId: String, showing: Boolean) {
        val allowed = NotificationPreferences(context).allows("rooms")
        if (!shouldNotifyRoom(RoomMutes.isMuted(context, roomId), showing, allowed) || !permitted(context)) return
        post(context, roomId, note.title, note.body, note.tag.ifBlank { tag(roomId) })
    }

    internal fun post(context: Context, roomId: String, title: String, body: String, tag: String, sent: CharSequence? = null) {
        val manager = channel(context)
        val prefs = NotificationPreferences(context)
        val open = PendingIntent.getActivity(
            context, "open:$tag".hashCode(), openIntent(context, roomId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val replyIntent = Intent(context, RoomReplyReceiver::class.java).setAction(REPLY)
            .setPackage(context.packageName)
            .putExtra(EXTRA_ROOM, roomId).putExtra(EXTRA_TAG, tag).putExtra(EXTRA_TITLE, title)
        // RemoteInput fills the intent in: it must stay mutable.
        val reply = PendingIntent.getBroadcast(
            context, "reply:$tag".hashCode(), replyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val input = RemoteInput.Builder(INPUT).setLabel("Message").build()
        val action = Notification.Action.Builder(null, "Reply", reply).addRemoteInput(input)
            .setAllowGeneratedReplies(false)
        if (Build.VERSION.SDK_INT >= 31) action.setAuthenticationRequired(true)
        val public = Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (prefs.lock == "hide") "pirc" else title)
            .setContentText(if (prefs.lock == "all") body else "Unlock to read")
            .build()
        val notification = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .addAction(action.build())
            .apply { if (sent != null) setRemoteInputHistory(arrayOf(sent)).setOnlyAlertOnce(true) }
            .build()
        manager.notify(tag, 0, notification)
    }

    /** The room is on screen: its notification has been read. */
    fun cancel(context: Context, roomId: String) {
        runCatching { GatewayNotifications.manager(context).cancel(tag(roomId), 0) }
    }
}

/**
 * "Reply" on a room's notification: the words go to the room as this
 * user's message; the notification says it went, or that it did not.
 */
class RoomReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != RoomNotifications.REPLY) return
        val roomId = intent.getStringExtra(RoomNotifications.EXTRA_ROOM) ?: return
        val tag = intent.getStringExtra(RoomNotifications.EXTRA_TAG) ?: RoomNotifications.tag(roomId)
        val title = intent.getStringExtra(RoomNotifications.EXTRA_TITLE) ?: "pirc"
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(RoomNotifications.INPUT)?.toString()?.trim()
        if (text.isNullOrEmpty()) return
        val pending = goAsync()
        val runtime = GatewayRuntime.get(context.applicationContext)
        runtime.scope.launch {
            try {
                withTimeout(20_000) { runtime.rooms.send(roomId, text, emptyList(), immediate = false) }
                RoomNotifications.post(context, roomId, title, "Sent", tag, sent = text)
            } catch (e: CancellationException) {
                RoomNotifications.post(context, roomId, title, "Not sent: open the room to try again.", tag)
                if (e !is kotlinx.coroutines.TimeoutCancellationException) throw e
            } catch (e: Exception) {
                RoomNotifications.post(context, roomId, title, "Not sent: ${e.message ?: "the gateway did not answer"}", tag)
            } finally {
                pending.finish()
            }
        }
    }
}
