package dev.jarvis.mobile

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class JarvisModel(app: Application) : AndroidViewModel(app) {
    private val tresor = runCatching { Tresor(app) }.getOrNull()
    @Volatile private var client = tresor?.lesen()?.let { LanClient(it.kopplung, it.token) }
    private var socket: WebSocket? = null
    private var generation = 0
    private var networkAllowed = false
    private var started = 0L
    private var taskSession: String? = null
    private val tools = mutableSetOf<String>()
    val haptik = Haptik(app, viewModelScope)
    var foreground = false
        set(value) { field = value; haptik.foreground = value }
    var found by mutableStateOf(listOf<Rechner>()); private set
    var connection by mutableStateOf("Suche nach Jarvis im lokalen Netz …"); private set
    var paired by mutableStateOf(client != null); private set
    var pairing by mutableStateOf(false); private set
    var notice by mutableStateOf(""); private set

    private val discovery = LanSuche(app, { entry ->
        viewModelScope.launch {
            found = (found.filterNot { it.name == entry.name } + entry).sortedBy { it.name }
            if (!paired && !pairing) connection = "Computer auswählen oder Adresse manuell eingeben."
        }
    }, { failure -> viewModelScope.launch { if (!paired) connection = failure } })

    fun localNetwork(allowed: Boolean) {
        networkAllowed = allowed
        if (allowed && !paired) discovery.start()
        else discovery.stop()
        if (!allowed) connection = "Erlaube den Zugriff aufs lokale Netz, um Jarvis zu verbinden."
    }

    fun error(text: String) { notice = text }

    fun pair(address: String, fingerprint: String, pin: String) {
        if (!pin.matches(Regex("[0-9]{6}"))) return error("Gib die sechsstellige PIN ein.")
        runCatching { Kopplung.prüfen(address, fingerprint) }.onSuccess { pairWith(it, pin) }
            .onFailure { error(it.message ?: "Ungültige Adresse.") }
    }

    fun pairQr(raw: String) = runCatching { Kopplung.ausQr(raw) }.onSuccess { pairWith(it, null) }
        .onFailure { error(it.message ?: "Dieser QR-Code gehört nicht zu Jarvis.") }

    private fun pairWith(kopplung: Kopplung, pin: String?) {
        if (!networkAllowed || pairing) return
        pairing = true
        viewModelScope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) {
                    val storage = checkNotNull(tresor) { "Der Android-Schlüsselspeicher ist nicht verfügbar." }
                    val response = LanClient(kopplung).post("/pair/complete",
                        JSONObject().put("name", android.os.Build.MODEL).put("pin", pin).put("secret", kopplung.secret))
                    val joined = Verbindung(kopplung.copy(secret = null), response.getString("token"))
                    storage.schreiben(joined)
                    LanClient(joined.kopplung, joined.token)
                }
            }
            pairing = false
            result.onSuccess {
                discovery.stop()
                client = it
                paired = true
            }.onFailure { error(it.message ?: "Computer nicht erreichbar. Prüfe WLAN, Adresse und Port.") }
        }
    }

    fun forget(reason: String = "Computer auswählen oder manuell verbinden.") {
        detach()
        client = null
        tresor?.löschen()
        paired = false
        connection = reason
        if (networkAllowed) discovery.start()
    }

    fun detach() {
        generation++
        socket?.cancel()
        socket = null
        haptik.stop()
        tools.clear()
    }

    fun connect(reply: (JSONObject) -> Unit) {
        detach()
        val transport = client
        if (transport == null || !networkAllowed) {
            reply(message("close"))
            return
        }
        val epoch = generation
        socket = transport.socket(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                viewModelScope.launch { if (epoch == generation) reply(message("open")) }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                viewModelScope.launch {
                    if (epoch != generation) return@launch
                    trackTask(text)
                    reply(message("socket", "data" to text))
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                lost(epoch, code == 1008)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                lost(epoch, response?.code == 401)
            }

            private fun lost(epoch: Int, revoked: Boolean) {
                viewModelScope.launch {
                    if (epoch != generation) return@launch
                    if (revoked) forget("Kopplung wurde widerrufen. Kopple das Handy erneut.")
                    else { haptik.stop(); reply(message("close")) }
                }
            }
        })
    }

    fun send(data: String) {
        val outgoing = runCatching { JSONObject(data) }.getOrNull() ?: return
        if (socket?.send(data) == true && outgoing.optString("type") in setOf("chat", "resend", "replace")) {
            started = SystemClock.elapsedRealtime()
            taskSession = outgoing.string("session") ?: outgoing.string("id")
            haptik.think(true)
        }
    }

    suspend fun emergency(): Boolean = withContext(Dispatchers.IO) {
        runCatching { client?.post("/stop")?.optBoolean("ok") == true }.getOrDefault(false)
    }

    fun visual(path: String): Pair<String, ByteArray>? = client?.visual(path)

    fun haptic(event: JSONObject) {
        when (event.optString("event")) {
            "reasoning" -> if (tools.isEmpty()) haptik.think(true)
            "delta" -> haptik.text()
            "tool" -> {
                val tool = event.optString("tool")
                val status = event.optString("status")
                if (status == "running" && tools.add(tool)) haptik.pulse(Impuls.TOOL)
                if (status in setOf("completed", "error") && tools.remove(tool)) haptik.pulse(Impuls.TOOL)
                haptik.think(tools.isEmpty())
            }
            "action" -> if (event.optString("action") in setOf("click", "dblclick")) haptik.pulse(Impuls.CLICK)
            "done", "stopped", "error", "reset" -> { tools.clear(); haptik.stop() }
        }
    }

    private fun trackTask(text: String) {
        if (started == 0L) return
        val incoming = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (incoming.optString("type")) {
            "session" -> if (taskSession == null) taskSession = incoming.string("id")
            "done", "stopped", "error" -> if (incoming.string("session") == taskSession) {
                if (incoming.optString("type") == "done" && !incoming.optBoolean("aborted") &&
                    !foreground && SystemClock.elapsedRealtime() - started >= 10_000L) notifyDone()
                started = 0L
            }
        }
    }

    private fun notifyDone() {
        val app = getApplication<Application>()
        if (android.os.Build.VERSION.SDK_INT >= 33 && app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val nm = app.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(NotificationChannel("jarvis-fertig", "Fertige Aufgaben", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(app, 0, Intent(app, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        nm.notify(1, Notification.Builder(app, "jarvis-fertig").setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Jarvis ist fertig").setContentText("Öffne den Chat, um die Antwort zu lesen.")
            .setContentIntent(open).setAutoCancel(true).build())
    }

    override fun onCleared() { discovery.stop(); detach(); super.onCleared() }
}
