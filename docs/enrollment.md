# Enrolling a user

For a `mad-admin` minting an OTP, and a new user redeeming it.

The OTP is the user's Linux password for 15 minutes. sshd accepts it via standard PAM. After enrolling, mad locks the password (`passwd -l`) so the OTP can't be reused.

## Mint the OTP (admin)

Interactive: **Admin → OTP**.

Scripted:

```sh
ssh <you>@<gw> admin otp <newuser>
```

Prints something like:

```
OTP for alice: 38182922
expires at: 2026-05-31T01:55:00.000Z
```

What the daemon does:

- `useradd -m -G mad,mad-users <newuser>` (or just `usermod` if the user exists).
- Generates an 8-digit OTP.
- `chpasswd` sets the OTP as the user's Linux password.

You must be in `mad-admin`.

## Redeem the OTP (user)

On your laptop, make sure you have a key:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519
```

Then enroll:

```sh
ssh <newuser>@<gw> enroll
```

You'll be asked to paste your public key. mad then:

- Appends it to `/home/<newuser>/.ssh/authorized_keys` on the gateway.
- Locks your Linux password so the OTP is one-shot.
- Prints a ready-to-paste `Host mad` block for your `~/.ssh/config`.

From now on:

```sh
ssh <newuser>@<gw>     # → the mad menu
```

## Cert vs authorized_keys

Enrollment does **not** issue a cert. Gateway login uses `authorized_keys`, which is already in place.

You only need a cert to SSH into field devices through the gateway. Mint one any time:

```sh
ssh mad cert refresh < ~/.ssh/id_ed25519.pub > ~/.ssh/id_ed25519-cert.pub
```

The daemon signs your key with your current group memberships as principals. Default validity: 10 years (`MAD_CERT_VALIDITY_WEEKS=520`).

## When things go wrong

- **`Permission denied (publickey)` on enroll** — the OTP probably expired (15 min) and the daemon locked the account. Re-mint with `mad admin otp <user>`.
- **`Failed to parse … as a valid auto format key`** — your pubkey is malformed. It should be one line: `ssh-ed25519 AAAA… [comment]`.
- **Login works but immediately exits** — your cert may have stale principals. Run `mad cert refresh`.
