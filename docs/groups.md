# Managing groups and users

For members of `mad-admin`.

## Concepts

- A **mad group** is a Linux group with a matching `/run/mad/groups/<g>/` directory (mode `2770`, setgid).
- A user is a **member** if their Linux account is in that group.

Membership controls:

- Which sockets they can `ssh -R` / `ssh -L`.
- Whether they can `mad tap join` the group's VPN.
- Which principals their cert carries.

## Create a group

Interactive: **Admin → Groups → create**.

Scripted:

```sh
ssh <you>@<gw> admin group create demo 10.42.0.0/24
```

The subnet is optional — only needed if anyone in the group wants `mad tap join`.

What happens:

- `groupadd demo`.
- `mkdir /run/mad/groups/demo`, `chown root:demo`, `chmod 2770`.
- If a subnet was given, the daemon records it and brings up bridge `mad-demo`.

## Add or remove members

```sh
ssh <you>@<gw> admin group add demo bob       # usermod -aG demo bob
ssh <you>@<gw> admin group rm  demo bob       # gpasswd -d  bob demo
```

Existing certs keep their old principals until they expire (default 10 years). To apply membership changes faster:

- Ask the user to run `mad cert refresh`, or
- Revoke their old cert with `mad cert revoke --user <them>`, or
- Lower `MAD_CERT_VALIDITY_WEEKS` on the daemon unit for shorter-lived certs going forward.

## List groups and members

```sh
ssh <you>@<gw> admin group ls
ssh <you>@<gw> admin group members demo
```

## Delete a user

Interactive: **Admin → Users → del** (with a confirm prompt).

Scripted:

```sh
ssh <you>@<gw> admin user del alice
```

Runs `userdel -r` (removes the home dir too). Any `ssh -R` sockets they had will close on disconnect. Their certs are still valid until expiry, but with no Linux account left they're effectively orphaned.

## Wipe a user's authorized_keys

```sh
ssh <you>@<gw> admin user forget-keys alice
```

Empties `/home/alice/.ssh/authorized_keys` — blocks gateway login without touching their certs.

## What mad doesn't do

- No quotas or rate limits — layer those via PAM or systemd if needed.
- No password management — cert auth doesn't need passwords.

See `mad help revocation` for the cert side of access removal.
