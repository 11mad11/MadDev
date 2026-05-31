# Cert serials, revocation, and lockout

Who: members of `mad-admin` (revoke), any user (list their own).
What: every cert mad signs is tracked, can be revoked, and the revocation propagates to the gateway immediately and to field devices on their next incoming SSH connection.

## Two axes of revocation

Mad authenticates in two different places:

| Where | What it uses | How to lock someone out |
|---|---|---|
| Gateway (`ssh alice@gw`) | Their pubkey in `~alice/.ssh/authorized_keys` | `mad user forget-keys alice` |
| Field devices (`ssh -W .../dev.sock mad`) | Their mad-signed cert + KRL | `mad cert revoke --user alice` |

The two axes are independent on purpose:
- **Lost laptop / suspected key compromise on the cert side** → `mad cert revoke --user alice`. Alice can still log into the gateway to figure out what happened (if her ssh keys are still intact); she just can't reach any field device.
- **Person leaving the team, day-of-departure** → both. Use `mad user lockout alice` (below).
- **Gateway lockout only** (rare — e.g., compromised host but you still want devices reachable to other group members via her cert lineage being clean) → `mad user forget-keys alice`.

If you don't care about the distinction, always do both: there's a single command for it.

## What's tracked

Every call into `consume-otp`, `ca-sign`, or `refresh-cert` records a `CertRecord` in `/var/lib/mad/state.json`:

```json
{
  "serial": 1,
  "username": "alice",
  "keyId": "user_alice",
  "fingerprint": "SHA256:VitudSmL/…",
  "principals": ["alice", "demo", "finance"],
  "issuedAt": 1780191028672,
  "expiresAt": 1811640628672
}
```

Serials are monotonic. The cert itself carries the serial (visible via `ssh-keygen -L -f <cert>` → `Serial: 1`). The serial is what makes selective revocation work — without it, OpenSSH KRLs can only revoke by full pubkey, which we'd lose if the user rotated keys.

## Listing certs

```sh
ssh mad cert ls                # your own (or all, if you're root)
ssh mad cert ls --user alice   # filter (admin / root)
```

Output columns: `serial | username | status | validity-range | fingerprint`.

`status` is one of:
- **active** — present in `certs`, not in `revoked`, not past `expiresAt`
- **revoked** — present in `revoked`
- **expired** — past `expiresAt`

## Revoking

By serial:

```sh
sudo mad cert revoke --serial 1 --reason "lost laptop"
```

By user (all of their currently-issued certs):

```sh
sudo mad cert revoke --user alice --reason "left team"
```

Both go through `/run/mad/daemon-root.sock`, so they require uid 0. Side effects:
1. Append a `RevocationRecord` to `state.json` for every matching serial.
2. Regenerate `/etc/ssh/mad_krl` from the full revoked-serials list, signed by the CA.
3. The gateway's sshd reads `RevokedKeys` on every auth attempt — **no `systemctl reload sshd` needed**, the next connection from a revoked cert is rejected.

## Unrevoking

```sh
sudo mad cert unrevoke 1
```

Removes the serial from `revoked` and regenerates `/etc/ssh/mad_krl`. Use sparingly — once you've told yourself a cert is compromised, "un-revoking" probably isn't what you actually want.

## Full lockout

```sh
sudo mad user lockout alice --reason "left the team"
```

Equivalent to `sudo mad cert revoke --user alice --reason …` followed by `sudo mad user forget-keys alice`. Pubkey gone from authorized_keys → can't ssh into the gateway. All her serials on the KRL → can't reach any device through the gateway. If you change your mind, you'd re-issue both: `mad cert unrevoke <serial>` for each and `mad ca sign alice < newpub.pub` to repopulate authorized_keys (`ca sign` writes there too).

## How the KRL gets to field devices

Field devices use the same `RevokedKeys /etc/ssh/mad_krl` directive in their sshd config. They keep it fresh by fetching it from the gateway **on every incoming tech connection**, via a tiny wrapper around their sshd.

The architecture:

```
tech                        gateway                      field device
─────                       ───                          ────────────
ssh -W .../dev01.sock mad ─→ sshd                        socat listener
                             │  forwards via ─R tunnel ─→ on /run/mad-tech-proxy.sock
                                                          ↓ fork per connection
                                                          mad-tech-handler:
                                                            ssh mad ca krl --raw → /etc/ssh/mad_krl
                                                            exec socat - TCP:127.0.0.1:22
                                                          ↓
                                                          local sshd
                                                          (reads fresh mad_krl,
                                                           validates cert)
```

What's installed by `service install-ssh demo/dev01`:

- `/usr/local/bin/mad-tech-handler` — the wrapper script. On each invocation it does:
  1. `timeout 5 ssh -o BatchMode=yes mad ca krl --raw < /dev/null > /tmp/krl` — refresh attempt, ≤5 s
  2. If successful and non-empty, `install -m 0644 /tmp/krl /etc/ssh/mad_krl`
  3. `exec socat - TCP:127.0.0.1:22` — pipe the original SSH stream through to local sshd
- `mad-tech-proxy.service` — systemd unit running `socat UNIX-LISTEN:/run/mad-tech-proxy.sock,fork EXEC:/usr/local/bin/mad-tech-handler`.
- `mad-ssh-share-<group>.service` — the forwarder, now targeting `/run/mad-tech-proxy.sock` instead of `:22`.
- `/root/.ssh/config` with `ControlMaster auto, ControlPath /run/mad-cm-%C, ControlPersist 10m` — so the `ssh mad ca krl` call in the wrapper reuses the forwarder's open TCP session (no new handshake).

Result: revocation latency is bounded by the round-trip on the existing tunnel — typically a few hundred ms. If the gateway is briefly unreachable, the wrapper falls back to the previous KRL on disk and lets the connection through (the gateway being down means *no tech could reach the device anyway*, so this isn't a security regression).

## What about devices that are offline when the tech tries to connect?

If the field device has lost its tunnel to the gateway, the tech's `ssh -W /run/mad/groups/.../dev.sock mad` fails at the gateway (the socket isn't bound by anyone). The tech can't reach the device. There's nothing to validate against a stale KRL.

The premise of the design is that field devices are behind NAT and *always* reach the world via the gateway — so the gateway is necessarily in the data path of every tech-to-device connection, and we can use that to refresh the KRL just-in-time.

## What about cert validity expiration?

The CA signs with `+520w` (~10 years) by default — configurable via the `MAD_CERT_VALIDITY_WEEKS` env var on the `mad-daemon` systemd unit. Field devices read the cert's `Valid: from … to …` directly — no KRL involvement. The long default reflects the fact that KRL distribution handles revocation; if you want faster passive expiry as a backstop, lower the env var and rely on `mad cert refresh` for routine renewal.

## Limits

- Mad doesn't revoke by **fingerprint or key id** — only by serial (and by user, which expands to that user's serials). Adding the others is a few lines in `revokeCert`; serials are enough for the common cases.
- **Audit:** revocation events are appended to `state.json` with a `revokedAt` timestamp and optional reason, but mad doesn't ship anything to syslog/journal. Wire that up if your environment requires it.
- **HSM:** the CA private key is a plain file at `/etc/mad/ca/ca.key` (0400 root). If you need HSM-backed signing, swap `CA.signSSHKey`'s `ssh-keygen -s ca.key` for a PKCS#11 path.
