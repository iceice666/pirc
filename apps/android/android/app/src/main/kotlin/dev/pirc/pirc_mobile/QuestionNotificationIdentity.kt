package dev.pirc.pirc_mobile

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/** The identity used by notifications, overlays, and answer actions. */
internal data class QuestionNotificationIdentity(
    val sessionId: String,
    val interactionId: String,
    val interactionEpoch: String,
) {
    val encoded: String get() = encodeParts(listOf(sessionId, interactionId, interactionEpoch))
    /** Shared with the gateway's push Topic identity so create/revoke coalesce per question. */
    val notificationTag: String get() = "interaction:${hexUtf8(sessionId)}:$interactionEpoch:${hexUtf8(interactionId)}"
    val postedPreferenceKey: String get() = "posted:$encoded"
    val resolvedPreferenceKey: String get() = "resolved:$encoded"
    fun intentAction(role: String, value: String? = null): String =
        "dev.pirc.question.$role:${sha256(encodeParts(listOf(sessionId, interactionId, interactionEpoch, value.orEmpty())))}"

    companion object {
        fun from(
            sessionId: String?,
            interactionId: String?,
            interactionEpoch: String?,
        ): QuestionNotificationIdentity? {
            if (sessionId.isNullOrBlank() || interactionId.isNullOrBlank() || interactionEpoch.isNullOrBlank()) return null
            if (interactionEpoch != "0" && !interactionEpoch.matches(Regex("[1-9][0-9]*"))) return null
            return QuestionNotificationIdentity(sessionId, interactionId, interactionEpoch)
        }

        fun decode(value: String): QuestionNotificationIdentity? =
            decodeParts(value)?.takeIf { it.size == 3 }?.let { from(it[0], it[1], it[2]) }

        private fun encodeParts(parts: List<String>): String = buildString {
            for (part in parts) append(part.length).append(':').append(part)
        }

        private fun decodeParts(value: String): List<String>? {
            val result = mutableListOf<String>()
            var offset = 0
            repeat(3) {
                val colon = value.indexOf(':', offset)
                if (colon <= offset) return null
                val length = value.substring(offset, colon).toIntOrNull() ?: return null
                val start = colon + 1
                if (length < 0 || length > value.length - start) return null
                val end = start + length
                result += value.substring(start, end)
                offset = end
            }
            return result.takeIf { offset == value.length }
        }

        private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte) }

        private fun hexUtf8(value: String): String = value.toByteArray(StandardCharsets.UTF_8)
            .joinToString("") { byte -> "%02x".format(byte) }
    }
}

/** Coalesce an in-flight overlay refresh only for the same question in the same pairing. */
internal fun sameQuestionOverlayRequest(
    current: QuestionNotificationIdentity?,
    currentPairingStamp: String?,
    incoming: QuestionNotificationIdentity?,
    incomingPairingStamp: String?,
): Boolean = current != null && incoming != null && current == incoming &&
    currentPairingStamp == incomingPairingStamp

/** Reject asynchronous overlay results after either the target or its generation has changed. */
internal fun sameQuestionOverlayTargetAtGeneration(
    current: QuestionNotificationIdentity?,
    currentPairingStamp: String?,
    revoked: QuestionNotificationIdentity,
    revokedPairingStamp: String?,
    capturedGeneration: Long,
    currentGeneration: Long,
): Boolean = current == revoked && currentPairingStamp == revokedPairingStamp &&
    capturedGeneration == currentGeneration

/** Cancel only identities from the snapshot's session that are no longer pending. */
internal fun staleQuestionNotifications(
    sessionId: String,
    active: Set<QuestionNotificationIdentity>,
    posted: Collection<QuestionNotificationIdentity>,
): Set<QuestionNotificationIdentity> = posted.filterTo(linkedSetOf()) {
    it.sessionId == sessionId && it !in active
}

internal enum class CreatedQuestionDisposition { SUPPRESS, SHOW_ACTIONABLE, SHOW_READ_ONLY, RESOLVE }

/** An unavailable snapshot is uncertainty, never evidence that a question was answered. */
internal fun createdQuestionDisposition(
    tombstoned: Boolean,
    snapshotAvailable: Boolean,
    exactPending: Boolean?,
): CreatedQuestionDisposition = when {
    tombstoned -> CreatedQuestionDisposition.SUPPRESS
    !snapshotAvailable -> CreatedQuestionDisposition.SHOW_READ_ONLY
    exactPending == true -> CreatedQuestionDisposition.SHOW_ACTIONABLE
    else -> CreatedQuestionDisposition.RESOLVE
}

/** Keep recent tombstones long enough to cover delayed push delivery without unbounded growth. */
internal fun pruneQuestionTombstones(
    tombstones: Map<String, Long>,
    now: Long,
    maxEntries: Int = 512,
    maxAgeMillis: Long = 30L * 24 * 60 * 60 * 1000,
): Map<String, Long> = tombstones
    .filterValues { it >= now - maxAgeMillis }
    .entries
    .sortedBy { it.value }
    .takeLast(maxEntries)
    .associate { it.key to it.value }
