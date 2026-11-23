package dev.jarvis.mobile

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.net.InetAddress
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

data class Verbindung(val kopplung: Kopplung, val token: String)

class Tresor(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context, "jarvis-verbindung", MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )
    fun lesen(): Verbindung? = runCatching {
        val url = prefs.getString("adresse", null) ?: return null
        val pin = prefs.getString("zertifikat", null) ?: return null
        val token = prefs.getString("token", null) ?: return null
        Verbindung(Kopplung.prüfen(url, pin), token)
    }.getOrNull()

    fun schreiben(value: Verbindung) {
        prefs.edit().putString("adresse", value.kopplung.url).putString("zertifikat", value.kopplung.fingerprint)
            .putString("token", value.token).apply()
    }

    fun löschen() { prefs.edit().clear().apply() }
}

class LanClient(private val kopplung: Kopplung, private val token: String? = null) {
    private val client = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)
        .proxy(java.net.Proxy.NO_PROXY)
        .connectTimeout(5, TimeUnit.SECONDS).callTimeout(12, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .apply {
            val trust = object : X509TrustManager {
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
                override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
                    throw CertificateException("Client-Zertifikat unerwartet.")

                override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                    val leaf = chain.firstOrNull() ?: throw CertificateException("Zertifikat fehlt.")
                    leaf.checkValidity()
                    val digest = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
                    val fingerprint = digest.joinToString("") { "%02x".format(it.toInt() and 255) }
                    if (!MessageDigest.isEqual(fingerprint.toByteArray(), kopplung.fingerprint.toByteArray()))
                        throw CertificateException("Der Zertifikat-Fingerabdruck passt nicht zu diesem Computer.")
                }
            }
            val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
            sslSocketFactory(tls.socketFactory, trust)
            hostnameVerifier { host, _ -> privateAdresse(host) }
            dns(object : okhttp3.Dns { override fun lookup(hostname: String): List<InetAddress> {
                require(privateAdresse(hostname))
                return listOf(InetAddress.getByName(hostname))
            } })
        }.build()

    private fun request(path: String): Request.Builder =
        Request.Builder().url(kopplung.url + path).apply {
            if (token != null) header("Authorization", "Bearer $token")
        }

    fun post(path: String, json: JSONObject = JSONObject()): JSONObject {
        val body = json.toString().toRequestBody("application/json".toMediaType())
        client.newCall(request(path).post(body).build()).execute().use {
            val result = JSONObject(it.body?.string() ?: "{}")
            if (!it.isSuccessful) error(result.optString("error", "Anfrage fehlgeschlagen (HTTP ${it.code})."))
            return result
        }
    }

    fun socket(listener: WebSocketListener): WebSocket = client.newWebSocket(request("/ui").build(), listener)
    fun visual(path: String): Pair<String, ByteArray>? {
        if (!path.matches(Regex("/visual/v[a-z0-9]{6,20}/[\\w.-]+\\.(png|jpg|jpeg|webp)", RegexOption.IGNORE_CASE))) return null
        return client.newCall(request(path).build()).execute().use {
            val body = it.body
            val type = body?.contentType()?.let { value -> "${value.type}/${value.subtype}" }
            if (it.isSuccessful && body != null && type?.startsWith("image/") == true) type to body.bytes()
            else null
        }
    }
}

@Suppress("DEPRECATION")
class LanSuche(context: Context, private val onFound: (Rechner) -> Unit, private val onFailure: (String) -> Unit) {
    private val nsd = context.getSystemService(NsdManager::class.java)
    private val wifi = context.applicationContext.getSystemService(WifiManager::class.java)
    private val lock = wifi?.createMulticastLock("jarvis-bonjour")
    private val waiting = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var running = false
    private val discovery = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(type: String) {}
        override fun onDiscoveryStopped(type: String) {}
        override fun onStartDiscoveryFailed(type: String, code: Int) { onFailure("Die Netzwerksuche konnte nicht starten."); stop() }
        override fun onStopDiscoveryFailed(type: String, code: Int) {}
        override fun onServiceLost(service: NsdServiceInfo) {}
        override fun onServiceFound(service: NsdServiceInfo) = enqueue(service)
    }
    fun start() {
        if (running || nsd == null) return
        running = true
        runCatching {
            lock?.acquire()
            nsd.discoverServices("_jarvis3._tcp.", NsdManager.PROTOCOL_DNS_SD, discovery)
        }.onFailure { stop(); onFailure("Das lokale Netzwerk ist für die Suche nicht verfügbar.") }
    }
    @Synchronized private fun enqueue(service: NsdServiceInfo) {
        if (!running) return
        waiting.add(service)
        resolveNext()
    }
    @Synchronized private fun resolveNext() {
        if (!running || resolving) return
        val next = waiting.removeFirstOrNull() ?: return
        resolving = true
        runCatching {
            nsd.resolveService(next, object : NsdManager.ResolveListener {
                override fun onResolveFailed(service: NsdServiceInfo, code: Int) = resolved()
                override fun onServiceResolved(service: NsdServiceInfo) {
                    val host = service.host?.hostAddress
                    if (host != null && privateAdresse(host)) onFound(Rechner(service.serviceName, host, service.port))
                    resolved()
                }
            })
        }.onFailure { resolving = false }
    }
    @Synchronized private fun resolved() { resolving = false; resolveNext() }
    @Synchronized fun stop() {
        if (!running) return
        running = false
        waiting.clear()
        runCatching { nsd?.stopServiceDiscovery(discovery) }
        if (lock?.isHeld == true) lock.release()
    }
}
