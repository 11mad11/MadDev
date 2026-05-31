# Enrolling a user (OTP-as-password flow)

Who: a `mad-admin` (or root) on the gateway, plus the new user with `ssh` on their machine.
What: hand the new user an OTP, they trade it for a signed SSH cert AND a key in their `authorized_keys`.

## How the flow works

Mad uses the user's own Linux account as the on-ramp. The OTP is stored as their Linux password for 15 minutes; sshd accepts it via standard PAM password auth — no `/etc/pam.d/sshd` tweak required. After the user enrolls, mad locks the password (`passwd -l`) so the OTP can't be reused. There's no shared `otp` user, no `AuthenticationMethods none` workaround.

## Mint the OTP (admin)

Interactive: **Admin → OTP** → enter the username.

Scripted:

```sh
ssh <you>@<gw> otp <newuser>
# prints e.g. 38182922
# expires at: 2026-05-31T01:55:00.000Z
```

This requires you to be in `mad-admin`. The daemon does three things in one shot:
1. `useradd -m -G mad,mad-users <newuser>` (if the user doesn't already exist; otherwise just adds them to those groups).
2. Generates an 8-digit OTP.
3. `echo "<newuser>:<OTP>" | chpasswd` — the OTP is now the user's Linux password.

## Redeem the OTP (new user)

```sh
# Generate an SSH key if you don't have one:
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519

# Run the enrollment from your client:
ssh <newuser>@<gw> enroll
# → prompts for your public key
# → you paste it (one line)
# → mad prints the signed cert
```

What happens during `ssh <newuser>@<gw> enroll`:
1. sshd accepts the OTP as your Linux password (`Match Group mad-users` has `PasswordAuthentication yes`).
2. `Match Group mad-users` → `ForceCommand /usr/bin/mad`. With `SSH_ORIGINAL_COMMAND="enroll"`, mad runs the `enroll` subcommand.
3. Mad prompts for your pubkey. You paste it. Mad asks the daemon:
   - Sign the pubkey for you (`mintCert`).
   - Append the pubkey to `/home/<newuser>/.ssh/authorized_keys`.
   - `passwd -l <newuser>` — your OTP password is locked; future logins must use your key.
4. Mad prints the cert. Save it as `~/.ssh/id_ed25519-cert.pub` on your client (or skip — your pubkey is in `authorized_keys` already, so gateway login works either way; the cert only matters for field-device access).

You can now SSH in as yourself:

```sh
ssh <newuser>@<gw>     # → mad menu
```

## What gets recorded

| | |
|---|---|
| Daemon validates the OTP via PAM | sshd's normal password auth |
| Daemon validates the pubkey | parsed before any state change (malformed pubkey fails cleanly) |
| Daemon creates / re-groups the Linux user | `useradd -m -G mad,mad-users` (new) or `usermod -aG mad,mad-users` (existing) |
| Daemon signs the pubkey | `ssh-keygen -s /etc/mad/ca/ca.key -I user_<u> -n <u>,…groups -z <serial> -V +520w` |
| Daemon writes authorized_keys | so the user can SSH in without a cert too |
| Daemon locks the OTP password | `passwd -l <u>` — single-use |
| OTP record is dropped from state.json | after enrollment, or by the 15-min prune timer |

The cert is valid for 10 years by default (`MAD_CERT_VALIDITY_WEEKS=520`). Principals are the user's username plus every mad-group they're in (excluding `mad`, `mad-users`, `mad-admin`).

The cert is **only needed when authenticating to field devices** — gateway access uses `authorized_keys`. If your cert is lost, stolen, expired, or revoked, you can still SSH into the gateway with just your key, and `mad cert refresh` will mint you a new one immediately.

## Refreshing your cert (existing user)

```sh
ssh mad cert refresh < ~/.ssh/id_ed25519.pub > ~/.ssh/id_ed25519-cert.pub
```

This re-signs your same pubkey with your current group memberships. No new keypair, just a fresh cert.

## When things go wrong

- **`ssh <newuser>@<gw> enroll` says "Permission denied (publickey)".** sshd refused password auth. Either the OTP expired (15 min) and the daemon locked the account already, or `PasswordAuthentication yes` isn't in effect for the `mad-users` Match block. Re-run `mad otp <newuser>` to mint a fresh one; check `sshd -T -C user=<newuser>` shows `passwordauthentication yes`.
- **`Failed to parse … as a valid auto format key`.** The pubkey you pasted is malformed. It should be a single line: `ssh-ed25519 AAAAC3… [comment]`.
- **You're enrolled but `ssh <you>@<gw>` immediately exits.** Your cert may have stale principals. Try `mad cert refresh` (you can run it because your pubkey is in `authorized_keys` now).
- **The OTP "expired"** even though you're within 15 minutes. The daemon prunes on a 60s timer — there's a small race window. If you missed it, re-mint.
