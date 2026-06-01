# mad

Full per-feature docs live in [docs/](docs/README.md). The README below is a quickstart; for details on any specific flow, jump into the docs.



A Linux-native SSH gateway helper. System sshd does all transport and auth; `mad` is a CLI + privileged daemon that gives users a group-scoped overlay for:

- **TCP service forwarding** via OpenSSH's Unix-domain-socket forwarding, with group isolation enforced by filesystem ACLs on `/run/mad/groups/<group>/`.
- **L2 VPN per group** via a bridge + persistent TAP devices, allocated by the daemon and owned by the requesting user.
- **OTP-based enrollment** so a new user can self-serve their SSH cert once a sysadmin hands them an OTP.
- **A tiny CA** that signs short-lived SSH user certs; sshd validates them via `TrustedUserCAKeys`.

There is no custom SSH server, no custom auth, no custom user store. Real Linux users, real Linux groups, real `sshd`.

## Install (server side)

```sh
# 1. Drop the source somewhere on the box and install runtime deps:
git clone <repo> /opt/mad
cd /opt/mad
bun install --production

# 2. Run the idempotent setup. It creates groups (mad, mad-users, mad-admin),
#    /etc/mad/ca, /var/lib/mad, /run/mad, the CA key, /etc/ssh/mad_ca.pub,
#    /etc/ssh/sshd_config.d/99-mad.conf, /etc/systemd/system/mad-daemon.service,
#    /usr/bin/mad, then enables and starts the daemon and reloads sshd if
#    anything changed.
sudo bun run src/cli.ts setup
```

After this first run, `/usr/bin/mad` exists, so further administration uses `mad` directly. Re-running `mad setup` after a pull is safe and only acts on what actually changed.

## Update

```sh
sudo mad update    # git pull --ff-only + bun install + mad setup + systemctl restart mad-daemon
```

There is no built-in auto-update — wrap `mad update` in a systemd timer or cron if you want one.

## Enroll a user

```sh
# sysadmin:
sudo mad otp alice
# → ensures alice's Linux user exists in groups mad,mad-users
# → sets a one-time 8-digit password (15-min TTL)

# alice on her client:
ssh alice@<server> enroll
# → sshd accepts the OTP as her Linux password
# → mad prompts her for her pubkey, signs it, writes authorized_keys,
#   then `passwd -l alice` so the OTP can't be reused
ssh alice@<server>   # lands in the mad menu
```

## Create a group

```sh
# sysadmin:
sudo mad group create demo --subnet 10.42.0.0/24
sudo mad group add demo bob
```

## Register & use a TCP service

```sh
# alice, exposing her local web server:
ssh -R /run/mad/groups/demo/web.sock:localhost:8000 alice@<server>

# bob, in the same group:
ssh -L 9000:/run/mad/groups/demo/web.sock bob@<server>
curl http://localhost:9000/
```

Carol, who isn't in `demo`, can't even traverse the directory — the kernel stops her at `mode 2770 alice:demo` on `/run/mad/groups/demo/`.

## L2 VPN

```sh
# alice:
mad tap join demo
# → prints the tap interface name + IP allocated for her
```

The TAP device is persistent and owned by alice — she can read/write it via `/dev/net/tun` and it's attached to the group's bridge by the daemon.

## Auto-install a forward on a client

```sh
# From any machine, fetch the install script from mad and pipe to sh:
ssh alice@<server> service install demo/web localhost:8000 --scope user | sh
```

That writes `~/.config/systemd/user/mad-fwd-demo-web.service`, adds a `Host mad` block to `~/.ssh/config`, and enables the unit. The forward survives logouts once you run `sudo loginctl enable-linger $(whoami)`. Pass `--scope system` for a `/etc/systemd/system/` unit instead.

## Cross-device SSH (field devices)

Owner of a device runs once on the device, as root:

```sh
ssh alice@<server> service install-ssh demo/dev01 | sudo sh
```

That installs mad's CA pubkey, configures sshd with `TrustedUserCAKeys`, creates a `mad-tech` Linux user with `AuthorizedPrincipalsFile /etc/ssh/principals.mad-tech` containing `demo`, and starts a systemd unit that forwards local port 22 to `/run/mad/groups/demo/dev01.sock` on the gateway.

Any tech in group `demo` then SSHes in via the gateway:

```sh
ssh -o ProxyCommand='ssh -W /run/mad/groups/demo/dev01.sock mad' mad-tech@dev01
```

Or in `~/.ssh/config`:

```
Host dev01
    ProxyCommand ssh -W /run/mad/groups/demo/dev01.sock mad
    User mad-tech
```

**Auth model.** Mad signs each user's cert with their username and *all of their mad-group names as principals* (so bob's cert has principals `bob,demo,otherGroup,…`). The field device's sshd lets `mad-tech` log in if any of the cert's principals appears in `/etc/ssh/principals.mad-tech` — which is just the group name. Result:

- Adding a tech = enroll them in mad, add them to the group. Zero work on the device.
- Removing a tech = remove them from the mad group. Their next cert won't have `demo`; the existing one is valid until expiry (default 520 weeks / ~10 years, configurable via `MAD_CERT_VALIDITY_WEEKS`). For faster effective revocation, `mad cert revoke --user <them>` adds them to the KRL immediately.
- Refresh: `ssh mad cert refresh < ~/.ssh/id_ed25519.pub > ~/.ssh/id_ed25519-cert.pub`.

## CLI

- `mad` — interactive menu (this is your login shell when in `mad-users`).
- `mad daemon` — run the privileged daemon (use the systemd unit in production).
- `mad gateway {add,ls,rm,test}` — manage gateways in `~/.ssh/config`.
- `mad ca {pubkey,sign,krl}` — CA operations (signed KRL fetch lives here).
- `mad cert {refresh,ls,revoke,unrevoke}` — issued cert inventory and revocation.
- `mad group {create,ls,members,add,rm}` — group management (admin).
- `mad user {del,forget-keys}` — user management (admin).
- `mad service {ls,register,use,hold,ping,install,install-ssh}` — discoverability + prints the right `ssh -R` / `ssh -L`.
- `mad tap {join,leave,ls}` — L2 VPN (Linux/macOS/Windows).
- `mad tun {join,leave,ls}` — L3 point-to-point tunnel (Linux/macOS/Windows).
- `mad otp <username>` — ensure the Linux user, mint a 15-min OTP, set it as their Linux password (admin).
- `mad enroll` — first-time pubkey upload; signs your key, writes authorized_keys, locks the OTP password. Run as the user being enrolled.
- `mad doctor [--install-l2-driver]` — Windows-side diagnostics; can fetch + install TAP-Windows6 with UAC.

## Windows clients

`mad tap/tun join` works on Windows via a Rust native module (`native/windows-tap/`) that mad loads through `bun:ffi`. L3 uses wintun; L2 uses TAP-Windows6 (driver installable via `mad doctor`). See [docs/internal/tun-tap-walkthrough.md](docs/internal/tun-tap-walkthrough.md) for the architecture and the Microsoft-OpenSSH text-mode-stdin gotcha.
