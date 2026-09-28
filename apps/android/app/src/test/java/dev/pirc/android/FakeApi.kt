package dev.pirc.android

import dev.pirc.android.core.ApiException
import dev.pirc.android.core.CommandReceipt
import dev.pirc.android.core.ControlLease
import dev.pirc.android.core.Drafts
import dev.pirc.android.core.InteractionAnswer
import dev.pirc.android.core.GitStatus
import dev.pirc.android.core.ModelOption
import dev.pirc.android.core.Pairing
import dev.pirc.android.core.PanelState
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.PircJson
import dev.pirc.android.core.StreamSignal
import dev.pirc.android.core.timeline.EventEnvelope
import dev.pirc.android.core.timeline.TimelineEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

const val ME = "android-me"
const val SESSION = "s1"
const val EPOCH = "e1"

/** A [PircApi] answering from memory; every call is recorded in [calls]. */
open class FakeApi(baseUrl: String = "https://pirc.example") : PircApi(Pairing(baseUrl, "pirc_dev_" + "t".repeat(43))) {
    val calls = mutableListOf<String>()

    var snapshotJson = """{"session":{"id":"$SESSION","workspaceId":"w","name":"Test","runnerState":"ready"},"history":[],"watermark":{"epoch":"$EPOCH","sequence":0}}"""
    var lease = ControlLease(ME, heldByCurrentClient = true, generation = 7)

    /** What a command replies; set [commandGate] to hold it until completed. */
    var receipt: () -> CommandReceipt = { CommandReceipt("c", "accepted", null) }
    var commandGate: CompletableDeferred<Unit>? = null

    /** One channel per [events] call, newest last. */
    val streams = mutableListOf<Channel<StreamSignal>>()

    override suspend fun snapshot(sessionId: String): JsonElement {
        calls += "snapshot"
        return PircJson.parseToJsonElement(snapshotJson)
    }

    override fun events(sessionId: String, cursor: String?): Flow<StreamSignal> {
        calls += "events:$cursor"
        return Channel<StreamSignal>(Channel.UNLIMITED).also { streams += it }.receiveAsFlow()
    }

    var models: () -> List<ModelOption> = { emptyList() }

    override suspend fun models(sessionId: String): List<ModelOption> {
        calls += "models"
        return models()
    }

    override suspend fun control(sessionId: String, clientId: String): ControlLease {
        calls += "control"
        return lease
    }

    override suspend fun acquireControl(sessionId: String, clientId: String, force: Boolean): ControlLease {
        calls += "acquire:$force"
        return lease
    }

    override suspend fun heartbeatControl(sessionId: String, clientId: String, generation: Long): ControlLease {
        calls += "heartbeat:$generation"
        return lease
    }

    override suspend fun releaseControl(sessionId: String, clientId: String, generation: Long) {
        calls += "release:$generation"
    }

    override suspend fun command(sessionId: String, clientId: String, generation: Long, commandId: String, payload: JsonObject): CommandReceipt {
        calls += "command:${(payload["type"] as? kotlinx.serialization.json.JsonPrimitive)?.content}:$generation"
        commandGate?.await()
        return receipt()
    }

    override suspend fun answer(sessionId: String, interactionId: String, clientId: String, generation: Long, answer: InteractionAnswer) {
        calls += "answer:$interactionId"
    }

    /** No Git unless a test sets one (never the network). */
    var git: () -> GitStatus = { throw ApiException(500, null, "no git") }

    override suspend fun gitStatus(sessionId: String): GitStatus {
        calls += "git"
        return git()
    }

    var panel: () -> PanelState = { throw ApiException(500, null, "no panel") }

    override suspend fun panelState(sessionId: String): PanelState {
        calls += "panel"
        return panel()
    }
}

class MemoryDrafts : Drafts {
    val saved = HashMap<String, String>()
    override fun draft(sessionId: String) = saved[sessionId] ?: ""
    override fun saveDraft(sessionId: String, text: String) {
        saved[sessionId] = text
    }
}

fun envelope(sequence: Long, event: TimelineEvent, epoch: String = EPOCH) =
    EventEnvelope(SESSION, epoch, sequence, "$epoch:$sequence", event)
