package dev.pirc.pirc_mobile

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushEnableCoordinatorTest {
    @Test
    fun missingDistributorReturnsExplicitErrorWithoutOpeningPicker() = runBlocking {
        val coordinator = PushEnableCoordinator()
        var captured = false
        var selected = false
        var enabled = false

        val error = runCatching {
            coordinator.run(
                hasDistributor = { false },
                captureSnapshot = { captured = true; "snapshot" },
                selectDistributor = { selected = true; true },
                validateSnapshot = {},
                enable = { enabled = true },
            )
        }.exceptionOrNull()

        assertEquals("NO_DISTRIBUTOR", (error as PushEnableFailure).code)
        assertFalse(captured)
        assertFalse(selected)
        assertFalse(enabled)
    }

    @Test
    fun declinedPickerReportsCancellationAndDoesNotEnable() = runBlocking {
        val coordinator = PushEnableCoordinator()
        var enabled = false

        val error = runCatching {
            coordinator.run(
                hasDistributor = { true },
                captureSnapshot = { "account snapshot" },
                selectDistributor = { false },
                validateSnapshot = {},
                enable = { enabled = true },
            )
        }.exceptionOrNull()

        assertEquals("PUSH_CANCELLED", (error as PushEnableFailure).code)
        assertFalse(enabled)
    }

    @Test
    fun vanishedDistributorIsReportedAsUnavailable() = runBlocking {
        val coordinator = PushEnableCoordinator()
        var checks = 0
        var enabled = false

        val error = runCatching {
            coordinator.run(
                hasDistributor = { ++checks == 1 },
                captureSnapshot = { "account snapshot" },
                selectDistributor = { false },
                validateSnapshot = {},
                enable = { enabled = true },
            )
        }.exceptionOrNull()

        assertEquals("NO_DISTRIBUTOR", (error as PushEnableFailure).code)
        assertEquals(2, checks)
        assertFalse(enabled)
    }

    @Test
    fun staleAccountOrContextValidationPreventsRegistration() = runBlocking {
        val coordinator = PushEnableCoordinator()
        var enabled = false

        val error = runCatching {
            coordinator.run(
                hasDistributor = { true },
                captureSnapshot = { "captured account/context" },
                selectDistributor = { true },
                validateSnapshot = { throw PushEnableFailure("STALE_CONTEXT", "context expired") },
                enable = { enabled = true },
            )
        }.exceptionOrNull()

        assertEquals("STALE_CONTEXT", (error as PushEnableFailure).code)
        assertFalse(enabled)
    }

    @Test
    fun concurrentRequestIsRejectedUntilPickerCompletes() = runBlocking {
        val coordinator = PushEnableCoordinator()
        val pickerStarted = CompletableDeferred<Unit>()
        val pickerResult = CompletableDeferred<Boolean>()
        var enabledCount = 0

        val first = async {
            coordinator.run(
                hasDistributor = { true },
                captureSnapshot = { "snapshot" },
                selectDistributor = {
                    pickerStarted.complete(Unit)
                    pickerResult.await()
                },
                validateSnapshot = {},
                enable = { enabledCount++ },
            )
        }
        pickerStarted.await()

        val secondError = runCatching {
            coordinator.run(
                hasDistributor = { true },
                captureSnapshot = { "second snapshot" },
                selectDistributor = { true },
                validateSnapshot = {},
                enable = { enabledCount++ },
            )
        }.exceptionOrNull()

        assertEquals("PUSH_BUSY", (secondError as PushEnableFailure).code)
        pickerResult.complete(true)
        first.await()
        assertEquals(1, enabledCount)
    }

    @Test
    fun successfulSelectionValidatesAndEnablesExactlyOnce() = runBlocking {
        val coordinator = PushEnableCoordinator()
        var validated = false
        var enabled = false

        coordinator.run(
            hasDistributor = { true },
            captureSnapshot = { "snapshot" },
            selectDistributor = { true },
            validateSnapshot = { validated = it == "snapshot" },
            enable = { enabled = validated && it == "snapshot" },
        )

        assertTrue(validated)
        assertTrue(enabled)
    }
}
