#!/bin/sh
# One-time setup for the Tabloom listener (voice intake). Needs Python 3.10+ and ffmpeg on PATH.
# Creates tools/voice/.venv and downloads the speech models (about 600 MB with PyTorch; no account or token).
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
"$PY" -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q faster-whisper numpy scipy scikit-learn librosa torch webrtcvad-wheels soundfile
.venv/bin/pip install -q --no-deps resemblyzer
.venv/bin/python -c "import listen; listen.models()" && echo "Listener installed. Start it with: npm run listen"
