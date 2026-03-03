#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/python3 "$SCRIPT_DIR/sandbox.py"
