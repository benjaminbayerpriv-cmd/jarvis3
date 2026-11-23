package dev.jarvis.mobile

import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    private val fingerprint = "ab".repeat(32)

    @Test fun lokaleAdressenSindErlaubt() {
        assertTrue(privateAdresse("172.27.182.50"))
        assertTrue(privateAdresse("10.0.2.2"))
        assertTrue(privateAdresse("fe80::a"))
        assertEquals("https://192.168.5.55:7787", Kopplung.prüfen("192.168.5.55:7787", fingerprint).url)
    }
    @Test fun fremdeZieleUndUnverschluesselteVerbindungenSindGesperrt() {
        for (host in listOf("172.32.1.1", "1.2.3.4", "2001:4860::8888", "192.168.1.1.fremd.test"))
            assertFalse(privateAdresse(host))
        for (url in listOf("http://10.0.2.2:7787", "https://10.0.2.2@8.8.8.8", "https://10.0.2.2/path"))
            assertTrue(runCatching { Kopplung.prüfen(url, fingerprint) }.isFailure)
        assertTrue(runCatching { Kopplung.prüfen("10.0.2.2:7787", "abc") }.isFailure)
    }
}
