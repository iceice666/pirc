package dev.pirc.android.core

import kotlinx.serialization.json.JsonElement

/** Who may act on a session. Only the lease holder can send commands or answer questions. */
data class ControlLease(
    val holderClientId: String? = null,
    val heldByCurrentClient: Boolean = false,
    /** The lease exists but its TTL has passed; anyone may acquire it. */
    val expired: Boolean = false,
    val generation: Long? = null,
    val expiresAt: Long? = null,
) {
    val free get() = holderClientId == null || expired

    companion object {
        /** A `{lease}` reply (or the lease itself), as seen by [clientId]. */
        fun from(raw: JsonElement?, clientId: String): ControlLease {
            val lease = raw["lease"] ?: raw.takeIf { it["clientId"] != null } ?: return ControlLease()
            val holder = lease["clientId"].text
            val expired = lease["expired"].truthy
            return ControlLease(
                holderClientId = holder,
                heldByCurrentClient = holder == clientId && !expired,
                expired = expired,
                generation = lease["generation"].number,
                expiresAt = lease["expiresAt"].number,
            )
        }
    }
}
