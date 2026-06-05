# Sharing field devices

Share a field device's sshd through mad so techs in a group can reach it — without provisioning each tech on each device.

## The model

- The device runs `ssh -R` exposing its local sshd as a Unix socket on the gateway: `/run/mad/groups/<g>/<device>.sock`.
- The device trusts mad's CA and configures one shared Linux user (`mad-tech` by default) with `AuthorizedPrincipalsFile` containing the group name.
- A tech's mad cert carries the group as a principal. sshd on the device matches it against the principals file and lets them in.

Adding a new tech: enroll them, add them to the group. No work on the device.

## Set up a device

Run this on the field device as root:

```sh
ssh alice@<gw> service install-ssh demo/dev01 | sudo sh
```

Argument shape: `<group>/<device-name>`. Pick a device name unique within the group — it becomes the filename of the socket on the gateway.

What the script installs:

- `socat` (apt/dnf/apk depending on distro).
- The CA pubkey at `/etc/ssh/mad_ca.pub` and the current KRL at `/etc/ssh/mad_krl` (both embedded in the script).
- `/etc/ssh/sshd_config.d/99-mad-share.conf` with `TrustedUserCAKeys`, `RevokedKeys`, and `Match User mad-tech`.
- The shared Linux user `mad-tech`, with `/etc/ssh/principals.mad-tech` containing the group name.
- A `mad-tech-handler` wrapper that refreshes the KRL from the gateway on every incoming connection before piping to local sshd.
- `mad-tech-proxy.service` (the socat listener) and `mad-ssh-share-<group>.service` (the `ssh -R` forwarder).

Re-running the same command is safe — every step is idempotent.

### Flags

- `--tech-user <name>` — use a different shared user (default `mad-tech`). The principals file becomes `/etc/ssh/principals.<name>`.
- `--scope user|system` — default `system`. You almost always want this.
- `--server-host <h>` — gateway hostname (default: derived from your incoming `$SSH_CONNECTION`).
- `--server-user <u>` — username on the gateway (default: your mad username).

## Connect to a device (tech side)

One-off:

```sh
ssh -o ProxyCommand='ssh -W /run/mad/groups/demo/dev01.sock mad' mad-tech@dev01
```

Persistent — add to `~/.ssh/config`:

```
Host dev01
    ProxyCommand ssh -W /run/mad/groups/demo/dev01.sock mad
    User mad-tech
```

Then just: `ssh dev01`.

The tech needs:

- A `Host mad` alias pointing at the gateway in their `~/.ssh/config`.
- A current cert with the group in its principals (`mad cert refresh` if their memberships changed).

## Lifecycle

- **Add a tech** — `mad admin group add demo bob`. Their next `mad cert refresh` carries `demo`.
- **Remove a tech** — `mad admin group rm demo bob` (drops principal from future certs), and/or `mad cert revoke --user bob` (KRL kicks in on the next connection through the gateway).
- **Replace a device** — re-run the install script on the new box with the same `<group>/<device>`. The old socket disappears when the old forwarder dies.
- **Decommission** — `systemctl disable --now mad-ssh-share-<group>` on the device.

## Why no per-tech accounts on the device

The principals file replaces them. All techs share `mad-tech` — same home, same shell history. Fine for "log in, diagnose, log out" flows. If you need per-user state, use real per-user accounts (and pay the per-device provisioning cost).

## Long-offline devices

When a device comes back online:

- The forwarder reconnects (`Restart=on-failure`).
- The CA pubkey on disk is permanent.
- The on-disk KRL is whatever was last fetched, but the wrapper refreshes it on the next incoming tech connection.
- While offline, no tech can reach the device anyway — so KRL staleness has no security impact.

Field-device clocks matter for cert validity. Use NTP, or rely on the long default validity (10 years).
