package dev.pirc.android.core.timeline

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.util.Locale

/*
 * Agent RPC messages (pi-ai compatible) as timeline messages; a port of
 * `apps/web/src/lib/pi-messages.ts`. Tool results fold into the assistant turn
 * that issued the call, so the timeline reads as conversation, not a raw log.
 */

// ---- JSON access with JavaScript's `??` semantics (null and absent alike) ----

internal operator fun JsonElement?.get(key: String): JsonElement? =
    (this as? JsonObject)?.get(key)?.takeUnless { it is JsonNull }

internal val JsonElement?.string: String? get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** `String(value)` of a primitive (numbers keep their JSON spelling). */
internal val JsonElement?.text: String? get() = (this as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content

internal val JsonElement?.number: Long?
    get() = (this as? JsonPrimitive)?.takeUnless { it.isString }?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }

internal val JsonElement?.array: JsonArray? get() = this as? JsonArray

/** JavaScript truthiness of a JSON value. */
internal val JsonElement?.truthy: Boolean
    get() = when (this) {
        null, JsonNull -> false
        is JsonPrimitive -> when {
            isString -> content.isNotEmpty()
            booleanOrNull != null -> booleanOrNull!!
            else -> doubleOrNull?.let { it != 0.0 && !it.isNaN() } ?: true
        }
        else -> true
    }

/** `typeof value === 'number' ? value : Date.now()`. */
internal fun at(value: JsonElement?, now: () -> Long): Long = value.number ?: now()

// ---- conversions ----

internal fun piMessageId(raw: JsonElement?): String =
    "${raw["role"].text ?: "message"}-${raw["timestamp"].text ?: "live"}"

private fun images(content: JsonElement?): List<InlineImage> =
    content.array.orEmpty()
        .filter { it["type"].string == "image" && it["data"].string != null }
        .map { InlineImage(it["mimeType"].string ?: "image/png", it["data"].string!!) }

internal fun text(content: JsonElement?): String = when {
    content is JsonPrimitive && content.isString -> content.content
    content is JsonArray -> content.filter { it["type"].string == "text" }.joinToString("") { it["text"].text ?: "" }
    else -> ""
}

private fun thinking(content: JsonElement?): Pair<String, Boolean> {
    val blocks = content.array.orEmpty().filter { it["type"].string == "thinking" }
    val text = blocks.map { it["thinking"].text ?: it["text"].text ?: "" }.filter { it.isNotEmpty() }.joinToString("\n\n")
    return text to blocks.any { it["redacted"].truthy }
}

private fun parseArguments(value: JsonElement?): JsonElement? {
    if (value !is JsonPrimitive || !value.isString) return value
    return try {
        Json.parseToJsonElement(value.content)
    } catch (_: Exception) {
        value
    }
}

private fun toolFromCall(part: JsonElement?, status: String): ToolCall = ToolCall(
    id = part["id"].text ?: "tool-${part["name"].text ?: part["toolName"].text ?: "undefined"}",
    name = part["name"].text ?: part["toolName"].text ?: "tool",
    status = status,
    input = parseArguments(part["arguments"] ?: part["toolCall"]["arguments"]),
)

/** Where browser recordings live in a session's workspace. */
internal val RECORDING_PATH = Regex("""^\.pirc/recordings/[^/]+\.webm$""")

/** Tool result payload (`toolResult` message or `tool_execution_*` result). */
internal fun toolResultFields(result: JsonElement?, id: String): ToolUpdate {
    if (result == null) return ToolUpdate(id)
    val output = text(result["content"])
    val diff = result["details"]["diff"].string
    val found = images(result["content"])
    val details = result["details"]
    val recording = details["path"].string?.takeIf {
        (details["recording"] as? JsonPrimitive)?.booleanOrNull == false && RECORDING_PATH.matches(it)
    }
    return ToolUpdate(
        id = id,
        output = output.ifEmpty { null },
        diff = diff?.ifEmpty { null },
        images = found.ifEmpty { null },
        recording = recording,
    )
}

private fun ToolUpdate.with(other: ToolUpdate) = copy(
    name = other.name ?: name,
    status = other.status ?: status,
    output = other.output ?: output,
    diff = other.diff ?: diff,
    images = other.images ?: images,
    recording = other.recording ?: recording,
    startedAt = other.startedAt ?: startedAt,
    endedAt = other.endedAt ?: endedAt,
    input = other.input ?: input,
)

internal fun toolUpdate(
    id: String,
    name: String? = null,
    status: String? = null,
    input: JsonElement? = null,
    startedAt: Long? = null,
    endedAt: Long? = null,
    result: JsonElement? = null,
    hasResult: Boolean = false,
): ToolUpdate {
    val base = ToolUpdate(id, name = name, status = status, input = input, startedAt = startedAt, endedAt = endedAt)
    return if (hasResult) base.with(toolResultFields(result, id)) else base
}

private fun assistantMessage(raw: JsonElement, id: String, now: () -> Long): Message {
    val (reasoning, redacted) = thinking(raw["content"])
    val stop = raw["stopReason"].string
    val failed = stop == "error" || stop == "aborted"
    val tools = raw["content"].array.orEmpty()
        .filter { it["type"].string == "toolCall" }
        .map { toolFromCall(it, if (failed) "failed" else "running") }
    return Message(
        id = id,
        role = "assistant",
        content = text(raw["content"]),
        createdAt = at(raw["timestamp"], now),
        completedAt = raw["completedAt"].number,
        thinking = reasoning.ifEmpty { null },
        thinkingRedacted = redacted,
        stopReason = if (failed) stop else null,
        errorMessage = raw["errorMessage"].takeIf { it.truthy }?.text,
        model = raw["model"].takeIf { it.truthy }?.text,
        tools = tools,
    )
}

private fun short(value: JsonElement?): String =
    value.string?.replace(Regex("\\s+"), " ")?.trim()?.take(100) ?: ""

/**
 * Convert one agent message; null for messages that should not appear (hidden
 * custom messages). Tool results become an orphan system entry here;
 * [piHistory] folds them into their owning assistant turn.
 */
internal fun piMessage(raw: JsonElement?, id: String = piMessageId(raw), now: () -> Long = System::currentTimeMillis): Message? {
    if (raw == null || raw !is JsonObject) return null
    val createdAt = at(raw["timestamp"], now)
    return when (raw["role"].string) {
        "assistant" -> assistantMessage(raw, id, now)
        "user" -> Message(id = id, role = "user", content = text(raw["content"]), createdAt = createdAt, images = images(raw["content"]))
        "toolResult" -> {
            val result = toolResultFields(raw, raw["toolCallId"].text ?: id)
            Message(
                id = id,
                role = "system",
                systemKind = "custom",
                label = "${raw["toolName"].text ?: "Tool"} result",
                content = "",
                createdAt = createdAt,
                tools = listOf(
                    ToolCall(
                        id = raw["toolCallId"].text ?: id,
                        name = raw["toolName"].text ?: "tool",
                        status = if (raw["isError"].truthy) "failed" else "succeeded",
                        output = result.output,
                        diff = result.diff,
                        images = result.images.orEmpty(),
                        recording = result.recording,
                    ),
                ),
            )
        }
        "bashExecution" -> {
            val cancelled = raw["cancelled"].truthy
            val exitCode = raw["exitCode"]
            val exit = when {
                cancelled -> "cancelled"
                exitCode == null -> null
                else -> "exit ${exitCode.text}"
            }
            val truncated = raw["truncated"].truthy
            Message(
                id = id,
                role = "system",
                systemKind = "bash",
                label = raw["command"].text ?: "",
                content = raw["output"].text ?: "",
                createdAt = createdAt,
                level = if (cancelled || (exitCode.number ?: 0L) != 0L) "warning" else "info",
                meta = if (exit != null || truncated) listOfNotNull(exit, if (truncated) "truncated" else null).joinToString(" · ") else null,
            )
        }
        "compactionSummary" -> Message(
            id = id,
            role = "system",
            systemKind = "compaction",
            label = "Context compacted",
            content = raw["summary"].text ?: "",
            createdAt = createdAt,
            meta = raw["tokensBefore"].number?.let { String.format(Locale.US, "%,d tokens before", it) },
        )
        "branchSummary" -> Message(
            id = id,
            role = "system",
            systemKind = "branch",
            label = "Branch summary",
            content = raw["summary"].text ?: "",
            createdAt = createdAt,
        )
        "custom" -> {
            val display = raw["display"]
            if (display is JsonPrimitive && display.booleanOrNull == false) return null
            val type = raw["customType"].text
            val team = type == "agent-team"
            val background = type == "background-task-finished" || type == "background-task-output"
            val skill = type == "skill"
            val event = raw["details"]["event"]
            val summary = when {
                team -> listOf(short(event["from"]), short(event["kind"])).filter { it.isNotEmpty() }.joinToString(" · ")
                background -> short(JsonPrimitive(text(raw["content"]).split('\n').first()))
                skill -> short(raw["details"]["name"])
                else -> ""
            }
            Message(
                id = id,
                role = "system",
                systemKind = if (team) "team" else if (background) "background" else "custom",
                label = if (team) "Agent team" else if (background) "Background task" else if (skill) "Skill" else type ?: "Extension",
                meta = summary.ifEmpty { null },
                content = text(raw["content"]),
                createdAt = createdAt,
                images = images(raw["content"]),
            )
        }
        else -> Message(
            id = id,
            role = "system",
            systemKind = "custom",
            label = raw["role"].string ?: "Message",
            content = text(raw["content"]).ifEmpty { raw["summary"].string ?: "" },
            createdAt = createdAt,
        )
    }
}

/** Merge an update into a tool, keeping whatever the update does not override. */
internal fun mergeTool(existing: ToolCall?, update: ToolUpdate): ToolCall {
    val base = existing ?: ToolCall(id = update.id, name = update.name ?: "tool", status = "running")
    val merged = base.copy(
        id = update.id,
        name = update.name ?: base.name,
        title = update.title ?: base.title,
        status = update.status ?: base.status,
        input = update.input ?: base.input,
        output = update.output ?: base.output,
        diff = update.diff ?: base.diff,
        images = update.images ?: base.images,
        startedAt = update.startedAt ?: base.startedAt,
        endedAt = update.endedAt ?: base.endedAt,
        recording = update.recording ?: base.recording,
    )
    // A finished tool never regresses to running because of a stale re-send.
    return if (existing != null && existing.status != "running" && update.status == "running")
        merged.copy(status = existing.status) else merged
}

internal fun ToolCall.asUpdate() = ToolUpdate(id, name, title, status, input, output, diff, images.ifEmpty { null }, startedAt, endedAt, recording)

/** Convert a full agent history, folding tool results into their assistant turn. */
internal fun piHistory(history: List<JsonElement>, now: () -> Long = System::currentTimeMillis): List<Message> {
    val messages = mutableListOf<Message>()
    val owners = mutableMapOf<String, Int>()
    val seen = mutableSetOf<String>()
    history.forEachIndexed { index, raw ->
        var id = piMessageId(raw)
        if (id in seen) id = "$id-$index"
        seen += id

        val callId = raw["toolCallId"].text
        if (raw["role"].string == "toolResult" && callId != null && callId in owners) {
            val ownerIndex = owners.getValue(callId)
            val owner = messages[ownerIndex]
            val result = toolResultFields(raw, callId).copy(status = if (raw["isError"].truthy) "failed" else "succeeded")
            messages[ownerIndex] = owner.copy(tools = owner.tools.map { if (it.id == callId) mergeTool(it, result) else it })
            return@forEachIndexed
        }

        val message = piMessage(raw, id, now) ?: return@forEachIndexed
        messages += message
        if (message.role == "assistant") for (tool in message.tools) owners[tool.id] = messages.size - 1
    }
    return messages
}

/** Gateway-assembled partial assistant message (`{ base, content: {index: block} }`). */
internal fun piPartialMessage(raw: JsonElement?, now: () -> Long = System::currentTimeMillis): Message? {
    if (raw == null || raw !is JsonObject) return null
    val blocks = (raw["content"] as? JsonObject).orEmpty().entries
        .sortedBy { it.key.toDoubleOrNull() ?: Double.NaN }
        .map { it.value }
    val reasoning = blocks.filter { it["type"].string == "thinking" }.joinToString("\n\n") { it["text"].text ?: "" }
    val tools = blocks.filter { it["type"].string == "toolCall" }.map { block ->
        toolFromCall(
            block["toolCall"] ?: JsonObject(
                buildMap {
                    block["id"]?.let { put("id", it) }
                    block["toolName"]?.let { put("name", it) }
                    block["arguments"]?.let { put("arguments", it) }
                },
            ),
            "running",
        )
    }
    val base = raw["base"]
    return Message(
        id = piMessageId(base ?: JsonObject(mapOf("role" to JsonPrimitive("assistant")))),
        role = "assistant",
        content = blocks.filter { it["type"].string == "text" }.joinToString("") { it["text"].text ?: "" },
        createdAt = at(base["timestamp"], now),
        isPartial = true,
        thinking = reasoning.ifEmpty { null },
        tools = tools,
    )
}

/** Extension `notify` request → timeline notice. */
internal fun piNotification(raw: JsonElement?, index: Int = 0, now: () -> Long = System::currentTimeMillis): Message {
    val type = raw["notifyType"].string
    val level = if (type == "error" || type == "warning") type else "info"
    val atValue = raw["receivedAt"].takeIf { it.number != null } ?: raw["timestamp"]
    return Message(
        id = "notice-${raw["id"].text ?: "${atValue.text ?: "live"}-$index"}",
        role = "system",
        systemKind = "notice",
        level = level,
        content = raw["message"].text ?: "",
        createdAt = at(atValue, now),
    )
}

/**
 * Insert notices into a chronological timeline by time. A streamed message
 * counts from when it finished, so a notice raised while the reply was still
 * streaming sorts above it, as it does live.
 */
internal fun interleave(messages: List<Message>, notices: List<Message>): List<Message> {
    if (notices.isEmpty()) return messages
    val pending = notices.withIndex().sortedWith(compareBy({ it.value.createdAt }, { it.index })).map { it.value }
    val result = mutableListOf<Message>()
    var next = 0
    for (message in messages) {
        val time = message.completedAt ?: message.createdAt
        while (next < pending.size && time > pending[next].createdAt) result += pending[next++]
        result += message
    }
    while (next < pending.size) result += pending[next++]
    return result
}
