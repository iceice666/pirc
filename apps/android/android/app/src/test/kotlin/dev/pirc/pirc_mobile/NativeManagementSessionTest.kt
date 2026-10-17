package dev.pirc.pirc_mobile

import dev.pirc.android.core.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest

class NativeManagementSessionTest {
    private val id = "a".repeat(32)
    private fun request(status: String) = mapOf<String, Any?>(
        "id" to id, "status" to status, "expiresAt" to 300_000L, "serverNow" to 0L,
        "capabilities" to listOf("providers"), "deviceName" to "Test phone", "verificationPath" to "/?nativeManagement=$id",
        "token" to "MUST_NOT_CROSS_BRIDGE", "verifier" to "MUST_NOT_CROSS_BRIDGE",
    )
    private fun api() = PircApi(Pairing("https://pirc.example", "pirc_dev_" + "b".repeat(43)))

    @Test fun approvalClaimsOnlyOnceAndNeverReturnsCredentials() = runTest {
        val api = api()
        var challenge = ""
        var status = "pending"
        var claims = 0
        val flow = NativeManagementSession(api, { method, path, body ->
            when {
                method == "POST" && path.endsWith("/requests") -> {
                    challenge = (body as Map<*, *>)["challenge"].toString(); request(status)
                }
                method == "POST" && path.endsWith("/claim") -> {
                    val verifier = (body as Map<*, *>)["verifier"].toString()
                    assertEquals(43, verifier.length)
                    assertEquals(challenge, MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()).joinToString("") { "%02x".format(it) })
                    claims++; status = "claimed"
                    mapOf("token" to "pirc_mgmt_" + "a".repeat(43), "expiresAt" to 900_000L, "serverNow" to 0L)
                }
                else -> request(status)
            }
        }, {})
        val pending = flow.begin(listOf("providers"))
        assertEquals("https://pirc.example/?nativeManagement=$id", pending["verificationUrl"])
        assertFalse(pending.containsKey("token")); assertFalse(pending.containsKey("verifier"))
        assertEquals(false, flow.check()["active"])
        status = "approved"
        val accepted = flow.check()
        assertEquals(true, accepted["active"])
        assertFalse(accepted.toString().contains("pirc_mgmt_"))
        flow.check(); assertEquals(1, claims)
        assertNotNull(api.request("/api/providers").build().header("X-Pirc-Management"))
    }

    @Test fun accountChangeDuringClaimCannotInstallGrant() = runTest {
        val api = api()
        var valid = true
        val flow = NativeManagementSession(api, { _, path, _ ->
            if (path.endsWith("/claim")) {
                valid = false
                mapOf("token" to "pirc_mgmt_" + "a".repeat(43), "expiresAt" to 900_000L, "serverNow" to 0L)
            } else request("approved")
        }, { if (!valid) throw ApiException(409, "account_changed", "Changed") })
        flow.begin(listOf("providers"))
        try { flow.check(); fail("must fail") } catch (e: ApiException) { assertEquals("account_changed", e.code) }
        assertEquals(false, api.managementStatus()["active"])
    }

    @Test fun cancellationClosesLocalAccessEvenWhenServerReplyIsLost() = runTest {
        val api = api()
        val flow = NativeManagementSession(api, { method, _, _ ->
            if (method == "DELETE") throw ApiException(503, "offline", "Offline")
            request("pending")
        }, {})
        flow.begin(listOf("providers"))
        api.installManagementGrant("pirc_mgmt_" + "a".repeat(43), 900_000L, 0L, setOf("providers"))
        try { flow.cancel(); fail("must fail") } catch (_: ApiException) { }
        assertEquals(false, api.managementStatus()["active"])
        assertNull(api.request("/api/providers").build().header("X-Pirc-Management"))
    }

    @Test fun pairingRetirementRevokesOnlyTheCapturedOldRequest() = runTest {
        val api = api()
        val deletes = mutableListOf<String>()
        var valid = true
        val flow = NativeManagementSession(api, { method, path, _ ->
            if (method == "DELETE") deletes += path
            request("pending")
        }, { if (!valid) throw ApiException(409, "account_changed", "Changed") })
        flow.begin(listOf("providers"))
        api.installManagementGrant("pirc_mgmt_" + "a".repeat(43), 900_000L, 0L, setOf("providers"))
        valid = false
        flow.abandon()
        assertEquals(listOf("/api/native-management/requests/$id"), deletes)
        assertEquals(false, api.managementStatus()["active"])
    }

    @Test fun serverRestartOrCleanedRequestCanBeReauthorized() = runTest {
        val api = api()
        var missing = false
        var creates = 0
        val flow = NativeManagementSession(api, { method, path, _ ->
            if (method == "POST" && path.endsWith("/requests")) { creates++; request("pending") }
            else if (missing) throw ApiException(404, "not_found", "Missing")
            else request("pending")
        }, {})
        flow.begin(listOf("providers"))
        api.installManagementGrant("pirc_mgmt_" + "a".repeat(43), 900_000L, 0L, setOf("providers"))
        missing = true
        val result = flow.check()
        assertEquals(false, result["active"])
        assertEquals("expired", (result["request"] as Map<*, *>)["status"])
        flow.begin(listOf("providers")); assertEquals(2, creates)
        flow.cancel(); assertEquals(false, flow.status()["active"])
    }

    @Test fun browserUrlCannotEscapeOriginAndDeniedClearsGrant() = runTest {
        val api = api()
        val bad = NativeManagementSession(api, { _, _, _ -> request("pending") + ("verificationPath" to "//evil.example") }, {})
        try { bad.begin(listOf("providers")); fail("must fail") } catch (e: ApiException) { assertEquals("bad_reply", e.code) }
        val denied = NativeManagementSession(api, { _, _, _ -> request("denied") }, {})
        denied.begin(listOf("providers"))
        api.installManagementGrant("pirc_mgmt_" + "a".repeat(43), 900_000L, 0L, setOf("providers"))
        assertEquals(false, denied.check()["active"])
    }
}
