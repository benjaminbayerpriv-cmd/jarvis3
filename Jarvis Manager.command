#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null; then
  echo 'Python 3 fehlt. Bitte Python 3 installieren und erneut starten.'
  read -r -p 'Eingabetaste zum Schließen …' _
  exit 1
fi
python3 tools/jarvis-manager/manager.py
