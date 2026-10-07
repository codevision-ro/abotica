#!/usr/bin/env bash
# Installs or updates Abotica on this machine with Docker.
#
#   curl -fsSL https://raw.githubusercontent.com/codevision-ro/abotica/main/install.sh | bash
#
# Installs Docker when it is missing (Linux), downloads the compose file of the latest release,
# writes .env with fresh secrets on the first run and starts everything. Run it again to update:
# it keeps .env and moves ABOTICA_VERSION to the new release.
#
# Options (or the environment variables in brackets):
#   --domain NAME     public domain served over HTTPS by the bundled Caddy (ABOTICA_DOMAIN);
#                     empty: only this machine, on http://localhost:3000
#   --dir PATH        install folder (ABOTICA_DIR); default /opt/abotica as root, ~/abotica otherwise
#   --version X.Y.Z   release to install (ABOTICA_VERSION); default the latest
#   --yes             no questions: defaults and the values given above
set -euo pipefail

REPO="codevision-ro/abotica"
MIN_COMPOSE="2.23.1"

main() {
  local domain="${ABOTICA_DOMAIN:-}" dir="${ABOTICA_DIR:-}" version="${ABOTICA_VERSION:-}"
  local assume_yes=false domain_given=false
  [ -n "$domain" ] && domain_given=true

  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) domain="${2:-}"; domain_given=true; shift 2 ;;
      --dir) dir="${2:-}"; shift 2 ;;
      --version) version="${2:-}"; shift 2 ;;
      --yes | -y) assume_yes=true; shift ;;
      -h | --help) sed -n '2,16p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) fail "Unknown option: $1" ;;
    esac
  done

  # Questions are read from the terminal, since the script itself comes through stdin with curl | bash.
  local interactive=false
  if [ "$assume_yes" = false ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then interactive=true; fi

  say "Abotica installer"
  need curl

  local os
  os="$(uname -s)"
  case "$os" in
    Linux | Darwin) ;;
    *) fail "Unsupported system: $os. Abotica runs on Linux and macOS (on Windows, inside WSL2)." ;;
  esac

  ensure_docker "$os"

  [ -n "$dir" ] || { if [ "$(id -u)" -eq 0 ]; then dir=/opt/abotica; else dir="$HOME/abotica"; fi; }
  mkdir -p "$dir" 2>/dev/null || sudo_cmd mkdir -p "$dir"
  [ -w "$dir" ] || sudo_cmd chown "$(id -u):$(id -g)" "$dir"
  cd "$dir"

  if [ -z "$version" ]; then
    version="$(latest_version)" || fail "Could not read the latest release of $REPO from GitHub. Pass --version X.Y.Z."
  fi
  version="${version#v}"

  say "Downloading Abotica $version into $dir"
  local tmp
  tmp="$(mktemp)"
  curl -fsSL "https://raw.githubusercontent.com/$REPO/v$version/docker-compose.prod.yml" -o "$tmp" \
    || fail "Release v$version has no docker-compose.prod.yml."
  mv "$tmp" docker-compose.yml

  local fresh=false
  if [ -f .env ]; then
    say "Keeping the existing .env (update)"
    set_env ABOTICA_VERSION "$version"
  else
    if [ "$interactive" = true ] && [ "$domain_given" = false ]; then
      echo
      echo "Domain for Abotica, e.g. abotica.example.com. Its DNS record must point to this server;"
      echo "HTTPS certificates are obtained automatically. Leave empty to use it only on this machine."
      ask domain "Domain"
    fi
    domain="${domain#http://}"
    domain="${domain#https://}"
    domain="${domain%%/*}"
    write_env "$version" "$domain"
    fresh=true
  fi

  say "Pulling the images"
  dc pull --quiet --ignore-buildable
  say "Starting Abotica (the first start builds the sandbox image, a few minutes)"
  dc up -d --remove-orphans

  wait_healthy

  local app_url code
  app_url="$(sed -n 's/^APP_URL=//p' .env)"
  code="$(sed -n 's/^SETUP_CODE=//p' .env)"
  echo
  say "Abotica $version is running"
  if [ "$fresh" = false ]; then
    echo
    echo "  Updated. Open $app_url"
    return 0
  fi
  echo
  echo "  Create your account (the link carries the setup code, which only you have):"
  echo
  echo "    $app_url/signup${code:+?code=$code}"
  echo
  echo "  The first account is the only one. Then connect a model provider under"
  echo "  Settings > AI providers."
  if grep -q '^ABOTICA_DOMAIN=.' .env; then
    local d
    d="$(sed -n 's/^ABOTICA_DOMAIN=//p' .env)"
    echo
    echo "  DNS: $d and *.preview.$d (agents' previews) must point to this server,"
    echo "  and ports 80 and 443 must be open."
  else
    echo
    echo "  Only this machine can open it. From another computer: ssh -L 3000:127.0.0.1:3000 <server>"
  fi
  echo
  echo "  Folder:   $dir (docker-compose.yml, .env, backups/)"
  echo "  Logs:     cd $dir && docker compose logs -f"
  echo "  Update:   run this installer again"
  echo "  Telegram, Ollama and other settings: https://github.com/$REPO/blob/main/DEPLOY.md"
}

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required."; }

sudo_cmd() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else need sudo; sudo "$@"; fi
}

# Docker through sudo when this user cannot reach the daemon (e.g. right after installing Docker,
# before a new login picks up the docker group).
DOCKER=(docker)
dc() { "${DOCKER[@]}" compose "$@"; }

ensure_docker() {
  local os="$1"
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$os" = Darwin ]; then
      fail "Docker is not installed. Install OrbStack (https://orbstack.dev) or Docker Desktop, start it, then run this installer again."
    fi
    say "Installing Docker (get.docker.com)"
    curl -fsSL https://get.docker.com | sudo_cmd sh
    if [ "$(id -u)" -ne 0 ]; then sudo_cmd usermod -aG docker "$(id -un)" || true; fi
  fi

  if ! docker info >/dev/null 2>&1; then
    if [ "$os" = Linux ] && [ "$(id -u)" -ne 0 ] && sudo docker info >/dev/null 2>&1; then
      DOCKER=(sudo docker)
    elif [ "$os" = Linux ]; then
      sudo_cmd systemctl enable --now docker >/dev/null 2>&1 || true
      if docker info >/dev/null 2>&1; then :
      elif [ "$(id -u)" -ne 0 ] && sudo docker info >/dev/null 2>&1; then DOCKER=(sudo docker)
      else fail "Docker is installed but not running."
      fi
    else
      fail "Docker is installed but not running. Start OrbStack or Docker Desktop, then run this installer again."
    fi
  fi

  local compose
  compose="$("${DOCKER[@]}" compose version --short 2>/dev/null)" \
    || fail "Docker Compose v2 is missing (the 'docker compose' plugin)."
  compose="${compose#v}"
  if ! version_ge "$compose" "$MIN_COMPOSE"; then
    fail "Docker Compose $compose is too old: $MIN_COMPOSE or newer is needed. Update Docker, then run this installer again."
  fi
}

version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)" = "$2" ]
}

latest_version() {
  local tag
  tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  [ -n "$tag" ] && printf '%s' "$tag"
}

ask() {
  local var="$1" prompt="$2" answer
  printf '%s: ' "$prompt" > /dev/tty
  IFS= read -r answer < /dev/tty || answer=""
  printf -v "$var" '%s' "$answer"
}

secret_base64() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 32
  else head -c 32 /dev/urandom | base64 | tr -d '\n'; echo
  fi
}

# Hex only: it goes into DATABASE_URL.
secret_hex() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }

set_env() {
  local key="$1" value="$2"
  if grep -q "^$key=" .env; then
    sed -i.bak "s|^$key=.*|$key=$value|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

write_env() {
  local version="$1" domain="$2" app_url preview profiles=""
  if [ -n "$domain" ]; then
    app_url="https://$domain"
    preview="PREVIEW_URL=https://preview.$domain"
    profiles="https"
  else
    app_url="http://localhost:3000"
    preview="# PREVIEW_URL=https://preview.abotica.example.com (default: http://preview.localhost:3100)"
  fi
  umask 077
  cat > .env <<EOF
# Abotica configuration, written by install.sh. Restart after a change: docker compose up -d

# Release of the images. install.sh moves it on update.
ABOTICA_VERSION=$version

# Public address. With a domain, the bundled Caddy (COMPOSE_PROFILES=https) serves it over HTTPS.
ABOTICA_DOMAIN=$domain
APP_URL=$app_url
BETTER_AUTH_URL=$app_url
# Agents' previews at <code>.<host of this URL>; needs the DNS record *.preview.<domain>.
$preview
# Optional services, comma separated: https, ollama.
COMPOSE_PROFILES=$profiles

# Secrets, generated on install. VAULT_KEY encrypts the keys saved in the UI: if it is lost or
# changed, they can no longer be read.
BETTER_AUTH_SECRET=$(secret_base64)
VAULT_KEY=$(secret_base64)
POSTGRES_PASSWORD=$(secret_hex)

# Creating the account needs this code, so nobody else can claim the instance before you do.
# Sign-up closes on its own after the first account.
SETUP_CODE=$(secret_hex)
ALLOW_SIGNUP=true

# Telegram (DEPLOY.md): bot token from @BotFather, then your user id, which the bot sends you.
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=
TELEGRAM_NOTIFY_CHAT_ID=

# Embeddings: openai (needs an OpenAI API key in Settings) or ollama (add ollama to
# COMPOSE_PROFILES and set OLLAMA_BASE_URL=http://ollama:11434).
EMBEDDING_PROVIDER=openai
EOF
  umask 022
}

wait_healthy() {
  local port i
  port="$(sed -n 's/^WEB_PORT=//p' .env)"
  port="${port:-3000}"
  for i in $(seq 1 180); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  warn "Abotica did not answer on port $port after 15 minutes. Check: cd $(pwd) && docker compose ps && docker compose logs"
}

main "$@"
