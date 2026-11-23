@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package dev.jarvis.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.Link
import org.commonmark.node.ListBlock
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.parser.Parser

class MainActivity : ComponentActivity() {
    private val jarvis by viewModels<JarvisModel>()
    private var speech: SpeechRecognizer? = null
    private var dictating by mutableStateOf(false)
    private var cameraRequested by mutableStateOf(false)
    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        if (it) dictate() else jarvis.error("Mikrofonzugriff für das Diktat wurde abgelehnt.")
    }
    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        if (it) cameraRequested = true else jarvis.error("Kamerazugriff wurde abgelehnt. Adresse und PIN kannst du eingeben.")
    }
    private val localNetwork = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        jarvis.localNetwork(it)
    }
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val permission = "android.permission.ACCESS_LOCAL_NETWORK"
        if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED)
            localNetwork.launch(permission)
        else jarvis.localNetwork(true)
        setContent {
            val dark = isSystemInDarkTheme()
            val colors = if (dark) dynamicDarkColorScheme(this) else dynamicLightColorScheme(this)
            MaterialExpressiveTheme(colorScheme = colors) {
                Jarvis(jarvis, cameraRequested, onCamera = {
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) cameraRequested = true
                    else cameraPermission.launch(Manifest.permission.CAMERA)
                }, onScan = { raw -> cameraRequested = false; jarvis.pairQr(raw) }, closeCamera = { cameraRequested = false },
                    dictating = dictating, onDictate = {
                        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) dictate()
                        else micPermission.launch(Manifest.permission.RECORD_AUDIO)
                    }, onNotifications = { if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS) })
            }
        }
    }
    override fun onStart() { super.onStart(); jarvis.foreground = true }
    override fun onStop() { jarvis.foreground = false; speech?.cancel(); dictating = false; super.onStop() }
    override fun onDestroy() { speech?.destroy(); super.onDestroy() }

    private fun dictate() {
        if (dictating) { speech?.stopListening(); return }
        if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
            jarvis.error("Lokale Spracherkennung ist auf diesem Gerät nicht verfügbar.")
            return
        }
        val session = speech ?: SpeechRecognizer.createOnDeviceSpeechRecognizer(this).also { speech = it }
        val base = jarvis.draft
        session.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onError(error: Int) {
                dictating = false
                jarvis.error("Das Diktat konnte nicht abgeschlossen werden. Prüfe die installierte Sprache.")
            }
            override fun onResults(results: Bundle?) {
                updateDraft(results)
                dictating = false
            }
            override fun onPartialResults(partialResults: Bundle?) = updateDraft(partialResults)
            override fun onEvent(eventType: Int, params: Bundle?) {}
            private fun updateDraft(bundle: Bundle?) {
                val text = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
                jarvis.draft = listOf(base.trim(), text.trim()).filter(String::isNotEmpty).joinToString(" ")
            }
        })
        dictating = true
        session.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true))
    }
}

private enum class Seite(val title: String, val icon: Int) {
    CHAT("Chats", R.drawable.symbol_chat), PREVIEW("Vorschau", R.drawable.symbol_visibility),
    SETTINGS("Einstellungen", R.drawable.symbol_settings)
}

@Composable
private fun Jarvis(
    vm: JarvisModel, scanning: Boolean, onCamera: () -> Unit, onScan: (String) -> Unit, closeCamera: () -> Unit,
    dictating: Boolean, onDictate: () -> Unit, onNotifications: () -> Unit
) {
    var page by rememberSaveable { mutableStateOf(Seite.CHAT) }
    var chatOpen by rememberSaveable { mutableStateOf(false) }
    val compact = LocalConfiguration.current.screenHeightDp < 480
    val keyboardShown = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val newChat = { vm.newChat(); chatOpen = true }
    val selectPage: (Seite) -> Unit = { item ->
        if (page == item && item == Seite.CHAT) chatOpen = false
        page = item
    }
    val scroll = TopAppBarDefaults.enterAlwaysScrollBehavior()
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(vm.notice) { if (vm.notice.isNotBlank()) { snack.showSnackbar(vm.notice); vm.error("") } }
    LaunchedEffect(page, vm.online) {
        if (page == Seite.PREVIEW) vm.refreshSources()
        if (page == Seite.CHAT && !chatOpen) vm.refreshChats()
    }
    BackHandler(enabled = chatOpen && page == Seite.CHAT) { chatOpen = false }
    if (scanning) ModalBottomSheet(onDismissRequest = closeCamera) {
        Text("Jarvis-QR-Code scannen", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(20.dp))
        QrCamera(onScan, vm::error)
        Spacer(Modifier.height(20.dp))
    }
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(if (!vm.paired) "Jarvis" else if (page == Seite.CHAT && chatOpen) vm.chats.firstOrNull { it.id == vm.active }?.title ?: "Neuer Chat" else page.title, maxLines = 1)
                        if (vm.paired) Text(vm.connection, style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    }
                },
                navigationIcon = {
                    if (vm.paired && chatOpen && page == Seite.CHAT) IconButton(onClick = { chatOpen = false }) {
                        Symbol(R.drawable.symbol_arrow_back, "Zur Chatliste")
                    }
                },
                actions = {
                    if (compact && vm.paired && page == Seite.CHAT && !chatOpen) {
                        IconButton(enabled = vm.online, onClick = newChat) {
                            Symbol(R.drawable.symbol_add, "Neuer Chat")
                        }
                    }
                    if (vm.paired) IconButton(enabled = vm.online, onClick = vm::emergency) {
                        Icon(painterResource(R.drawable.symbol_stop), "Not-Aus", tint = MaterialTheme.colorScheme.error)
                    }
                },
                scrollBehavior = scroll
            )
        },
        bottomBar = {
            if (vm.paired && !compact && !keyboardShown) NavigationBar {
                for (item in Seite.entries) NavigationBarItem(
                    selected = page == item, onClick = { selectPage(item) },
                    icon = { Symbol(item.icon, null) }, label = { Text(item.title) })
            }
        },
    ) { padding ->
        Row(Modifier.fillMaxSize().padding(padding)) {
            if (vm.paired && compact && !keyboardShown) {
                NavigationRail(windowInsets = WindowInsets(0), modifier = Modifier.width(112.dp)) {
                    for (item in Seite.entries) NavigationRailItem(
                        selected = page == item, onClick = { selectPage(item) },
                        icon = { Symbol(item.icon, null) }, label = { Text(item.title) })
                }
            }
            val body = Modifier.weight(1f)
            when {
                !vm.paired -> Verbindungsseite(vm, onCamera, body)
                page == Seite.PREVIEW -> Vorschau(vm, body)
                page == Seite.SETTINGS -> Einstellungen(vm, onNotifications, body)
                chatOpen -> Unterhaltung(vm, dictating, onDictate, compact, body)
                else -> Chatliste(vm, open = { vm.open(it); chatOpen = true }, new = newChat, compact, body)
            }
        }
    }
}

@Composable private fun Symbol(id: Int, label: String?) = Icon(painterResource(id), label)

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
            Symbol(R.drawable.symbol_qr_code_scanner, null)
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

@Composable
private fun Chatliste(vm: JarvisModel, open: (String) -> Unit, new: () -> Unit, compact: Boolean, modifier: Modifier) {
    var query by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf(false) }
    val filtered = vm.chats.filter { it.title.contains(query, true) || it.folder?.contains(query, true) == true }
    Box(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            @Composable fun Eingabe() {
                SearchBarDefaults.InputField(query = query, onQueryChange = { query = it }, onSearch = { expanded = false },
                    expanded = expanded, onExpandedChange = { expanded = it }, placeholder = { Text("Chats suchen") },
                    leadingIcon = { Symbol(R.drawable.symbol_search, null) })
            }
            val search = Modifier.fillMaxWidth().padding(horizontal = 16.dp)
            if (compact) DockedSearchBar(inputField = { Eingabe() }, expanded = expanded,
                onExpandedChange = { expanded = it }, modifier = search) {
                Chatzeilen(filtered, bottom = 16, open = { expanded = false; open(it) })
            } else SearchBar(inputField = { Eingabe() }, expanded = expanded,
                onExpandedChange = { expanded = it }, modifier = search) {
                Chatzeilen(filtered, bottom = 16, open = { expanded = false; open(it) })
            }
            if (!expanded) Chatzeilen(filtered, bottom = if (compact) 16 else 88, open = open)
        }
        if (!compact && !expanded) HorizontalFloatingToolbar(expanded = true, modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp)) {
            Button(onClick = new, enabled = vm.online) {
                Symbol(R.drawable.symbol_add, null); Spacer(Modifier.width(8.dp)); Text("Neuer Chat")
            }
        }
    }
}

@Composable
private fun Chatzeilen(chats: List<Chat>, bottom: Int, open: (String) -> Unit) {
    LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = bottom.dp)) {
        if (chats.isEmpty()) item {
            Text("Keine Chats gefunden.", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        for ((folder, entries) in chats.groupBy { it.folder ?: "Chats" }) {
            item { Text(folder, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
            items(entries, key = { it.id }) { chat ->
                Surface(onClick = { open(chat.id) }, shape = MaterialTheme.shapes.medium) {
                    ListItem(
                        leadingContent = { Symbol(R.drawable.symbol_chat, null) },
                        trailingContent = if (chat.running) ({ CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) }) else null
                    ) { Text(chat.title) }
                }
            }
        }
    }
}

@Composable
private fun Unterhaltung(vm: JarvisModel, dictating: Boolean, onDictate: () -> Unit, compact: Boolean, modifier: Modifier) {
    val state = rememberLazyListState()
    val total = vm.messages.size + vm.tools.size
    LaunchedEffect(total, vm.messages.lastOrNull()?.text?.length) {
        if (total > 0 && state.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= total - 3 } != false) {
            state.scrollToItem(total - 1)
            val layout = state.layoutInfo
            layout.visibleItemsInfo.lastOrNull()?.let { last ->
                val overflow = last.offset + last.size + layout.afterContentPadding - layout.viewportEndOffset
                if (overflow > 0) state.scrollBy(overflow.toFloat())
            }
        }
    }
    Column(modifier.fillMaxSize().imePadding()) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = state,
            contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (total == 0) item {
                Text("Womit kann ich dir helfen?", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 20.dp))
            }
            items(vm.messages) { item ->
                if (item.role == "user") {
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
                        Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.large) {
                            Text(item.text, Modifier.widthIn(max = 540.dp).padding(14.dp))
                        }
                        if (item.id != null) Row {
                            TextButton(onClick = { vm.edit(item) }, enabled = !vm.busy) { Text("Bearbeiten") }
                            TextButton(onClick = { vm.resend(item) }, enabled = !vm.busy) { Text("Erneut senden") }
                        }
                    }
                } else {
                    if (item.text.isNotBlank()) Markdown(item.text)
                    for (picture in item.bilder) {
                        val bitmap by produceState<Bitmap?>(null, picture.path) { value = vm.loadImage(picture.path) }
                        bitmap?.let { Image(it.asImageBitmap(), picture.title, Modifier.fillMaxWidth(), contentScale = ContentScale.FillWidth) }
                    }
                }
            }
            items(vm.tools, key = { "tool:" + it.optString("id") }) { tool ->
                var details by remember { mutableStateOf(false) }
                Surface(onClick = { details = !details }, shape = MaterialTheme.shapes.medium,
                    color = MaterialTheme.colorScheme.surfaceContainer) {
                    ListItem(supportingContent = if (details) ({ Text(tool.string("error") ?: when (tool.optString("status")) {
                            "running" -> "Läuft"
                            "completed" -> "Abgeschlossen"
                            "error" -> "Fehlgeschlagen"
                            else -> "Wartet"
                        }) }) else null) { Text(tool.string("title") ?: tool.optString("name", "Werkzeug")) }
                }
            }
        }
        Surface(tonalElevation = 2.dp) {
            Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (vm.editing != null) TextButton(onClick = vm::cancelEdit) { Text("Bearbeiten abbrechen") }
                @Composable fun Nachricht(field: Modifier) {
                    OutlinedTextField(vm.draft, { vm.draft = it }, modifier = field,
                        label = { Text(if (vm.editing != null) "Nachricht bearbeiten" else "Nachricht") },
                        maxLines = if (compact) 2 else 5)
                }
                if (!compact) Nachricht(Modifier.fillMaxWidth())
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onDictate, enabled = !vm.busy) {
                        Symbol(if (dictating) R.drawable.symbol_stop else R.drawable.symbol_mic, if (dictating) "Diktat beenden" else "Diktieren")
                    }
                    if (compact) Nachricht(Modifier.weight(1f)) else Spacer(Modifier.weight(1f))
                    if (compact) {
                        IconButton(onClick = { if (vm.busy) vm.stop() else vm.sendDraft() },
                            enabled = if (vm.busy) vm.active != null else vm.online && vm.draft.isNotBlank()) {
                            if (vm.busy) Symbol(R.drawable.symbol_stop, "Stopp") else Symbol(R.drawable.symbol_send, "Senden")
                        }
                    } else if (vm.busy) FilledTonalButton(onClick = vm::stop, enabled = vm.active != null) { Text("Stopp") }
                    else Button(onClick = vm::sendDraft, enabled = vm.online && vm.draft.isNotBlank()) {
                        Symbol(R.drawable.symbol_send, null); Spacer(Modifier.width(8.dp)); Text("Senden")
                    }
                }
            }
        }
    }
}

@Composable
private fun Vorschau(vm: JarvisModel, modifier: Modifier) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Auswahl("Vorschauquelle", listOf(Quelle("", "Automatisch")) + vm.sources, vm.selectedSource, vm::selectSource)
        OutlinedButton(onClick = vm::refreshSources, enabled = vm.online) {
            Symbol(R.drawable.symbol_refresh, null); Spacer(Modifier.width(8.dp)); Text("Quellen aktualisieren")
        }
        val frame = vm.frame
        if (frame != null) Image(frame.asImageBitmap(), "Live-Vorschau", Modifier.fillMaxWidth(), contentScale = ContentScale.FillWidth)
        else Text("Hier erscheint das Bild, sobald Jarvis einen Tab oder ein Fenster verwendet.")
    }
}

@Composable
private fun Einstellungen(vm: JarvisModel, notifications: () -> Unit, modifier: Modifier) {
    var enabled by remember { mutableStateOf(vm.haptik.enabled) }
    var strength by remember { mutableStateOf(vm.haptik.strength) }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Jarvis am Computer", style = MaterialTheme.typography.titleLarge)
        Auswahl("Chatmodell", vm.models.map { Quelle(it.id, it.name) }, vm.model) { vm.setting("model", it.id) }
        Umschalter("Computer-Steuerung", vm.computer, vm.online) { vm.setting("mode", if (it) "computer" else "browser") }
        Umschalter("Automatische Chattitel", vm.titles, vm.online) { vm.setting("autoChatTitles", it) }
        Umschalter("Live-Vorschau", vm.liveView, vm.online) { vm.setting("liveView", it) }
        HorizontalDivider()
        Text("Haptik", style = MaterialTheme.typography.titleLarge)
        Umschalter("Haptisches Feedback", enabled) { enabled = it; vm.haptik.enabled = it }
        Auswahl("Stärke", Stärke.entries.map { Quelle(it.name, it.title) }, strength.name) {
            strength = Stärke.valueOf(it.id); vm.haptik.strength = strength
        }
        for (kind in Impuls.entries) {
            var active by remember { mutableStateOf(vm.haptik.active(kind)) }
            Umschalter(kind.title, active, enabled) { value -> active = value; vm.haptik.set(kind, value) }
        }
        HorizontalDivider()
        if (Build.VERSION.SDK_INT >= 33) OutlinedButton(onClick = notifications) { Text("Mitteilungen erlauben") }
        TextButton(onClick = vm::forget) { Text("Kopplung auf diesem Handy löschen") }
    }
}

@Composable
private fun Umschalter(title: String, checked: Boolean, enabled: Boolean = true, change: (Boolean) -> Unit) {
    ListItem(trailingContent = { Switch(checked, change, enabled = enabled) }) { Text(title) }
}

@Composable
private fun Auswahl(label: String, options: List<Quelle>, selected: String, choose: (Quelle) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded, onExpandedChange = { expanded = it && options.isNotEmpty() }) {
        OutlinedTextField(options.firstOrNull { it.id == selected }?.name ?: "", {},
            modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable),
            readOnly = true, label = { Text(label) }, trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) })
        ExposedDropdownMenu(expanded, onDismissRequest = { expanded = false }) {
            for (item in options) DropdownMenuItem(text = { Text(item.name) }, onClick = { expanded = false; choose(item) })
        }
    }
}

private val markdownParser = Parser.builder().build()
private fun annotated(node: Node, color: Color): AnnotatedString = buildAnnotatedString {
    fun read(part: Node) {
        fun children() { var child = part.firstChild; while (child != null) { read(child); child = child.next } }
        when (part) {
            is org.commonmark.node.Text -> append(part.literal)
            is Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(part.literal) }
            is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { children() }
            is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { children() }
            is Link -> if (part.destination.startsWith("https://") || part.destination.startsWith("http://"))
                withLink(LinkAnnotation.Url(part.destination, TextLinkStyles(style = SpanStyle(color = color)))) { children() }
                else children()
            is SoftLineBreak, is HardLineBreak -> append("\n")
            else -> children()
        }
    }
    read(node)
}

@Composable
private fun Markdown(raw: String) {
    val document = remember(raw) { markdownParser.parse(raw) }
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        var block = document.firstChild
        while (block != null) {
            when (val value = block) {
                is FencedCodeBlock -> Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainer) {
                    Text(value.literal.trimEnd(), modifier = Modifier.padding(12.dp), fontFamily = FontFamily.Monospace)
                }
                is Heading -> Text(annotated(value, MaterialTheme.colorScheme.primary), style = MaterialTheme.typography.titleMedium)
                is ListBlock -> {
                    var entry = value.firstChild
                    var number = (value as? OrderedList)?.markerStartNumber ?: 1
                    while (entry != null) {
                        val marker = if (value is OrderedList) "${number++}. " else "• "
                        Text(AnnotatedString(marker) + annotated(entry, MaterialTheme.colorScheme.primary))
                        entry = entry.next
                    }
                }
                else -> Text(annotated(value, MaterialTheme.colorScheme.primary))
            }
            block = block.next
        }
    }
}
