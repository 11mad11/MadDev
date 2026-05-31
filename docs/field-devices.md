# Sharing field devices

Who: a user (the device owner) and the techs in their group.
What: configure a field device so techs in a group can SSH into it via the mad gateway, without provisioning the techs per-device.

## The model

- Each field device runs an `ssh -R` that exposes its local port 22 as a Unix socket on the gateway: `/run/mad/groups/<g>/<device>.sock`.
- The device installs mad's CA pubkey in `TrustedUserCAKeys` and has one shared Linux user (`mad-tech` by default) configured with `AuthorizedPrincipalsFile /etc/ssh/principals.mad-tech` containing the group name.
- A tech's mad cert has the group as one of its principals. When they SSH in as `mad-tech` via the gateway, sshd on the device matches the cert's `demo` principal against the file's `demo` entry and lets them in.

That's the whole auth chain. Adding a new tech: enroll them in mad, add them to the group. Done — no work on the device.

## Set up a device

Run this on the field device as root (or pipe to `sudo sh`):

```sh
ssh alice@<gw> service install-ssh demo/dev01 | sudo sh
```

Arg shape: `<group>/<device-name>`. Pick a device name that's unique within the group — it becomes the filename of the Unix socket on the gateway.

What the install script does on the device:

| Step | What |
|---|---|
| Install `socat` | required by the wrapper; apt/dnf/apk depending on distro |
| Write CA pubkey | `/etc/ssh/mad_ca.pub` — embedded in the install script, no network call |
| Write initial KRL | `/etc/ssh/mad_krl` — also embedded (signed by mad CA at script-generation time) |
| Write sshd snippet | `/etc/ssh/sshd_config.d/99-mad-share.conf` with `TrustedUserCAKeys`, `RevokedKeys`, `Match User mad-tech AuthorizedPrincipalsFile /etc/ssh/principals.%u` |
| Create `mad-tech` Linux user | with shell `/bin/bash` |
| Update principals file | `/etc/ssh/principals.mad-tech` gets the group name appended (sorted, deduped) |
| Borrow your keys for root | the script copies `$SUDO_USER`'s `id_ed25519` + cert into `/root/.ssh/` so root can `ssh mad ca krl` later. Root has full local access already, so this isn't a privilege escalation. |
| `/root/.ssh/config` Host mad | with `ControlMaster auto, ControlPath /run/mad-cm-%C` so KRL fetches reuse the forwarder's TCP session |
| Install `/usr/local/bin/mad-tech-handler` | tiny script: fetches latest KRL, then `exec socat - TCP:127.0.0.1:22` |
| Install `mad-tech-proxy.service` | socat listener on `/run/mad-tech-proxy.sock` that forks the handler per connection |
| Install forwarder unit | `mad-ssh-share-<group>.service` running `ssh -N -R /run/mad/groups/<g>/<device>.sock:/run/mad-tech-proxy.sock mad` |
| Reload sshd | only if its snippet actually changed |
| Enable both services | `systemctl enable --now mad-tech-proxy mad-ssh-share-<group>` |

The forwarder's local target is `/run/mad-tech-proxy.sock`, not `:22`. Every incoming SSH connection passes through `mad-tech-handler`, which refreshes the KRL from the gateway before piping the connection to the device's own `sshd`. That's how revocations propagate.

Re-run the same command at any time — every step is idempotent.

Flags worth knowing:

| Flag | Default | Notes |
|---|---|---|
| `--tech-user <name>` | `mad-tech` | use a different shared user if you want; principals file is named `/etc/ssh/principals.<name>` |
| `--scope user\|system` | `system` | `user` writes the forwarder unit under `/root/.config/systemd/user/` instead. For field devices you almost always want `system`. |
| `--server-host <h>` | derived from your incoming `$SSH_CONNECTION` | the gateway hostname the forwarder will use |
| `--server-user <u>` | your mad username | who the forwarder will SSH as |

## Connect to a device (tech side)

The device exposes its sshd as a Unix socket on the gateway. Techs reach it through a `ProxyCommand`:

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

Then: `ssh dev01`.

For this to work the tech needs:
- A `Host mad` alias in their own `~/.ssh/config` pointing at the gateway (set up by `service install` or by hand).
- A current mad cert with `demo` in its principals (their enrollment cert; refresh with `mad cert refresh` if their group memberships changed since).

## Lifecycle

- Adding a tech: `mad group add demo bob`. Bob's next `mad cert refresh` or new enrollment carries `demo`. Done.
- Removing a tech: `mad group rm demo bob` (drops the principal from future certs), or `mad cert revoke --user bob` (KRL — kicks in on every device's next incoming connection, since the wrapper refetches before each auth check). Existing certs are otherwise valid until expiry (default 520 weeks / ~10 years, `MAD_CERT_VALIDITY_WEEKS`).
- Replacing a device: the install script is idempotent, so re-running it on a fresh box with the same `<group>/<device>` is the upgrade path. The old socket on the gateway is unlinked when the old device's forwarder unit dies (sshd does this via `StreamLocalBindUnlink yes`).
- Decommissioning a device: stop the forwarder unit (`systemctl disable --now mad-ssh-share-<group>`). The socket on the gateway disappears.

## Why no per-tech accounts on the device

The principals-file mechanism replaces them. The cost is that all techs share the same Linux user (`mad-tech`) on the device — same home, same shell history, same authorized_keys for any per-tech additions you'd otherwise want. For "tech logs in, runs diagnostics, logs out" workflows that's fine. For long-lived per-tech sessions with separate state, prefer per-user accounts; the cost is provisioning each tech on each device.

## Long-offline devices

A device that's been off the network for months catches up with the gateway as soon as it gets connectivity:

- Its forwarder unit reconnects (`Restart=on-failure`, `ServerAliveInterval=30`).
- The CA pubkey is permanent — installed once at setup time, never needs refresh.
- The KRL on disk is whatever was last fetched. While the device is online, the `mad-tech-handler` wrapper refreshes `/etc/ssh/mad_krl` per incoming tech connection (via the live ControlMaster session to the gateway). While offline, no techs can reach the device anyway (NAT), so the staleness has no security impact — techs only ever pass through the gateway, where the gateway's KRL is always live.
- A tech's cert is accepted if its `Valid: from … to …` range covers "now" by the device's clock. If the device's clock is way off, certs may fail validity. Use NTP on field devices, or rely on the long default validity (10 years).

A device that's offline at the moment a tech tries to connect: the connection fails at the gateway (the `/run/mad/groups/…/<device>.sock` isn't bound), so KRL staleness never gets a chance to matter. When the device comes back, the wrapper fetches fresh KRL on the very next inbound tech connection.
