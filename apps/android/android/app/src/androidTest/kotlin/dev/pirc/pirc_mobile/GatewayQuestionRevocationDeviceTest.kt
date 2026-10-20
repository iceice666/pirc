package dev.pirc.pirc_mobile

import android.Manifest
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushMessage
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Real OS notifications and the real same-app UnifiedPush callback. No relay/network delivery. */
class GatewayQuestionRevocationDeviceTest {
    @Test fun exactRevocationWithdrawsOnlyThatEpochAndBlocksARepeatedShow() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = GatewayNotifications.manager(context)
        val session = "revocation-${UUID.randomUUID()}"
        val old = QuestionNotificationIdentity(session, "confirmation", "1")
        val next = QuestionNotificationIdentity(session, "confirmation", "2")
        withPreferences(context) {
            try {
                GatewayNotifications.show(context, "Old confirmation", "synthetic", session, questionIdentity = old)
                waitFor("old notification posted") { manager.activeNotifications.any { it.tag == old.notificationTag } }
                GatewayNotifications.show(context, "New confirmation", "synthetic", session, questionIdentity = next)
                waitFor("both epochs posted") {
                    manager.activeNotifications.count { it.tag in setOf(old.notificationTag, next.notificationTag) } == 2
                }
                GatewayNotifications.revokeQuestion(context, old)
                waitFor("exact old notification withdrawn") { manager.activeNotifications.none { it.tag == old.notificationTag } }
                assertTrue(manager.activeNotifications.any { it.tag == next.notificationTag })
                assertTrue(GatewayNotifications.isQuestionResolved(context, old))
                assertFalse(GatewayNotifications.isQuestionResolved(context, next))
                GatewayNotifications.show(context, "Repeated old confirmation", "synthetic", session, questionIdentity = old)
                Thread.sleep(300)
                assertTrue(manager.activeNotifications.none { it.tag == old.notificationTag })
                assertTrue(manager.activeNotifications.any { it.tag == next.notificationTag })
            } finally {
                manager.cancel(old.notificationTag, 0)
                manager.cancel(next.notificationTag, 0)
                removeIdentity(context, old)
                removeIdentity(context, next)
            }
        }
    }

    @Test fun decryptedAnsweredCallbackWithEmptyTitleRetractsAndSuppressesDelayedCreate() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val manager = GatewayNotifications.manager(context)
        val identity = QuestionNotificationIdentity("callback-${UUID.randomUUID()}", "confirm", "3")
        val instance = "revocation-device-test-${UUID.randomUUID()}"
        val push = context.getSharedPreferences("push", Context.MODE_PRIVATE)
        val saved = push.all.toMap()
        val connected = CountDownLatch(1)
        val service = AtomicReference<GatewayPushService?>()
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                service.set((binder as? PushService.PushBinder)?.getService() as? GatewayPushService)
                connected.countDown()
            }
            override fun onServiceDisconnected(name: ComponentName) { service.set(null) }
        }
        var bound = false
        withPreferences(context) {
            try {
                check(push.edit().clear().putBoolean("enabled", true).putString("instance", instance).commit())
                GatewayNotifications.show(context, "Waiting", "synthetic", identity.sessionId, questionIdentity = identity)
                waitFor("initial question posted") { manager.activeNotifications.any { it.tag == identity.notificationTag } }
                bound = context.bindService(Intent(context, GatewayPushService::class.java), connection, Context.BIND_AUTO_CREATE)
                assertTrue(bound)
                assertTrue(connected.await(8, TimeUnit.SECONDS))
                assertNotNull(service.get())
                fun deliver(kind: String, title: String) {
                    val payload = """{"title":"$title","body":"","tag":"${identity.notificationTag}","target":{"sessionId":"${identity.sessionId}"},"kind":"$kind","sessionId":"${identity.sessionId}","interactionId":"${identity.interactionId}","interactionEpoch":"${identity.interactionEpoch}"}"""
                    instrumentation.runOnMainSync {
                        service.get()!!.onMessage(PushMessage(payload.toByteArray(Charsets.UTF_8), true), instance)
                    }
                }
                deliver("interaction_answered", "")
                waitFor("blank-title answered callback withdrew question") {
                    GatewayNotifications.isQuestionResolved(context, identity) && manager.activeNotifications.none { it.tag == identity.notificationTag }
                }
                deliver("interaction_created", "Delayed waiting")
                Thread.sleep(1200)
                assertTrue("Delayed created push must not revive resolved action", manager.activeNotifications.none { it.tag == identity.notificationTag })
            } finally {
                if (bound) context.unbindService(connection)
                manager.cancel(identity.notificationTag, 0)
                removeIdentity(context, identity)
                restorePreferences(push, saved)
            }
        }
    }

    private fun withPreferences(context: Context, action: () -> Unit) {
        if (Build.VERSION.SDK_INT >= 33) assertEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS))
        val prefs = context.getSharedPreferences("notification_preferences", Context.MODE_PRIVATE)
        val saved = prefs.all.toMap()
        val activity = context.getSharedPreferences("recent_activity", Context.MODE_PRIVATE)
        val savedActivity = activity.all.toMap()
        try {
            check(prefs.edit().putBoolean("q", true).putBoolean("quiet", false).putStringSet("muted", emptySet()).commit())
            action()
        } finally {
            restorePreferences(prefs, saved)
            restorePreferences(activity, savedActivity)
        }
    }
    private fun removeIdentity(context: Context, identity: QuestionNotificationIdentity) {
        context.getSharedPreferences("question_notifications", Context.MODE_PRIVATE).edit()
            .remove(identity.postedPreferenceKey).remove(identity.resolvedPreferenceKey).commit()
    }
    private fun restorePreferences(prefs: android.content.SharedPreferences, values: Map<String, *>) {
        val edit = prefs.edit().clear()
        for ((key, value) in values) when (value) {
            is String -> edit.putString(key, value)
            is Boolean -> edit.putBoolean(key, value)
            is Int -> edit.putInt(key, value)
            is Long -> edit.putLong(key, value)
            is Float -> edit.putFloat(key, value)
            is Set<*> -> edit.putStringSet(key, value.filterIsInstance<String>().toSet())
        }
        check(edit.commit())
    }
    private fun waitFor(label: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 8000
        while (!condition() && System.currentTimeMillis() < deadline) Thread.sleep(30)
        assertTrue(label, condition())
    }
}
