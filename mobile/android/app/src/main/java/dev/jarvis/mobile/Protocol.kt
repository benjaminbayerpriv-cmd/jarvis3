package dev.jarvis.mobile

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
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
