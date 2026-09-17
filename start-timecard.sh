#!/bin/sh
# Linux / macOS launcher
cd "$(dirname "$0")" && exec python3 run.py "$@"
