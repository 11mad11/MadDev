# TCP service forwarding

For any user enrolled in mad, in at least one group. Expose a local TCP service so other group members can reach it through the gateway.

## How it works

OpenSSH forwards to/from Unix sockets. mad uses that — there's no custom forwarding code. Access is enforced by the kernel via filesystem permissions on `/run/mad/groups/<g>/`.

```
host A (publisher)        gateway                       host B (consumer)
─────────                 ───                           ─────────
backend                   sshd                          ssh client
:8080  ←── ssh -R ───→  /run/mad/groups/g/web.sock  ←── ssh -L ───  :9000
                        (0660 publisher:g)
```

A non-member of `g` can't even traverse the directory.

## One-off forward

On the publisher (host A):

```sh
ssh -R /run/mad/groups/demo/web.sock:localhost:8080 alice@<gw>
```

On the consumer (host B):

```sh
ssh -L 9000:/run/mad/groups/demo/web.sock bob@<gw>
curl http://localhost:9000/
```

The mad menu and CLI generate the right command for you:

- `mad service register <group>/<name> <addr:port>` — prints the `ssh -R …`
- `mad service use <group>/<name> <localport>` — prints the `ssh -L …`
- `mad service ls` — lists what's visible to you

## Persistent forward (systemd)

For always-on services, mad generates an install script that drops a systemd unit on the publisher.

Interactive: **Services → install**.

Scripted (recommended):

```sh
ssh alice@<gw> service install demo/web localhost:8080 --scope user | sh
```

The script:

- Adds `Host mad` to `~/.ssh/config` (or `/root/.ssh/config` for `--scope system`).
- Writes `mad-fwd-demo-web.service` running `ssh -N -R …`.
- Enables and starts it.
- For user scope, prompts you to enable `loginctl enable-linger` so it survives logout.

The script is idempotent — re-running it reports `·` for unchanged, `✦` for changed.

## Scope

- **user** — unit under `~/.config/systemd/user/`, runs as you. Needs `loginctl enable-linger` to survive logout. Best for most cases.
- **system** — unit under `/etc/systemd/system/`. Runs as the sudo-invoking user. Survives reboot naturally. Best for always-on hosts.

## Concurrency

Many consumers can `ssh -L` to the same socket at once. Each gets its own SSH channel; sshd opens a fresh `connect()` per channel; the publisher opens a fresh TCP connection to its local backend per channel. Capacity is limited by the publisher's bandwidth, not mad.

## Why non-members can't connect

`/run/mad/groups/demo/` is `2770 root:demo`. Without `x` on the directory, the kernel refuses `connect()` to anything inside before sshd even sees the request. The denial is filesystem ACL, not mad code.
