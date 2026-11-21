// Zentrales Fehler-Log (docs/errors.md): gleiche Dateien wie core/src/errorlog.ts.
// Ein JSON pro Fehler in ~/.jarvis3/errors/<id>.json; gleiche Fehler werden gezählt.
use std::{env, fs, path::PathBuf, time::SystemTime};

use serde_json::{json, Value};

fn error_dir() -> Option<PathBuf> {
    if let Some(dir) = env::var_os("JARVIS_ERRORS_DIR") {
        return Some(PathBuf::from(dir));
    }
    let home = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".jarvis3").join("errors"))
}

/// FNV-1a (64 bit), identisch zur TypeScript- und Python-Fassung.
fn fnv(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")[..12].to_string()
}

pub(crate) fn error_id(category: &str, source: &str, message: &str) -> String {
    let (mut normalized, mut in_digits) = (String::new(), false);
    for ch in message.chars() {
        if ch.is_ascii_digit() {
            if !in_digits {
                normalized.push('#');
            }
        } else {
            normalized.push(ch);
        }
        in_digits = ch.is_ascii_digit();
    }
    let normalized: String = normalized.chars().take(300).collect();
    fnv(&format!("{category}|{source}|{normalized}"))
}

/// ISO-8601 in UTC ohne Zusatzpaket (Tage seit 1970 -> Datum, Algorithmus von H. Hinnant).
fn now_iso() -> String {
    let since = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    let (secs, millis) = (since.as_secs() as i64, since.subsec_millis());
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Schreibt oder zählt einen Fehler. Schlägt still fehl (meldet nur auf stderr): das Log darf nichts abstürzen lassen.
pub(crate) fn record(category: &str, source: &str, message: &str, context: Value) {
    let Some(dir) = error_dir() else { return };
    if let Err(error) = write(&dir, category, source, message, context) {
        eprintln!("Jarvis3: Fehler-Log nicht schreibbar: {error}");
    }
}

fn write(dir: &PathBuf, category: &str, source: &str, message: &str, context: Value) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let id = error_id(category, source, message);
    let path = dir.join(format!("{id}.json"));
    let old: Value = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let now = now_iso();
    let mut entry = json!({
        "id": id, "category": category, "source": source,
        "message": message.chars().take(2000).collect::<String>(),
        "context": context,
        "firstSeen": old.get("firstSeen").cloned().unwrap_or(json!(now)),
        "lastSeen": now,
        "count": old.get("count").and_then(Value::as_u64).unwrap_or(0) + 1,
    });
    if let Some(shot) = old.get("screenshot") {
        entry["screenshot"] = shot.clone();
    }
    fs::write(path, serde_json::to_string_pretty(&entry).unwrap_or_default())
}

/// Panics der Desktop-Hülle landen im Fehler-Log (Kategorie "app").
pub(crate) fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "Panic".into());
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line()));
        record("app", "tauri/panic", &format!("Desktop-Hülle abgestürzt: {message}"), json!({ "where": location }));
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_match_typescript() {
        // Gleiche Werte wie core/src/errorlog.test.ts
        assert_eq!(fnv("abc"), "e71fa2190541");
        assert_eq!(error_id("app", "tauri/x", "Port 7777 belegt"), error_id("app", "tauri/x", "Port 8 belegt"));
    }

    #[test]
    fn iso_time_looks_right() {
        let now = now_iso();
        assert_eq!(now.len(), 24);
        assert!(now.ends_with('Z'));
    }
}
