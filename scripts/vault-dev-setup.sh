#!/bin/sh
# Enables transit on the dev Vault from docker-compose.yml and creates the
# Ed25519 key the examples sign with. Safe to run more than once.
set -eu

VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
VAULT_TOKEN="${VAULT_TOKEN:-root}"
KEY="${VAULT_KEY_NAME:-hiero-operations}"

for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sf "$VAULT_ADDR/v1/sys/health" >/dev/null && break
    sleep 1
done

curl -s -H "X-Vault-Token: $VAULT_TOKEN" -X POST \
    -d '{"type":"transit"}' "$VAULT_ADDR/v1/sys/mounts/transit" >/dev/null || true
curl -sf -H "X-Vault-Token: $VAULT_TOKEN" -X POST \
    -d '{"type":"ed25519"}' "$VAULT_ADDR/v1/transit/keys/$KEY" >/dev/null

echo "transit key '$KEY' ready at $VAULT_ADDR"
