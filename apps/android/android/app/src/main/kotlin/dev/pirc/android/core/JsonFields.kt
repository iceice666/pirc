package dev.pirc.android.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

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
