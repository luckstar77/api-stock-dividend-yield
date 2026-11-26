#!/usr/bin/env bash
# Deploys the API on the server. CI runs it over SSH (.github/workflows/ci.yml):
#   ssh user@host "DEPLOY_SHA=<commit> APP_DIR=<dir> bash -s" < deploy/deploy.sh
#
# 1. Fast-forwards the server checkout to DEPLOY_SHA (stops if the checkout has local changes or has diverged).
# 2. npm ci, npm test (builds build/ and runs the unit tests), pm2 restart, then waits for GET /v1/health.
# 3. When anything after the fast-forward fails, goes back to the previous commit, rebuilds it and restarts.
#
# The daily sync (deploy/stock-dividend-sync.service) runs build/sync.js from this same directory, which is why
# a failed deploy must not leave build/ half-built. A sync that starts while npm ci runs fails and systemd runs it
# again 30 minutes later.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/stock-dividend-yield/api-stock-dividend-yield}"
DEPLOY_SHA="${DEPLOY_SHA:?DEPLOY_SHA is required}"
DEPLOY_BRANCH="master"
PM2_APP="${PM2_APP:-stock}"
NODE_VERSION="20"
HEALTH_URL="http://127.0.0.1:${PORT:-3000}/v1/health"
HEALTH_ATTEMPTS=15
HEALTH_INTERVAL_SECONDS=2

log() {
    echo "[deploy] $*"
}

fail() {
    echo "[deploy] $*" >&2
    exit 1
}

PREV=""
MERGED=false

rollback() {
    local status=$?
    if [ "$status" -ne 0 ] && [ "$MERGED" = true ]; then
        set +e
        echo "[deploy] failed (exit $status); rolling back to $PREV" >&2
        git reset --hard "$PREV" && npm ci && npm run build && "$PM2_BIN" restart "$PM2_APP"
        echo "[deploy] rollback finished (exit $?)" >&2
    fi
    exit "$status"
}

main() {
    # nvm does not run under `set -u`. pm2 may have been installed under the default Node version, so look for it first.
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    set +u
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    PM2_BIN="${PM2_BIN:-$(command -v pm2 || true)}"
    nvm use "$NODE_VERSION" >/dev/null
    set -u
    PM2_BIN="${PM2_BIN:-$(command -v pm2 || true)}"
    [ -n "$PM2_BIN" ] || fail "pm2 not found"
    log "node $(node -v), pm2 at $PM2_BIN"

    cd "$APP_DIR"
    [ "$(git rev-parse --abbrev-ref HEAD)" = "$DEPLOY_BRANCH" ] || fail "$APP_DIR is not on $DEPLOY_BRANCH"
    git diff --quiet && git diff --cached --quiet || fail "$APP_DIR has local changes; commit or discard them first"

    PREV="$(git rev-parse HEAD)"

    trap rollback EXIT

    log "$PREV -> $DEPLOY_SHA in $APP_DIR"
    git fetch origin "$DEPLOY_BRANCH"
    git merge --ff-only "$DEPLOY_SHA"
    MERGED=true

    npm ci
    npm test
    "$PM2_BIN" restart "$PM2_APP"

    for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
        if curl -fsS --max-time 5 "$HEALTH_URL"; then
            echo
            log "healthy after $attempt attempt(s); deployed $DEPLOY_SHA"
            exit 0
        fi
        sleep "$HEALTH_INTERVAL_SECONDS"
    done
    fail "$HEALTH_URL did not answer OK"
}

# The script itself arrives on stdin; keep the commands it runs from reading the rest of it.
main < /dev/null
