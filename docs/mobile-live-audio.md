# Folgeauftrag für Live-Sprache am Handy

Die Pixel-App nutzt zunächst lokale Android-Spracherkennung. Ein Diktat landet als Text im Eingabefeld und wird erst über „Senden“ zum Chat. Der vollständige Live-Modus braucht einen eigenen Audioeingang und eine eigene Ausgabe im Sprachdienst.

Dafür soll Jarvis die Audioverbindung an ein gekoppeltes Gerät und eine laufende Sprachsitzung binden. Das Handy sendet 16-kHz-Mono-PCM mit Sequenznummern und kleinen Puffern über den authentifizierten LAN-WebSocket. Der Daemon reicht die Daten intern an den Sidecar weiter. Der Sidecar gibt synthetisierte Segmente mit Abtastrate und Sequenznummer zurück. Ein Schalter legt die Ausgabe am Handy oder Computer fest. Stopp, Widerruf, Verbindungsabbruch und App-Hintergrund müssen Aufnahme und Wiedergabe beenden. Getrennte Tests decken Überlastung, Mikrofonwechsel, Handy-Lautsprecherecho und paralleles Diktat ab.
