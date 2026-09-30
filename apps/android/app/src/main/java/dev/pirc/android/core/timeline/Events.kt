package dev.pirc.android.core.timeline

import dev.pirc.android.core.PircJson
import dev.pirc.android.core.Session
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/*
 * Gateway snapshots and `/api/events` messages as client state; a port of the
 * web's `snapshotFromRaw`/`normalizeEvent` (`api.ts`) and `state.ts`.
 */

sealed interface TimelineEvent {
    data class MessageStarted(val message: Message) : TimelineEvent
    /** [messageId] null: applies to the newest partial assistant message. */
    data class MessageDelta(val delta: String, val thinking: Boolean, val messageId: String? = null) : TimelineEvent
    data class MessageCompleted(val message: Message) : TimelineEvent
    data class ToolUpdated(val tool: ToolUpdate, val messageId: String? = null) : TimelineEvent
    data class QueueUpdated(val queue: List<QueueItem>) : TimelineEvent
    data class WidgetUpdated(val key: String, val lines: List<String>?) : TimelineEvent
    data class StatusUpdated(val key: String, val text: String?) : TimelineEvent
    data class SessionRenamed(val name: String) : TimelineEvent
    /** Side-panel data changed (memory, background, team, git); refetch lazily. */
    data class PanelChanged(val sections: List<String>) : TimelineEvent
    /** Only a new snapshot can tell what changed. */
    data class Reset(val reason: String) : TimelineEvent
    data object Noop : TimelineEvent
}

data class EventEnvelope(
    val sessionId: String,
    val runnerEpoch: String,
    val sequence: Long,
    val cursor: String,
    val event: TimelineEvent,
)

/** Events that change run/runner state only a snapshot reports accurately. */
private val SNAPSHOT_EVENTS = setOf(
    "interaction_created",
    "interaction_answered",
    "runner_ready",
    "runner_error",
    "runner_exit",
    "node_offline",
    "node_reconnected",
)

/** Agent lifecycle events that change run status. */
private val RUN_EVENTS = setOf("agent_start", "agent_end", "agent_settled")

private val THINKING_LEVELS = setOf("off", "minimal", "low", "medium", "high", "xhigh")

private fun queue(steering: JsonElement?, followUp: JsonElement?) =
    steering.array.orEmpty().mapIndexed { index, item -> QueueItem("steer-$index", "steer", item.text ?: "", index) } +
        followUp.array.orEmpty().mapIndexed { index, item -> QueueItem("follow-$index", "follow_up", item.text ?: "", index) }

private fun piEvent(pi: JsonElement?, timestamp: JsonElement?, now: () -> Long): TimelineEvent {
    return when (pi["type"].string) {
        "message_start" -> {
            if (pi["message"]["role"].string != "assistant") return TimelineEvent.Noop
            piMessage(pi["message"], now = now)?.let { TimelineEvent.MessageStarted(it.copy(isPartial = true)) }
                ?: TimelineEvent.Noop
        }
        "message_update" -> {
            val delta = pi["assistantMessageEvent"]
            when (delta["type"].string) {
                "text_delta", "thinking_delta" ->
                    TimelineEvent.MessageDelta(delta["delta"].text ?: "", thinking = delta["type"].string == "thinking_delta")
                "toolcall_start" -> delta["id"].takeIf { it.truthy }?.let {
                    TimelineEvent.ToolUpdated(ToolUpdate(it.text!!, name = delta["toolName"].text ?: "tool", status = "running"))
                } ?: TimelineEvent.Noop
                "toolcall_end" -> delta["toolCall"]["id"].takeIf { it.truthy }?.let {
                    TimelineEvent.ToolUpdated(
                        ToolUpdate(
                            it.text!!,
                            name = delta["toolCall"]["name"].text ?: "tool",
                            input = delta["toolCall"]["arguments"],
                            status = "running",
                        ),
                    )
                } ?: TimelineEvent.Noop
                else -> TimelineEvent.Noop
            }
        }
        "message_end" -> {
            val raw = pi["message"]
            if (raw["role"].string == "toolResult") {
                val id = raw["toolCallId"].text ?: "undefined"
                TimelineEvent.ToolUpdated(
                    toolResultFields(raw, id).copy(
                        name = raw["toolName"].text,
                        status = if (raw["isError"].truthy) "failed" else "succeeded",
                    ),
                )
            } else {
                piMessage(raw, now = now)?.let { TimelineEvent.MessageCompleted(it) } ?: TimelineEvent.Noop
            }
        }
        "tool_execution_start" -> TimelineEvent.ToolUpdated(
            ToolUpdate(
                pi["toolCallId"].text ?: "undefined",
                name = pi["toolName"].text,
                input = pi["args"],
                status = "running",
                startedAt = at(timestamp, now),
            ),
        )
        "tool_execution_update" -> TimelineEvent.ToolUpdated(
            toolResultFields(pi["partialResult"], pi["toolCallId"].text ?: "undefined"),
        )
        "tool_execution_end" -> TimelineEvent.ToolUpdated(
            toolResultFields(pi["result"], pi["toolCallId"].text ?: "undefined").copy(
                name = pi["toolName"].text,
                status = if (pi["isError"].truthy) "failed" else "succeeded",
                endedAt = at(timestamp, now),
            ),
        )
        "queue_update" -> TimelineEvent.QueueUpdated(queue(pi["steering"], pi["followUp"]))
        "panel_changed" -> TimelineEvent.PanelChanged(pi["sections"].array.orEmpty().map { it.text ?: "null" })
        else -> if (pi["type"].string in RUN_EVENTS) TimelineEvent.Reset("cursor_expired") else TimelineEvent.Noop
    }
}

/** One `/api/events` message. */
fun normalizeEvent(raw: JsonElement, now: () -> Long = System::currentTimeMillis): EventEnvelope {
    val type = raw["type"].string
    val data = raw["data"]
    val event: TimelineEvent = when {
        type == "reset" -> TimelineEvent.Reset(raw["reason"].text ?: "cursor_expired")
        type == "pi_event" -> piEvent(data ?: JsonObject(emptyMap()), raw["timestamp"], now)
        type == "notification" -> when (data["method"].string) {
            "notify" -> TimelineEvent.MessageCompleted(
                piNotification(
                    JsonObject((data as JsonObject) + ("receivedAt" to (raw["timestamp"] ?: kotlinx.serialization.json.JsonNull))),
                    now = now,
                ),
            )
            "setWidget" -> TimelineEvent.WidgetUpdated(
                data["widgetKey"].text ?: "",
                data["widgetLines"].array?.map { it.text ?: "null" },
            )
            "setStatus" -> TimelineEvent.StatusUpdated(data["statusKey"].text ?: "", data["statusText"].string)
            else -> TimelineEvent.Noop
        }
        type == "session_renamed" && data["name"].string != null -> TimelineEvent.SessionRenamed(data["name"].string!!)
        type == "runner_stderr" -> TimelineEvent.Noop
        type in SNAPSHOT_EVENTS -> TimelineEvent.Reset("cursor_expired")
        else -> TimelineEvent.Reset("epoch_changed")
    }
    return EventEnvelope(
        sessionId = raw["sessionId"].text ?: "",
        runnerEpoch = raw["epoch"].text ?: "0",
        sequence = raw["sequence"].number ?: 0,
        cursor = "${raw["epoch"].text ?: "0"}:${raw["sequence"].text ?: "0"}",
        event = event,
    )
}

private fun interaction(raw: JsonElement): Interaction {
    val request = raw["request"]
    val kind = raw["kind"].string
    val base = Interaction(
        id = raw["id"].text ?: "",
        runnerEpoch = raw["runnerEpoch"].text ?: "undefined",
        kind = "input",
        title = request["title"].text ?: "The agent needs your input",
        description = request["message"].text,
        expiresAt = raw["expiresAt"].number,
        status = raw["status"].text ?: "pending",
    )
    return when (kind) {
        "select" -> base.copy(
            kind = "select",
            multiple = request["multiple"].truthy,
            options = request["options"].array.orEmpty().mapIndexed { index, option ->
                val description = request["optionDescriptions"].array?.getOrNull(index)
                InteractionOption(option.text ?: "", option.text ?: "", description?.takeIf { it.truthy }?.text)
            },
        )
        "confirm" -> base.copy(kind = "confirm")
        "editor" -> base.copy(kind = "editor", initialValue = request["prefill"].text ?: "")
        else -> base.copy(placeholder = request["placeholder"].text)
    }
}

/** A `GET /api/sessions/:id/snapshot` reply as client state. */
fun snapshotState(raw: JsonElement, now: () -> Long = System::currentTimeMillis): SessionState {
    val sessionJson = raw["session"] ?: error("snapshot without a session")
    val session = PircJson.decodeFromJsonElement(Session.serializer(), sessionJson)
    val partial = piPartialMessage(raw["partialMessage"], now)
    val notices = raw["notifications"].array.orEmpty()
        .filter { it["method"].string == "notify" }
        .mapIndexed { index, item -> piNotification(item, index, now) }
    val messages = interleave(piHistory(raw["history"].array.orEmpty(), now), notices)
    val run = raw["run"]
    val watermark = raw["watermark"]
    val agent = raw["agent"]
    return SessionState(
        session = session,
        runnerStatus = sessionJson["runnerState"].text ?: "stopped",
        run = run?.let {
            RunState(
                id = it["id"].text,
                status = it["status"].text ?: "undefined",
                startedAt = it["startedAt"].takeIf { value -> value.truthy }?.let { value -> at(value, now) },
                endedAt = it["endedAt"].takeIf { value -> value.truthy }?.let { value -> at(value, now) },
                failureReason = it["failureReason"].text,
            )
        },
        // A snapshot taken mid-stream carries the live partial separately.
        messages = if (partial != null) messages.filter { it.id != partial.id } + partial else messages,
        interactions = raw["interactions"].array.orEmpty().map(::interaction),
        queue = queue(raw["queue"]["steering"], raw["queue"]["followUp"]),
        cursor = "${watermark["epoch"].text ?: "0"}:${watermark["sequence"].text ?: "0"}",
        runnerEpoch = watermark["epoch"].text ?: sessionJson["runnerEpoch"].text ?: "0",
        selectedModelId = agent["model"]["id"].takeIf { it.truthy }?.text,
        selectedModelProvider = agent["model"]["provider"].takeIf { it.truthy }?.text,
        thinkingLevel = agent["thinkingLevel"].string?.takeIf { it in THINKING_LEVELS },
        widgets = (raw["widgets"] as? JsonObject).orEmpty().mapValues { (_, lines) -> lines.array.orEmpty().map { it.text ?: "null" } },
        statuses = (raw["statuses"] as? JsonObject).orEmpty().mapValues { (_, text) -> text.text ?: "null" },
        sandbox = raw["sandbox"].takeIf { it.truthy }?.let { sandbox ->
            (sandbox["active"] as? JsonPrimitive)?.booleanOrNull?.let { SandboxStatus(it, sandbox["reason"].string) }
        },
    )
}

/** Apply one event. An event from another runner epoch cannot be applied: take a new snapshot. */
fun SessionState.reduce(envelope: EventEnvelope, now: () -> Long = System::currentTimeMillis): SessionState {
    val event = envelope.event
    if (event !is TimelineEvent.Reset && envelope.runnerEpoch != runnerEpoch) return copy(needsSnapshot = true)
    val base = copy(cursor = envelope.cursor)
    return when (event) {
        is TimelineEvent.Reset -> base.copy(needsSnapshot = true)
        TimelineEvent.Noop, is TimelineEvent.PanelChanged -> base
        is TimelineEvent.WidgetUpdated -> base.copy(
            widgets = if (!event.lines.isNullOrEmpty()) widgets + (event.key to event.lines) else widgets - event.key,
        )
        is TimelineEvent.StatusUpdated -> base.copy(
            statuses = if (!event.text.isNullOrEmpty()) statuses + (event.key to event.text) else statuses - event.key,
        )
        is TimelineEvent.MessageStarted -> {
            // Replace a stale partial with the same id; never clobber a finished message.
            val kept = messages.filterNot { it.id == event.message.id && it.isPartial }
            base.copy(messages = kept + event.message.copy(id = uniqueId(kept, event.message.id, envelope)))
        }
        is TimelineEvent.MessageDelta -> {
            var list = messages
            var index = if (event.messageId != null) list.indexOfFirst { it.id == event.messageId }
            else list.indexOfLast { it.role == "assistant" && it.isPartial }
            if (index == -1) {
                if (event.messageId != null) return base
                // Joined mid-stream without a message_start: open a live partial.
                list = list + Message(
                    id = uniqueId(list, "assistant-live", envelope),
                    role = "assistant",
                    content = "",
                    createdAt = now(),
                    isPartial = true,
                )
                index = list.size - 1
            }
            base.copy(
                messages = list.mapIndexed { position, message ->
                    when {
                        position != index -> message
                        event.thinking -> message.copy(thinking = (message.thinking ?: "") + event.delta, isPartial = true)
                        else -> message.copy(content = message.content + event.delta, isPartial = true)
                    }
                },
            )
        }
        is TimelineEvent.MessageCompleted -> {
            val incoming = event.message
            var index = messages.indexOfFirst { it.id == incoming.id && it.isPartial }
            // Partials may lack timestamps; the newest partial assistant is the one ending.
            if (index == -1 && incoming.role == "assistant")
                index = messages.indexOfLast { it.role == "assistant" && it.isPartial }
            if (index == -1) {
                return if (messages.any { it.id == incoming.id && !it.isPartial }) {
                    // Delivered twice (replay after reconnect): keep the newest copy.
                    base.copy(messages = messages.map { if (it.id == incoming.id) withTools(incoming, it) else it })
                } else {
                    base.copy(messages = appendCompleted(messages, incoming))
                }
            }
            val previous = messages[index]
            base.copy(
                messages = messages.mapIndexed { position, message ->
                    if (position == index) withTools(incoming, previous).copy(id = previous.id) else message
                },
            )
        }
        is TimelineEvent.ToolUpdated -> {
            val tool = event.tool
            var index = if (event.messageId != null) messages.indexOfFirst { it.id == event.messageId }
            else messages.indexOfLast { message -> message.tools.any { it.id == tool.id } }
            if (index == -1 && event.messageId == null) index = messages.indexOfLast { it.role == "assistant" }
            if (index == -1) return base
            base.copy(
                messages = messages.mapIndexed { position, message ->
                    if (position == index) message.copy(tools = upsertTool(message.tools, tool)) else message
                },
            )
        }
        is TimelineEvent.QueueUpdated -> base.copy(queue = event.queue)
        is TimelineEvent.SessionRenamed -> base.copy(session = session.copy(name = event.name))
    }
}

/** A notice raised while a turn streams goes above it: the partial is replaced in place when it completes. */
private fun appendCompleted(messages: List<Message>, incoming: Message): List<Message> {
    val last = messages.lastOrNull()
    return if (incoming.systemKind == "notice" && last?.role == "assistant" && last.isPartial)
        messages.dropLast(1) + incoming + last
    else messages + incoming
}

private fun upsertTool(tools: List<ToolCall>, tool: ToolUpdate): List<ToolCall> =
    if (tools.any { it.id == tool.id }) tools.map { if (it.id == tool.id) mergeTool(it, tool) else it }
    else tools + mergeTool(null, tool)

/** Carry live tool results onto the final message, which only knows the calls. */
private fun withTools(incoming: Message, previous: Message): Message {
    if (previous.tools.isEmpty()) return incoming
    val known = LinkedHashMap(previous.tools.associateBy { it.id })
    val tools = incoming.tools.map { tool ->
        val existing = known.remove(tool.id)
        if (existing != null) mergeTool(existing, tool.asUpdate().copy(status = existing.status)) else tool
    }
    return incoming.copy(tools = tools + known.values)
}

private fun uniqueId(messages: List<Message>, id: String, envelope: EventEnvelope) =
    if (messages.any { it.id == id }) "$id-${envelope.cursor}" else id
