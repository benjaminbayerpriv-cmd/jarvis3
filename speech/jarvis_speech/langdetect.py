"""Deutsch oder Englisch? Leichte Erkennung für die Sprachausgabe (kein Modell, nur Funktionswörter)."""

import re

_DE = set("""der die das den dem des ein eine einen einem einer und oder aber nicht ist sind war waren bin bist habe hat haben
ich du er sie es wir ihr mit von zu zum zur auf aus bei nach für über unter auch noch nur schon wie was wer wo wann warum
kann können muss soll will wird werden wurde dass ob wenn dann also mein dein sein ihr hier dort jetzt heute gerade bitte
danke ja nein gut sehr mehr alle alles etwas nichts""".split())
_EN = set("""the a an and or but not is are was were am be been have has had do does did i you he she it we they my your his her
its our their this that these those with from to of in on at by for about into over under also just only still very more all
what who where when why how can could should would will shall may might please thanks yes no good here there now today
something nothing""".split())
_WORD = re.compile(r"[A-Za-zÄÖÜäöüß']+")


def detect_lang(text: str) -> str:
    """'de' oder 'en'; im Zweifel Deutsch (Standardsprache)."""
    if re.search(r"[äöüÄÖÜß]", text):
        return "de"
    words = [w.lower() for w in _WORD.findall(text)]
    de = sum(w in _DE for w in words)
    en = sum(w in _EN for w in words)
    return "en" if en >= 2 and en > de * 1.3 else "de"
