#!/usr/bin/env bash
#
# run-canary.sh — Launcher für den k6/browser-Canary mit Resource-Flags für
# hohe Parallelität (viele gleichzeitige Browser-Sessions).
# =============================================================================
#
# Jede Chromium-Instanz kostet real ~300–700 MB RAM + CPU. Die Flags unten
# machen viele parallele Instanzen erst praktikabel — entscheidend ist
# `disable-dev-shm-usage`: ohne das crasht Chromium unter Last, sobald das
# (oft winzige) /dev/shm vollläuft (v.a. in Containern/Servern).
#
# Modi (ENV MODE, Default: headless):
#   ./run-canary.sh 20              # 20 VUs, headless  → skaliert am besten
#   MODE=xvfb    ./run-canary.sh 20 # 20 VUs, headful im VIRTUELLEN Display
#                                   #   (Server ohne Monitor; braucht xvfb-run)
#   MODE=visible ./run-canary.sh 2  # echte Fenster auf einem Desktop (wenige!)
#
# Faustregel VU-Obergrenze: ~ (freies RAM in GB) / 0.6  Browser-VUs.
# 16 GB frei → grob 25 VUs. Lieber hochtasten und `free -h` / `htop` beobachten.
#
# Weitere ENV: alles aus browser-canary.js (THINK_MIN/MAX, CANARY_OFFSET/RANGE,
# MAX_QUESTIONS) sowie K6_BROWSER_ARGS (überschreibt die Defaults unten).
set -euo pipefail

cd "$(dirname "$0")"

VUS="${1:-2}"
MODE="${MODE:-headless}"

# Chromium-Flags (k6-Format: ohne führende "--", komma-separiert, KEINE Werte
# mit Komma — daher kein window-size hier).
#   disable-dev-shm-usage ............ KRITISCH unter Parallelität (s.o.)
#   disable-gpu / -software-rasterizer  kein (sinnloser) GPU-Overhead
#   no-sandbox ....................... nötig in vielen Server-/Container-Umgebungen
#   disable-background-* ............. kein Throttling/Backgrounding inaktiver Tabs,
#                                      damit alle Sessions gleichmäßig laufen
export K6_BROWSER_ARGS="${K6_BROWSER_ARGS:-disable-dev-shm-usage,disable-gpu,disable-software-rasterizer,no-sandbox,disable-background-timer-throttling,disable-backgrounding-occluded-windows,disable-renderer-backgrounding}"

echo "▶ Canary: MODE=$MODE  VUS=$VUS"
echo "  K6_BROWSER_ARGS=$K6_BROWSER_ARGS"

case "$MODE" in
  headless)
    export K6_BROWSER_HEADLESS=true
    exec k6 run -e VUS="$VUS" browser-canary.js
    ;;
  xvfb)
    # Headful-Renderpfad OHNE echten Monitor (Server). Voraussetzung: xvfb-run.
    if ! command -v xvfb-run >/dev/null 2>&1; then
      echo "xvfb-run fehlt — installieren: apt-get install -y xvfb" >&2
      exit 1
    fi
    export K6_BROWSER_HEADLESS=false
    exec xvfb-run -a -s "-screen 0 1280x1024x24" k6 run -e VUS="$VUS" browser-canary.js
    ;;
  visible)
    # Echte Fenster — nur auf einem lokalen Desktop, und nur für wenige VUs.
    export K6_BROWSER_HEADLESS=false
    exec k6 run -e VUS="$VUS" browser-canary.js
    ;;
  *)
    echo "Unbekannter MODE: '$MODE' (erwartet: headless | xvfb | visible)" >&2
    exit 1
    ;;
esac
