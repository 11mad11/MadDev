#!/bin/bash
# Each Linux client container boots, drops the SSH key for its
# assigned user into /root/.ssh/, waits for the gateway's sshd,
# joins the configured mad group, then sleeps forever so the
# tunnel stays up for tests.

set -e
MAD_USER="${MAD_USER:?must set MAD_USER}"
MAD_GROUP="${MAD_GROUP:?must set MAD_GROUP}"
MAD_MODE="${MAD_MODE:-l3}"
GATEWAY_HOST="${GATEWAY_HOST:-gateway}"

log() { echo "[client/$MAD_USER] $*"; }

# ---- SSH key -------------------------------------------------------
mkdir -p /root/.ssh
cp "/init-keys/$MAD_USER" /root/.ssh/id_ed25519
chmod 600 /root/.ssh/id_ed25519
cat > /root/.ssh/config <<EOF
Host $GATEWAY_HOST
    HostName $GATEWAY_HOST
    User $MAD_USER
    StrictHostKeyChecking accept-new
    UserKnownHostsFile /root/.ssh/known_hosts
EOF

# ---- wait for sshd ---------------------------------------------------
log "waiting for $GATEWAY_HOST:22"
for i in $(seq 1 60); do
    if ssh-keyscan -T 2 "$GATEWAY_HOST" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# ---- join -----------------------------------------------------------
log "joining mad group '$MAD_GROUP' as $MAD_USER ($MAD_MODE)"
if [ "$MAD_MODE" = "l2" ]; then
    SUBCMD="tap"
else
    SUBCMD="tun"
fi

mad "$SUBCMD" join "$MAD_USER@$GATEWAY_HOST/$MAD_GROUP" 2>&1 | tee /var/log/mad-client.log &
JOIN_PID=$!

# Wait for the tunnel to come up (MAD_TUN_OK in the log).
for i in $(seq 1 30); do
    if grep -q MAD_TUN_OK /var/log/mad-client.log 2>/dev/null; then
        log "tunnel up"
        break
    fi
    sleep 1
done

log "ready — tail -F /var/log/mad-client.log to follow"
# Keep the container alive while mad join runs.
wait "$JOIN_PID"
