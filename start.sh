#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p data

exec docker compose up -d
