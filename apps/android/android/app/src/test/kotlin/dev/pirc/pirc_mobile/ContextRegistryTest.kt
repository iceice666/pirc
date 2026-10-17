package dev.pirc.pirc_mobile

import org.junit.Assert.*
import org.junit.Test

class ContextRegistryTest {
    @Test fun childContextsRequireExplicitOpenAndCloseCannotBeReused() {
        val registry = ContextRegistry()
        registry.bindPairingStamp("stamp-a")

        assertEquals("primary", registry.requireContext().contextId)
        assertThrows(ContextRegistryException::class.java) {
            registry.requireContext("child-a")
        }

        val opened = registry.openContext("child-a", "stamp-a")
        assertTrue(registry.isCurrent(opened))
        assertSame(opened, registry.requireContext("child-a"))
        assertSame(opened, registry.closeContext("child-a"))
        assertFalse(registry.isCurrent(opened))
        assertThrows(ContextRegistryException::class.java) {
            registry.requireContext("child-a")
        }
        assertThrows(IllegalStateException::class.java) {
            registry.openContext("child-a", "stamp-a")
        }
    }

    @Test fun pairingChangePurgesContextsAndInvalidatesCapturedAsyncLeases() {
        val registry = ContextRegistry()
        registry.bindPairingStamp("stamp-a")
        val first = registry.openContext("child-a", "stamp-a")
        val second = registry.openContext("child-b", "stamp-a")
        val primaryBeforeChange = registry.requireContext()

        assertEquals(listOf(first, second), registry.bindPairingStamp("stamp-b"))
        assertFalse(registry.isCurrent(first))
        assertFalse(registry.isCurrent(second))
        assertFalse(registry.isCurrent(primaryBeforeChange))
        assertThrows(ContextRegistryException::class.java) {
            registry.requireContext("child-a")
        }
        assertThrows(ContextRegistryException::class.java) {
            registry.openContext("child-c", "stamp-a")
        }
        assertTrue(registry.isCurrent(registry.requireContext()))
    }

    @Test fun closingOneContextDoesNotInvalidateOtherContexts() {
        val registry = ContextRegistry()
        registry.bindPairingStamp("stamp-a")
        val first = registry.openContext("child-a", "stamp-a")
        val second = registry.openContext("child-b", "stamp-a")

        registry.closeContext("child-a")

        assertFalse(registry.isCurrent(first))
        assertTrue(registry.isCurrent(second))
        assertSame(second, registry.requireContext("child-b"))
    }
}
