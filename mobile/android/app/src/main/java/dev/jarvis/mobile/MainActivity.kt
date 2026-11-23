@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package dev.jarvis.mobile

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ArrayAdapter
import android.widget.AutoCompleteTextView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.Image
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import kotlinx.coroutines.launch
import org.json.JSONObject

private const val origin = "https://appassets.androidplatform.net"
private const val home = "$origin/app/index.html"

class MainActivity : ComponentActivity() {
    private val jarvis by viewModels<JarvisModel>()
    private var cameraRequested by mutableStateOf(false)
    private var web: WebView? = null
    private var page: JavaScriptReplyProxy? = null
    private var picker: ValueCallback<Array<Uri>>? = null
    private var speech: SpeechRecognizer? = null
    private var dictationResult: ((Any?) -> Unit)? = null
    private val microphone = registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) dictate() else finishDictation(null, "Mikrofonzugriff wurde abgelehnt.")
    }
    private val camera = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        if (it) cameraRequested = true else jarvis.error("Kamera abgelehnt. Du kannst die Verbindung manuell einrichten.")
    }
    private val network = registerForActivityResult(ActivityResultContracts.RequestPermission()) { jarvis.localNetwork(it) }
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
    private val files = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val selected = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            ?.filter { it.scheme == "content" }?.takeIf { it.isNotEmpty() }?.toTypedArray()
        picker?.onReceiveValue(selected)
        picker = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val permission = "android.permission.ACCESS_LOCAL_NETWORK"
        if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED)
            network.launch(permission)
        else jarvis.localNetwork(true)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val current = page
                if (current == null) finish()
                else current.postMessage(message("back").toString())
            }
        })
        setContent {
            val colors = if (isSystemInDarkTheme()) dynamicDarkColorScheme(this) else dynamicLightColorScheme(this)
            MaterialExpressiveTheme(colorScheme = colors) {
                if (jarvis.paired) {
                    AndroidView(factory = { buildWebView().also { web = it } },
                        modifier = Modifier.fillMaxSize().safeDrawingPadding().imePadding(),
                        onRelease = { releaseWeb(it) },
                        update = {})
                } else {
                    val snack = remember { SnackbarHostState() }
                    LaunchedEffect(jarvis.notice) {
                        if (jarvis.notice.isNotBlank()) {
                            snack.showSnackbar(jarvis.notice)
                            jarvis.error("")
                        }
                    }
                    if (cameraRequested) ModalBottomSheet(onDismissRequest = { cameraRequested = false }) {
                        Text("Jarvis-QR-Code scannen", modifier = Modifier.padding(20.dp))
                        QrCamera({ data -> cameraRequested = false; jarvis.pairQr(data) }, jarvis::error)
                    }
                    Scaffold(snackbarHost = { SnackbarHost(snack) }) { padding ->
                        Verbindungsseite(jarvis, camera = {
                            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
                                cameraRequested = true
                            else camera.launch(Manifest.permission.CAMERA)
                        }, Modifier.padding(padding))
                    }
                }
            }
        }
    }

    private fun buildWebView() = WebView(this).apply {
        setBackgroundColor(0xFF131314.toInt())
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        val assets = WebViewAssetLoader.Builder().addPathHandler("/app/", WebViewAssetLoader.AssetsPathHandler(this@MainActivity)).build()

        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val url = request.url
                if (url.scheme != "https" || url.host != "appassets.androidplatform.net" || url.port != -1)
                    return unavailable()
                assets.shouldInterceptRequest(url)?.let { return it }
                val path = url.encodedPath.orEmpty()
                val image = if (request.method == "GET" && !request.isForMainFrame && path.startsWith("/visual/"))
                    runCatching { jarvis.visual(path) }.getOrNull() else null
                return if (image != null) WebResourceResponse(image.first, null, 200, "OK",
                    mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"), ByteArrayInputStream(image.second))
                else unavailable()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.toString() == home) return false
                if (request.isForMainFrame && request.hasGesture() && request.url.scheme in setOf("https", "http") &&
                    request.url.host != "appassets.androidplatform.net") openExternal(request.url)
                return true
            }
        }

        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                picker?.onReceiveValue(null)
                picker = callback
                runCatching { files.launch(params.createIntent()) }.onFailure {
                    picker?.onReceiveValue(null)
                    picker = null
                    notify("Dateiauswahl konnte nicht geöffnet werden.")
                }
                return true
            }

            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(this, "JarvisAndroid", setOf(origin)) { _, request, source, main, reply ->
                if (main && source.toString() == origin) {
                    page = reply
                    runCatching { JSONObject(request.data ?: "") }.getOrNull()?.let { receive(it, reply) }
                }
            }
            loadUrl(home)
        } else {
            loadData("<p>Aktualisiere Android System WebView, um Jarvis zu öffnen.</p>", "text/html", "UTF-8")
        }
    }

    private fun unavailable() = WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(),
        ByteArrayInputStream(ByteArray(0)))

    private fun receive(request: JSONObject, reply: JavaScriptReplyProxy) {
        val id = request.optInt("id")
        val result: (Any?) -> Unit = { reply.postMessage(message("result", "id" to id, "value" to it).toString()) }
        when (request.optString("type")) {
            "connect" -> jarvis.connect { reply.postMessage(it.toString()) }
            "send" -> jarvis.send(request.optString("data"))
            "stop" -> lifecycleScope.launch { result(jarvis.emergency()) }
            "back" -> moveTaskToBack(true)
            "forget" -> jarvis.forget()
            "toast" -> notify(request.optString("text"))
            "confirm", "prompt", "choice" -> dialog(request, result)
            "dictate" -> {
                if (dictationResult != null) { result(null); return }
                dictationResult = result
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) dictate()
                else microphone.launch(Manifest.permission.RECORD_AUDIO)
            }
            "notifications" -> if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                else notify("Mitteilungen sind auf diesem Gerät bereits erlaubt.")
            "haptic" -> jarvis.haptic(request)
            "hapticSettings" -> result(hapticSettings())
            "hapticSetting" -> setHaptic(request.optString("name"), request)
        }
    }

    private fun dialog(request: JSONObject, result: (Any?) -> Unit) {
        val title = request.optString("title").take(120)
        val text = request.optString("text").take(500)
        val options = request.optJSONArray("options")
        val labels = Array(options?.length()?.coerceAtMost(500) ?: 0) { options!!.optString(it).take(180) }
        val builder = AlertDialog.Builder(this).setTitle(title).setNegativeButton("Abbrechen") { _, _ -> result(null) }
            .setOnCancelListener { result(null) }
        when (request.optString("type")) {
            "choice" -> builder.setItems(labels) { _, index -> result(index) }.show()
            "confirm" -> builder.setMessage(text).setPositiveButton("Bestätigen") { _, _ -> result(true) }.show()
            "prompt" -> {
                val edit = AutoCompleteTextView(this).apply {
                    hint = request.optString("hint").take(120)
                    setText(request.optString("value").take(240))
                    setSelection(length())
                    setSingleLine()
                    setAdapter(ArrayAdapter(this@MainActivity, android.R.layout.simple_dropdown_item_1line, labels))
                }
                val field = FrameLayout(this).apply {
                    val horizontal = (24 * resources.displayMetrics.density).toInt()
                    setPadding(horizontal, 0, horizontal, 0)
                    addView(edit, FrameLayout.LayoutParams(-1, -2))
                }
                val prompt = builder.setView(field).setMessage(text.takeIf(String::isNotEmpty))
                    .setPositiveButton("Speichern") { _, _ -> result(edit.text.toString()) }.create()
                edit.requestFocus()
                prompt.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
                prompt.show()
            }
        }
    }

    private fun hapticSettings() = JSONObject().apply {
        put("haptics", jarvis.haptik.enabled)
        put("hapticsStrength", when (jarvis.haptik.strength) {
            Stärke.LEICHT -> "soft"; Stärke.MITTEL -> "normal"; Stärke.STARK -> "strong"
        })
        for (kind in Impuls.entries) put(kind.key, jarvis.haptik.active(kind))
    }

    private fun setHaptic(name: String, request: JSONObject) {
        when (name) {
            "haptics" -> jarvis.haptik.enabled = request.optBoolean("value")
            "hapticsStrength" -> jarvis.haptik.strength = when (request.optString("value")) {
                "soft" -> Stärke.LEICHT; "strong" -> Stärke.STARK; else -> Stärke.MITTEL
            }
            else -> Impuls.entries.find { it.key == name }?.let { jarvis.haptik.set(it, request.optBoolean("value")) }
        }
    }

    private fun dictate() {
        if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(this))
            return finishDictation(null, "Lokale Spracherkennung ist auf diesem Gerät nicht verfügbar.")
        val recognizer = speech ?: SpeechRecognizer.createOnDeviceSpeechRecognizer(this).also { speech = it }
        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { notify("Jarvis hört zu …") }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onError(error: Int) { finishDictation(null, "Diktat beendet. Prüfe die installierte Sprache.") }
            override fun onResults(results: Bundle?) {
                finishDictation(results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull())
            }
        })
        recognizer.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true))
    }

    private fun finishDictation(text: String?, error: String? = null) {
        dictationResult?.invoke(text)
        dictationResult = null
        if (error != null) notify(error)
    }

    private fun notify(text: String) = Toast.makeText(this, text.take(250), Toast.LENGTH_SHORT).show()

    private fun openExternal(uri: Uri) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
            .onFailure { notify("Kein Browser zum Öffnen dieses Links verfügbar.") }
    }

    private fun releaseWeb(view: WebView) {
        if (web != view) return
        jarvis.detach()
        page = null
        web = null
        view.destroy()
    }

    override fun onStart() { super.onStart(); jarvis.foreground = true; web?.onResume() }
    override fun onStop() { jarvis.foreground = false; speech?.cancel(); finishDictation(null); web?.onPause(); super.onStop() }
    override fun onDestroy() { speech?.destroy(); web?.let(::releaseWeb); super.onDestroy() }
}
@Composable
private fun Verbindungsseite(vm: JarvisModel, camera: () -> Unit, modifier: Modifier) {
    var address by remember { mutableStateOf("") }
    var fingerprint by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Image(painterResource(R.drawable.jarvis_icon), null, Modifier.size(58.dp))
        Text("Mit Jarvis verbinden", style = MaterialTheme.typography.headlineMedium)
        Text(vm.connection, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Button(onClick = camera, enabled = !vm.pairing, modifier = Modifier.fillMaxWidth()) {
            Icon(painterResource(R.drawable.symbol_qr_code_scanner), null)
            Spacer(Modifier.width(10.dp))
            Text("Kopplungs-QR-Code scannen")
        }
        if (vm.found.isNotEmpty()) {
            Text("Computer im lokalen Netz", style = MaterialTheme.typography.titleMedium)
            for (host in vm.found) OutlinedButton(onClick = {
                address = if (':' in host.host) "[${host.host}]:${host.port}" else "${host.host}:${host.port}"
            }) { Text(host.name) }
        }
        HorizontalDivider()
        Text("Manuell koppeln", style = MaterialTheme.typography.titleMedium)
        Text("Adresse, PIN und Fingerabdruck stehen in Jarvis unter Einstellungen → Handy-Zugriff.")
        OutlinedTextField(address, { address = it }, label = { Text("Lokale Adresse und Port") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
        OutlinedTextField(pin, { pin = it.filter(Char::isDigit).take(6) }, label = { Text("PIN") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        OutlinedTextField(fingerprint, { fingerprint = it }, label = { Text("Zertifikat-Fingerabdruck") }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { vm.pair(address, fingerprint, pin) }, enabled = !vm.pairing && pin.length == 6 && address.isNotBlank() && fingerprint.isNotBlank()) {
            if (vm.pairing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            else Text("Koppeln")
        }
    }
}
