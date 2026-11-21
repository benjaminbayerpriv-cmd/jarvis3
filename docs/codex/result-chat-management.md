# Codex Übergabe: Chatverwaltung

In `app/ui` und `core/src/index.ts` umgesetzt:

- Chatnamen werden automatisch aus der ersten Nachricht und der Antwort abgeleitet; nach der Antwort wird der Thementitel aktualisiert. Manuell umbenannte Chats werden dabei nicht überschrieben.
- Suchfeld mit Tabler-Lupe, die auch bei eingeklappter Seitenleiste sichtbar bleibt und diese beim Anklicken öffnet.
- Alle Sidebar-Symbole (Navigation, Suche, Ordner sowie Chat-Aktionen) sind Tabler-Icons. Die Lupe ist im offenen und geschlossenen Zustand an derselben linken Position ausgerichtet.
- Neuer Ordner bleibt in beiden Sidebar-Zuständen sichtbar. Chataktionen sind hinter einem Tabler-Menüicon aufklappbar.
- Beim Anlegen klappt die Sidebar auf und zeigt den neuen Ordner sofort optimistisch an; der Daemon speichert ihn anschließend dauerhaft.
- Ordner erscheinen wie Chatzeilen mit einem Ordnersymbol. Ihre Chats stehen eingerückt darunter; „Zuletzt“ als zusätzliche Überschrift wurde entfernt.
- Ordner erstellen, umbenennen, verschieben und löschen verwenden ein eingebautes Tauri-kompatibles Dialogfenster statt Browser-Prompts.
- Chats umbenennen, löschen, in persistente Ordner einsortieren; Ordner lassen sich erstellen, ein- und ausklappen. Drag-and-drop verschiebt Chats in Ordner.
- Nachrichten bearbeiten oder erneut senden. Der Daemon springt dafür in derselben OpenCode-Sitzung zur ausgewählten Nachricht zurück und setzt den Verlauf dort fort.
- Chat-Metadaten und Ordner werden unter `~/.jarvis3/chat-meta.json` und `~/.jarvis3/chat-folders.json` gespeichert.

Geänderte Dateien: `app/ui/app.js`, `app/ui/index.html`, `app/ui/styles.css`, `app/ui/icons-custom.js`, `core/src/index.ts`.

Keine Tests oder Builds ausgeführt.
