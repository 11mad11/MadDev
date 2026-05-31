# Installing the gateway

Who: a sysadmin with root on the gateway box.
What: clone the source, install runtime deps, run `mad setup` once.

## Prerequisites on the gateway

- Linux with `systemd`, `openssh-server`, `iproute2`, `openssh-client` (used by `ssh-keygen` for signing).
- `bun` ≥ 1.3 on `PATH`.
- The box where you run this should be the one users SSH to.

## Install

```sh
git clone <repo-url> /opt/mad
cd /opt/mad
bun install --production
sudo bun run src/cli.ts setup
```

`mad setup` is idempotent — it only acts on what's not already correct. Re-run it any time (notably after `mad update`).

What `mad setup` does:

| Step | Where | Detail |
|---|---|---|
| Create groups | `/etc/group` | `mad`, `mad-users`, `mad-admin` |
| Create the `otp` Linux user | `/etc/passwd` | shell `/usr/sbin/nologin`, member of `mad` |
| Make dirs | `/etc/mad/{ca,groups}`, `/var/lib/mad`, `/run/mad/groups` | proper modes and ownership |
| Materialize CA | `/etc/mad/ca/ca.key` (0400 root) | ed25519, generated on first run |
| Publish CA pubkey | `/etc/ssh/mad_ca.pub` | what `TrustedUserCAKeys` reads |
| Install wrapper | `/usr/bin/mad` | a shell script `exec bun run /opt/mad/src/cli.ts "$@"` |
| Install sshd snippet | `/etc/ssh/sshd_config.d/99-mad.conf` | `Match Group mad-users`, `Match User otp` |
| Install systemd unit | `/etc/systemd/system/mad-daemon.service` | for the privileged daemon |
| Reload sshd | only if the snippet changed | `systemctl reload-or-restart ssh` |
| Enable+start daemon | only if unit changed or not running | `systemctl enable --now mad-daemon` |

The output marks `✦` for changes and `·` for already-correct items.

## sshd configuration installed by setup

Roughly (see `/etc/ssh/sshd_config.d/99-mad.conf` after setup):

```
TrustedUserCAKeys /etc/ssh/mad_ca.pub
AllowStreamLocalForwarding all
StreamLocalBindUnlink yes

Match Group mad-users
    ForceCommand /usr/bin/mad
    AllowStreamLocalForwarding all
    StreamLocalBindMask 0117
    StreamLocalBindUnlink yes

Match User otp
    AuthenticationMethods none
    PermitEmptyPasswords yes
    ForceCommand /usr/bin/mad enroll
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    PermitTTY yes
```

Members of `mad-users` who SSH in land directly in the mad menu (no shell). The `otp` user is the public on-ramp for enrollment — it accepts unauthenticated connections and immediately runs `mad enroll`.

Known deployment gotcha: many distros' default PAM config rejects empty passwords. If `ssh otp@server` fails before reaching `mad enroll`, add to `/etc/pam.d/sshd`:

```
auth sufficient pam_succeed_if.so user = otp quiet
```

…above the standard `@include common-auth` line.

## Updating

```sh
sudo mad update
```

That runs `git -C /opt/mad pull --ff-only`, then `bun install` if the commit advanced, then `mad setup` (idempotent), then `systemctl restart mad-daemon`. Safe to re-run.

There is no auto-update built into the daemon. If you want it scheduled, wire `mad update` into a systemd timer.

## File layout at runtime

```
/etc/mad/
  ca/ca.key                          # 0400 root:root  (the CA private key)
  ca/ca.pub                          # 0644 root:root
  groups/<group>.json                # group metadata (owner, optional subnet)

/etc/ssh/
  mad_ca.pub                         # what sshd's TrustedUserCAKeys reads
  sshd_config.d/99-mad.conf

/run/mad/
  daemon.sock                        # 0660 root:mad
  daemon-root.sock                   # 0600 root:root (privileged ops)
  groups/<group>/                    # 2770 <owner>:<group> (setgid)
  groups/<group>/<service>.sock      # created by `ssh -R`

/var/lib/mad/
  state.json                         # 0640 root:mad (TAPs, OTPs, group netns)

/usr/bin/mad                         # bash wrapper → bun run /opt/mad/src/cli.ts
```
