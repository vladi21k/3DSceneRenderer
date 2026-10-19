#!/usr/bin/env bash
# Periodic progress checkpoint: capture a few views, convert to JPEG, commit everything with a
# message that says what changed (areas, files, line counts) and which stage the work is in.
# The stage comes from .work/checkpoint_note.txt (one line, updated as the work moves on).
# Prints one "CHECKPOINT <dir>" line per run (consumed as a progress notification).
#   tools/checkpoint.sh [interval_seconds]
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERVAL="${1:-1200}"
cd "$ROOT"
n=0
area_of() {
  case "$1" in
    src/env/*) echo "lighting/post" ;;
    src/materials/*|tools/textures/*) echo "materials" ;;
    src/world/street*) echo "street" ;;
    src/world/buildings*|src/world/facadePlan.js) echo "buildings" ;;
    src/world/facades*) echo "facades" ;;
    src/world/ironwork*) echo "ironwork" ;;
    src/world/vegetation*) echo "trees" ;;
    src/world/catenary*) echo "catenary/lamps" ;;
    src/world/furniture*) echo "street furniture" ;;
    src/ride/*|src/style.css) echo "ride/camera/trams" ;;
    src/crowd/humans*|tools/blender/mh_*|tools/blender/humans_*|assets/humans_mh/*|docker/Dockerfile.mh) echo "people figures" ;;
    src/crowd/*) echo "crowd behaviour" ;;
    src/main.js|src/core/*|src/world/route.js|src/world/layout.js|src/world/streaming.js|index.html|serve.py) echo "core" ;;
    docs/*) echo "docs" ;;
    tools/*) echo "tools" ;;
    *) echo "other" ;;
  esac
}
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
  timeout 400 python3 tools/shoot.py --out "$dir/default.png" --params "speed=0" --settle 4 --timeout 250 > "$dir/a.log" 2>&1 &
  timeout 400 python3 tools/shoot.py --out "$dir/view1.png" --params "speed=0&s=${S[$i]}&tod=${T[$i]}" --settle 4 --timeout 250 > "$dir/b.log" 2>&1 &
  timeout 400 python3 tools/shoot.py --out "$dir/view2.png" --params "speed=0&s=${S[$j]}&tod=${T[$j]}&fov=40" --settle 4 --timeout 250 > "$dir/c.log" 2>&1 &
  wait
  for f in "$dir"/*.png; do
    [ -f "$f" ] && tools/dk convert "$f" -resize 1600x -quality 84 "${f%.png}.jpg" >/dev/null 2>&1
  done
  errs=$(grep -h -c "\[error\]\|\[exception\]" "$dir"/*.log 2>/dev/null | paste -sd+ | bc 2>/dev/null || echo "?")
  git add -A >/dev/null 2>&1
  if git diff --cached --quiet; then
    echo "CHECKPOINT $dir views: default, s=${S[$i]} tod=${T[$i]}, s=${S[$j]} tod=${T[$j]} fov40; console errors: $errs; no changes; HEAD: $(git log --oneline -1 | cut -c1-70)"
    continue
  fi
  note="$(head -n1 .work/checkpoint_note.txt 2>/dev/null)"; note="${note:-work in progress}"
  declare -A files=() adds=() dels=()
  while IFS=$'\t' read -r a d p; do
    [ -z "$p" ] && continue
    ar="$(area_of "$p")"; b="${p##*/}"
    files[$ar]="${files[$ar]:+${files[$ar]}, }$b"
    [ "$a" != "-" ] && adds[$ar]=$(( ${adds[$ar]:-0} + a )) && dels[$ar]=$(( ${dels[$ar]:-0} + d ))
  done < <(git diff --cached --numstat)
  areas="$(printf '%s\n' "${!files[@]}" | sort | paste -sd, | sed 's/,/, /g')"
  stat="$(git diff --cached --shortstat | sed 's/^ //')"
  {
    echo "Checkpoint $(date +%H:%M): ${areas}"
    echo
    echo "Stage: ${note}"
    echo
    for ar in $(printf '%s\n' "${!files[@]}" | sort | tr ' ' '_'); do
      k="${ar//_/ }"
      echo "- ${k} (+${adds[$k]:-0}/-${dels[$k]:-0}): ${files[$k]}"
    done
    echo
    echo "${stat}. Views captured (.work/shots/auto/${stamp}): default, s=${S[$i]} tod=${T[$i]}, s=${S[$j]} tod=${T[$j]} fov 40; console errors: ${errs}."
  } > .work/checkpoint_msg.txt
  git commit -q -F .work/checkpoint_msg.txt >/dev/null 2>&1
  unset files adds dels
  echo "CHECKPOINT $dir views: default, s=${S[$i]} tod=${T[$i]}, s=${S[$j]} tod=${T[$j]} fov40; console errors: $errs; commit: $(git log --oneline -1 | cut -c1-90)"
done
