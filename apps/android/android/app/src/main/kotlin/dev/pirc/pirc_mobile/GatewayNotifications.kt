package dev.pirc.pirc_mobile

import android.Manifest
import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import dev.pirc.android.core.*
import dev.pirc.android.push.PushRegistration
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import org.unifiedpush.android.connector.FailedReason

object GatewayNotifications {
    const val CHANNEL = "pirc_live"
    private const val QUESTION_NOTIFICATIONS = "question_notifications"
    private const val MAX_QUESTION_TOMBSTONES = 512
    private const val QUESTION_TOMBSTONE_AGE = 30L * 24 * 60 * 60 * 1000
    private const val QUESTION_OVERLAY_STATE = "question_overlay_state"
    private val questionNotificationLock = Any()
    private val categories = mapOf("q" to "需要你回應", "deleg" to "委派的工作", "done" to "完成或失敗", "live" to "即時進度")
    fun intent(context: Context, session: String?, page: String? = null) = Intent(context, MainActivity::class.java)
        .putExtra("gatewaySession", session).putExtra("gatewayRoute", page)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    fun manager(context: Context) = context.getSystemService(NotificationManager::class.java).apply {
        createNotificationChannel(NotificationChannel(CHANNEL, "pirc 工作通知", NotificationManager.IMPORTANCE_DEFAULT))
        for ((id, label) in categories) createNotificationChannel(NotificationChannel("pirc_$id", label,
            if(id=="live") NotificationManager.IMPORTANCE_LOW else NotificationManager.IMPORTANCE_DEFAULT))
    }
    private fun open(context: Context, intent: Intent, key: String) = PendingIntent.getActivity(context, key.hashCode(), intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun Intent.putQuestionIdentity(identity: QuestionNotificationIdentity?, pairingStamp: String?) = apply {
        if (identity != null) {
            putExtra("interactionId", identity.interactionId)
            putExtra("interactionEpoch", identity.interactionEpoch)
            pairingStamp?.let { putExtra("questionPairingStamp", it) }
            action = identity.intentAction("open")
        }
    }
    internal fun notification(context: Context, title: String, body: String, session: String?, page: String? = null, category: String = "q",
        questionIdentity: QuestionNotificationIdentity? = null, questionPairingStamp: String? = null): Notification.Builder {
        manager(context)
        val prefs = NotificationPreferences(context)
        val channel = if(category=="q") CHANNEL else "pirc_$category"
        val contentIntent = intent(context,session,page).putQuestionIdentity(questionIdentity, questionPairingStamp)
        val contentKey = questionIdentity?.notificationTag?.let { "open:$it" } ?: "open:$session:$page"
        val public = Notification.Builder(context, channel).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if(prefs.lock=="hide") "pirc" else title)
            .setContentText(if(prefs.lock=="all") body else "解鎖後查看內容").build()
        return Notification.Builder(context, channel).setSmallIcon(R.drawable.ic_notification).setContentTitle(title)
            .setContentText(body).setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(open(context,contentIntent,contentKey))
            .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(public).setAutoCancel(true)
    }
    internal fun show(context: Context, title: String, body: String, session: String?, page: String? = null,
        category: String = "q", workspace: String? = null, question: dev.pirc.android.core.timeline.Interaction? = null,
        tag: String = session ?: page ?: title, questionIdentity: QuestionNotificationIdentity? = null,
        questionPairingStamp: String? = null, allowQuestionActions: Boolean = false) {
        val prefs = context.getSharedPreferences("recent_activity", Context.MODE_PRIVATE)
        val history = runCatching { org.json.JSONArray(prefs.getString("items", "[]")) }.getOrDefault(org.json.JSONArray())
        val next = org.json.JSONArray().put(org.json.JSONObject().put("title", title).put("body", body).put("sessionId", session).put("page", page).put("at", System.currentTimeMillis()))
        for (i in 0 until minOf(history.length(), 99)) next.put(history.get(i))
        prefs.edit().putString("items", next.toString()).apply()
        val settings=NotificationPreferences(context)
        if(!settings.allows(category,workspace)) return
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val identity = questionIdentity ?: question?.takeIf { session != null && it.status == "pending" }
            ?.let { QuestionNotificationIdentity.from(session, it.id, it.runnerEpoch) }
        val notification = notification(context,title,body,session,page,category,identity,questionPairingStamp)
        if(category=="q" && session!=null && allowQuestionActions) {
            val q=question
            val simple=q!=null && q.status=="pending" && (q.expiresAt == null || q.expiresAt > System.currentTimeMillis()) &&
                !q.multiple &&
                (q.kind=="confirm" || (q.kind=="select" && q.options.size<=3))
            if(settings.enabled("rich") && simple) {
                val options=if(q!!.kind=="confirm") listOf("yes" to "確認…", "no" to "拒絕…") else q.options.map { it.value to it.label }
                for((value,label) in options) {
                    val target=intent(context,session).putQuestionIdentity(identity, questionPairingStamp).putExtra("interactionId",q.id).putExtra("answerChoice",value)
                    identity?.let { target.action = it.intentAction("answer", value) }
                    val action=Notification.Action.Builder(null,label,open(context,target,identity?.intentAction("answer-pi", value) ?: "$tag:${q.id}:$value"))
                    if(Build.VERSION.SDK_INT>=31) action.setAuthenticationRequired(true)
                    notification.addAction(action.build())
                }
            } else {
                val target=intent(context,session).putQuestionIdentity(identity, questionPairingStamp).putExtra("interactionId",identity?.interactionId ?: q?.id).putExtra("confirmQuestion",true)
                identity?.let { target.action = it.intentAction("open-answer") }
                val action=Notification.Action.Builder(null,"開啟對話回答",open(context,target,identity?.intentAction("open-answer-pi") ?: "answer:$tag"))
                if(Build.VERSION.SDK_INT>=31) action.setAuthenticationRequired(true)
                notification.addAction(action.build())
            }
            if(settings.enabled("popup") && Settings.canDrawOverlays(context)) {
                val target=Intent(context,GatewayOverlayService::class.java).putExtra("sessionId",session)
                    .putExtra("interactionId",identity?.interactionId ?: q?.id).putExtra("interactionEpoch",identity?.interactionEpoch)
                    .putExtra("questionPairingStamp",questionPairingStamp)
                identity?.let { target.action = it.intentAction("overlay") }
                val reply=PendingIntent.getForegroundService(context,0,target,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                val action=Notification.Action.Builder(null,"快速回應…",reply)
                if(Build.VERSION.SDK_INT>=31) action.setAuthenticationRequired(true)
                if(!simple || !settings.enabled("rich") || q!!.options.size<3) notification.addAction(action.build())
            }
        }
        val built = notification.build()
        if (category == "q" && session != null) {
            synchronized(questionNotificationLock) {
                if (identity != null && isQuestionResolvedLocked(context, identity)) return
                if (identity != null) {
                    manager(context).notify(identity.notificationTag, 0, built)
                    context.getSharedPreferences(QUESTION_NOTIFICATIONS,Context.MODE_PRIVATE).edit()
                        .putString(identity.postedPreferenceKey, identity.encoded).apply()
                } else {
                    manager(context).notify(tag.hashCode(),built)
                    context.getSharedPreferences(QUESTION_NOTIFICATIONS,Context.MODE_PRIVATE).edit().putString(tag,session).apply()
                }
            }
        } else manager(context).notify(tag.hashCode(),notification.build())
    }
    private val lastProgress=mutableMapOf<String,Long>()
    fun sync(context: Context, state: dev.pirc.android.core.timeline.SessionState, previous: dev.pirc.android.core.timeline.SessionState? = null,
        questionPairingStamp: String? = null) {
        val prefs=NotificationPreferences(context)
        val id=state.session.id
        if(!state.needsSnapshot) reconcileQuestionNotifications(context, state, questionPairingStamp)
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val status=state.run?.status
        val active=status in listOf("running","queued","stopping")
        val progressId=("progress:$id").hashCode()
        if(!active || !prefs.allows("live",state.session.workspaceId)) { manager(context).cancel(progressId); lastProgress.remove(id) }
        else if(System.currentTimeMillis()-(lastProgress[id]?:0)>5000) {
            lastProgress[id]=System.currentTimeMillis()
            val step=state.messages.lastOrNull()?.tools?.lastOrNull()?.title ?: "正在執行工作"
            val note=notification(context,state.session.name,step,id,category="live").setOngoing(true).setOnlyAlertOnce(true).setProgress(0,0,true).setAutoCancel(false)
            manager(context).notify(progressId,note.build())
        }
        if(previous?.run?.id==state.run?.id && previous?.run?.status in listOf("running","queued","stopping","waiting_input") && status in listOf("succeeded","completed","failed","cancelled","stopped"))
            show(context,state.session.name,if(status in listOf("succeeded","completed")) "工作已完成" else "工作已結束：$status",id,category="done",workspace=state.session.workspaceId,tag="done:$id")
    }

    internal fun isQuestionResolved(context: Context, identity: QuestionNotificationIdentity): Boolean = synchronized(questionNotificationLock) {
        isQuestionResolvedLocked(context, identity)
    }

    /** Apply an exact answered event even when this session is not currently watched. */
    internal fun revokeQuestion(context: Context, identity: QuestionNotificationIdentity, questionPairingStamp: String? = null) = synchronized(questionNotificationLock) {
        resolveQuestionLocked(context, identity, questionPairingStamp)
    }

    internal fun setActiveQuestionOverlay(context: Context, identity: QuestionNotificationIdentity?, questionPairingStamp: String?) {
        val prefs = context.getSharedPreferences(QUESTION_OVERLAY_STATE, Context.MODE_PRIVATE)
        val edit = prefs.edit()
        if (identity == null) edit.clear()
        else edit.putString("identity", identity.encoded).putString("pairingStamp", questionPairingStamp)
        edit.commit()
    }

    internal fun clearActiveQuestionOverlay(context: Context, identity: QuestionNotificationIdentity?) {
        val prefs = context.getSharedPreferences(QUESTION_OVERLAY_STATE, Context.MODE_PRIVATE)
        val active = prefs.getString("identity", null)?.let(QuestionNotificationIdentity::decode)
        if (identity == null || identity == active) prefs.edit().clear().commit()
    }

    fun clearQuestionNotifications(context: Context) = synchronized(questionNotificationLock) {
        val prefs = context.getSharedPreferences(QUESTION_NOTIFICATIONS, Context.MODE_PRIVATE)
        for ((key, value) in prefs.all) {
            if (key.startsWith("posted:") && value is String) {
                QuestionNotificationIdentity.decode(value)?.let {
                    manager(context).cancel(it.notificationTag, 0)
                    stopMatchingOverlay(context, it, null)
                }
            } else if (!key.startsWith("resolved:") && !key.startsWith("posted:")) {
                manager(context).cancel(key.hashCode())
            }
        }
        runCatching {
            for (active in manager(context).activeNotifications) {
                if (active.tag?.startsWith("interaction:") == true) manager(context).cancel(active.tag, active.id)
            }
        }
        prefs.edit().clear().commit()
        GatewayOverlayService.clearQuestionIfActive(context)
        context.getSharedPreferences(QUESTION_OVERLAY_STATE, Context.MODE_PRIVATE).edit().clear().commit()
    }

    private fun reconcileQuestionNotifications(context: Context, state: dev.pirc.android.core.timeline.SessionState,
        questionPairingStamp: String?) = synchronized(questionNotificationLock) {
        val prefs = context.getSharedPreferences(QUESTION_NOTIFICATIONS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val active = state.interactions.asSequence()
            .filter { it.status == "pending" && (it.expiresAt == null || it.expiresAt > now) }
            .mapNotNull { QuestionNotificationIdentity.from(state.session.id, it.id, it.runnerEpoch) }
            .filterNot { isQuestionResolvedLocked(context, it) }
            .toSet()
        for (resolved in state.interactions.asSequence().filter { it.status != "pending" }) {
            QuestionNotificationIdentity.from(state.session.id, resolved.id, resolved.runnerEpoch)?.let {
                tombstoneQuestionLocked(context, it)
                if (questionPairingStamp != null) stopMatchingOverlay(context, it, questionPairingStamp)
            }
        }
        val posted = prefs.all.entries.mapNotNull { (key, value) ->
            if (!key.startsWith("posted:") || value !is String) null else QuestionNotificationIdentity.decode(value)
        }
        for (stale in staleQuestionNotifications(state.session.id, active, posted))
            resolveQuestionLocked(context, stale, questionPairingStamp)

        // Cancel notifications created by an older app version that had only a session tag.
        val hasPending = state.interactions.any { it.status == "pending" && (it.expiresAt == null || it.expiresAt > now) }
        if (!hasPending) for ((tag, session) in prefs.all) {
            if (!tag.startsWith("posted:") && !tag.startsWith("resolved:") && session == state.session.id) {
                manager(context).cancel(tag.hashCode())
                prefs.edit().remove(tag).apply()
            }
        }
    }

    private fun isQuestionResolvedLocked(context: Context, identity: QuestionNotificationIdentity): Boolean {
        val prefs = context.getSharedPreferences(QUESTION_NOTIFICATIONS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val tombstones = prefs.all.entries.mapNotNull { (key, value) ->
            if (key.startsWith("resolved:") && value is Long) key to value else null
        }.toMap()
        val retained = pruneQuestionTombstones(tombstones, now, MAX_QUESTION_TOMBSTONES, QUESTION_TOMBSTONE_AGE)
        if (retained.size != tombstones.size) {
            val edit = prefs.edit()
            for (key in tombstones.keys - retained.keys) edit.remove(key)
            edit.apply()
        }
        return retained.containsKey(identity.resolvedPreferenceKey)
    }

    private fun resolveQuestionLocked(context: Context, identity: QuestionNotificationIdentity, questionPairingStamp: String?) {
        tombstoneQuestionLocked(context, identity)
        if (questionPairingStamp != null) stopMatchingOverlay(context, identity, questionPairingStamp)
    }

    private fun tombstoneQuestionLocked(context: Context, identity: QuestionNotificationIdentity) {
        val prefs = context.getSharedPreferences(QUESTION_NOTIFICATIONS, Context.MODE_PRIVATE)
        prefs.edit().putLong(identity.resolvedPreferenceKey, System.currentTimeMillis())
            .remove(identity.postedPreferenceKey).commit()
        manager(context).cancel(identity.notificationTag, 0)
        trimQuestionTombstonesLocked(prefs)
    }

    private fun trimQuestionTombstonesLocked(prefs: android.content.SharedPreferences) {
        val now = System.currentTimeMillis()
        val tombstones = prefs.all.entries.mapNotNull { (key, value) ->
            if (key.startsWith("resolved:") && value is Long) key to value else null
        }.toMap()
        val retained = pruneQuestionTombstones(tombstones, now, MAX_QUESTION_TOMBSTONES, QUESTION_TOMBSTONE_AGE)
        val edit = prefs.edit()
        for (key in tombstones.keys - retained.keys) edit.remove(key)
        edit.apply()
    }

    private fun stopMatchingOverlay(context: Context, identity: QuestionNotificationIdentity, questionPairingStamp: String?) {
        val active = activeQuestionOverlay(context) ?: return
        if (active.first == identity && active.second == questionPairingStamp)
            GatewayOverlayService.revokeQuestionIfActive(context, identity, questionPairingStamp)
    }

    private fun activeQuestionOverlay(context: Context): Pair<QuestionNotificationIdentity, String?>? {
        val prefs = context.getSharedPreferences(QUESTION_OVERLAY_STATE, Context.MODE_PRIVATE)
        val identity = prefs.getString("identity", null)?.let(QuestionNotificationIdentity::decode) ?: return null
        return identity to prefs.getString("pairingStamp", null)
    }
}

class GatewayPushService : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) = PushRegistration.onEndpoint(applicationContext, instance, endpoint)
    override fun onMessage(message: PushMessage, instance: String) {
        if (!message.decrypted || !PushRegistration.acceptsMessage(applicationContext, instance)) return
        val note = PushNote.parse(message.content) ?: return
        val runtimeForRooms = GatewayRuntime.get(applicationContext)
        when (val target = note.target) {
            // A room: notified unless muted here or on screen (decision 1).
            is PushTarget.OpenRoom -> {
                runtimeForRooms.scope.launch {
                    runtimeForRooms.withCurrentPairingStampForPush {
                        if (!PushRegistration.acceptsMessage(applicationContext, instance)) return@withCurrentPairingStampForPush
                        RoomNotifications.show(applicationContext, note, target.roomId, runtimeForRooms.rooms.isShowing(target.roomId))
                    }
                }
                return
            }
            // What pirc remembered: the engine's memory page.
            PushTarget.OpenMemory -> {
                if (note.kind == null) {
                    GatewayNotifications.show(applicationContext, note.title, note.body, null, "memory", tag = note.tag)
                    return
                }
            }
            else -> Unit
        }
        val pushedInteraction = note.interaction
        val session = pushedInteraction?.sessionId ?: note.sessionId ?: (note.target as? PushTarget.OpenSession)?.sessionId
        val identity = pushedInteraction?.let {
            QuestionNotificationIdentity.from(it.sessionId, it.interactionId, it.interactionEpoch)
        }
        val runtime = GatewayRuntime.get(applicationContext)
        if (pushedInteraction != null && note.tag != identity?.notificationTag) return
        if (pushedInteraction != null && (note.target as? PushTarget.OpenSession)?.sessionId?.let { it != pushedInteraction.sessionId } == true) return
        if (pushedInteraction?.isResolved == true && identity != null) {
            runtime.scope.launch {
                runtime.withOptionalPairingStampForPush { stamp ->
                    if (!PushRegistration.acceptsMessage(applicationContext, instance)) return@withOptionalPairingStampForPush
                    GatewayNotifications.revokeQuestion(applicationContext, identity, stamp)
                }
            }
            return
        }
        if (note.kind == "interaction_answered") return
        if (note.kind == "interaction_created" && (pushedInteraction?.isCreated != true || identity == null)) return
        if (note.kind == "interaction_refresh" &&
            (!note.isInteractionRefresh || (note.target as? PushTarget.OpenSession)?.sessionId != session)) return
        if (pushedInteraction?.isCreated == true && identity != null && GatewayNotifications.isQuestionResolved(applicationContext, identity)) return
        if (note.kind == "interaction_refresh") {
            if (session == null) return
            runtime.scope.launch {
                val captured = readPushValueOrNull {
                    withTimeout(8000) { runtime.sessions.snapshotForInteraction(session) }
                } ?: return@launch
                runtime.withCurrentPairingStampForPush { stamp ->
                    if (!PushRegistration.acceptsMessage(applicationContext, instance) || stamp != captured.second) return@withCurrentPairingStampForPush
                    GatewayNotifications.sync(applicationContext, captured.first, questionPairingStamp = stamp)
                }
            }
            return
        }
        val suppressVisible = shouldSuppressVisibleSessionPush(session, runtime.sessions::hasVisibleSessionSubscriber)
        if (suppressVisible && pushedInteraction?.isCreated != true) return
        val category = if (note.tag.startsWith("delegation:")) "deleg" else "q"
        runtime.scope.launch {
            val captured = if (session != null) readPushValueOrNull {
                withTimeout(8000) { runtime.sessions.snapshotForInteraction(session) }
            } else null
            val snapshot = captured?.first
            runtime.withCurrentPairingStampForPush { pairingStamp ->
                if (!PushRegistration.acceptsMessage(applicationContext, instance) || (captured != null && captured.second != pairingStamp)) return@withCurrentPairingStampForPush
                val current = if (identity != null) snapshot?.interactions?.firstOrNull {
                    it.id == identity.interactionId && it.runnerEpoch == identity.interactionEpoch && it.status == "pending" &&
                        (it.expiresAt == null || it.expiresAt > System.currentTimeMillis())
                } else null
                val disposition = identity?.let {
                    createdQuestionDisposition(
                        tombstoned = GatewayNotifications.isQuestionResolved(applicationContext, it),
                        snapshotAvailable = snapshot != null,
                        exactPending = current != null,
                    )
                }
                when (disposition) {
                    CreatedQuestionDisposition.SUPPRESS -> return@withCurrentPairingStampForPush
                    CreatedQuestionDisposition.RESOLVE -> {
                        GatewayNotifications.revokeQuestion(applicationContext, identity!!, pairingStamp)
                        return@withCurrentPairingStampForPush
                    }
                    else -> Unit
                }
                if (snapshot != null) GatewayNotifications.sync(applicationContext, snapshot, questionPairingStamp = pairingStamp)
                if (suppressVisible || shouldSuppressVisibleSessionPush(session, runtime.sessions::hasVisibleSessionSubscriber)) return@withCurrentPairingStampForPush
                if (snapshot != null && category == "q" && identity == null && snapshot.interactions.none {
                    it.status == "pending" && (it.expiresAt == null || it.expiresAt > System.currentTimeMillis())
                }) return@withCurrentPairingStampForPush
                val q = if (disposition == CreatedQuestionDisposition.SHOW_ACTIONABLE) current else null
                GatewayNotifications.show(applicationContext,note.title,note.body,session,null,category,snapshot?.session?.workspaceId,q,note.tag,identity,
                    questionPairingStamp = pairingStamp, allowQuestionActions = disposition == CreatedQuestionDisposition.SHOW_ACTIONABLE)
            }
        }
    }
    override fun onRegistrationFailed(reason: FailedReason, instance: String) = PushRegistration.fail(applicationContext, instance, reason.toString())
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

private suspend fun GatewayRuntime.withOptionalPairingStampForPush(action: (String?) -> Unit) {
    try {
        withOptionalPairingStamp(action)
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        // A malformed/stale control delivery must not crash the push service.
    }
}

/** A timed-out/unavailable snapshot is uncertainty; coroutine cancellation still belongs to the caller. */
private suspend fun <T> readPushValueOrNull(read: suspend () -> T): T? = try {
    read()
} catch (_: TimeoutCancellationException) {
    null
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    null
}
