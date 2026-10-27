package dev.pirc.pirc_mobile

import kotlinx.serialization.json.*

private fun JsonObject.text(key: String) = get(key)?.jsonPrimitive?.contentOrNull
private fun JsonObject.yes(key: String) = get(key)?.jsonPrimitive?.booleanOrNull == true
private fun JsonObject.admission() = get("messageAdmission") as? JsonObject
internal fun firstAttemptNumber(value: JsonObject?): Long {
    val raw = value?.admission()?.get("attemptNumber") ?: return 0
    val number = raw.jsonPrimitive.longOrNull
    require(number != null && number in 0..9007199254740991) { "Invalid first-message attempt number" }
    return number
}
/** Outcomes belong to a command; Stop and deletion fence the whole operation. */
internal fun mergeFirstPreparation(previous: JsonObject?, value: JsonObject): JsonObject {
    val before = previous?.admission(); val incoming = value.admission()
    val oldNumber = firstAttemptNumber(previous); val newNumber = firstAttemptNumber(value)
    require(oldNumber != newNumber || before?.text("commandId") == null || incoming?.text("commandId") == null || before.text("commandId") == incoming.text("commandId")) { "The first-message attempt identity changed" }
    val stale = newNumber < oldNumber; val same = newNumber == oldNumber
    val keep = previous != null && (
        (previous.text("state") == "cancelled" && (value.text("state") != "cancelled" || (!previous.yes("cleanupPending") && value.yes("cleanupPending")))) ||
        (previous.text("state") == "admitted" && value.text("state") !in setOf("admitted", "cancelled")) ||
        (previous.yes("accepted") && !value.yes("accepted")) ||
        (value.text("state") != "cancelled" && (stale || (same && before?.text("outcome") == "not_admitted" && incoming?.text("outcome") != "not_admitted")))
    )
    val chosen = if (keep) previous else value
    var result = if (previous?.yes("nodeMapped") == true || value.yes("nodeMapped")) JsonObject(chosen + ("nodeMapped" to JsonPrimitive(true))) else chosen
    if (result.text("state") == "cancelled") return result
    val confirmed = before?.yes("stopConfirmed") == true || incoming?.yes("stopConfirmed") == true
    val requested = confirmed || before?.yes("stopRequested") == true || incoming?.yes("stopRequested") == true
    val admitted = previous?.text("state") == "admitted" || value.text("state") == "admitted"
    if (before != null || incoming != null) {
        val selected = if (stale) before else if (same) JsonObject(before.orEmpty() + chosen.admission().orEmpty()) else incoming
        result = JsonObject(result + mapOf(
            "state" to JsonPrimitive(if (admitted) "admitted" else if (confirmed) "stopped" else if (requested) "stopping" else result.text("state")),
            "messageAdmission" to JsonObject(selected.orEmpty() + mapOf(
                "stopRequested" to JsonPrimitive(requested), "stopConfirmed" to JsonPrimitive(confirmed),
                "outcome" to JsonPrimitive(if (admitted) "admitted" else selected?.text("outcome") ?: "pending"),
                "retryEligible" to JsonPrimitive(!admitted && !requested && result.text("state") == "admission_failed" && selected?.text("outcome") == "not_admitted" && selected.yes("retryEligible")),
            )),
        ))
    }
    return result
}
