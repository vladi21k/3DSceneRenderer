#!/usr/bin/env bash
# Environment check for a fresh clone: what the app needs, and what the optional tools need.
# It only looks: nothing is installed or changed.
#
#   tools/doctor.sh          check, with the server's default port 8080
#   tools/doctor.sh 9000     check another port
#
# Each line is OK, MISSING or WARN, with a one-line fix under anything that is not OK.
# Exit status: 0 when everything the app needs is there (the optional tools never fail it), 1 otherwise.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PORT="${1:-8080}"
APP_OK=1

ok()   { printf '  %-8s %s\n' OK "$1"; }
miss() { printf '  %-8s %s\n' MISSING "$1"; hint "${2:-}"; }
warn() { printf '  %-8s %s\n' WARN "$1"; hint "${2:-}"; }
hint() { [ -n "$1" ] && printf '  %-8s -> %s\n' '' "$1"; return 0; }
have() { command -v "$1" >/dev/null 2>&1; }
# run with a time limit where `timeout` exists (it is missing on stock macOS)
limit() { local s="$1"; shift; if have timeout; then timeout "$s" "$@"; else "$@"; fi; }

OS="$(uname -s 2>/dev/null || echo unknown)"
DISTRO=""
[ -r /etc/os-release ] && DISTRO="$(. /etc/os-release; echo "${ID:-} ${ID_LIKE:-}")"
case "$OS" in
  Linux)  case "$DISTRO" in *ubuntu*|*debian*) PLATFORM=apt ;; *) PLATFORM=linux ;; esac ;;
  Darwin) PLATFORM=mac ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM=windows ;;
  *) PLATFORM=other ;;
esac
# install hint per platform: pick apt mac windows other
pick() {
  case "$PLATFORM" in
    apt) echo "$1" ;; mac) echo "$2" ;; windows) echo "$3" ;; *) echo "$4" ;;
  esac
}

echo "Tramline environment check ($OS; repository: $ROOT)"
echo
echo "To run the app"

# --- Python 3.8 or newer
PY=""
for c in python3 python py; do
  if have "$c" && "$c" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' >/dev/null 2>&1; then
    PY="$c"; break
  fi
done
if [ -z "$PY" ]; then
  miss "Python 3 (python3) not found" \
    "$(pick 'sudo apt install python3' 'brew install python (or the installer from python.org)' \
            'install Python 3 from python.org, then run the server with: py serve.py' 'install Python 3.8 or newer')"
  APP_OK=0
else
  PYV="$("$PY" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
  if "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
    ok "Python $PYV ($PY)"
  else
    miss "Python $PYV is older than 3.8" \
      "$(pick 'sudo apt install python3 (Ubuntu 20.04 or newer ships 3.8+)' 'brew install python' \
              'install a current Python 3 from python.org' 'install Python 3.8 or newer')"
    APP_OK=0
  fi
fi

# --- repository root and the files the page loads
if [ "$(pwd -P)" = "$ROOT" ]; then
  ok "at the repository root"
else
  warn "you are in $(pwd -P), not at the repository root (the README's commands run from there)" "cd \"$ROOT\""
fi
missing=""
for f in index.html serve.py src/main.js vendor/three/build/three.module.js \
         assets/humans_mh/cast.json assets/humans_mh/cast.bin.gz; do
  [ -f "$ROOT/$f" ] || missing="$missing $f"
done
if [ -z "$missing" ] && [ -n "$PY" ]; then
  # every texture strip cast.json lists must be there too
  missing="$("$PY" - "$ROOT/assets/humans_mh" <<'EOF' 2>/dev/null || echo " assets/humans_mh (cast.json unreadable)"
import json, os, sys
d = sys.argv[1]
doc = json.load(open(os.path.join(d, "cast.json")))
t = doc["textures"]
files = [s[k] for s in t["albedo"] + t["normal"] for k in ("file", "alpha") if s.get(k)]
gone = [f for f in files if not os.path.isfile(os.path.join(d, f))]
print("".join(" assets/humans_mh/" + f for f in gone))
EOF
)"
fi
if [ -z "$missing" ]; then
  size="$(du -sm "$ROOT/assets/humans_mh" 2>/dev/null | cut -f1)"
  ok "app files: index.html, src/, vendor/three/, assets/humans_mh/ (${size:-?} MB of figures)"
else
  miss "app files missing:$missing" "clone the whole repository again: git clone https://github.com/vladi21k/3DSceneRenderer.git"
  APP_OK=0
fi

# --- the server's port
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  warn "port '$PORT' is not a number" "tools/doctor.sh 9000"
else
  busy=0
  if [ -n "$PY" ]; then
    "$PY" - "$PORT" <<'EOF' >/dev/null 2>&1 || busy=1
import socket, sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)   # as serve.py does
s.bind(("", int(sys.argv[1])))
s.close()
EOF
  elif have ss && [ -n "$(ss -ltnH "sport = :$PORT" 2>/dev/null)" ]; then
    busy=1
  fi
  if [ "$busy" = 0 ]; then
    ok "port $PORT is free"
  else
    pid=""
    if have ss; then
      pid="$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"
    fi
    if [ -z "$pid" ] && have lsof; then
      pid="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
    fi
    if [ -n "$pid" ]; then
      cmd="$(ps -o args= -p "$pid" 2>/dev/null | cut -c1-70)"
      case "$cmd" in
        *serve.py*|*http.server*) fix="a server is already running there: open http://localhost:$PORT/, or stop it (Ctrl+C in its terminal)" ;;
        *) fix="stop that process, or serve on another port: python3 serve.py 9000" ;;
      esac
      warn "port $PORT is in use by pid $pid${cmd:+ ($cmd)}" "$fix"
    else
      warn "port $PORT is in use (by a process of another user, or the owner is not visible)" \
        "serve on another port: python3 serve.py 9000"
    fi
  fi
fi

# --- a browser with WebGL 2 and a GPU (only a reminder: this machine may just serve the page)
browser=""
for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge microsoft-edge-stable firefox; do
  if have "$b"; then browser="$b"; break; fi
done
if [ -z "$browser" ] && [ "$PLATFORM" = mac ]; then
  for a in "Google Chrome" "Microsoft Edge" "Firefox" "Chromium"; do
    [ -d "/Applications/$a.app" ] && { browser="$a"; break; }
  done
fi
if [ -z "$browser" ] && [ "$PLATFORM" = windows ]; then
  for p in "/c/Program Files/Google/Chrome/Application/chrome.exe" \
           "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "/c/Program Files/Mozilla Firefox/firefox.exe"; do
    [ -f "$p" ] && { browser="$(basename "$p")"; break; }
  done
fi
if [ -n "$browser" ]; then
  ok "browser: $browser (it needs WebGL 2 on the GPU: chrome://gpu should say \"WebGL2: Hardware accelerated\")"
else
  warn "no desktop browser found here; the page needs one with WebGL 2 on a GPU (Chrome, Edge or Firefox)" \
    "open http://<this machine>:$PORT/ from a machine that has one, or install Chrome (see README Prerequisites)"
fi
gpu=""
if have nvidia-smi; then
  gpu="$(limit 10 nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
fi
if [ -z "$gpu" ] && have lspci; then
  gpu="$(lspci 2>/dev/null | grep -Ei 'vga|3d controller|display controller' | head -1 | sed -E 's/^[^:]*: [^:]*: //' | cut -c1-80)"
fi
if [ -z "$gpu" ] && [ "$PLATFORM" = mac ]; then
  gpu="$(system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model/{print $2; exit}')"
fi
if [ -n "$gpu" ]; then
  ok "GPU: $gpu (recommended: an NVIDIA RTX-class card at 1920x1080; integrated GPUs: add ?q=med or ?q=low)"
else
  warn "could not detect a GPU; the app needs hardware-accelerated WebGL 2" \
    "check chrome://gpu in the browser you will use; on a weak GPU add ?q=low to the URL"
fi

echo
echo "Optional, for the tools (screenshots, videos, asset builds)"

# --- git
if have git; then
  ok "$(git --version)"
else
  miss "git" "$(pick 'sudo apt install git' 'xcode-select --install (or brew install git)' 'install Git for Windows' 'install git')"
fi

# --- Chrome or Chromium on the PATH, under the names tools/shoot.py looks for
chrome=""
for b in google-chrome chromium; do
  if have "$b"; then chrome="$b"; break; fi
done
if [ -n "$chrome" ]; then
  ver="$(limit 20 "$chrome" --version 2>/dev/null | head -1 | sed 's/ *$//')"
  ok "$chrome for tools/shoot.py and tools/record.py${ver:+ ($ver)}"
else
  other=""
  for b in google-chrome-stable chromium-browser; do have "$b" && { other="$b"; break; }; done
  if [ -n "$other" ]; then
    warn "found $other, but tools/shoot.py looks for google-chrome or chromium on the PATH" \
      "sudo ln -s \"$(command -v "$other")\" /usr/local/bin/google-chrome"
  else
    miss "Google Chrome or Chromium (google-chrome / chromium) for tools/shoot.py and tools/record.py" \
      "$(pick 'wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install ./google-chrome-stable_current_amd64.deb' \
              'the capture tools were tested on Linux only (see README Prerequisites)' \
              'the capture tools were tested on Linux only (see README Prerequisites)' \
              'install Google Chrome or Chromium')"
  fi
fi

# --- Docker, usable without sudo
DOCKER_OK=0
if ! have docker; then
  miss "docker (for tools/dk: video encoding, Blender, the figure builds)" \
    "$(pick 'curl -fsSL https://get.docker.com | sudo sh   (see README Prerequisites)' \
            'Docker Desktop; the Docker tools were tested on Linux only' \
            'Docker Desktop with WSL 2; the Docker tools were tested on Linux only' \
            'install Docker Engine: https://docs.docker.com/engine/install/')"
else
  err="$(limit 30 docker info 2>&1 >/dev/null)"; rc=$?
  if [ $rc = 0 ]; then
    DOCKER_OK=1
    ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), usable without sudo"
  elif echo "$err" | grep -qi 'permission denied'; then
    warn "docker is installed but needs sudo (permission denied on the Docker socket)" \
      "sudo usermod -aG docker \$USER, then log out and back in (or run: newgrp docker)"
  elif [ $rc = 124 ]; then
    warn "docker info did not answer within 30 s" "sudo systemctl restart docker"
  else
    warn "docker is installed but the daemon does not answer: $(echo "$err" | grep -v '^$' | tail -1 | cut -d';' -f1 | cut -c1-100)" \
      "sudo systemctl start docker"
  fi
fi

# --- the two images
TOOLS_IMG=0
if [ $DOCKER_OK = 1 ]; then
  for img in tramline-tools:latest tramline-mh:latest; do
    if docker image inspect "$img" >/dev/null 2>&1; then
      sz="$(docker image ls "$img" --format '{{.Size}}' 2>/dev/null | head -1)"
      ok "image $img${sz:+ ($sz)}"
      [ "$img" = tramline-tools:latest ] && TOOLS_IMG=1
    elif [ "$img" = tramline-tools:latest ]; then
      miss "image $img (videos, Blender, ImageMagick)" \
        "docker build -t tramline-tools:latest docker/   (about 3.2 GB; tools/dk also builds it on first use)"
    else
      miss "image $img (only to rebuild the human figures)" \
        "tools/mh_fetch.sh   (after tramline-tools; downloads about 330 MB, see README Commands)"
    fi
  done
else
  warn "images tramline-tools:latest and tramline-mh:latest not checked (docker is not usable)" ""
fi

# --- NVIDIA GPU on the host and inside Docker (only for DK_GPU=1: Cycles renders and bakes)
HOST_GPU=0
if have nvidia-smi && line="$(limit 10 nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -1)" && [ -n "$line" ]; then
  HOST_GPU=1
  ok "nvidia-smi: ${line%%, *}, driver ${line##*, } (needed only for DK_GPU=1)"
else
  miss "nvidia-smi (an NVIDIA driver; only for DK_GPU=1, Cycles on the GPU)" \
    "$(pick 'sudo ubuntu-drivers install, then reboot' 'not available on macOS; DK_GPU=1 is for NVIDIA on Linux' \
            'DK_GPU=1 was tested on Linux only' 'install the NVIDIA driver for your distribution')"
fi
if [ $DOCKER_OK = 1 ] && [ $TOOLS_IMG = 1 ] && [ $HOST_GPU = 1 ]; then
  name="tramline-doctor-$$"
  out="$(limit 60 docker run --rm --name "$name" --gpus all tramline-tools:latest nvidia-smi -L 2>&1)"; rc=$?
  [ $rc = 124 ] && docker rm -f "$name" >/dev/null 2>&1
  if [ $rc = 0 ] && echo "$out" | grep -q '^GPU'; then
    ok "GPU inside Docker: $(echo "$out" | grep '^GPU' | head -1 | sed -E 's/ \(UUID.*//')"
  else
    warn "the GPU is not visible inside Docker ($(echo "$out" | grep -v '^$' | tail -1 | cut -c1-80))" \
      "install the NVIDIA Container Toolkit, then: sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker"
  fi
else
  why=""
  [ $DOCKER_OK = 1 ] || why="docker"
  [ $DOCKER_OK = 1 ] && [ $TOOLS_IMG = 0 ] && why="tramline-tools:latest"
  [ $HOST_GPU = 1 ] || why="${why:+$why and }nvidia-smi"
  why="needs $why"
  warn "GPU inside Docker not checked ($why)" ""
fi

# --- disk space for the images
dir=""
[ $DOCKER_OK = 1 ] && dir="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
[ -n "$dir" ] && [ -e "$dir" ] || dir="$ROOT"
free_kb="$(df -Pk "$dir" 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "$free_kb" ]; then
  free_gb=$(( free_kb / 1048576 ))
  if [ $free_gb -ge 8 ]; then
    ok "disk: $free_gb GB free for $dir (the two images take about 8 GB)"
  else
    warn "disk: only $free_gb GB free for $dir; the two images take about 8 GB" \
      "free some space (docker system prune removes unused images and build cache)"
  fi
else
  warn "disk: could not read the free space for $dir" ""
fi

echo
if [ $APP_OK = 1 ]; then
  echo "The app's requirements are met. Start it with: python3 serve.py   then open http://localhost:8080/"
  exit 0
fi
echo "Something the app needs is missing (the MISSING lines under \"To run the app\")."
exit 1
