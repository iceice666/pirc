package dev.pirc.pirc_mobile

/** Physical-pixel target bounds measured by Flutter and clipped to its native view. */
internal data class ExternalDropBounds(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
) {
    init {
        require(left.isFinite() && top.isFinite() && right.isFinite() && bottom.isFinite())
        require(left >= 0f && top >= 0f && right > left && bottom > top)
    }

    fun contains(x: Float, y: Float): Boolean =
        x.isFinite() && y.isFinite() && x >= left && x < right && y >= top && y < bottom

    companion object {
        fun fromLogicalRect(
            left: Double,
            top: Double,
            right: Double,
            bottom: Double,
            devicePixelRatio: Double,
            viewWidth: Int,
            viewHeight: Int,
        ): ExternalDropBounds {
            require(
                listOf(left, top, right, bottom, devicePixelRatio).all(Double::isFinite) &&
                    devicePixelRatio > 0.0 && right > left && bottom > top &&
                    viewWidth > 0 && viewHeight > 0,
            ) { "Invalid external image drop target bounds" }

            val clippedLeft = (left * devicePixelRatio).coerceAtLeast(0.0)
            val clippedTop = (top * devicePixelRatio).coerceAtLeast(0.0)
            val clippedRight = (right * devicePixelRatio).coerceAtMost(viewWidth.toDouble())
            val clippedBottom = (bottom * devicePixelRatio).coerceAtMost(viewHeight.toDouble())
            require(clippedRight > clippedLeft && clippedBottom > clippedTop) {
                "External image drop target is outside the Flutter view"
            }
            return ExternalDropBounds(
                clippedLeft.toFloat(),
                clippedTop.toFloat(),
                clippedRight.toFloat(),
                clippedBottom.toFloat(),
            )
        }
    }
}

internal data class ExternalDropCandidate<T>(val value: T, val mimeType: String?)

/** Mirrors the web composer's image-only filter (Composer.svelte, removed in plans/rewrite/11-web.md) while preserving drag order. */
internal fun <T> imageDropCandidates(items: List<ExternalDropCandidate<T>>): List<ExternalDropCandidate<T>> =
    items.filter { it.mimeType?.startsWith("image/", ignoreCase = true) == true }

/** ACTION_DRAG_STARTED has metadata, but its DragEvent does not expose ClipData yet. */
internal fun acceptsImageDropStart(clipDescriptionMimeTypes: Iterable<String>?): Boolean =
    clipDescriptionMimeTypes?.any { mimeType ->
        mimeType.equals("text/uri-list", ignoreCase = true) ||
            mimeType.startsWith("image/", ignoreCase = true)
    } == true

internal data class ExternalImageDropTarget(
    val contextId: String,
    val targetId: String,
    val scopeToken: String,
    val sessionId: String,
    val bounds: ExternalDropBounds,
    val lease: ContextRegistry.Lease,
)

/** One visible composer may accept drops at a time in a Flutter window. */
internal class ExternalImageDropTargetRegistry {
    @Volatile
    private var current: ExternalImageDropTarget? = null

    @Synchronized
    fun register(target: ExternalImageDropTarget) {
        current = target
    }

    @Synchronized
    fun clear(contextId: String, targetId: String, scopeToken: String): Boolean {
        val active = current ?: return false
        if (active.contextId != contextId || active.targetId != targetId || active.scopeToken != scopeToken) {
            return false
        }
        current = null
        return true
    }

    @Synchronized
    fun clearContext(contextId: String): Boolean {
        if (current?.contextId != contextId) return false
        current = null
        return true
    }

    @Synchronized
    fun clearAll() {
        current = null
    }

    fun active(leaseIsCurrent: (ContextRegistry.Lease) -> Boolean): ExternalImageDropTarget? =
        current?.takeIf { leaseIsCurrent(it.lease) }

    fun forDrop(x: Float, y: Float, leaseIsCurrent: (ContextRegistry.Lease) -> Boolean): ExternalImageDropTarget? {
        val active = current ?: return null
        if (!active.bounds.contains(x, y) || !leaseIsCurrent(active.lease)) return null
        return active
    }

    fun isCurrent(target: ExternalImageDropTarget): Boolean {
        val active = current ?: return false
        return active.contextId == target.contextId &&
            active.targetId == target.targetId &&
            active.scopeToken == target.scopeToken &&
            active.lease == target.lease
    }
}
