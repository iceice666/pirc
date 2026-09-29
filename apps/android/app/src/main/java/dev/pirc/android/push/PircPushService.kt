package dev.pirc.android.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.pirc.android.MainActivity
import dev.pirc.android.R
import dev.pirc.android.core.PushNote
import dev.pirc.android.core.PushTarget
import dev.pirc.android.core.PushTarget.Companion.putTarget
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/** Messages from the UnifiedPush distributor (declared in the manifest). */
class PircPushService : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        PushRegistration.onEndpoint(applicationContext, endpoint)
    }

    override fun onMessage(message: PushMessage, instance: String) {
        // Only what the gateway encrypted for this app; anything else is not ours.
        if (!message.decrypted) return
        PushNote.parse(message.content)?.let { Notifier.show(applicationContext, it) }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        PushRegistration.fail(
            applicationContext,
            when (reason) {
                FailedReason.VAPID_REQUIRED -> "The distributor needs a VAPID key."
                FailedReason.NETWORK -> "The distributor could not reach its server."
                else -> "The distributor refused the registration ($reason)."
            },
        )
    }

    override fun onUnregistered(instance: String) {
        PushRegistration.onUnregistered(applicationContext)
    }
}

/** The session on screen: notifications about it are not shown. */
object VisibleSession {
    @Volatile var id: String? = null
}

object Notifier {
    private const val CHANNEL = "pirc"

    fun show(context: Context, note: PushNote) {
        val target = note.target
        if (target is PushTarget.OpenSession && target.sessionId == VisibleSession.id) return
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Scheduled runs and waiting sessions", NotificationManager.IMPORTANCE_DEFAULT),
        )
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .apply { target?.let { putTarget(it) } }
        val open = PendingIntent.getActivity(
            context,
            note.tag.hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(note.title)
            .setContentText(note.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(note.body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        // One notification per tag: a newer one about the same session replaces it.
        NotificationManagerCompat.from(context).notify(note.tag, 0, notification)
    }
}
