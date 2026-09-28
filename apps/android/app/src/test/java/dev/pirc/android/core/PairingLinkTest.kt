package dev.pirc.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class PairingLinkTest {
    private val token = "pirc_dev_" + "a".repeat(43)

    /** Exactly what the web builds: `pirc://pair?${new URLSearchParams({url, token})}`. */
    private fun link(url: String, token: String = this.token) =
        "pirc://pair?url=${java.net.URLEncoder.encode(url, Charsets.UTF_8)}&token=$token"

    @Test
    fun parsesTheWebLink() {
        assertEquals(Pairing("https://pirc.example", token), PairingLink.parse(link("https://pirc.example")))
        assertEquals(Pairing("https://pirc.example:8443", token), PairingLink.parse("  " + link("https://pirc.example:8443/") + "\n"))
    }

    @Test
    fun allowsPlainHttpOnlyForLocalDevelopment() {
        assertEquals("http://10.0.2.2:5173", PairingLink.parse(link("http://10.0.2.2:5173"), allowDevHosts = true).baseUrl)
        assertThrows(InvalidPairingLink::class.java) { PairingLink.parse(link("http://pirc.example"), allowDevHosts = true) }
    }

    @Test
    fun releaseBuildsRefusePlainHttpEverywhere() {
        for (host in listOf("http://10.0.2.2:5173", "http://localhost:8080", "http://127.0.0.1"))
            assertThrows(host, InvalidPairingLink::class.java) { PairingLink.parse(link(host), allowDevHosts = false) }
    }

    @Test
    fun refusesAnythingButAnOriginAndAValidToken() {
        for (bad in listOf(
            link("https://pirc.example/api"),
            link("https://user:pw@pirc.example"),
            link("https://pirc.example?x=1"),
            link("ftp://pirc.example"),
            link("not a url"),
            link("https://pirc.example", "pirc_dev_short"),
            link("https://pirc.example", "other_" + "a".repeat(43)),
            "https://pirc.example",
            "pirc://other?url=https%3A%2F%2Fpirc.example&token=$token",
            "",
        )) assertThrows(bad, InvalidPairingLink::class.java) { PairingLink.parse(bad) }
    }

    @Test
    fun neverPrintsTheToken() {
        assertFalse(PairingLink.parse(link("https://pirc.example")).toString().contains(token))
    }
}
