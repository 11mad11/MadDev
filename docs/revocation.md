# Certs, revocation, and lockout

For `mad-admin` (revoke) or any user (list their own).

Every cert mad signs has a serial. Revocation propagates to the gateway immediately and to field devices on their next incoming SSH connection.

## Two axes of access

- **Gateway login** (`ssh alice@<gw>`) — uses `~alice/.ssh/authorized_keys`. Lock with `mad admin user forget-keys alice`.
- **Field devices** (`ssh -W .../dev.sock mad`) — uses the cert + KRL. Lock with `mad cert revoke --user alice`.

Pick what you need:

- **Lost laptop / suspected key compromise** — `mad cert revoke --user alice`. She can still log into the gateway to investigate; she just can't reach any device.
- **Person leaving the team** — both. Run the cert revoke and the forget-keys.

## Listing certs

```sh
ssh mad cert ls                # your own (or all, if admin/root)
ssh mad cert ls --user alice   # filter (admin)
```

Columns: `serial | username | status | validity | fingerprint`.

Status is one of:

- **active** — present in `certs`, not revoked, not expired.
- **revoked** — present in `revoked`.
- **expired** — past `expiresAt`.

## Revoking

By serial:

```sh
sudo mad cert revoke --serial 1 --reason "lost laptop"
```

By user (all currently-issued certs):

```sh
sudo mad cert revoke --user alice --reason "left team"
```

Both go through the root-only daemon socket (so the `sudo`). Side effects:

- Append to `state.json` for each matching serial.
- Regenerate `/etc/ssh/mad_krl`, signed by the CA.
- The gateway's sshd reads `RevokedKeys` on every auth attempt — no reload needed.

## Unrevoking

```sh
sudo mad cert unrevoke <serial>
```

Removes the serial and regenerates the KRL. Use sparingly.

## How field devices get the KRL

The device's sshd reads `RevokedKeys /etc/ssh/mad_krl`. The mad install script wraps incoming tech connections in a small handler that fetches a fresh KRL from the gateway (via the device's existing reverse tunnel) before piping the connection to local sshd.

So revocation latency on the device side is one short round-trip on an already-open tunnel — typically a few hundred ms.

If the gateway is briefly unreachable, the wrapper falls back to the on-disk KRL. That's safe — if the gateway is down, no tech could reach the device anyway.

## When devices are offline

If a device has lost its tunnel to the gateway, the tech's `ssh -W` fails at the gateway (the socket isn't bound). No stale KRL involved.

The premise is that field devices are behind NAT and *always* reach the world through the gateway — so the gateway is in the data path of every connection and can refresh KRL just-in-time.

## What about expiry?

The CA signs with `+520w` (~10 years) by default. Override via `MAD_CERT_VALIDITY_WEEKS` on the `mad-daemon` systemd unit:

```
Environment=MAD_CERT_VALIDITY_WEEKS=52
```

KRL handles revocation; validity is just a backstop if KRL distribution silently breaks.

## Limits

- Revocation is by serial only (or by user, which expands to serials). No revoke-by-fingerprint or key-id today.
- Revocation events go into `state.json` with a timestamp. mad doesn't ship anything to syslog/journal — wire that up if you need it.
- The CA private key is a plain file. No HSM/PKCS#11 today.
