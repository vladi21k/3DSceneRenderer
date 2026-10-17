#!/usr/bin/env bash
# Periodic progress checkpoint: capture a few views, convert to JPEG, commit everything.
# Prints one "CHECKPOINT <dir>" line per run (consumed as a progress notification).
#   tools/checkpoint.sh [interval_seconds]
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERVAL="${1:-1200}"
cd "$ROOT"
n=0
while true; do
  sleep "$INTERVAL"
  n=$((n + 1))
  stamp="$(date +%H%M)"
  dir=".work/shots/auto/$stamp"
  mkdir -p "$dir"
  # rotate through route positions / times of day so each checkpoint shows something new
  S=(25 700 1450 2440 3300 4100 5000 5600)
  T=(0.1 0.3 0.55 0.85 0.2 0.45 0.65 0.95)
  i=$(( n % ${#S[@]} )); j=$(( (n + 3) % ${#S[@]} ))
  python3 tools/shoot.py --out "$dir/default.png" --params "speed=0" --settle 4 --timeout 250 > "$dir/a.log" 2>&1 &
  python3 tools/shoot.py --out "$dir/view1.png" --params "speed=0&s=${S[$i]}&tod=${T[$i]}" --settle 4 --timeout 250 > "$dir/b.log" 2>&1 &
  python3 tools/shoot.py --out "$dir/view2.png" --params "speed=0&s=${S[$j]}&tod=${T[$j]}&fov=40" --settle 4 --timeout 250 > "$dir/c.log" 2>&1 &
  wait
  for f in "$dir"/*.png; do
    [ -f "$f" ] && tools/dk convert "$f" -resize 1600x -quality 84 "${f%.png}.jpg" >/dev/null 2>&1
  done
  errs=$(grep -h -c "\[error\]\|\[exception\]" "$dir"/*.log 2>/dev/null | paste -sd+ | bc 2>/dev/null || echo "?")
  git add -A >/dev/null 2>&1
  git commit -qm "Auto checkpoint $stamp" >/dev/null 2>&1
  echo "CHECKPOINT $dir views: default, s=${S[$i]} tod=${T[$i]}, s=${S[$j]} tod=${T[$j]} fov40; console errors: $errs; commit: $(git log --oneline -1 | cut -c1-60)"
done
