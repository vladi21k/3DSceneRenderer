#!/usr/bin/env bash
# Fetch MPFB2 (MakeHuman for Blender) and the MakeHuman CC0 system assets into docker/mh/,
# then build the tramline-mh image used by tools/blender/mh_*.py (run with TRAM_TOOLS_IMAGE=tramline-mh tools/dk ...).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/docker/mh"
curl -fL -C - --retry 8 -o "$ROOT/docker/mh/system_assets.zip" "http://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip"
curl -fL --retry 8 -o "$ROOT/docker/mh/mpfb.zip" "https://extensions.blender.org/download/sha256:c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad/add-on-mpfb-v2.0.18.zip?repository=%2Fapi%2Fv1%2Fextensions%2F&blender_version_min=4.2.0"
docker build -t tramline-mh:latest -f "$ROOT/docker/Dockerfile.mh" "$ROOT/docker"
