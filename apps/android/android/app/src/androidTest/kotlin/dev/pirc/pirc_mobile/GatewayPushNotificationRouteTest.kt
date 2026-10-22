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
import dev.pirc.android.core.KeystoreCredentialStore
import dev.pirc.android.core.Pairing
import dev.pirc.android.core.PircApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushMessage
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Exercises the app's real UnifiedPush callback, OS notification record and
 * content PendingIntent route. The callback is injected locally through the
 * same-app SDK binder; this does not test distributor registration or remote
 * network delivery.
 */
class GatewayPushNotificationRouteTest {
    @Test
    fun injectedCallbackPostsNotificationAndContentPendingIntentRoutesToMainActivity() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val notifications = context.getSystemService(NotificationManager::class.java)
        val tag = "android-test-${UUID.randomUUID()}"
        val sessionId = "push-route-${UUID.randomUUID()}"
        val notificationId = tag.hashCode()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            assertEquals(
                "Grant POST_NOTIFICATIONS before running this instrumentation test",
                PackageManager.PERMISSION_GRANTED,
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS),
            )
        }

        val preferenceStore = context.getSharedPreferences("notification_preferences", Context.MODE_PRIVATE)
        val pushStore = context.getSharedPreferences("push", Context.MODE_PRIVATE)
        val savedPushValues = pushStore.all.toMap()
        val savedPreferenceValues = mapOf(
            "q" to preferenceStore.all["q"],
            "quiet" to preferenceStore.all["quiet"],
            "muted" to preferenceStore.all["muted"],
        )
        val activityStore = context.getSharedPreferences("recent_activity", Context.MODE_PRIVATE)
        val previousRecentItems = activityStore.getString("items", null)
        val manager = GatewayNotifications.manager(context)
        val qChannel = manager.getNotificationChannel(GatewayNotifications.CHANNEL)
        assertTrue("Enable app notifications before running this test", manager.areNotificationsEnabled())
        assertNotNull("The question notification channel must exist", qChannel)
        assertTrue("Enable the question notification channel before running this test", qChannel.importance != NotificationManager.IMPORTANCE_NONE)

        val serviceConnected = CountDownLatch(1)
        val serviceRef = AtomicReference<GatewayPushService?>()
        val serviceConnection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                val pushBinder = binder as? PushService.PushBinder
                serviceRef.set(pushBinder?.getService() as? GatewayPushService)
                serviceConnected.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName) {
                serviceRef.set(null)
            }
        }

        val routedActivity = AtomicReference<MainActivity?>()
        var pairingOverride: PairingOverride? = null
        var bound = false
        try {
            pairingOverride = PairingOverride(context, Pairing("http://127.0.0.1:1", "android-test-token"))
            check(pushStore.edit().clear().putBoolean("enabled", true).putString("instance", "android-test").commit())
            check(preferenceStore.edit()
                .putBoolean("q", true)
                .putBoolean("quiet", false)
                .putStringSet("muted", emptySet())
                .commit()) { "Could not enable question notifications for test" }
            manager.cancel(notificationId)
            bound = context.bindService(
                Intent(context, GatewayPushService::class.java),
                serviceConnection,
                Context.BIND_AUTO_CREATE,
            )
            assertTrue("Could not bind the app's UnifiedPush service", bound)
            assertTrue("UnifiedPush service did not connect", serviceConnected.await(8, TimeUnit.SECONDS))
            val service = serviceRef.get() ?: error("SDK binder did not expose GatewayPushService")

            val payload = """{"title":"Push route test","body":"OS notification route","tag":"$tag","target":{"sessionId":"$sessionId"}}"""
            instrumentation.runOnMainSync {
                service!!.onMessage(PushMessage(payload.toByteArray(Charsets.UTF_8), true), "retired-test")
            }
            Thread.sleep(300)
            assertTrue("A retired instance must not post a notification", manager.activeNotifications.none { it.id == notificationId })
            check(pushStore.edit().putBoolean("enabled", false).commit())
            instrumentation.runOnMainSync {
                service!!.onMessage(PushMessage(payload.toByteArray(Charsets.UTF_8), true), "android-test")
            }
            Thread.sleep(300)
            assertTrue("Disabled push must ignore a late decrypted message", manager.activeNotifications.none { it.id == notificationId })
            check(pushStore.edit().putBoolean("enabled", true).commit())
            instrumentation.runOnMainSync {
                service!!.onMessage(PushMessage(payload.toByteArray(Charsets.UTF_8), true), "android-test")
            }

            val posted = waitForNotification(manager, notificationId, 15)
            assertNotNull("GatewayPushService did not post an OS notification", posted)
            val contentIntent = posted!!.notification.contentIntent
            assertNotNull("Posted notification has no content PendingIntent", contentIntent)

            val activity = instrumentation.startActivitySync(
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            ) as MainActivity
            routedActivity.set(activity)
            instrumentation.runOnMainSync { contentIntent!!.send() }
            assertTrue(
                "Notification content PendingIntent did not route MainActivity to the session",
                waitForSessionRoute(instrumentation, activity, sessionId, 20),
            )
        } finally {
            manager.cancel(notificationId)
            routedActivity.get()?.let { activity -> instrumentation.runOnMainSync { activity.finish() } }
            if (bound) context.unbindService(serviceConnection)
            pairingOverride?.close()
            val pushKeys = pushStore.all.keys + savedPushValues.keys
            for (key in pushKeys) restorePreference(pushStore, key, savedPushValues[key])
            restorePreference(preferenceStore, "q", savedPreferenceValues["q"])
            restorePreference(preferenceStore, "quiet", savedPreferenceValues["quiet"])
            restorePreference(preferenceStore, "muted", savedPreferenceValues["muted"])
            val recentEditor = activityStore.edit()
            if (previousRecentItems == null) recentEditor.remove("items") else recentEditor.putString("items", previousRecentItems)
            check(recentEditor.commit()) { "Could not restore recent activity after test" }
        }
    }

    @Test
    fun unpairedLegacyAndExactCreatedCallbacksAreIgnoredWithoutCrashing() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val notifications = GatewayNotifications.manager(context)
        val pushStore = context.getSharedPreferences("push", Context.MODE_PRIVATE)
        val savedPushValues = pushStore.all.toMap()
        val preferenceStore = context.getSharedPreferences("notification_preferences", Context.MODE_PRIVATE)
        val savedNotificationValues = mapOf(
            "q" to preferenceStore.all["q"],
            "quiet" to preferenceStore.all["quiet"],
            "muted" to preferenceStore.all["muted"],
        )
        val legacyTag = "unpaired-${UUID.randomUUID()}"
        val legacyId = legacyTag.hashCode()
        val sessionId = "unpaired-session-${UUID.randomUUID()}"
        val interactionId = "memory:unpaired-${UUID.randomUUID()}"
        // Session questions are asked in rooms now: their pushes post nothing.
        val questionTag = "interaction:$sessionId:$interactionId:7"
        val serviceConnected = CountDownLatch(1)
        val serviceRef = AtomicReference<GatewayPushService?>()
        val serviceConnection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                val pushBinder = binder as? PushService.PushBinder
                serviceRef.set(pushBinder?.getService() as? GatewayPushService)
                serviceConnected.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName) {
                serviceRef.set(null)
            }
        }

        var pairingOverride: PairingOverride? = null
        var bound = false
        try {
            pairingOverride = PairingOverride(context, null)
            check(pushStore.edit().clear().putBoolean("enabled", true).putString("instance", "android-test").commit())
            check(preferenceStore.edit().putBoolean("q", true).putBoolean("quiet", false)
                .putStringSet("muted", emptySet()).commit())
            notifications.cancel(legacyId)
            notifications.cancel(questionTag, 0)
            bound = context.bindService(
                Intent(context, GatewayPushService::class.java),
                serviceConnection,
                Context.BIND_AUTO_CREATE,
            )
            assertTrue("Could not bind the app's UnifiedPush service", bound)
            assertTrue("UnifiedPush service did not connect", serviceConnected.await(8, TimeUnit.SECONDS))
            val service = serviceRef.get()
            assertNotNull("SDK binder did not expose GatewayPushService", service)

            val legacy = """{"title":"Unpaired legacy","body":"must be ignored","tag":"$legacyTag","target":{"sessionId":"$sessionId"}}"""
            val created = """{"kind":"interaction_created","sessionId":"$sessionId","interactionId":"$interactionId","interactionEpoch":"7","title":"Unpaired question","body":"must be ignored","tag":"${questionTag}","target":{"sessionId":"$sessionId"}}"""
            instrumentation.runOnMainSync {
                service!!.onMessage(PushMessage(legacy.toByteArray(Charsets.UTF_8), true), "android-test")
                service!!.onMessage(PushMessage(created.toByteArray(Charsets.UTF_8), true), "android-test")
            }

            Thread.sleep(700)
            assertTrue("An unpaired legacy callback must not post a notification", notifications.activeNotifications.none {
                it.id == legacyId && it.tag == null
            })
            assertTrue("An unpaired exact question callback must not post a notification", notifications.activeNotifications.none {
                it.tag == questionTag
            })
        } finally {
            notifications.cancel(legacyId)
            notifications.cancel(questionTag, 0)
            if (bound) context.unbindService(serviceConnection)
            pairingOverride?.close()
            val pushKeys = pushStore.all.keys + savedPushValues.keys
            for (key in pushKeys) restorePreference(pushStore, key, savedPushValues[key])
            restorePreference(preferenceStore, "q", savedNotificationValues["q"])
            restorePreference(preferenceStore, "quiet", savedNotificationValues["quiet"])
            restorePreference(preferenceStore, "muted", savedNotificationValues["muted"])
        }
    }

    /** Supply a local pairing to paired-route coverage, or remove it to cover late unpaired delivery. */
    private class PairingOverride(context: Context, pairing: Pairing?) : java.io.Closeable {
        private val credentials = KeystoreCredentialStore(context)
        private val previousPairing = credentials.load()
        private val runtime = GatewayRuntime.get(context)
        private val activeApiField = GatewayRuntime::class.java.getDeclaredField("activeApi").apply { isAccessible = true }
        private val previousApi = activeApiField.get(runtime)
        private val stampStore = context.getSharedPreferences("pairing_identity", Context.MODE_PRIVATE)
        private val previousStamp = stampStore.getString("stamp", null)

        init {
            if (pairing == null) {
                credentials.clear()
                activeApiField.set(runtime, null)
            } else {
                credentials.save(pairing)
                activeApiField.set(runtime, PircApi(pairing))
            }
            check(stampStore.edit().putString("stamp", UUID.randomUUID().toString()).commit())
        }

        override fun close() {
            activeApiField.set(runtime, previousApi)
            if (previousPairing == null) credentials.clear() else credentials.save(previousPairing)
            val edit = stampStore.edit()
            if (previousStamp == null) edit.remove("stamp") else edit.putString("stamp", previousStamp)
            check(edit.commit())
        }
    }

    private fun waitForSessionRoute(
        instrumentation: android.app.Instrumentation,
        activity: MainActivity,
        sessionId: String,
        timeoutSeconds: Long,
    ): Boolean {
        val currentSession = AtomicReference<String?>()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds)
        while (System.nanoTime() < deadline) {
            instrumentation.runOnMainSync {
                currentSession.set(activity.intent?.getStringExtra("gatewaySession"))
            }
            if (currentSession.get() == sessionId) return true
            Thread.sleep(100)
        }
        return false
    }

    private fun waitForNotification(
        manager: NotificationManager,
        notificationId: Int,
        timeoutSeconds: Long,
    ): android.service.notification.StatusBarNotification? {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds)
        while (System.nanoTime() < deadline) {
            val item = manager.activeNotifications.firstOrNull { it.id == notificationId && it.tag == null }
            if (item?.notification?.extras?.getString(android.app.Notification.EXTRA_TITLE) == "Push route test") {
                return item
            }
            Thread.sleep(100)
        }
        return manager.activeNotifications.firstOrNull { it.id == notificationId && it.tag == null }
    }

    private fun restorePreference(store: android.content.SharedPreferences, key: String, value: Any?) {
        val editor = store.edit()
        when (value) {
            null -> editor.remove(key)
            is Boolean -> editor.putBoolean(key, value)
            is String -> editor.putString(key, value)
            is Set<*> -> editor.putStringSet(key, value.filterIsInstance<String>().toSet())
            else -> error("Unexpected saved preference type for $key: ${value::class.java.name}")
        }
        check(editor.commit()) { "Could not restore notification preference $key" }
    }
}
