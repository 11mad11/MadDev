# The mad CA

`mad` runs a tiny ed25519 SSH certificate authority. The CA signs user certs used to authenticate to **field devices**. Gateway login itself uses standard `~/.ssh/authorized_keys` (populated by mad on enrollment), so a cert that's missing, expired, or revoked never locks anyone out of the gateway — they can SSH in with just their pubkey and `mad cert refresh` themselves a new one.

## Where the CA lives

- Private key: `/etc/mad/ca/ca.key` (0400 root:root). Generated on first `mad setup`.
- Public key: served by the daemon via op `ca-pubkey`, and copied to `/etc/ssh/mad_ca.pub` on every `mad setup`. `sshd`'s `TrustedUserCAKeys` directive points at the latter.

The key never moves and is never embedded into clients. Clients trust mad-issued certs because the *server-side* sshd trusts the CA pubkey — clients themselves don't need it.

## Reading the pubkey

```sh
ssh <you>@<gw> ca pubkey       # via the daemon (any user)
sudo mad ca pubkey             # locally, reads the key file directly (root only)
```

Useful when bringing up a new device that needs to trust mad. The install script for field devices (`mad service install-ssh`) fetches this for you.

## Signing a user pubkey

The daemon ops `ca-sign` and `refresh-cert` both wrap the same `CA.signSSHKey(pubkey, username, principals[])` method, which shells out to:

```
ssh-keygen -s /etc/mad/ca/ca.key \
           -I user_<username> \
           -n <username>,<group1>,<group2>,... \
           -V +52w \
           <tempfile.pub>
```

Why `ssh-keygen` rather than a JS-side cert library: `ssh-keygen` includes the standard user-cert extensions (`permit-X11-forwarding`, `permit-agent-forwarding`, `permit-port-forwarding`, `permit-pty`, `permit-user-rc`) by default. Without `permit-port-forwarding`, sshd refuses `ssh -R`/`ssh -L` with the message "Server has disabled streamlocal forwarding."

The principals list is the user's mad username plus every mad-group they're a member of (excluding the housekeeping groups `mad`, `mad-users`, `mad-admin`). That's what makes the field-device flow work: the device's sshd allows the cert if any of those principals matches an entry in its `AuthorizedPrincipalsFile`.

Validity defaults to **520 weeks (10 years)** because revocation goes through the KRL on every device connection (see [revocation.md](revocation.md)) — the validity window is only a backstop if KRL distribution itself silently breaks. Override via `MAD_CERT_VALIDITY_WEEKS` on the `mad-daemon` unit:

```
Environment=MAD_CERT_VALIDITY_WEEKS=52
```

Set it to `1` for "every cert expires in a week" testing, or higher for longer windows.

## Refreshing a cert

```sh
ssh mad cert refresh < ~/.ssh/id_ed25519.pub > ~/.ssh/id_ed25519-cert.pub
```

The daemon identifies the caller via `SO_PEERCRED` (no spoofable username arg), looks up their current Linux group memberships, and signs the supplied pubkey with those as principals. No new keypair — same key, fresh cert.

## Signing for someone else (admin)

```sh
ssh <you>@<gw> ca sign <username> < their.pub > their-cert.pub
```

Goes through the root-only daemon socket. Used as an alternative to OTP enrollment when handing off an OTP isn't practical.

## Serials and revocation

Every cert gets a monotonic serial (from `state.nextSerial`) and is persisted as a `CertRecord` in `state.json`. The CA generates and ships a signed KRL at `/etc/ssh/mad_krl`; the gateway's sshd reads it via `RevokedKeys` on every auth attempt. Field devices fetch it through their reverse tunnel on every incoming tech connection. See [revocation.md](revocation.md) for the full flow.

## What mad does not do

- **No host certs.** Mad signs user certs only. If you also want sshd to present a mad-signed host cert (so clients can pin via `@cert-authority`), add `-h` and a host pubkey to a wrapper around the same key, but mad doesn't ship that.
- **No HSM / PKCS#11.** The CA private key is a plain file at `/etc/mad/ca/ca.key` mode 0400. If you need hardware-backed signing, swap `CA.signSSHKey`'s `ssh-keygen -s ca.key` for a PKCS#11 path; the rest of the system doesn't need to change.
