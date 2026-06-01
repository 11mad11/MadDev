#!/bin/bash
# Boots the mad gateway container: creates Linux users + groups,
# pre-loads SSH pubkeys (skipping the OTP/enrollment flow), starts
# the privileged daemon, brings up the per-group bridges via
# `mad group create`, then execs sshd.

set -e

log() { echo "[gateway] $*"; }

# ---- groups ---------------------------------------------------------
log "creating groups"
for g in mad mad-users mad-admin ga gb; do
    groupadd -f "$g"
done

# ---- users ----------------------------------------------------------
log "creating users + assigning groups"
declare -A USER_GROUPS=( [alice]=ga [bob]=ga [eve]=ga [frank]=ga [carol]=gb [dave]=gb )
for user in "${!USER_GROUPS[@]}"; do
    if ! id "$user" >/dev/null 2>&1; then
        useradd -m -s /bin/bash -G mad,mad-users "$user"
    fi
    usermod -aG "${USER_GROUPS[$user]}" "$user"

    homedir=$(getent passwd "$user" | cut -d: -f6)
    mkdir -p "$homedir/.ssh"
    cp "/init-keys/${user}.pub" "$homedir/.ssh/authorized_keys"
    chown -R "$user:$user" "$homedir/.ssh"
    chmod 700 "$homedir/.ssh"
    chmod 600 "$homedir/.ssh/authorized_keys"
done

# ---- mad runtime dirs ------------------------------------------------
mkdir -p /run/mad /etc/mad /var/lib/mad
chown root:mad /run/mad /var/lib/mad
chmod 0750 /run/mad /var/lib/mad

# ---- daemon ----------------------------------------------------------
log "starting mad daemon (background)"
mad daemon > /var/log/mad-daemon.log 2>&1 &
DAEMON_PID=$!
sleep 3
if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    log "daemon died on startup — log follows:"
    cat /var/log/mad-daemon.log
    exit 1
fi
log "daemon pid=$DAEMON_PID"

# ---- group subnets ---------------------------------------------------
# Idempotent — re-running the container reuses existing nets.
log "creating group bridges"
mad admin group create ga 10.77.10.0/24 2>&1 | sed 's/^/  /'  || true
mad admin group create gb 10.77.20.0/24 2>&1 | sed 's/^/  /'  || true

# ---- sshd (foreground = container PID 1) ----------------------------
log "starting sshd"
exec /usr/sbin/sshd -D -e
