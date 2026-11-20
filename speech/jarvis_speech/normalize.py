"""German number rules from the original Jarvis speech engine."""

import re

from num2words import num2words


_TIME_RE = re.compile(r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b(?:\s*Uhr)?")


def _spell_time(match: re.Match) -> str:
    hour, minute, second = match.group(1), match.group(2), match.group(3)
    words = f"{num2words(int(hour), lang='de')} Uhr"
    if int(minute) != 0:
        words += f" {num2words(int(minute), lang='de')}"
    if second is not None and int(second) != 0:
        words += f" und {num2words(int(second), lang='de')} Sekunden"
    return words
_DATE_RE = re.compile(r"\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b")
_NUMBER_RE = re.compile(r"(?<!\d\.)(?<!\w)(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?(?!\w)(?!\.\d)")

_MONTH_NAMES = {
    1: "Januar", 2: "Februar", 3: "März", 4: "April", 5: "Mai", 6: "Juni",
    7: "Juli", 8: "August", 9: "September", 10: "Oktober", 11: "November", 12: "Dezember",
}

_DATE_WORDS_RE = re.compile(
    r"\b(?:((?i:am|an|den|dem|vom|zum|ab|seit))\s+)?(\d{1,2})\.\s*("
    + "|".join(_MONTH_NAMES.values())
    + r")\b(?:\s+(\d{4}))?"
)


def _spell_date_words(match: re.Match) -> str:
    lead = match.group(1)
    day = int(match.group(2))
    month_name = match.group(3)
    year = match.group(4)
    if not 1 <= day <= 31:
        return match.group(0)
    day_words = num2words(day, lang="de", to="ordinal")
    if lead:
        day_words = f"{lead} {day_words}n"
    result = f"{day_words} {month_name}"
    if year:
        result += f" {num2words(int(year), lang='de')}"
    return result

_UNIT_PATTERNS = [
    (re.compile(r"(?<=\d)\s*°\s*C\b"), " Grad"),
    (re.compile(r"(?<=\d)\s*°\s*F\b"), " Grad Fahrenheit"),
    (re.compile(r"(?<=\d)\s*°"), " Grad"),
    (re.compile(r"(?<=\d)\s*km/h\b"), " Kilometer pro Stunde"),
    (re.compile(r"(?<=\d)\s*€"), " Euro"),
]

_MATH_SYMBOL_PATTERNS = [
    (re.compile(r"(?<=\d)\s*\+\s*(?=\d)"), " plus "),
    (re.compile(r"\+(?=\d)"), "plus "),
    (re.compile(r"(?<=\d)\s*-\s*(?=\d)"), " minus "),
    (re.compile(r"(?<![\w.,])-(?=\d)"), "minus "),
    (re.compile(r"(?<=\d)\s*[*xX]\s*(?=\d)"), " mal "),
    (re.compile(r"(?<=\d)\s*/\s*(?=\d)"), " durch "),
    (re.compile(r"(?<=\d)\s*=\s*(?=\d)"), " gleich "),
    (re.compile(r"(?<=\d)\s*%"), " Prozent"),
]


_RANGE_RE = re.compile(r"(?<=\d)-(?=\d)")


def _expand_math_symbols_for_speech(text: str) -> str:
    if "=" not in text:
        text = _RANGE_RE.sub(" bis ", text)
    for pattern, replacement in _MATH_SYMBOL_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def _spell_date(match: re.Match) -> str:
    day, month, year = (int(g) for g in match.groups())
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return match.group(0)  # not actually a date (e.g. a version number)
    day_words = num2words(day, lang="de", to="ordinal")
    month_name = _MONTH_NAMES[month]
    year_words = num2words(year, lang="de")
    return f"{day_words} {month_name} {year_words}"


_ISO_DATE_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")


def _spell_iso_date(match: re.Match) -> str:
    year, month, day = (int(g) for g in match.groups())
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return match.group(0)
    return f"{num2words(day, lang='de', to='ordinal')} {_MONTH_NAMES[month]} {num2words(year, lang='de')}"


_DATE_NO_YEAR_RE = re.compile(
    r"\b(am|an|den|der|dem|vom|zum|bis|ab|seit|ist|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)"
    r"(,?\s+)(\d{1,2})\.(\d{1,2})\.(?!\d)",
    re.IGNORECASE,
)


def _spell_date_no_year(match: re.Match) -> str:
    lead, gap, day, month = match.group(1), match.group(2), int(match.group(3)), int(match.group(4))
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return match.group(0)
    ordinal = num2words(day, lang="de", to="ordinal")
    if lead.lower() in ("am", "an", "den", "dem", "vom", "zum", "ab", "seit"):
        ordinal += "n"
    return f"{lead}{gap}{ordinal} {_MONTH_NAMES[month]}"


def _spell_number(match: re.Match) -> str:
    integer_part = match.group(1).replace(".", "")
    fraction = match.group(2)
    try:
        words = num2words(int(integer_part), lang="de")
    except (ValueError, OverflowError):
        return match.group(0)
    if fraction:
        digit_words = " ".join(num2words(int(d), lang="de") for d in fraction)
        words += f" Komma {digit_words}"
    return words


_DIGIT_GROUPS_RE = re.compile(r"(?<!\w)\d{1,15}(?: \d{1,15}){1,}(?!\w)")


def _spell_digit_groups(match: re.Match) -> str:
    digits = match.group(0).replace(" ", "")
    if len(digits) < 6:
        return match.group(0)
    return " ".join(num2words(int(d), lang="de") for d in digits)


def expand_numbers(text: str) -> str:
    expanded = _TIME_RE.sub(_spell_time, text)
    expanded = _DATE_RE.sub(_spell_date, expanded)
    expanded = _ISO_DATE_RE.sub(_spell_iso_date, expanded)
    expanded = _DATE_NO_YEAR_RE.sub(_spell_date_no_year, expanded)
    expanded = _DATE_WORDS_RE.sub(_spell_date_words, expanded)
    for pattern, replacement in _UNIT_PATTERNS:
        expanded = pattern.sub(replacement, expanded)
    expanded = _DIGIT_GROUPS_RE.sub(_spell_digit_groups, expanded)
    expanded = _expand_math_symbols_for_speech(expanded)
    return _NUMBER_RE.sub(_spell_number, expanded)
