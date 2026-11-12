#!/bin/sh
# Starts the Tabloom listener on 127.0.0.1:5611 (override with TABLOOM_VOICE_PORT). Use TABLOOM_VOICE_PYTHON to point at another venv.
cd "$(dirname "$0")"
PY="${TABLOOM_VOICE_PYTHON:-.venv/bin/python}"
[ -x "$PY" ] || { echo "Listener not installed. Run: npm run listen:install"; exit 1; }
exec "$PY" listen.py
