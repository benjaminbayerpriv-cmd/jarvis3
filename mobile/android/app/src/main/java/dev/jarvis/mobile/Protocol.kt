package dev.jarvis.mobile

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject

data class Rechner(val name: String, val host: String, val port: Int)
data class Kopplung(val url: String, val fingerprint: String, val secret: String? = null) {
    companion object {
        fun ausQr(raw: String): Kopplung {
            val json = JSONObject(raw)
            return prüfen(json.getString("url"), json.getString("fingerprint"), json.getString("secret"))
        }

        fun prüfen(raw: String, fingerprint: String, secret: String? = null): Kopplung {
            val url = (if ("://" in raw) raw else "https://$raw").trim().toHttpUrlOrNull()
            require(url != null && url.isHttps && url.encodedPath == "/" &&
                url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null &&
                privateAdresse(url.host)) { "Gib eine lokale IP-Adresse und den Port ein." }
            val pin = fingerprint.filterNot { it.isWhitespace() || it == ':' }.lowercase()
            require(pin.matches(Regex("[a-f0-9]{64}"))) { "Der Zertifikat-Fingerabdruck hat 64 Hex-Zeichen." }
            require(secret == null || secret.matches(Regex("[a-f0-9]{64}"))) { "Ungültiger QR-Code." }
            return Kopplung(url.toString().removeSuffix("/"), pin, secret)
        }
    }
}

fun privateAdresse(value: String): Boolean {
    val host = value.lowercase().substringBefore('%').removePrefix("[").removeSuffix("]")
    if (host == "::1") return true
    if (':' in host) return host.matches(Regex("(f[cd]|fe[89ab])[0-9a-f:]+"))
    val parts = host.split('.').map { it.toIntOrNull() ?: -1 }
    if (parts.size != 4 || parts.any { it !in 0..255 }) return false
    val (first, second) = parts
    return first == 10 || first == 127 || first == 172 && second in 16..31 ||
        first == 192 && second == 168 || first == 169 && second == 254
}

fun message(type: String, vararg fields: Pair<String, Any?>) = JSONObject().put("type", type).apply {
    for ((key, value) in fields) put(key, value ?: JSONObject.NULL)
}

fun JSONObject.string(key: String): String? = optString(key).takeUnless { it.isBlank() || isNull(key) }
fun JSONObject.objects(key: String): List<JSONObject> = optJSONArray(key)?.objects().orEmpty()
fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull(::optJSONObject)
data class Chat(val id: String, val title: String, val folder: String?, val running: Boolean) {
    companion object {
        fun read(json: JSONObject) = Chat(json.getString("id"), json.optString("title", "Chat"), json.string("folder"), json.optBoolean("running"))
    }
}
data class Modell(val id: String, val name: String)
data class Quelle(val id: String, val name: String)
data class Bild(val path: String, val title: String) {
    companion object {
        fun read(json: JSONObject): List<Bild> {
            val id = json.optString("id")
            if (!id.matches(Regex("v[a-z0-9]{6,20}"))) return emptyList()
            val files = json.optJSONArray("files") ?: return emptyList()
            return (0 until files.length()).map(files::getString).filter {
                it.matches(Regex("[a-zA-Z0-9_.-]+\\.(png|jpg|jpeg|webp)", RegexOption.IGNORE_CASE))
            }.map { Bild("/visual/$id/$it", json.optString("title", "Visualisierung")) }
        }
    }
}
data class Beitrag(val id: String?, val role: String, val text: String, val bilder: List<Bild> = emptyList())
