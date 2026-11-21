"""Zentrales Fehler-Log (docs/errors.md): gleiche Dateien wie core/src/errorlog.ts.

Ein JSON pro Fehler in ~/.jarvis3/errors/<id>.json. Gleiche Fehler werden gezählt statt doppelt gespeichert.
"""

from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import traceback


def error_dir():
    return Path(os.environ.get("JARVIS_ERRORS_DIR") or Path.home() / ".jarvis3" / "errors")


def fnv(text):
    """FNV-1a (64 bit), identisch zur TypeScript- und Rust-Fassung."""
    h = 0xCBF29CE484222325
    for b in text.encode("utf-8"):
        h = ((h ^ b) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"[:12]


def error_id(category, source, message):
    return fnv(f"{category}|{source}|{re.sub(r'[0-9]+', '#', message)[:300]}")


def record(category, source, message, context=None, stack=None):
    """Schreibt oder zählt einen Fehler. Wirft nie."""
    try:
        directory = error_dir()
        directory.mkdir(parents=True, exist_ok=True)
        message = str(message)[:2000] or "Unbekannter Fehler"
        entry_id = error_id(category, source, message)
        path = directory / f"{entry_id}.json"
        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        old = {}
        if path.exists():
            try:
                old = json.loads(path.read_text("utf-8"))
            except ValueError:
                old = {}
        entry = {
            "id": entry_id, "category": category, "source": source, "message": message,
            "context": context or {}, "stack": (stack or old.get("stack") or None),
            "firstSeen": old.get("firstSeen", now), "lastSeen": now, "count": old.get("count", 0) + 1,
        }
        if old.get("screenshot"):
            entry["screenshot"] = old["screenshot"]
        path.write_text(json.dumps(entry, ensure_ascii=False, indent=2, default=str), "utf-8")
        return entry_id
    except Exception:  # noqa: BLE001 – das Log darf keinen Absturz auslösen
        return None


class ErrorLogHandler(logging.Handler):
    """Leitet LOG.error/LOG.exception des Sidecars ins Fehler-Log."""

    def __init__(self):
        super().__init__(level=logging.ERROR)

    def emit(self, rec):
        stack = "".join(traceback.format_exception(*rec.exc_info))[-4000:] if rec.exc_info else None
        detail = f": {rec.exc_info[1]}" if rec.exc_info and rec.exc_info[1] else ""
        record("speech", f"speech/{rec.name.rsplit('.', 1)[-1]}", rec.getMessage() + detail,
               {"logger": rec.name, "where": f"{rec.pathname}:{rec.lineno}"}, stack)
