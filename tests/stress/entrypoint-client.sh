#!/usr/bin/env bash
# Bind-mounting the host's ~/.ssh fails sshd's strict ownership check
# (uid mismatch). The host dir is bind-mounted read-only at /host-ssh
# and we copy the marc identity into /root/.ssh with proper perms here.

set -e
mkdir -p /root/.ssh
chmod 700 /root/.ssh

if [ -r /host-ssh/id_ed25519 ]; then
    cp /host-ssh/id_ed25519 /root/.ssh/id_ed25519
    chmod 600 /root/.ssh/id_ed25519
    [ -r /host-ssh/id_ed25519.pub ] && cp /host-ssh/id_ed25519.pub /root/.ssh/id_ed25519.pub
fi

cat > /root/.ssh/config <<'EOF'
Host mad
    HostName 167.114.194.173
    User marc
    IdentityFile /root/.ssh/id_ed25519
    StrictHostKeyChecking accept-new
    UserKnownHostsFile /root/.ssh/known_hosts
    ServerAliveInterval 30
    SetEnv MAD_GATEWAY=1
EOF
chmod 600 /root/.ssh/config

exec "$@"
