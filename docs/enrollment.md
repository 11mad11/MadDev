# Enrolling a user (OTP flow)

Who: a `mad-admin` (or root) on the gateway, plus the new user with `ssh` on their machine.
What: hand the new user an OTP, they trade it for a signed SSH cert that lets them log in as themselves.

## Mint the OTP (admin)

Interactive:

1. SSH into the gateway as yourself: `ssh <you>@<gw>`
2. In the menu: **Admin → OTP** → enter the new user's chosen username.
3. Mad prints an 8-digit OTP. Hand it (and the gateway hostname) to the new user. Valid for 15 minutes.

Scripted:

```sh
ssh <you>@<gw> otp <newuser>
# prints e.g. 38182922
```

This requires you to be in `mad-admin`. The username is just a label — the Linux user gets created on first successful enrollment.

## Redeem the OTP (new user)

```sh
# Generate an SSH key if you don't have one:
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519

# Run the enrollment:
ssh otp@<gw>
```

The `otp` user on the gateway accepts unauthenticated connections and runs `mad enroll`. You'll be prompted for the OTP and your public key (single line, paste). On success, mad prints a signed certificate. Save it as `~/.ssh/id_ed25519-cert.pub` on your client.

You can now SSH in as yourself:

```sh
ssh <newuser>@<gw>     # → mad menu
```

## What happens behind the scenes

| | |
|---|---|
| Daemon validates the OTP | found in `/var/lib/mad/state.json`, not expired |
| Daemon validates the pubkey | parsed before any state change (a malformed pubkey fails cleanly) |
| Daemon creates the Linux user | `useradd -m -G mad,mad-users <newuser>` (if not already present) |
| Daemon signs the pubkey | `ssh-keygen -s /etc/mad/ca/ca.key -I user_<newuser> -n <newuser>,...groups -z <serial> -V +520w` |
| Daemon writes pubkey to authorized_keys | so the user can SSH into the gateway with just their key — no live cert required |
| Daemon consumes the OTP | single use |

The cert is valid for 10 years by default (`MAD_CERT_VALIDITY_WEEKS=520`). Override the default by setting that env var on the `mad daemon` unit (`Environment=MAD_CERT_VALIDITY_WEEKS=52` for the older 1-year behavior). Principals are the user's username plus every mad-group they're in (excluding `mad`, `mad-users`, `mad-admin`).

The cert is **only needed when authenticating to field devices** — gateway access happens via the authorized_keys entry. If your cert is lost, stolen, expired, or revoked, you can still SSH into the gateway as long as your pubkey is in `authorized_keys`, and `mad cert refresh` will mint you a new one immediately.

## Refreshing your cert

If your group memberships change (an admin adds or removes you from a group), the principals in your existing cert are stale until it expires. To get an updated one immediately:

```sh
ssh mad cert refresh < ~/.ssh/id_ed25519.pub > ~/.ssh/id_ed25519-cert.pub
```

This re-signs your same pubkey with your current group memberships. No new keypair, just a fresh cert.

## When things go wrong

- **`ssh otp@gw` hangs or kicks back `Permission denied`.** PAM is rejecting empty-password auth before mad gets a chance. Add `auth sufficient pam_succeed_if.so user = otp quiet` near the top of `/etc/pam.d/sshd`.
- **`OTP expired`.** OTPs are valid 15 minutes; ask for a new one.
- **`Failed to parse … as a valid auto format key`.** The pubkey you pasted is malformed. It should be a single line: `ssh-ed25519 AAAAC3… [comment]`.
- **You're authed but `ssh <you>@gw` immediately exits.** Your cert may be missing principals you need. Try `ssh mad cert refresh` (assuming you're in `mad-users`+`mad` already).
