#!/bin/bash
set -e

cd /Users/admin/Projects/ADE/apps/desktop

# Install deps if node_modules missing or stale
if [ ! -d "node_modules" ] || [ ! -f "node_modules/.package-lock.json" ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Environment ready."
