#!/usr/bin/env bash
# checkpoint.sh: periodic progress checkpoint for a long, multi-agent build.
# Every INTERVAL seconds it captures a few views of the app (rotating through a view list, so
# each checkpoint shows something new), saves them as phone-sized JPEGs, and commits the whole
# working tree with a message that says WHAT changed (areas, files, line counts) and which
# STAGE the work is in. A bare "Auto checkpoint 1420" message was judged useless by the user.
#
#   cd <repo> && nohup <skill>/scripts/checkpoint.sh 1200 >> .work/checkpoint.log 2>&1 &
#   echo "M3 lighting rework: exposure and shade colour" > .work/checkpoint_note.txt   (every stage change)
#   touch .work/checkpoint.pause    (skip captures while a timing run needs a quiet machine; rm to resume)
#   kill "$(cat .work/checkpoint.pid)"   (stop; avoid `pkill -f checkpoint.sh`: the pattern also
#                                         matches the calling agent's own shell and kills it)
#   CP_ONCE=1 checkpoint.sh         (one run now, no sleep: also the way to test it)
#
# Files (optional, relative to the repository root; .work/ must be git-ignored):
#   .work/checkpoint_note.txt   first line = the stage, quoted in every commit message
#   .work/checkpoint_views.txt  one URL query per line, e.g. "s=700&tod=0.3&fov=40" ('#' comments);
#                               line 1 is captured every time, the others rotate. Default: one
#                               line, the app's default view.
#   .work/checkpoint_areas.txt  "<shell glob><TAB><area>" per line, first match wins, e.g.
#                               "src/env/*<TAB>lighting/post". Default area: first two path parts.
# Environment: CP_SHOOT (shoot.py; default next to this script), CP_VIEWS_PER_RUN (3),
#   CP_JPEG_QUALITY (85), CP_SHOOT_ARGS (extra shoot.py arguments, e.g. "--settle 4").
# Output: one line per run, "CHECKPOINT <dir> views: ...; console errors: N; commit: <sha> <subject>",
# for a log watcher. Captures run one at a time (parallel headless captures load the GPU and
# skew other agents' timing runs). Commit messages carry no tool or vendor attribution.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "checkpoint.sh: run it inside a git repository" >&2; exit 2; }
cd "$ROOT"
INTERVAL="${1:-1200}"
SHOOT="${CP_SHOOT:-$HERE/shoot.py}"
PER_RUN="${CP_VIEWS_PER_RUN:-3}"
QUALITY="${CP_JPEG_QUALITY:-85}"
WORK="$ROOT/.work"
mkdir -p "$WORK"
git check-ignore -q .work/x 2>/dev/null || echo "checkpoint.sh: WARNING: .work/ is not git-ignored; captures would be committed" >&2
if [ "${CP_ONCE:-0}" != "1" ]; then
  echo $$ > "$WORK/checkpoint.pid"
  trap 'rm -f "$WORK/checkpoint.pid"' EXIT
fi

area_of() {
  local p="$1" glob area
  if [ -f "$WORK/checkpoint_areas.txt" ]; then
    while IFS=$'\t' read -r glob area; do
      [ -z "$glob" ] || [ "${glob:0:1}" = "#" ] && continue
      # shellcheck disable=SC2053
      if [[ "$p" == $glob ]]; then echo "$area"; return; fi
    done < "$WORK/checkpoint_areas.txt"
  fi
  case "$p" in
    */*/*) echo "${p%%/*}/$(echo "$p" | cut -d/ -f2)" ;;
    */*) echo "${p%%/*}" ;;
    *) echo "top level" ;;
  esac
}

views() {
  if [ -f "$WORK/checkpoint_views.txt" ]; then
    grep -v '^[[:space:]]*#' "$WORK/checkpoint_views.txt" | sed '/^[[:space:]]*$/d'
  else
    echo ""
  fi
}

n=0
while true; do
  [ "${CP_ONCE:-0}" = "1" ] || sleep "$INTERVAL"
  n=$((n + 1))
  stamp="$(date +%H%M)"
  dir=".work/shots/auto/$stamp"
  mkdir -p "$dir"
  mapfile -t V < <(views)
  [ "${#V[@]}" -eq 0 ] && V=("")
  pick=(0)
  rest=$(( ${#V[@]} - 1 ))
  for ((j = 0; j < PER_RUN - 1 && j < rest; j++)); do pick+=( $(( (n * (PER_RUN - 1) + j) % rest + 1 )) ); done
  shown=() errs=0 fails=0
  if [ -f "$WORK/checkpoint.pause" ]; then
    shown=("none (paused)")
  else
    k=0
    for i in "${pick[@]}"; do
      v="${V[$i]}"
      k=$((k + 1))
      # shellcheck disable=SC2086
      timeout 600 python3 "$SHOOT" --root "$ROOT" --params "$v" --out "$dir/view$k.jpg" --quality "$QUALITY" \
        --settle 4 --timeout 300 ${CP_SHOOT_ARGS:-} > "$dir/view$k.log" 2>&1
      grep -q "^ready=True" "$dir/view$k.log" || fails=$((fails + 1))
      errs=$(( errs + $(grep -c '^\[error\]\|^\[exception\]' "$dir/view$k.log") ))
      shown+=("${v:-default}")
    done
  fi
  views_txt="$(printf '%s; ' "${shown[@]}")"; views_txt="${views_txt%; }"
  status="console errors: $errs$([ "$fails" -gt 0 ] && echo ", NOT READY in $fails capture(s)")"
  git add -A >/dev/null 2>&1
  if git diff --cached --quiet; then
    echo "CHECKPOINT $dir views: $views_txt; $status; no changes; HEAD: $(git log --oneline -1 2>/dev/null | cut -c1-80)"
    [ "${CP_ONCE:-0}" = "1" ] && break || continue
  fi
  note="$(head -n1 "$WORK/checkpoint_note.txt" 2>/dev/null)"; note="${note:-work in progress}"
  declare -A files=() adds=() dels=() count=()
  while IFS=$'\t' read -r a d p; do
    [ -z "$p" ] && continue
    ar="$(area_of "$p")"
    count[$ar]=$(( ${count[$ar]:-0} + 1 ))
    if [ "${count[$ar]}" -le 12 ]; then files[$ar]="${files[$ar]:+${files[$ar]}, }${p##*/}"; fi
    if [ "$a" != "-" ]; then adds[$ar]=$(( ${adds[$ar]:-0} + a )); dels[$ar]=$(( ${dels[$ar]:-0} + d )); fi
  done < <(git diff --cached --numstat)
  mapfile -t AREAS < <(printf '%s\n' "${!files[@]}" | sort)
  {
    echo "Checkpoint $(date +%H:%M): $(printf '%s, ' "${AREAS[@]}" | sed 's/, $//')"
    echo
    echo "Stage: $note"
    echo
    for ar in "${AREAS[@]}"; do
      more=$(( ${count[$ar]} - 12 ))
      echo "- $ar (+${adds[$ar]:-0}/-${dels[$ar]:-0}): ${files[$ar]}$([ "$more" -gt 0 ] && echo " and $more more")"
    done
    echo
    echo "$(git diff --cached --shortstat | sed 's/^ //'). Views captured ($dir): $views_txt; $status."
  } > "$WORK/checkpoint_msg.txt"
  git commit -q -F "$WORK/checkpoint_msg.txt" >/dev/null 2>&1
  unset files adds dels count
  echo "CHECKPOINT $dir views: $views_txt; $status; commit: $(git log --oneline -1 | cut -c1-90)"
  [ "${CP_ONCE:-0}" = "1" ] && break
done
