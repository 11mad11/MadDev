# Managing groups and users

Who: members of `mad-admin`.
What: create groups, list members, add/remove people, delete users.

## Concepts

- A **group** in mad is just a **Linux group** with a matching `/run/mad/groups/<group>/` directory. The directory is `root:<group>` mode `2770` (setgid). There's no per-group "owner" — `mad-admin` membership is the central admin role; any member of `<group>` can register sockets there.
- A user is a **member** if their Linux account is in that group (`/etc/group`). Membership controls:
  - which sockets they can `ssh -R`/`-L` to,
  - whether they can `mad tap join` the group's VPN,
  - which principals their mad cert carries.

## Create a group

Interactive: **Admin → Groups → group-create**, supply name, owner username (must exist), optional VPN subnet (`10.42.0.0/24`).

Scripted:

```sh
ssh <you>@<gw> group create demo --subnet 10.42.0.0/24
```

What happens:

| Step | What |
|---|---|
| `groupadd demo` | new Linux group |
| `mkdir /run/mad/groups/demo` | runtime dir |
| `chown alice:demo /run/mad/groups/demo` | ownership |
| `chmod 2770 /run/mad/groups/demo` | setgid + group rwx |
| `state.json` `netns[]` entry | persistent subnet metadata (only if `--subnet` given) |
| daemon op `create-group-netns` | bridge `mad-demo`, gateway IP `10.42.0.1/24` (only if `--subnet` given) |

The subnet is only required if anyone in the group wants `mad tap join`.

## Add and remove members

Interactive: **Admin → Groups → group-add** / **group-rm**.

Scripted:

```sh
ssh <you>@<gw> group add demo bob       # usermod -aG demo bob
ssh <you>@<gw> group rm  demo bob       # gpasswd -d  bob demo
```

When you add or remove someone, their **existing certificate keeps its old principals until it expires** (520 weeks / ~10 years by default, configurable via the `MAD_CERT_VALIDITY_WEEKS` env var on the `mad-daemon` systemd unit). For faster effect:

- Lower `MAD_CERT_VALIDITY_WEEKS` on the daemon unit so newly-issued certs expire sooner, or
- Ask them to run `ssh mad cert refresh` to pick up the new memberships immediately, or
- Revoke the old cert with `sudo mad cert revoke --user <them>` (or `--serial <n>`) so the gateway and field devices reject it on the next connection.

## List groups / members

```sh
ssh <you>@<gw> group ls
ssh <you>@<gw> group members demo
```

The first walks `/run/mad/groups/*`. The second is `getent group demo` parsed for the member field.

## Delete a user

Interactive: **Admin → Users → user-del** (confirms before running).

Scripted:

```sh
ssh <you>@<gw> user del alice            # userdel -r alice (removes home dir too)
```

This removes the user account. Any `ssh -R` sockets she had registered will close on her next disconnect (sshd cleans them up via `StreamLocalBindUnlink yes`). Her existing certs will be effectively orphaned — they're still valid until expiry but there's no Linux account left.

## Wipe a user's authorized_keys

```sh
ssh <you>@<gw> user forget-keys alice
```

Empties `/home/alice/.ssh/authorized_keys`. Useful if a non-mad key was added there by some other path and you want to force them through the cert flow.

## Things mad doesn't do

- It does **not** quotacheck or rate-limit. If you need that, layer it via PAM or systemd resource controls.
- It does **not** manage user passwords. Cert auth doesn't need them; the OTP user doesn't have one.

(Cert revocation — `mad cert revoke`, KRL distribution, `mad user lockout` — is documented in [revocation.md](revocation.md).)
