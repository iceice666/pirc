package dev.pirc.pirc_mobile

import android.app.*
import android.content.*
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.*
import android.provider.Settings
import android.view.*
import android.widget.*
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.timeline.Interaction
import kotlinx.coroutines.*
import org.json.JSONObject

/** The same verified window lifecycle, backed by real snapshots and control leases. */
class GatewayOverlayService: Service() {
    companion object {
        @Volatile private var activeService: GatewayOverlayService? = null

        internal fun revokeQuestionIfActive(
            context: Context,
            identity: QuestionNotificationIdentity,
            questionPairingStamp: String?,
        ): Boolean {
            val service = activeService ?: return false
            service.scope.launch {
                if (activeService !== service || service.scheduleId != null || service.sessionId != identity.sessionId) return@launch
                if (service.currentQuestionIdentity() != identity || service.activeQuestionPairingStamp() != questionPairingStamp) return@launch
                val capturedGeneration = ++service.overlayGeneration
                service.refreshGeneration++
                service.refreshJob?.cancel()
                service.ready = false
                service.handled = true
                service.busy = false
                service.status = "這項已經處理過了"
                service.render()
                delay(350)
                if (activeService === service && sameQuestionOverlayTargetAtGeneration(
                        current = service.currentQuestionIdentity(),
                        currentPairingStamp = service.activeQuestionPairingStamp(),
                        revoked = identity,
                        revokedPairingStamp = questionPairingStamp,
                        capturedGeneration = capturedGeneration,
                        currentGeneration = service.overlayGeneration,
                    )) service.stopSelf()
            }
            return true
        }

        internal fun clearQuestionIfActive(context: Context): Boolean {
            val service = activeService ?: return false
            val capturedGeneration = service.overlayGeneration
            service.scope.launch {
                if (activeService !== service || service.overlayGeneration != capturedGeneration || service.scheduleId != null) return@launch
                service.overlayGeneration++
                service.refreshGeneration++
                service.refreshJob?.cancel()
                service.stopSelf()
            }
            return true
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var runtime: GatewayRuntime
    private lateinit var windows: WindowManager
    private var root: ScrollView? = null
    private lateinit var body: LinearLayout
    private lateinit var colors: JSONObject
    private var sessionId = ""
    private var scheduleId: String? = null
    private var missedRun: Map<*, *>? = null
    private var scheduleTitle = "錯過的排程"
    private var questionId: String? = null
    private var questionEpoch: String? = null
    private var entryPairingStamp: String? = null
    private var legacyQuestionEntry = false
    private var question: Interaction? = null
    private var pairingStamp: String? = null
    private var choice: String? = null
    private var sessionTitle = "快速回應"
    private var handled = false
    private var failed = false
    private var expiryJob: Job? = null
    private var status = "確認最新狀態…"
    private var ready = false
    private var busy = false
    private var lockedOutcome = false
    private var pending: Job? = null
    private var refreshJob: Job? = null
    @Volatile private var overlayGeneration = 0L
    private var refreshGeneration = 0L
    private val screenOff = object: BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { stopSelf() }
    }
    private fun currentQuestionIdentity(): QuestionNotificationIdentity? =
        question?.let { QuestionNotificationIdentity.from(sessionId, it.id, it.runnerEpoch) }
            ?: QuestionNotificationIdentity.from(sessionId, questionId, questionEpoch)

    private fun activeQuestionPairingStamp(): String? = entryPairingStamp ?: pairingStamp

    override fun onCreate() {
        super.onCreate()
        activeService = this
        runtime = GatewayRuntime.get(this)
        windows = getSystemService(WindowManager::class.java)
        loadColors()
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF), RECEIVER_NOT_EXPORTED)
        else registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF))
    }
    private fun loadColors() {
        val appearance = NotificationPreferences(this).read()["appearance"]
        val dark = appearance == "dark" || (appearance != "light" && resources.configuration.uiMode and 0x30 == 0x20)
        colors = JSONObject(assets.open("flutter_assets/assets/design-tokens.json").bufferedReader().use { it.readText() })
            .getJSONObject("color").getJSONObject(if (dark) "dark" else "light")
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nextScheduleId = intent?.getStringExtra("scheduleId")
        val nextSessionId = intent?.getStringExtra("sessionId") ?: ""
        val nextQuestionId = intent?.getStringExtra("interactionId")
        val nextQuestionEpoch = intent?.getStringExtra("interactionEpoch")
        val nextPairingStamp = intent?.getStringExtra("questionPairingStamp")
        val incomingIdentity = QuestionNotificationIdentity.from(nextSessionId, nextQuestionId, nextQuestionEpoch)
        if (busy && !ready && (refreshJob?.isActive == true || pending?.isActive == true) &&
            scheduleId == null && nextScheduleId == null &&
            sameQuestionOverlayRequest(currentQuestionIdentity(), activeQuestionPairingStamp(), incomingIdentity, nextPairingStamp)) {
            return START_NOT_STICKY
        }

        overlayGeneration++
        refreshGeneration++
        refreshJob?.cancel()
        expiryJob?.cancel()
        loadColors()
        val previousSession = sessionId
        val previousQuestion = questionId
        val previousQuestionEpoch = questionEpoch
        val previousPairingStamp = entryPairingStamp
        val previousSchedule=scheduleId
        scheduleId=nextScheduleId
        if(previousSchedule!=scheduleId) {missedRun=null;choice=null;lockedOutcome=false}
        sessionId=nextSessionId
        if(sessionId.isEmpty() && scheduleId==null) {stopSelf(); return START_NOT_STICKY}
        val changedQuestion = nextQuestionId != previousQuestion || nextQuestionEpoch != previousQuestionEpoch ||
            nextPairingStamp != previousPairingStamp
        questionId = nextQuestionId
        questionEpoch = nextQuestionEpoch
        entryPairingStamp = nextPairingStamp
        legacyQuestionEntry = nextQuestionId != null && nextQuestionEpoch == null
        if (sessionId != previousSession || changedQuestion) { question=null; choice=null; lockedOutcome=false }
        if (scheduleId != null || nextQuestionId == null) GatewayNotifications.setActiveQuestionOverlay(this, null, null)
        try {
            startForeground(4201, GatewayNotifications.notification(this, "pirc · 快速回應", "確認最新問題後才會送出", sessionId).setOngoing(true).build())
            if (!Settings.canDrawOverlays(this) || getSystemService(KeyguardManager::class.java).isKeyguardLocked) {
                GatewayNotifications.show(this, "pirc · 待你處理", "解鎖後開啟對話確認", sessionId)
                stopSelf(); return START_NOT_STICKY
            }
            if (root == null) createWindow()
            refresh()
        } catch (_: Exception) { stopSelf() }
        return START_NOT_STICKY
    }
    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private fun color(key: String): Int {
        val raw=colors.getString(key)
        if(!raw.startsWith("rgba")) return Color.parseColor(raw)
        val values=raw.substringAfter('(').substringBefore(')').split(',').map { it.trim().toDouble() }
        return Color.argb((values[3]*255).toInt(),values[0].toInt(),values[1].toInt(),values[2].toInt())
    }
    private fun createWindow() {
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(16), dp(20), dp(16)) }
        root = object: ScrollView(this) {
            override fun onMeasure(w: Int, h: Int) { super.onMeasure(w, MeasureSpec.makeMeasureSpec((resources.displayMetrics.heightPixels * .7).toInt(), MeasureSpec.AT_MOST)) }
        }.apply {
            addView(body)
            background = GradientDrawable().apply { setColor(color("surface.layer")); cornerRadius = dp(26).toFloat() }
            elevation = dp(12).toFloat()
        }
        windows.addView(root, WindowManager.LayoutParams(minOf(resources.displayMetrics.widthPixels - dp(24), dp(560)), -2,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL; y = dp(12)
        })
    }
    private fun text(value: String, size: Float = 15f) { body.addView(TextView(this).apply { text = value; textSize = size; if(size>=17f) typeface=android.graphics.Typeface.create("sans-serif-medium",android.graphics.Typeface.NORMAL); setTextColor(color("text.primary")); setPadding(0, dp(8), 0, dp(8)) }) }
    private fun button(label: String, primary: Boolean = false, enabled: Boolean = true, action: () -> Unit) {
        body.addView(Button(this).apply {
            text = label; isAllCaps = false; stateListAnimator=null; elevation=0f; backgroundTintList=null; minHeight = dp(48); isEnabled = enabled; alpha=if(enabled) 1f else .4f
            setTextColor(color(if(primary) "action.onPrimary" else "text.primary"))
            background = GradientDrawable().apply { setColor(color(if(primary) "action.primary" else "surface.subtle")); cornerRadius = dp(12).toFloat() }
            layoutParams = LinearLayout.LayoutParams(-1,-2).apply { topMargin = dp(8) }
            setOnClickListener { action() }
        })
    }
    private fun option(value: String, label: String) {
        val selected=choice==value
        body.addView(TextView(this).apply {
            text=(if(selected) "◉  " else "○  ")+label; textSize=15f; minHeight=dp(48); gravity=Gravity.CENTER_VERTICAL
            setPadding(dp(14),dp(12),dp(14),dp(12)); setTextColor(color(if(selected) "accent.default" else "text.primary"))
            background=GradientDrawable().apply { setColor(color(if(selected) "accent.soft" else "surface.subtle")); cornerRadius=dp(12).toFloat(); if(selected) setStroke(dp(1),color("accent.default")) }
            layoutParams=LinearLayout.LayoutParams(-1,-2).apply { topMargin=dp(6) }
            isClickable=true; isFocusable=true; contentDescription=label+(if(selected) "，已選取" else "")
            setOnClickListener { choice=value; render() }
        })
    }
    private fun render() {
        if(root==null) return
        root?.background=GradientDrawable().apply { setColor(color("surface.layer")); cornerRadius=dp(26).toFloat() }
        body.removeAllViews()
        val header=LinearLayout(this).apply { gravity=Gravity.CENTER_VERTICAL }
        header.addView(TextView(this).apply { text="π  pirc · $sessionTitle"; textSize=13f; gravity=Gravity.CENTER_VERTICAL; setTextColor(color("text.muted")); maxLines=1; ellipsize=android.text.TextUtils.TruncateAt.END },LinearLayout.LayoutParams(0,dp(48),1f))
        fun icon(label:String,glyph:String,action:()->Unit) { header.addView(TextView(this).apply { text=glyph; textSize=24f; gravity=Gravity.CENTER; contentDescription=label; setTextColor(color("text.secondary")); isClickable=true; isFocusable=true; setOnClickListener { action() } },LinearLayout.LayoutParams(dp(48),dp(48))) }
        icon("開啟完整對話","↗") { startActivity(GatewayNotifications.intent(this,sessionId.takeIf { it.isNotEmpty() },scheduleId?.let { "schedule:$it" })); stopSelf() }
        icon("關閉","×") { stopSelf() }
        body.addView(header)
        text(if(handled) "這項已經處理過了" else if(scheduleId!=null) scheduleTitle else question?.title ?: "確認最新狀態…",20f)
        question?.description?.takeIf { !handled }?.let { text(it,14f) }
        if(busy) body.addView(ProgressBar(this).apply { isIndeterminate=true },LinearLayout.LayoutParams(dp(24),dp(24)).apply { topMargin=dp(12); bottomMargin=dp(12) })
        val q=question
        if(scheduleId!=null && ready && !busy && !lockedOutcome) {
            option("run","執行這次工作"); option("dismiss","略過這次執行")
            button(if(choice=="dismiss") "確認略過" else "確認執行",true,choice!=null) { submitSchedule() }
        }
        if(ready && !busy && !lockedOutcome && q!=null) {
            if(q.kind=="confirm") { option("yes","確認"); option("no","拒絕") }
            else for(o in q.options) option(o.value,o.label)
            button("送出答案",true,choice!=null) { submit() }
            q.expiresAt?.let { text("到期 "+java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(it)),12f) }
        }
        text(status,13f)
        if(handled) button("好",true) { stopSelf() }
        else if(!busy && !ready) {
            if(failed) button("重試") { refresh() }
            else button("開啟完整對話") { startActivity(GatewayNotifications.intent(this,sessionId.takeIf { it.isNotEmpty() },scheduleId?.let { "schedule:$it" })); stopSelf() }
        }
    }
    private fun refresh() {
        if(scheduleId!=null) { refreshSchedule(); return }
        refreshJob?.cancel()
        val targetGeneration = overlayGeneration
        val requestGeneration = ++refreshGeneration
        fun isCurrentRefresh() = targetGeneration == overlayGeneration && requestGeneration == refreshGeneration
        expiryJob?.cancel(); ready=false; busy=true; handled=false; failed=false; status="確認最新狀態…"; render()
        refreshJob = scope.launch {
            try {
                val (state, snapshotPairingStamp) = runtime.snapshotForInteraction(sessionId)
                if (!isCurrentRefresh()) return@launch
                if (entryPairingStamp != null && entryPairingStamp != snapshotPairingStamp) {
                    pairingStamp = null
                    question = null
                    ready = false
                    handled = false
                    status = "配對已變更，請從目前帳號重新開啟對話。"
                    GatewayNotifications.setActiveQuestionOverlay(this@GatewayOverlayService, null, null)
                    return@launch
                }
                pairingStamp = snapshotPairingStamp
                sessionTitle=state.session.name
                GatewayNotifications.sync(this@GatewayOverlayService,state,questionPairingStamp=snapshotPairingStamp)
                val selectedId = questionId
                val selectedEpoch = questionEpoch
                val next = if(selectedId != null) {
                    state.interactions.firstOrNull { it.id == selectedId && selectedEpoch != null && it.runnerEpoch == selectedEpoch }
                        ?: if (selectedEpoch == null) state.interactions.firstOrNull { it.id == selectedId && it.status == "pending" }
                            ?: state.interactions.firstOrNull { it.id == selectedId }
                        else null
                } else state.interactions.firstOrNull { it.status=="pending" }
                if (question?.id != next?.id || question?.runnerEpoch != next?.runnerEpoch || question?.options != next?.options || question?.title != next?.title) choice=null
                question=next
                questionId=next?.id ?: questionId
                if (!legacyQuestionEntry && questionEpoch == null) questionEpoch=next?.runnerEpoch
                val nextIdentity = next?.let { QuestionNotificationIdentity.from(sessionId, it.id, it.runnerEpoch) }
                val revoked = next?.status == "pending" && nextIdentity != null && GatewayNotifications.isQuestionResolved(this@GatewayOverlayService, nextIdentity)
                val activeIdentity = next?.takeIf { it.status == "pending" && !revoked && (it.expiresAt == null || it.expiresAt > System.currentTimeMillis()) }
                    ?.let { nextIdentity }
                GatewayNotifications.setActiveQuestionOverlay(this@GatewayOverlayService, activeIdentity, snapshotPairingStamp)
                when {
                    revoked -> { handled=true; status="這項已經處理過了" }
                    next == null || next.status != "pending" -> { handled=true; status="最新狀態已確認，不需要再次回答。" }
                    legacyQuestionEntry -> status="這是舊通知，無法確認題目版本；請開啟完整對話重新查看。"
                    (next.expiresAt != null && next.expiresAt!! <= System.currentTimeMillis()) -> status="問題已過期"
                    lockedOutcome -> status="先前送出結果不明，請在完整對話檢查；不會自動重送"
                    next.kind !in listOf("confirm","select") || next.multiple || next.options.size > 3 ||
                        next.modelChoice != null || next.userRequestChoice != null -> status="請開啟完整對話輸入答案"
                    else -> {
                        val lease = runtime.lease(sessionId, acquire=true)
                        if (!isCurrentRefresh()) return@launch
                        ready=lease["held"]==true
                        status=if(ready) "控制：此裝置" else "控制權在其他裝置，請開啟完整對話確認是否接管"
                        if(ready && next.expiresAt!=null) expiryJob=scope.launch expiry@{
                            delay((next.expiresAt!!-System.currentTimeMillis()).coerceAtLeast(1))
                            if (!isCurrentRefresh()) return@expiry
                            ready=false; status="問題已過期"; render()
                        }
                    }
                }
            } catch(e: CancellationException) { throw e }
            catch(e: Exception) { if (isCurrentRefresh()) { failed=true; status="無法確認最新狀態，請重試。" } }
            finally { if (isCurrentRefresh()) { busy=false; render() } }
        }
    }
    private val scheduleUnknown get() = getSharedPreferences("uncertain_schedules",MODE_PRIVATE)
    private fun schedulePath() = "/api/schedules/"+android.net.Uri.encode(scheduleId!!)
    private fun refreshSchedule() {
        refreshJob?.cancel()
        val targetGeneration = overlayGeneration
        val requestGeneration = ++refreshGeneration
        fun isCurrentRefresh() = targetGeneration == overlayGeneration && requestGeneration == refreshGeneration
        ready=false;busy=true;failed=false;handled=false;status="確認最新狀態…";render()
        refreshJob=scope.launch {
            try {
                val data=runtime.request("GET",schedulePath(),null) as Map<*, *>
                if (!isCurrentRefresh()) return@launch
                val schedule=data["schedule"] as? Map<*, *>
                scheduleTitle=schedule?.get("title")?.toString() ?: "錯過的排程"
                sessionTitle="排程"
                val runs=(data["runs"] as? List<*>)?.filterIsInstance<Map<*, *>>().orEmpty()
                val next=if(missedRun==null) runs.firstOrNull { it["status"]=="missed" } else runs.firstOrNull { it["id"]==missedRun?.get("id") && it["status"]=="missed" }
                missedRun=next
                lockedOutcome=next!=null && scheduleUnknown.getBoolean("$scheduleId:${next["id"]}",false)
                when {
                    next==null -> {handled=true;status="這次排程已處理，不需要再次操作。"}
                    lockedOutcome -> status="先前送出結果不明，請開啟排程檢查執行紀錄。"
                    else -> {ready=true;status="選擇執行或略過，再按確認。"}
                }
            } catch(e:CancellationException) {throw e}
            catch(e:Exception) {if (isCurrentRefresh()) {failed=true;status="無法確認最新狀態，請重試。"}}
            finally {if (isCurrentRefresh()) {busy=false;render()}}
        }
    }
    private fun submitSchedule() {
        val run=missedRun ?: return
        val action=choice ?: return
        if(!ready || busy || lockedOutcome) return
        val submitGeneration = overlayGeneration
        val submitScheduleId = scheduleId ?: return
        val submitPath = "/api/schedules/" + android.net.Uri.encode(submitScheduleId)
        ready=false;busy=true;status="送出中…";render()
        pending=scope.launch {
            val key="$submitScheduleId:${run["id"]}"
            var sent=false
            try {
                val fresh=runtime.request("GET",submitPath,null) as Map<*, *>
                if (submitGeneration != overlayGeneration || scheduleId != submitScheduleId) return@launch
                val valid=(fresh["runs"] as? List<*>)?.filterIsInstance<Map<*, *>>()?.any { it["id"]==run["id"] && it["status"]=="missed" }==true
                if(!valid) {handled=true;status="這次排程已經處理過了";busy=false;render();return@launch}
                check(scheduleUnknown.edit().putBoolean(key,true).commit())
                sent=true
                runtime.request("POST",submitPath+if(action=="run") "/run" else "/runs/${android.net.Uri.encode(run["id"].toString())}/dismiss",if(action=="run") mapOf("runId" to run["id"]) else emptyMap<String,Any>())
                scheduleUnknown.edit().remove(key).commit()
                if (submitGeneration != overlayGeneration || scheduleId != submitScheduleId) return@launch
                status=if(action=="run") "已提出執行" else "已略過"; render();delay(1200)
                if (submitGeneration == overlayGeneration && scheduleId == submitScheduleId) stopSelf()
            } catch(e:CancellationException) {throw e}
            catch(e:Exception) {
                val operationLockedOutcome=sent && (e !is ApiException || e.status !in 400..499 || e.code=="outcome_unknown")
                if(!operationLockedOutcome) scheduleUnknown.edit().remove(key).commit()
                if (submitGeneration != overlayGeneration || scheduleId != submitScheduleId) return@launch
                lockedOutcome=operationLockedOutcome
                status=if(lockedOutcome) "不確定是否已送達，請開啟排程檢查紀錄；不會重送。" else "狀態已改變或連線失敗，請重新確認。"
                failed=!lockedOutcome;busy=false;render()
            }
        }
    }
    private fun submit() {
        val q=question ?: return; val selected=choice ?: return
        if(busy || !ready || lockedOutcome) return
        val submitPairingStamp = pairingStamp ?: run { ready=false; status="請重新確認配對狀態"; render(); return }
        val submitOverlayStamp = activeQuestionPairingStamp()
        if (submitOverlayStamp != submitPairingStamp) { ready=false; status="配對已變更，請重新確認"; render(); return }
        val submitSessionId = sessionId
        val submitIdentity = QuestionNotificationIdentity.from(submitSessionId, q.id, q.runnerEpoch) ?: return
        val submitGeneration = overlayGeneration
        busy=true; ready=false; status="送出中…"; render()
        pending=scope.launch {
            try {
                runtime.answer(submitSessionId,q.id,q.runnerEpoch,submitPairingStamp, if(q.kind=="confirm") mapOf("confirmed" to (selected=="yes")) else mapOf("values" to listOf(selected)))
                if (!sameQuestionOverlayTargetAtGeneration(
                        current = currentQuestionIdentity(),
                        currentPairingStamp = activeQuestionPairingStamp(),
                        revoked = submitIdentity,
                        revokedPairingStamp = submitOverlayStamp,
                        capturedGeneration = submitGeneration,
                        currentGeneration = overlayGeneration,
                    )) return@launch
                status="已送出"; render(); delay(1200)
                if (sameQuestionOverlayTargetAtGeneration(
                        current = currentQuestionIdentity(),
                        currentPairingStamp = activeQuestionPairingStamp(),
                        revoked = submitIdentity,
                        revokedPairingStamp = submitOverlayStamp,
                        capturedGeneration = submitGeneration,
                        currentGeneration = overlayGeneration,
                    )) stopSelf()
            } catch(e: CancellationException) { throw e }
            catch(e: Exception) {
                if (!sameQuestionOverlayTargetAtGeneration(
                        current = currentQuestionIdentity(),
                        currentPairingStamp = activeQuestionPairingStamp(),
                        revoked = submitIdentity,
                        revokedPairingStamp = submitOverlayStamp,
                        capturedGeneration = submitGeneration,
                        currentGeneration = overlayGeneration,
                    )) return@launch
                lockedOutcome = e !is ApiException || e.status !in 400..499 || e.code=="outcome_unknown"
                status=if(lockedOutcome) "不確定是否已送達，請檢查狀態" else e.message ?: "問題已變更"
                busy=false; render()
            }
        }
    }
    override fun onConfigurationChanged(config: android.content.res.Configuration) {
        super.onConfigurationChanged(config)
        loadColors();render()
        val view = root ?: return
        val params = view.layoutParams as WindowManager.LayoutParams
        params.width = minOf(resources.displayMetrics.widthPixels - dp(24), dp(560))
        windows.updateViewLayout(view, params)
        view.requestLayout()
    }
    override fun onDestroy() {
        GatewayNotifications.clearActiveQuestionOverlay(this, question?.let { QuestionNotificationIdentity.from(sessionId, it.id, it.runnerEpoch) })
        if (activeService === this) activeService = null
        scope.cancel(); root?.let { if(it.isAttachedToWindow) windows.removeView(it) }; root=null
        unregisterReceiver(screenOff); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
