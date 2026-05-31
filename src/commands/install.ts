import { createCommand } from "@commander-js/extra-typings";
import { hostname } from "os";
import { cmdDef } from "../menu";
import { assertValidName } from "../groups";
import { daemon } from "../daemon/client";

type Scope = "user" | "system";

export interface ForwardingSpec {
    serverHost: string;
    sshUser: string;
    group: string;
    name: string;
    target: string;
    scope: Scope;
}

export interface SshShareSpec {
    serverHost: string;
    sshUser: string;
    group: string;
    deviceName: string;
    techUser: string;
    scope: Scope;
}

function bashHeader(): string {
    return `#!/usr/bin/env bash
set -euo pipefail
log() { printf "  %s %s\\n" "$1" "$2"; }
ok()  { log "·" "$1"; }
new() { log "✦" "$1"; }
`;
}

function sshConfigBlock(serverHost: string, sshUser: string): string {
    return `# mad gateway
Host mad
    HostName ${serverHost}
    User ${sshUser}
    IdentityFile ~/.ssh/id_ed25519
    CertificateFile ~/.ssh/id_ed25519-cert.pub
    ServerAliveInterval 30
    ExitOnForwardFailure yes
`;
}

export function forwardingScript(spec: ForwardingSpec): string {
    assertValidName(spec.group);
    if (!/^[a-z0-9-]{1,32}$/.test(spec.name)) throw new Error(`invalid service name: ${spec.name}`);
    const unitName = `mad-fwd-${spec.group}-${spec.name}.service`;
    const isUser = spec.scope === "user";
    const sshConfig = sshConfigBlock(spec.serverHost, spec.sshUser);

    return `${bashHeader()}
SCOPE="${spec.scope}"
GROUP="${spec.group}"
SVC_NAME="${spec.name}"
TARGET="${spec.target}"
UNIT_NAME="${unitName}"

if [ "$SCOPE" = "user" ]; then
    SSH_CONFIG="$HOME/.ssh/config"
    UNIT_DIR="$HOME/.config/systemd/user"
    SYSTEMCTL=(systemctl --user)
    WANTED_BY="default.target"
    UNIT_USER=""
else
    if [ "$(id -u)" -ne 0 ]; then echo "system scope requires root" >&2; exit 1; fi
    SUDO_REAL_USER="\${SUDO_USER:-root}"
    SSH_CONFIG="/home/$SUDO_REAL_USER/.ssh/config"
    [ "$SUDO_REAL_USER" = "root" ] && SSH_CONFIG="/root/.ssh/config"
    UNIT_DIR="/etc/systemd/system"
    SYSTEMCTL=(systemctl)
    WANTED_BY="multi-user.target"
    UNIT_USER="User=$SUDO_REAL_USER"
fi

mkdir -p "$(dirname "$SSH_CONFIG")" "$UNIT_DIR"

# 1. ssh_config Host mad
if grep -qE "^Host mad\\b" "$SSH_CONFIG" 2>/dev/null; then
    ok "ssh_config Host mad already present in $SSH_CONFIG"
else
    cat >> "$SSH_CONFIG" <<'SSHCFG'

${sshConfig}SSHCFG
    chmod 600 "$SSH_CONFIG"
    new "added Host mad to $SSH_CONFIG"
fi

# 2. systemd unit
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
read -r -d "" UNIT_CONTENT <<UNIT || true
[Unit]
Description=mad forward: $GROUP/$SVC_NAME -> $TARGET
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$UNIT_USER
ExecStart=/usr/bin/ssh -N -R /run/mad/groups/$GROUP/$SVC_NAME.sock:$TARGET \\\\
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \\\\
  -o ExitOnForwardFailure=yes -o BatchMode=yes \\\\
  mad
Restart=on-failure
RestartSec=10

[Install]
WantedBy=$WANTED_BY
UNIT

if [ -f "$UNIT_PATH" ] && [ "$(cat "$UNIT_PATH")" = "$UNIT_CONTENT" ]; then
    ok "unit $UNIT_PATH unchanged"
else
    printf '%s\\n' "$UNIT_CONTENT" > "$UNIT_PATH"
    new "wrote $UNIT_PATH"
fi

# 3. enable
"\${SYSTEMCTL[@]}" daemon-reload
"\${SYSTEMCTL[@]}" enable --now "$UNIT_NAME"

# 4. lingering for user scope
if [ "$SCOPE" = "user" ]; then
    if loginctl show-user "$(id -un)" --property=Linger 2>/dev/null | grep -q "=yes"; then
        ok "lingering already enabled for $(id -un)"
    else
        echo ""
        echo "Run this once so the forward survives logout:"
        echo "    sudo loginctl enable-linger $(id -un)"
    fi
fi

echo ""
echo "mad forward $GROUP/$SVC_NAME -> $TARGET installed."
`;
}

export function sshShareScript(spec: SshShareSpec, caPubkey: string, initialKrlB64: string): string {
    assertValidName(spec.group);
    if (!/^[a-z0-9-]{1,32}$/.test(spec.deviceName)) throw new Error(`invalid device name: ${spec.deviceName}`);
    assertValidName(spec.techUser, "user");
    const fwdUnitName = `mad-ssh-share-${spec.group}.service`;
    const proxyUnitName = `mad-tech-proxy.service`;
    const proxySocket = `/run/mad-tech-proxy.sock`;

    return `${bashHeader()}
# Sets up this device so members of mad group '${spec.group}' can SSH in
# through the mad gateway. Requires root.
if [ "$(id -u)" -ne 0 ]; then echo "must run as root" >&2; exit 1; fi

GROUP="${spec.group}"
DEVICE="${spec.deviceName}"
TECH="${spec.techUser}"
SERVER_HOST="${spec.serverHost}"
SERVER_USER="${spec.sshUser}"
FWD_UNIT="${fwdUnitName}"
PROXY_UNIT="${proxyUnitName}"
PROXY_SOCKET="${proxySocket}"
SCOPE="${spec.scope}"
REAL_USER="\${SUDO_USER:-root}"
REAL_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"

# 0. socat required for the KRL-aware wrapper
if ! command -v socat >/dev/null 2>&1; then
    new "installing socat"
    if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -q socat
    elif command -v dnf >/dev/null 2>&1; then dnf install -y socat
    elif command -v apk >/dev/null 2>&1; then apk add --no-cache socat
    else echo "install socat manually then re-run" >&2; exit 1; fi
fi

# 1. mad CA pubkey (embedded — no network round-trip)
CA_PUBKEY=$(cat <<'PUB'
${caPubkey.trim()}
PUB
)
if [ -f /etc/ssh/mad_ca.pub ] && [ "$(cat /etc/ssh/mad_ca.pub)" = "$CA_PUBKEY" ]; then
    ok "/etc/ssh/mad_ca.pub already current"
else
    printf '%s\\n' "$CA_PUBKEY" > /etc/ssh/mad_ca.pub
    chmod 644 /etc/ssh/mad_ca.pub
    new "wrote /etc/ssh/mad_ca.pub"
    SSHD_CHANGED=1
fi

# 2. initial KRL — signed by mad CA at script-generation time
KRL_B64="${initialKrlB64}"
KRL_TMP=$(mktemp)
printf '%s' "$KRL_B64" | base64 -d > "$KRL_TMP"
if [ -f /etc/ssh/mad_krl ] && cmp -s "$KRL_TMP" /etc/ssh/mad_krl; then
    ok "/etc/ssh/mad_krl already current"
    rm -f "$KRL_TMP"
else
    mv "$KRL_TMP" /etc/ssh/mad_krl
    chmod 644 /etc/ssh/mad_krl
    new "wrote /etc/ssh/mad_krl"
    SSHD_CHANGED=1
fi

# 3. sshd_config snippet (TrustedUserCAKeys + RevokedKeys + Match)
SSHD_SNIPPET=/etc/ssh/sshd_config.d/99-mad-share.conf
read -r -d "" SSHD_CONTENT <<EOF || true
TrustedUserCAKeys /etc/ssh/mad_ca.pub
RevokedKeys /etc/ssh/mad_krl

Match User $TECH
    AuthorizedPrincipalsFile /etc/ssh/principals.%u
EOF
if [ -f "$SSHD_SNIPPET" ] && [ "$(cat "$SSHD_SNIPPET")" = "$SSHD_CONTENT" ]; then
    ok "$SSHD_SNIPPET unchanged"
else
    printf '%s\\n' "$SSHD_CONTENT" > "$SSHD_SNIPPET"
    new "wrote $SSHD_SNIPPET"
    SSHD_CHANGED=1
fi

# 4. tech user
if id "$TECH" >/dev/null 2>&1; then
    ok "user $TECH exists"
else
    useradd -m -s /bin/bash "$TECH"
    new "created user $TECH"
fi

# 5. principals file (the group name = the principal)
PRINCIPALS_FILE=/etc/ssh/principals.$TECH
if [ -f "$PRINCIPALS_FILE" ] && grep -qxE "$GROUP" "$PRINCIPALS_FILE"; then
    ok "$PRINCIPALS_FILE already permits group $GROUP"
else
    {
        if [ -f "$PRINCIPALS_FILE" ]; then cat "$PRINCIPALS_FILE"; fi
        echo "$GROUP"
    } | sort -u > "$PRINCIPALS_FILE.tmp"
    mv "$PRINCIPALS_FILE.tmp" "$PRINCIPALS_FILE"
    chmod 644 "$PRINCIPALS_FILE"
    new "added $GROUP to $PRINCIPALS_FILE"
fi

# 6. root needs an ssh identity to reach the gateway for KRL refresh. Borrow
#    the keys of whoever piped this script to sudo (they're already mad-enrolled,
#    so their cert authenticates them as themselves). Root on this box already
#    has full local access, so this is not a privilege escalation.
mkdir -p /root/.ssh; chmod 700 /root/.ssh
for f in id_ed25519 id_ed25519.pub id_ed25519-cert.pub; do
    if [ -f "$REAL_HOME/.ssh/$f" ] && [ ! -f "/root/.ssh/$f" ]; then
        cp "$REAL_HOME/.ssh/$f" "/root/.ssh/$f"
        chmod 600 "/root/.ssh/$f"
        new "copied $f to /root/.ssh"
    fi
done
ssh-keyscan -H "$SERVER_HOST" 2>/dev/null >> /root/.ssh/known_hosts
sort -u /root/.ssh/known_hosts -o /root/.ssh/known_hosts
chmod 600 /root/.ssh/known_hosts

# 7. /root/.ssh/config with ControlMaster so the KRL-fetch shares the forwarder's tunnel
SSH_CONFIG=/root/.ssh/config
read -r -d "" SSH_CFG <<EOF || true
Host mad
    HostName $SERVER_HOST
    User $SERVER_USER
    IdentityFile /root/.ssh/id_ed25519
    CertificateFile /root/.ssh/id_ed25519-cert.pub
    ServerAliveInterval 30
    ExitOnForwardFailure yes
    ControlMaster auto
    ControlPath /run/mad-cm-%C
    ControlPersist 10m
EOF
if grep -qE "^Host mad\\b" "$SSH_CONFIG" 2>/dev/null; then
    ok "Host mad already in $SSH_CONFIG (not rewritten — edit by hand if it's stale)"
else
    printf '\\n%s\\n' "$SSH_CFG" >> "$SSH_CONFIG"
    chmod 600 "$SSH_CONFIG"
    new "added Host mad to $SSH_CONFIG"
fi

# 8. /usr/local/bin/mad-tech-handler — fetches KRL, then pipes the connection to local sshd
HANDLER=/usr/local/bin/mad-tech-handler
read -r -d "" HANDLER_CONTENT <<'EOF' || true
#!/bin/bash
# Invoked by socat for each incoming tech connection. stdin/stdout are the
# SSH stream from the gateway. We refresh the KRL via the shared ControlMaster
# session before piping through to local sshd, so revocation takes effect
# immediately (gateway is in the data path anyway).
KRL_TMP=$(mktemp)
if timeout 5 ssh -o BatchMode=yes mad ca krl --raw < /dev/null > "$KRL_TMP" 2>/dev/null; then
    if [ -s "$KRL_TMP" ]; then
        install -m 0644 "$KRL_TMP" /etc/ssh/mad_krl
    fi
fi
rm -f "$KRL_TMP"
exec socat - TCP:127.0.0.1:22
EOF
if [ -f "$HANDLER" ] && [ "$(cat "$HANDLER")" = "$HANDLER_CONTENT" ]; then
    ok "$HANDLER unchanged"
else
    printf '%s\\n' "$HANDLER_CONTENT" > "$HANDLER"
    chmod 755 "$HANDLER"
    new "wrote $HANDLER"
fi

# 9. mad-tech-proxy.service — socat listener that invokes the handler per connection
PROXY_UNIT_PATH=/etc/systemd/system/$PROXY_UNIT
read -r -d "" PROXY_UNIT_CONTENT <<EOF || true
[Unit]
Description=mad tech proxy (KRL-aware wrapper around local sshd)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/socat UNIX-LISTEN:$PROXY_SOCKET,fork,mode=0660 EXEC:$HANDLER
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
if [ -f "$PROXY_UNIT_PATH" ] && [ "$(cat "$PROXY_UNIT_PATH")" = "$PROXY_UNIT_CONTENT" ]; then
    ok "$PROXY_UNIT_PATH unchanged"
else
    printf '%s\\n' "$PROXY_UNIT_CONTENT" > "$PROXY_UNIT_PATH"
    new "wrote $PROXY_UNIT_PATH"
fi

# 10. forwarder unit — points at the wrapper's Unix socket, not local :22
if [ "$SCOPE" = "user" ]; then
    UNIT_DIR=/root/.config/systemd/user
    SYSTEMCTL=(systemctl --user)
    WANTED_BY=default.target
else
    UNIT_DIR=/etc/systemd/system
    SYSTEMCTL=(systemctl)
    WANTED_BY=multi-user.target
fi
mkdir -p "$UNIT_DIR"
FWD_UNIT_PATH="$UNIT_DIR/$FWD_UNIT"

read -r -d "" FWD_UNIT_CONTENT <<UNIT || true
[Unit]
Description=mad ssh-share: $DEVICE in group $GROUP
After=$PROXY_UNIT network-online.target
Wants=$PROXY_UNIT network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/ssh -N \\\\
  -R /run/mad/groups/$GROUP/$DEVICE.sock:$PROXY_SOCKET \\\\
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \\\\
  -o ExitOnForwardFailure=yes -o BatchMode=yes \\\\
  mad
Restart=on-failure
RestartSec=10

[Install]
WantedBy=$WANTED_BY
UNIT
if [ -f "$FWD_UNIT_PATH" ] && [ "$(cat "$FWD_UNIT_PATH")" = "$FWD_UNIT_CONTENT" ]; then
    ok "$FWD_UNIT_PATH unchanged"
else
    printf '%s\\n' "$FWD_UNIT_CONTENT" > "$FWD_UNIT_PATH"
    new "wrote $FWD_UNIT_PATH"
fi

# 11. reload + enable
if [ "\${SSHD_CHANGED:-0}" = "1" ]; then
    new "reloading sshd"
    systemctl reload-or-restart ssh 2>/dev/null || systemctl reload-or-restart sshd 2>/dev/null || true
fi
systemctl daemon-reload
systemctl enable --now "$PROXY_UNIT"
"\${SYSTEMCTL[@]}" daemon-reload
"\${SYSTEMCTL[@]}" enable --now "$FWD_UNIT"

echo ""
echo "Device '$DEVICE' is now reachable through mad."
echo "Group $GROUP members SSH in with:"
echo "    ssh -o ProxyCommand='ssh -W /run/mad/groups/$GROUP/$DEVICE.sock mad' $TECH@$DEVICE"
echo "or add to ~/.ssh/config on tech machines:"
echo "    Host $DEVICE"
echo "        ProxyCommand ssh -W /run/mad/groups/$GROUP/$DEVICE.sock mad"
echo "        User $TECH"
echo ""
echo "Every incoming tech connection refreshes /etc/ssh/mad_krl from the gateway"
echo "before sshd runs cert validation, so revocations take effect on next connect."
`;
}

const SCOPE_CHOICES = ["user", "system"] as const;

async function pickScope(ctx: any): Promise<Scope> {
    return await ctx.inquirer.select({
        message: "systemd unit scope",
        choices: [
            { name: "user (~/.config/systemd/user, no root needed; loginctl enable-linger to survive logout)", value: "user" as const },
            { name: "system (/etc/systemd/system, needs root, always-on)", value: "system" as const },
        ],
    });
}

export const installForwarding = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("install").summary("Generate install script: auto-forward a service to mad")
        .argument("<group/name>", "service id, e.g. demo/web")
        .argument("<target>", "local addr:port, e.g. localhost:8000")
        .option("--scope <scope>", "user | system", "user")
        .option("--server-host <host>", "mad server hostname for ssh_config", hostname())
        .option("--server-user <user>", "mad username on the server"),
    async pty(ctx) {
        const group = await ctx.inquirer.input({ message: "Group name" });
        const name = await ctx.inquirer.input({ message: "Service name" });
        const target = await ctx.inquirer.input({ message: "Local target (addr:port)", default: "localhost:8000" });
        const serverHost = await ctx.inquirer.input({ message: "mad server hostname", default: hostname() });
        const scope = await pickScope(ctx);
        const script = forwardingScript({
            group, name, target,
            serverHost,
            sshUser: ctx.username,
            scope,
        });
        ctx.output.write("\n# Pipe the following into `sh` on the client:\n\n");
        ctx.output.write(script + "\n");
        return false;
    },
    async run(ctx, opts, groupSlashName, target) {
        const [group, name] = groupSlashName.split("/");
        if (!group || !name) throw new Error("expected <group>/<name>");
        const script = forwardingScript({
            group, name, target,
            serverHost: opts.serverHost!,
            sshUser: (opts.serverUser as string | undefined) ?? ctx.username,
            scope: (opts.scope as Scope),
        });
        ctx.output.write(script);
    },
});

export const installSshShare = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("install-ssh").summary("Generate install script: share this device's sshd through mad")
        .argument("<group/device>", "e.g. demo/dev01")
        .option("--tech-user <name>", "Linux user techs will log in as", "mad-tech")
        .option("--scope <scope>", "user | system", "system")
        .option("--server-host <host>", "mad server hostname", hostname())
        .option("--server-user <user>", "mad username on the server"),
    async pty(ctx) {
        const groupDevice = await ctx.inquirer.input({
            message: "group/device (e.g. demo/dev01)",
            validate: (v) => /^[a-z0-9_-]+\/[a-z0-9_-]+$/.test(v) || "expected <group>/<device>",
        });
        const [group, deviceName] = groupDevice.split("/");
        const techUser = await ctx.inquirer.input({ message: "Linux user techs log in as on the device", default: "mad-tech" });
        const serverHost = await ctx.inquirer.input({ message: "mad server hostname", default: hostname() });
        const scope = await pickScope(ctx);
        const [caResp, krlResp] = await Promise.all([daemon.caPubkey(), daemon.caKrl()]);
        const script = sshShareScript({
            group, deviceName, techUser,
            serverHost,
            sshUser: ctx.username,
            scope,
        }, caResp.pubkey, krlResp.krl);
        ctx.output.write("\n# Run as root on the field device (e.g. `curl ... | sudo sh`):\n\n");
        ctx.output.write(script + "\n");
        return false;
    },
    async run(ctx, opts, groupDevice) {
        const [group, deviceName] = groupDevice.split("/");
        if (!group || !deviceName) throw new Error("expected <group>/<device>");
        const [caResp, krlResp] = await Promise.all([daemon.caPubkey(), daemon.caKrl()]);
        const script = sshShareScript({
            group,
            deviceName,
            techUser: opts.techUser!,
            serverHost: opts.serverHost!,
            sshUser: (opts.serverUser as string | undefined) ?? ctx.username,
            scope: (opts.scope as Scope),
        }, caResp.pubkey, krlResp.krl);
        ctx.output.write(script);
    },
});
