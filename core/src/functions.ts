// Funktions-Befehle: jede Fähigkeit von Jarvis als Schrägstrich-Befehl (/computer, /browser, /recherche …). Die Vorlage sagt dem Modell
// genau, welche Werkzeuge es in welcher Reihenfolge benutzen soll. $ARGUMENTS ist, was der Nutzer hinter den Befehl schreibt.
export interface FunctionCommand {
  name: string; description: string; hint?: string;
  /** schaltet die Computer-Steuerung ein, bevor die Aufgabe startet */
  mode?: "computer";
  template: string;
}

const NO_TASK = "Hat der Nutzer keine Aufgabe genannt, frage ihn in einem Satz, was du tun sollst, und tu noch nichts.";

export const FUNCTION_COMMANDS: FunctionCommand[] = [
  { name: "computer", description: "Computer übernehmen: Programme bedienen (Klicks, Tippen, Fenster)", hint: "Aufgabe", mode: "computer",
    template: `Aufgabe am Computer des Nutzers (die Computer-Steuerung ist eingeschaltet): $ARGUMENTS

Vorgehen:
1. Sag in einem Satz, was du tust, dann los.
2. desktop_windows: das passende Fenster suchen. Fehlt das Programm, mit desktop_open_app öffnen und erneut suchen. Mehrere Monitore: desktop_displays.
3. desktop_scan mit window=ID: Bedienelemente UND sichtbarer Text als Liste. Bedienen mit desktop_click, desktop_type (Feld-ID), desktop_type_text (Text, Rechnungen), desktop_key (nur Kürzel wie cmd+t, return), desktop_scroll.
4. Nach jedem Schritt, der die Ansicht ändert, erneut scannen. Bei Unklarheit desktop_look mit marks=true, bevor du klickst. Nie raten.
5. Melde am Ende nur, was du wirklich beobachtet hast.
Keine Passwörter, keine Käufe oder Überweisungen. ${NO_TASK}` },

  { name: "browser", description: "Webseite im eigenen Browser öffnen und bedienen", hint: "Aufgabe oder Adresse",
    template: `Aufgabe im Browser: $ARGUMENTS

Vorgehen:
1. browser_tab_open öffnet die Seite im eigenen Jarvis-Browser (der Nutzer sieht sie in der Vorschau). Eine Adresse oder ein Suchbegriff genügt.
2. browser_scan zeigt die Bedienelemente als Liste, browser_read den Seitentext. Klicken mit browser_click, Schreiben mit browser_type (submit=true schickt ab), Scrollen mit browser_scroll.
3. Nach jedem Seitenwechsel neu scannen. Bei Auswahllisten browser_type mit dem Text des Eintrags.
4. Tabs, die du nicht mehr brauchst, mit browser_tab_close schließen.
Keine Passwörter eingeben, nichts kaufen. ${NO_TASK}` },

  { name: "chrome", description: "Tabs im echten Google Chrome des Nutzers steuern", hint: "Aufgabe",
    template: `Aufgabe im ECHTEN Google Chrome des Nutzers (nicht im eigenen Browser): $ARGUMENTS

Vorgehen:
1. browser_tab_list zeigt alle Tabs; Chrome-Tabs sind mit chrome=true markiert. Neue Seiten mit browser_tab_open und in="chrome" öffnen (sie landen im Hintergrund in der Tab-Gruppe „Jarvis“).
2. Einen schon offenen Tab des Nutzers nur auf ausdrückliche Bitte mit browser_tab_adopt übernehmen, am Ende browser_tab_release.
3. Bedienen wie gewohnt: browser_scan, browser_click, browser_type, browser_read; bei Bildbedarf browser_look.
Ist die Chrome-Erweiterung nicht verbunden, sag es dem Nutzer, statt auf den eigenen Browser auszuweichen. ${NO_TASK}` },

  { name: "recherche", description: "Im Web recherchieren und mit Quellen antworten", hint: "Frage",
    template: `Recherchiere im Web: $ARGUMENTS

Vorgehen:
1. Suche mit browser_tab_open (z. B. eine Suchmaschine mit dem Suchbegriff) und lies die Treffer mit browser_read. Öffne zwei bis vier gute Quellen, nicht nur eine.
2. Vergleiche die Angaben. Widersprüche und Unsicheres offen sagen. Keine Meinungen oder Kursziele aus Artikeln als Tatsache übernehmen.
3. Antworte kurz, mit den wichtigsten Punkten und den Adressen der Quellen. Geöffnete Tabs am Ende schließen.
${NO_TASK}` },

  { name: "diagramm", description: "Diagramm, Grafik oder Rechnung zeichnen (Python oder HTML)", hint: "Was soll gezeichnet werden",
    template: `Visualisiere: $ARGUMENTS

Vorgehen:
1. Rechnen und Plotten mit visualize_python (numpy, matplotlib, pandas, scipy, sympy). Interaktives, Mermaid-Flussdiagramme, Formeln oder Animationen mit visualize_html.
2. Keine festen Hintergrund- oder Textfarben setzen, die Grafik folgt hell/dunkel des Nutzers.
3. Das Ergebnis erscheint im Chat und in der Vorschau. Sag danach in ein bis zwei Sätzen, was zu sehen ist. Schlägt der Code fehl, korrigiere ihn einmal selbst.
${NO_TASK}` },

  { name: "projekt", description: "Projekte und Chat-Zuordnung verwalten", hint: "Was soll geändert werden",
    template: `Projektverwaltung: $ARGUMENTS

Vorgehen: Rufe zuerst project_list auf (IDs). Dann project_create, project_update (umbenennen, Beschreibung, verschieben), project_delete (Chats bleiben erhalten), project_assign (Chat in ein Projekt legen, projectId=null löst ihn) oder project_analyze. Sag danach kurz, was geändert wurde.
${NO_TASK}` },

  { name: "bildschirm", description: "Bildschirm ansehen und vorlesen, ohne etwas zu bedienen", hint: "Was soll ich ansehen",
    template: `Sieh dir den Bildschirm des Nutzers an, OHNE etwas anzuklicken oder zu tippen: $ARGUMENTS

Vorgehen: desktop_windows zeigt die Fenster, desktop_scan mit window=ID liefert Elemente und sichtbaren Text, desktop_read liest einen Bereich. Nur wenn das nicht reicht, desktop_look. Fasse zusammen, was du siehst; verändere nichts.
${NO_TASK}` },

  { name: "tabs", description: "Offene Tabs auflisten und aufräumen", hint: "z. B. alle schließen",
    template: `Tabs verwalten: $ARGUMENTS

Vorgehen: browser_tab_list zeigt die Tabs des eigenen Browsers und der Chrome-Tab-Gruppe „Jarvis“. Schließe mit browser_tab_close nur Tabs, die zu Jarvis gehören (nie normale Chrome-Tabs des Nutzers). Ohne Auftrag nur die Liste kurz nennen.` },

  { name: "skills", description: "Verfügbare Skills anzeigen oder einen Skill anwenden", hint: "Skill-Name oder Aufgabe",
    template: `Skills: $ARGUMENTS

Vorgehen: skill_list zeigt die aktivierten Skills mit Beschreibung. Passt einer zur Aufgabe, lies ihn mit skill_read und befolge ihn. Ohne Aufgabe: nenne die Skills kurz.` },
];
