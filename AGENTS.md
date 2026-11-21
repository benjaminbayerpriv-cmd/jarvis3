# Hinweise für KI-Agenten

Einstieg: `docs/HANDOFF.md` lesen. Antworten an den Nutzer auf Deutsch.

## Fehler-Log zuerst ansehen
Alle Fehler von Daemon, Modellen, Werkzeugen, Sprache, App und Oberfläche stehen in einem Log
(`~/.jarvis3/errors/`, Details in `docs/errors.md`):

```sh
bun core/scripts/errors.ts            # offene Fehler
bun core/scripts/errors.ts show <id>  # Kontext, Stack, Pfad zum markierten Screenshot
```

Wenn du einen Fehler behoben und den Fix überprüft hast, lösche den Eintrag:

```sh
bun core/scripts/errors.ts resolve <id>
```

Damit verschwinden Eintrag und Screenshot. Nur offene Fehler bleiben im Log. Taucht der Fehler wieder auf, wird er neu angelegt.
