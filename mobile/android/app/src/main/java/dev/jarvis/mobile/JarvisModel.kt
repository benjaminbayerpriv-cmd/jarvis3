package dev.jarvis.mobile

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class JarvisModel(app: Application) : AndroidViewModel(app) {
    private var tresor = runCatching { Tresor(app) }.getOrNull()
    private var credentials = tresor?.lesen()
    private var client: LanClient? = null
    private var socket: WebSocket? = null
    private var retry: Job? = null
    private var attempt = 0
    private var generation = 0
    private var waiting = false
    private var streamIndex: Int? = null
    private var started = 0L
    private var toolsRunning = mutableSetOf<String>()
    private var lastFrameAt = 0L
    val haptik = Haptik(app, viewModelScope)
    var foreground = false
        set(value) { field = value; haptik.foreground = value; if (value && busy && toolsRunning.isEmpty() && streamIndex == null) haptik.think(true) }

    var found by mutableStateOf(listOf<Rechner>()); private set
    var connection by mutableStateOf("Suche nach Jarvis im lokalen Netz …"); private set
    var online by mutableStateOf(false); private set
    var paired by mutableStateOf(credentials != null); private set
    var pairing by mutableStateOf(false); private set
    var notice by mutableStateOf(""); private set
    var chats by mutableStateOf(listOf<Chat>()); private set
    var active by mutableStateOf<String?>(null); private set
    var messages by mutableStateOf(listOf<Beitrag>()); private set
    var tools by mutableStateOf(listOf<JSONObject>()); private set
    var busy by mutableStateOf(false); private set
    var draft by mutableStateOf("")
    var editing by mutableStateOf<String?>(null); private set
    var models by mutableStateOf(listOf<Modell>()); private set
    var model by mutableStateOf(""); private set
    var titles by mutableStateOf(true); private set
    var liveView by mutableStateOf(true); private set
    var computer by mutableStateOf(false); private set
    var frame by mutableStateOf<Bitmap?>(null); private set
    var sources by mutableStateOf(listOf<Quelle>()); private set
    var selectedSource by mutableStateOf(""); private set

    private val discovery = LanSuche(app, { entry ->
        viewModelScope.launch {
            found = (found.filterNot { it.name == entry.name } + entry).sortedBy { it.name }
            if (!paired && !pairing) connection = "Computer auswählen oder Adresse manuell eingeben."
        }
    }, { failure -> viewModelScope.launch { if (!paired) connection = failure } })

    fun localNetwork(allowed: Boolean) {
        if (!allowed) {
            discovery.stop()
            connection = "Erlaube den Zugriff aufs lokale Netz, um Jarvis zu verbinden."
            return
        }
        discovery.start()
        if (paired && !online && socket == null) connect()
    }
    fun error(text: String) { notice = text }
    fun pair(address: String, fingerprint: String, pin: String) {
        if (!pin.matches(Regex("[0-9]{6}"))) { error("Gib die sechsstellige PIN ein."); return }
        runCatching { Kopplung.prüfen(address, fingerprint) }
            .onSuccess { pairWith(it, pin) }.onFailure { error(it.message ?: "Ungültige Adresse.") }
    }
    fun pairQr(raw: String) = runCatching { Kopplung.ausQr(raw) }
        .onSuccess { pairWith(it, null) }.onFailure { error(it.message ?: "Dieser QR-Code gehört nicht zu Jarvis.") }

    private fun pairWith(kopplung: Kopplung, pin: String?) {
        if (pairing) return
        pairing = true
        notice = ""
        viewModelScope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) {
                    val storage = checkNotNull(tresor) { "Der Android-Schlüsselspeicher ist nicht verfügbar." }
                    val response = LanClient(kopplung).post("/pair/complete",
                        JSONObject().put("name", android.os.Build.MODEL).put("pin", pin).put("secret", kopplung.secret))
                    val joined = Verbindung(kopplung.copy(secret = null), response.getString("token"))
                    storage.schreiben(joined)
                    joined
                }
            }
            pairing = false
            result.onSuccess {
                credentials = it
                paired = true
                attempt = 0
                connect()
            }.onFailure {
                error(it.message?.takeIf { message -> !message.contains("timeout", ignoreCase = true) }
                    ?: "Computer nicht erreichbar. Prüfe WLAN, Adresse und Port.")
            }
        }
    }

    fun forget() {
        generation++
        retry?.cancel()
        socket?.cancel()
        socket = null
        client = null
        tresor?.löschen()
        credentials = null
        online = false
        paired = false
        chats = emptyList()
        frame = null
        newChat()
        connection = "Computer auswählen oder manuell verbinden."
        discovery.start()
    }

    private fun connect() {
        val saved = credentials ?: return
        val epoch = ++generation
        retry?.cancel()
        socket?.cancel()
        online = false
        connection = "Verbinde mit dem Computer …"
        val transport = LanClient(saved.kopplung, saved.token)
        client = transport
        socket = transport.socket(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                viewModelScope.launch {
                    if (epoch != generation) return@launch
                    attempt = 0
                    online = true
                    connection = "Verbunden"
                    active?.let { send(message("open", "id" to it)) }
                }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                viewModelScope.launch {
                    if (epoch != generation) return@launch
                    runCatching { handle(JSONObject(text)) }.onFailure { report("Ungültiges Ereignis vom Daemon.") }
                }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                viewModelScope.launch {
                    if (epoch != generation) return@launch
                    if (code == 1008) lostPairing() else retryLater()
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                viewModelScope.launch {
                    if (epoch != generation) return@launch
                    if (response?.code == 401) lostPairing()
                    else if (t is javax.net.ssl.SSLException) {
                        online = false
                        connection = "Zertifikat stimmt nicht. Erneut koppeln."
                    } else retryLater()
                }
            }
        })
    }

    private fun lostPairing() {
        forget()
        connection = "Kopplung wurde widerrufen. Koppeln ist erneut möglich."
    }

    private fun retryLater() {
        online = false
        haptik.stop()
        connection = "Computer nicht erreichbar. Prüfe das lokale Netz."
        retry?.cancel()
        retry = viewModelScope.launch {
            delay((1_000L shl attempt.coerceAtMost(3)))
            attempt++
            connect()
        }
    }
    private fun send(json: JSONObject): Boolean {
        if (online && socket?.send(json.toString()) == true) return true
        error("Jarvis ist gerade nicht erreichbar.")
        return false
    }
    fun refreshChats() { if (online) send(message("history")) }
    fun refreshSources() { if (online) send(message("tabs")) }
    fun selectSource(source: Quelle) {
        selectedSource = source.id
        if (source.id.startsWith("win:")) send(message("viewer_window", "window" to source.id.removePrefix("win:").toIntOrNull()))
        else send(message("viewer_tab", "tab" to source.id.toIntOrNull()))
    }
    fun setting(key: String, value: Any) { send(message("settings", "settings" to JSONObject().put(key, value))) }

    fun open(id: String) {
        if (!send(message("open", "id" to id))) return
        newChat()
        active = id
        busy = chats.firstOrNull { it.id == id }?.running == true
    }
    fun newChat() {
        active = null
        messages = emptyList()
        tools = emptyList()
        toolsRunning.clear()
        streamIndex = null
        waiting = false
        busy = false
        editing = null
        draft = ""
        haptik.stop()
    }

    fun edit(item: Beitrag) { editing = item.id; draft = item.text }
    fun cancelEdit() { editing = null; draft = "" }
    fun sendDraft() {
        val content = draft.trim()
        if (content.isEmpty()) return
        val edit = editing
        val outgoing = if (edit != null) message("replace", "id" to active, "messageID" to edit, "text" to content)
        else message("chat", "session" to active, "text" to content, "model" to model.takeIf(String::isNotBlank))
        if (!send(outgoing)) return
        if (edit == null) messages += Beitrag(null, "user", content)
        cancelEdit()
        waiting = active == null
        started = System.nanoTime()
        busy = true
        tools = emptyList()
        streamIndex = null
        haptik.think(true)
    }
    fun resend(item: Beitrag) {
        if (item.id != null && !busy && send(message("resend", "id" to active, "messageID" to item.id))) {
            busy = true
            started = System.nanoTime()
            haptik.think(true)
        }
    }
    fun stop() { active?.let { send(message("stop", "session" to it)) }; haptik.stop() }
    fun emergency() {
        val transport = client ?: return error("Jarvis ist gerade nicht erreichbar.")
        haptik.stop()
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { transport.post("/stop") } }
                .onSuccess { notice = "Jarvis gestoppt."; finish(false) }
                .onFailure { error("Not-Aus konnte nicht gesendet werden."); report("Not-Aus konnte nicht gesendet werden.") }
        }
    }
    suspend fun loadImage(path: String): Bitmap? = withContext(Dispatchers.IO) {
        runCatching { client?.bild(path)?.let { BitmapFactory.decodeByteArray(it, 0, it.size) } }.getOrNull()
    }

    private fun report(text: String) {
        val transport = client ?: return
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { transport.post("/errors", JSONObject().put("platform", "android").put("message", text)) }
        }
    }

    private fun handle(event: JSONObject) {
        val type = event.optString("type")
        if (type == "session" && (waiting || event.string("replaces") == active && active != null)) {
            active = event.string("id")
            waiting = false
        }
        val session = event.string("session")
        if (session != null && session != active) return
        when (type) {
            "history" -> chats = event.objects("sessions").filterNot { it.optBoolean("archived") }.map(Chat::read)
            "messages" -> if (session == active) {
                messages = event.objects("messages").map {
                    Beitrag(it.string("id"), it.optString("role"), it.optString("text"), it.objects("visuals").flatMap(Bild::read))
                }
                streamIndex = null
                busy = event.optBoolean("running")
            }
            "state" -> {
                models = event.objects("models").map { Modell(it.optString("id"), it.optString("model")) }
                model = event.optString("model")
                computer = event.optString("mode") == "computer"
                titles = event.optBoolean("autoChatTitles", true)
                liveView = event.optBoolean("liveView", true)
                val running = event.optJSONArray("busySessions")
                busy = waiting || (0 until (running?.length() ?: 0)).any { running?.optString(it) == active }
            }
            "delta" -> {
                haptik.text()
                val delta = event.optString("text")
                val index = streamIndex
                if (index == null || index !in messages.indices) {
                    streamIndex = messages.size
                    messages += Beitrag(null, "assistant", delta)
                } else {
                    messages = messages.toMutableList().apply { this[index] = this[index].copy(text = this[index].text + delta) }
                }
            }
            "tool" -> {
                val id = event.optString("id")
                val status = event.optString("status")
                if (status == "running" && toolsRunning.add(id)) haptik.pulse(Impuls.TOOL)
                if (status in setOf("completed", "error") && toolsRunning.remove(id)) haptik.pulse(Impuls.TOOL)
                haptik.think(busy && toolsRunning.isEmpty() && streamIndex == null)
                tools = tools.filterNot { it.optString("id") == id } + event
            }
            "action" -> if (event.optString("cmd") in setOf("click", "dblclick")) haptik.pulse(Impuls.CLICK)
            "done" -> { finish(!event.optBoolean("aborted")); active?.let { send(message("open", "id" to it)) } }
            "stopped" -> finish(false)
            "error", "notice" -> {
                notice = event.string("message") ?: event.optString("text")
                if (type == "error") finish(false)
            }
            "tabs" -> {
                sources = event.objects("tabs").map { Quelle(it.optString("tab"), it.optString("title")) } +
                    event.objects("windows").map { Quelle("win:" + it.optString("id"), it.optString("title", it.optString("app"))) }
                selectedSource = event.string("pinned").orEmpty()
            }
            "frame" -> {
                val now = System.nanoTime()
                if (!foreground || now - lastFrameAt < TimeUnit.MILLISECONDS.toNanos(65)) return
                lastFrameAt = now
                val data = event.optString("data").substringAfter("base64,")
                if (data.length <= 2_000_000) viewModelScope.launch {
                    val next = withContext(Dispatchers.Default) {
                        runCatching {
                            val bytes = Base64.decode(data, Base64.DEFAULT)
                            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        }.getOrNull()
                    }
                    if (lastFrameAt == now && next != null) frame = next
                }
            }
            "viewer_idle" -> { frame = null; lastFrameAt = 0 }
            "visual" -> messages += Beitrag(null, "assistant", "", Bild.read(event))
        }
    }

    private fun finish(completed: Boolean) {
        haptik.stop()
        toolsRunning.clear()
        streamIndex = null
        waiting = false
        busy = false
        if (completed && !foreground && started > 0 && System.nanoTime() - started >= TimeUnit.SECONDS.toNanos(10)) notifyDone()
        started = 0
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

    override fun onCleared() { discovery.stop(); socket?.cancel(); haptik.stop(); super.onCleared() }
}
