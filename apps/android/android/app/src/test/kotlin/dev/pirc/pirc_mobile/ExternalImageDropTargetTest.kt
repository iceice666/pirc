package dev.pirc.pirc_mobile

import org.junit.Assert.*
import org.junit.Test

class ExternalImageDropTargetTest {
    @Test fun logicalBoundsUseFlutterDprAndClipToNativeView() {
        val bounds = ExternalDropBounds.fromLogicalRect(
            left = 10.0,
            top = 20.0,
            right = 80.0,
            bottom = 60.0,
            devicePixelRatio = 2.0,
            viewWidth = 400,
            viewHeight = 300,
        )

        assertEquals(20f, bounds.left)
        assertEquals(40f, bounds.top)
        assertEquals(160f, bounds.right)
        assertEquals(120f, bounds.bottom)
        assertTrue(bounds.contains(20f, 40f))
        assertTrue(bounds.contains(159.99f, 119.99f))
        assertFalse(bounds.contains(160f, 80f))
        assertFalse(bounds.contains(60f, 120f))

        val clipped = ExternalDropBounds.fromLogicalRect(
            left = -10.0,
            top = 20.0,
            right = 250.0,
            bottom = 200.0,
            devicePixelRatio = 2.0,
            viewWidth = 400,
            viewHeight = 300,
        )
        assertEquals(0f, clipped.left)
        assertEquals(300f, clipped.bottom)
        assertEquals(400f, clipped.right)
    }

    @Test fun staleClearCannotRemoveReplacementTargetAndClosedLeaseRejectsDrop() {
        val contexts = ContextRegistry()
        contexts.bindPairingStamp("stamp-one")
        val lease = contexts.requireContext("primary")
        val registry = ExternalImageDropTargetRegistry()
        val bounds = ExternalDropBounds(0f, 0f, 100f, 100f)
        val old = ExternalImageDropTarget("primary", "target", "scope-1", "session", bounds, lease)
        val replacement = old.copy(scopeToken = "scope-2")

        registry.register(old)
        registry.register(replacement)
        assertFalse(registry.clear("primary", "target", "scope-1"))
        assertEquals(replacement, registry.forDrop(50f, 50f, contexts::isCurrent))

        contexts.bindPairingStamp("stamp-two")
        assertNull(registry.forDrop(50f, 50f, contexts::isCurrent))
        assertTrue(registry.clear("primary", "target", "scope-2"))
        assertNull(registry.forDrop(50f, 50f, contexts::isCurrent))
    }

    @Test fun dragStartAcceptsImageMetadataWithoutAccessingClipData() {
        // ACTION_DRAG_STARTED exposes ClipDescription only; ClipData is valid at DROP.
        assertTrue(acceptsImageDropStart(listOf("text/uri-list")))
        assertTrue(acceptsImageDropStart(listOf("image/jpeg")))
        assertTrue(acceptsImageDropStart(listOf("application/octet-stream", "IMAGE/PNG")))
        assertFalse(acceptsImageDropStart(listOf("text/plain")))
        assertFalse(acceptsImageDropStart(null))
    }

    @Test fun imageFilterPreservesCandidateOrderAndKeepsReadFailuresAsImageItems() {
        val selected = imageDropCandidates(
            listOf(
                ExternalDropCandidate("first.png", "image/png"),
                ExternalDropCandidate("document.pdf", "application/pdf"),
                ExternalDropCandidate("failed-image", "image/unknown"),
                ExternalDropCandidate("last.webp", "IMAGE/WEBP"),
                ExternalDropCandidate("unknown", null),
            ),
        )

        assertEquals(listOf("first.png", "failed-image", "last.webp"), selected.map { it.value })
    }
}
