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
3. Mad prompts for your pubkey. You paste it. Mad asks the daemon to:
   - Append the pubkey to `/home/<newuser>/.ssh/authorized_keys`.
   - `passwd -l <newuser>` — your OTP password is locked; future logins must use your key.
4. Mad prints a ready-to-paste `Host mad { … }` block for your `~/.ssh/config`, plus the one-liner you'd run if you ever want a cert (e.g. to reach field devices through the gateway):

```sh
ssh mad cert refresh < ~/.ssh/id_ed25519.pub > ~/.ssh/id_ed25519-cert.pub
```

Enrollment does **not** auto-sign a cert. The cert is only needed to reach field devices — gateway login itself uses `authorized_keys`, which is already set. Users who need a cert can mint one any time with `mad cert refresh`.

You can now SSH in as yourself:

```sh
ssh <newuser>@<gw>     # → mad menu
```

## What gets recorded

| | |
|---|---|
| sshd authenticates the user via PAM | the OTP IS the user's Linux password during the 15-min window |
| Daemon validates the pubkey shape | fingerprinted before any state change so a malformed key fails cleanly |
| Daemon writes the pubkey to authorized_keys | so the user can SSH in by key from now on |
| Daemon locks the OTP password | `passwd -l <u>` — single-use |
| Daemon drops the OTP record from state.json | (or the 60-second prune timer does it on TTL expiry) |

Enrollment does **not** issue a cert. The cert is a separate concern — only useful for authenticating to field devices through the gateway. Whenever a user needs one:

```sh
ssh mad cert refresh < ~/.ssh/id_ed25519.pub > ~/.ssh/id_ed25519-cert.pub
```

This signs the same pubkey with the user's current group memberships as principals. Default validity is 10 years (`MAD_CERT_VALIDITY_WEEKS=520`).

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
