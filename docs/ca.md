# The mad CA

mad runs a small ed25519 SSH certificate authority. The CA signs **user certs** used to authenticate to **field devices**.

Gateway login itself uses `~/.ssh/authorized_keys`, populated by mad on enrollment — so a missing, expired, or revoked cert never locks anyone out of the gateway. They can SSH in with just their pubkey and `mad cert refresh` themselves a new one.

## Where the CA lives

- **Private key** — `/etc/mad/ca/ca.key` (0400 root:root). Generated on first `mad system setup`.
- **Public key** — copied to `/etc/ssh/mad_ca.pub` on every setup. `sshd`'s `TrustedUserCAKeys` points at it.

The key never moves and is never embedded in clients. Clients trust mad certs because the *server-side* sshd trusts the CA pubkey.

## Read the pubkey

```sh
ssh <you>@<gw> ca pubkey    # via the daemon (any user)
sudo mad ca pubkey          # locally, reads the key file directly (root)
```

The field-device install script (`mad service install-ssh`) fetches this for you.

## How signing works

The daemon calls:

```
ssh-keygen -s /etc/mad/ca/ca.key \
           -I user_<username> \
           -n <username>,<group1>,<group2>,... \
           -V +520w \
           <tempfile.pub>
```

mad uses `ssh-keygen` (not a JS cert library) because it includes the standard user-cert extensions by default — notably `permit-port-forwarding`, without which sshd refuses `ssh -R`/`ssh -L`.

The principals list = the user's mad username + every mad-group they're in (excluding `mad`, `mad-users`, `mad-admin`). That's what makes the field-device flow work: a device accepts the cert if any principal matches its `AuthorizedPrincipalsFile`.

## Validity

Default: 520 weeks (~10 years), because revocation goes through the KRL on every device connection — see `mad help revocation`. The validity window is only a backstop if KRL distribution silently breaks.

Override via `MAD_CERT_VALIDITY_WEEKS` on the `mad-daemon` unit:

```
Environment=MAD_CERT_VALIDITY_WEEKS=52
```

Set to `1` for "every cert expires in a week" testing.

## Refresh a cert

```sh
ssh mad cert refresh < ~/.ssh/id_ed25519.pub > ~/.ssh/id_ed25519-cert.pub
```

The daemon identifies the caller via `SO_PEERCRED` (no spoofable username arg), reads their current Linux group memberships, and signs the supplied pubkey with those as principals. No new keypair — same key, fresh cert.

## Sign for someone else (admin)

```sh
ssh <you>@<gw> ca sign <username> < their.pub > their-cert.pub
```

Goes through the root-only daemon socket. Useful when handing off an OTP isn't practical.

## Serials and revocation

Every signed cert gets a monotonic serial and is recorded in `state.json`. The CA generates a signed KRL at `/etc/ssh/mad_krl` that the gateway reads via `RevokedKeys`. Field devices fetch a fresh KRL through their reverse tunnel on every incoming tech connection. See `mad help revocation` for the full flow.

## What mad does not do

- **No host certs** — only user certs.
- **No HSM/PKCS#11** — the CA private key is a plain file. Swap `CA.signSSHKey`'s `ssh-keygen -s ca.key` for a PKCS#11 path if you need hardware signing.
