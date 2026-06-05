# Installing the gateway

For a sysadmin with root on the gateway box.

## Requirements

- Linux with `systemd`, `openssh-server`, `iproute2`, `openssh-client`.
- `bun` ≥ 1.3 on `PATH`.
- This is the host users will SSH into.

## Install

```sh
git clone <repo-url> /opt/mad
cd /opt/mad
bun install --production
sudo bun run src/cli.ts system setup
```

`mad system setup` is idempotent. Re-run it any time (notably after `mad system update`).

## What setup does

- Creates groups `mad`, `mad-users`, `mad-admin`.
- Makes `/etc/mad/ca`, `/var/lib/mad`, `/run/mad/groups` with the right modes.
- Generates `/etc/mad/ca/ca.key` (ed25519, 0400 root) on first run.
- Publishes the CA pubkey to `/etc/ssh/mad_ca.pub`.
- Installs the `/usr/bin/mad` wrapper.
- Drops the sshd snippet at `/etc/ssh/sshd_config.d/99-mad.conf`.
- Installs `mad-daemon.service` and starts it.
- Reloads sshd only if the snippet actually changed.

Output marks `✦` for changes and `·` for already-correct items.

## sshd snippet

The snippet adds (roughly):

```
TrustedUserCAKeys /etc/ssh/mad_ca.pub
RevokedKeys       /etc/ssh/mad_krl

Match Group mad-users
    ForceCommand              /usr/bin/mad
    AllowStreamLocalForwarding all
    StreamLocalBindMask       0117
    StreamLocalBindUnlink     yes
    PasswordAuthentication    yes
```

`mad-users` members land in the mad menu (no shell). `PasswordAuthentication yes` is required for the OTP enrollment flow — see `mad help enrollment`. After enrolling, the daemon locks each user's password (`passwd -l`), so subsequent logins use their key.

No PAM tweaks needed.

## Updating

```sh
sudo mad system update
```

Runs `git pull --ff-only`, then `bun install` if the commit advanced, then `mad system setup`, then restarts the daemon. Safe to re-run.

For scheduled updates, wire `mad system update` into a systemd timer.

## Runtime layout

```
/etc/mad/ca/ca.key             # 0400 root:root  (CA private key)
/etc/mad/ca/ca.pub             # 0644 root:root
/etc/ssh/mad_ca.pub            # what TrustedUserCAKeys reads
/etc/ssh/mad_krl               # KRL — revoked cert serials
/etc/ssh/sshd_config.d/99-mad.conf

/run/mad/daemon.sock           # 0660 root:mad
/run/mad/daemon-root.sock      # 0600 root:root
/run/mad/groups/<g>/           # 2770 root:<g>
/run/mad/groups/<g>/<s>.sock   # created by `ssh -R`

/var/lib/mad/state.json        # 0640 root:mad

/usr/bin/mad                   # bash wrapper → bun run /opt/mad/src/cli.ts
```
