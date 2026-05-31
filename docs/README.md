# mad documentation

`mad` is a thin layer over system `sshd` and Linux groups that gives you:

- TCP service forwarding scoped to groups, enforced by filesystem ACLs.
- Cross-host SSH into field devices via the gateway, with kernel-level auth via SSH certificates.
- L2 VPN per group via TAP devices.
- OTP-driven self-service onboarding for new users.

Everything is one binary (`mad`) plus a small root daemon (`mad daemon`). System `sshd` handles all transport and auth.

## Audience guide

| You are | Read |
|---|---|
| Setting up the gateway box for the first time | [install.md](install.md) |
| Adding a new user (and they're enrolling) | [enrollment.md](enrollment.md) |
| Managing groups (who's in what) | [groups.md](groups.md) |
| A user wanting to expose a TCP service to your team | [forwarding.md](forwarding.md) |
| Setting up a field device so techs can SSH into it | [field-devices.md](field-devices.md) |
| A user wanting an L2 VPN to other group members | [vpn.md](vpn.md) |
| Revoking a tech's access (or a lost laptop's certs) | [revocation.md](revocation.md) |
| Needing the full subcommand reference | [cli-reference.md](cli-reference.md) |
| Curious about the CA / cert details | [ca.md](ca.md) |

## Core idea, in 30 seconds

- The **mad CA** signs SSH user certificates. `sshd` accepts them via `TrustedUserCAKeys`.
- Each **Linux group** that mad knows about gets a directory at `/run/mad/groups/<group>/` owned `<owner-user>:<group>` with mode `2770` (setgid). Anyone in the group can put a Unix socket in there with `ssh -R …`. The setgid bit copies the group onto created sockets. Anyone *not* in the group can't even traverse the directory.
- Every member's cert carries their **group memberships as cert principals**. Field devices' sshd uses an `AuthorizedPrincipalsFile` to accept those principals — no per-tech provisioning on each device.

That's it.
