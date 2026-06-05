# mad

A thin layer over system `sshd` + Linux groups.

What it gives you:

- TCP service forwarding, scoped to groups.
- SSH into NAT'd field devices through the gateway.
- L2/L3 VPN per group.
- OTP-based onboarding for new users.

Everything is one binary (`mad`) plus a small root daemon.

## Pick a page

- **client**       — set up your laptop, manage gateways
- **install**      — provision the gateway box (sysadmin)
- **enrollment**   — onboard a new user
- **groups**       — create groups, add/remove members
- **forwarding**   — share a TCP service with your group
- **field-devices** — share an SSH-able device with your group
- **tun**          — L2/L3 VPN into a group's subnet
- **revocation**   — revoke certs, lock people out
- **ca**           — about the CA mad ships
- **cli-reference** — every subcommand in one page

Open any of them with `mad help <name>`.

## In 30 seconds

- The **mad CA** signs SSH user certs. `sshd` trusts them via `TrustedUserCAKeys`.
- Each Linux group gets `/run/mad/groups/<g>/` at mode `2770` (setgid). Members can drop sockets in there with `ssh -R`; non-members can't even traverse it.
- A user's cert carries their group memberships as **principals**. Field devices accept any cert whose principals match an entry in their `AuthorizedPrincipalsFile` — no per-user provisioning per device.

That's the whole model.
