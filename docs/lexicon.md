# Wortliste für die Spracherkennung

`core/src/lexicon.ts` korrigiert jeden fertigen STT-Text (`final`), bevor er an das Modell geht. Eingebaut sind bekannte Verhörer
(Systemeinstellungen, Tab, Jarvis, Gemini, YouTube, Claude …). Eigene Ergänzungen in `~/.jarvis3/lexicon.json`
(wird bei Änderung automatisch neu gelesen, kaputte Datei wird ignoriert):

```json
{
  "begriffe": ["Zettelkasten", "Obsidian"],
  "ersetzungen": [{ "von": "\\bhey jarvis wach auf\\b", "nach": "Jarvis aufwachen" }]
}
```

- `begriffe`: Wörter ab 6 Buchstaben; knappe Verhörer (1 Buchstabe, bei Wörtern ab 12 Zeichen 2) werden darauf korrigiert.
- `ersetzungen`: Regex (Flags `giu`) → Text, `$1` usw. erlaubt. Für Umlaute statt `\b` lieber `(?<![\p{L}\d])` verwenden.
- Jede Korrektur steht im Voice-Log als „Wortliste: alt → neu“.
