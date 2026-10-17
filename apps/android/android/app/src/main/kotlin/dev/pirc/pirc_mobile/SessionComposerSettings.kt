package dev.pirc.pirc_mobile

import dev.pirc.android.core.timeline.SessionState

/** Main-thread projection of settings accepted after a watch snapshot began. */
internal class SessionComposerSettings {
    var revision: Long = 0
        private set
    var approvalObservationRevision: Long = 0
        private set
    private var modelRevision = 0L
    private var thinkingRevision = 0L
    private var approvalModeRevision = 0L
    private var modelId: String? = null
    private var provider: String? = null
    private var thinking: String? = null
    private var approvalMode: String? = null

    fun accepted(payload: Map<*, *>, observedApprovalRevision: Long = approvalObservationRevision): Boolean {
        when (payload["type"]) {
            "set_model" -> {
                val nextModel = payload["modelId"] as? String ?: return false
                val nextProvider = payload["provider"] as? String ?: return false
                if (nextModel.isBlank() || nextProvider.isBlank()) return false
                modelId = nextModel
                provider = nextProvider
                modelRevision = ++revision
            }
            "set_thinking" -> {
                val nextThinking = payload["level"] as? String ?: return false
                if (nextThinking !in setOf("off", "minimal", "low", "medium", "high", "xhigh")) return false
                thinking = nextThinking
                thinkingRevision = ++revision
            }
            "set_approval_mode" -> {
                if (observedApprovalRevision != approvalObservationRevision) return false
                val nextMode = payload["mode"] as? String ?: return false
                if (nextMode !in APPROVAL_MODES) return false
                approvalMode = nextMode
                approvalModeRevision = ++revision
            }
            else -> return false
        }
        return true
    }

    /** A live event supersedes an optimistic command projection and older in-flight snapshots. */
    fun authoritativeApprovalMode(mode: String): Boolean {
        if (mode !in APPROVAL_MODES) return false
        approvalObservationRevision++
        approvalMode = mode
        approvalModeRevision = ++revision
        return true
    }

    /** A fetched snapshot is authoritative over any earlier HTTP command receipt. */
    fun observedApprovalSnapshot(mode: String?) {
        if (mode in APPROVAL_MODES) approvalObservationRevision++
    }

    /** A fetch begun after the acceptance remains authoritative, including remote changes. */
    fun mergeFetched(state: SessionState, requestRevision: Long): SessionState = state.copy(
        selectedModelId = if (modelRevision > requestRevision) modelId else state.selectedModelId,
        selectedModelProvider = if (modelRevision > requestRevision) provider else state.selectedModelProvider,
        thinkingLevel = if (thinkingRevision > requestRevision) thinking else state.thinkingLevel,
        approvalMode = if (approvalModeRevision > requestRevision) approvalMode else state.approvalMode,
    )

    private companion object {
        val APPROVAL_MODES = setOf("read-only", "auto", "full-access")
    }
}
