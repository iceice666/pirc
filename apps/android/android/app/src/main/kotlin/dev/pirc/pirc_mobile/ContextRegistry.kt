package dev.pirc.pirc_mobile

/** Process-local identity leases for independent Flutter browsing contexts. */
internal class ContextRegistry(
    private val primaryId: String = PRIMARY_CONTEXT_ID,
) {
    internal data class Lease(
        val contextId: String,
        val accountEpoch: Long,
        val registryEpoch: Long,
        val generation: Long,
        val pairingStamp: String?,
    )

    private var pairingStamp: String? = null
    private var accountEpoch = 0L
    private var registryEpoch = 0L
    private var nextGeneration = 0L
    private val active = linkedMapOf<String, Lease>()
    private val retired = mutableSetOf<String>()

    @Synchronized
    fun bindPairingStamp(stamp: String?): List<Lease> {
        if (pairingStamp == stamp) return emptyList()
        val invalidated = invalidateAll()
        pairingStamp = stamp
        accountEpoch++
        return invalidated
    }

    @Synchronized
    fun openContext(contextId: String, expectedPairingStamp: String): Lease {
        require(contextId.isNotBlank() && contextId.length <= 128) {
            "Invalid contextId"
        }
        require(contextId != primaryId) { "The primary context is implicit" }
        if (expectedPairingStamp.isBlank() || expectedPairingStamp != pairingStamp) {
            throw ContextRegistryException(NativeI18n.text("Pairing changed; reopen this context."))
        }
        check(contextId !in active && contextId !in retired) {
            "A contextId cannot be reopened after it has been used."
        }
        return Lease(
            contextId = contextId,
            accountEpoch = accountEpoch,
            registryEpoch = registryEpoch,
            generation = ++nextGeneration,
            pairingStamp = pairingStamp,
        ).also { active[contextId] = it }
    }

    @Synchronized
    fun requireContext(contextId: String? = null): Lease {
        val id = contextId ?: primaryId
        if (id == primaryId) {
            return Lease(id, accountEpoch, registryEpoch, 0L, pairingStamp)
        }
        return active[id] ?: throw ContextRegistryException(NativeI18n.text("This native context is closed."))
    }

    @Synchronized
    fun isCurrent(lease: Lease): Boolean {
        if (lease.accountEpoch != accountEpoch || lease.registryEpoch != registryEpoch) {
            return false
        }
        if (lease.contextId == primaryId) return true
        return active[lease.contextId] == lease
    }

    @Synchronized
    fun closeContext(contextId: String): Lease? {
        if (contextId == primaryId) return null
        val removed = active.remove(contextId) ?: return null
        retired.add(contextId)
        return removed
    }

    /** Invalidates outstanding async work and retires every registered child. */
    @Synchronized
    fun invalidateAll(): List<Lease> {
        registryEpoch++
        val removed = active.values.toList()
        retired.addAll(active.keys)
        active.clear()
        return removed
    }

    @Synchronized
    fun currentPairingStamp(): String? = pairingStamp

    companion object {
        const val PRIMARY_CONTEXT_ID = "primary"
    }
}

internal class ContextRegistryException(message: String) : IllegalStateException(message)
