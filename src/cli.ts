import { Command } from "@commander-js/extra-typings";
import { readFileSync, mkdirSync, chmodSync, writeFileSync, existsSync } from "fs";
import menu from "./commands";
import { runMenu, runExec, Ctx } from "./menu";
import { runHelpCli, helpTopics } from "./commands/help";
import { fixedInquirer } from "./utils/inquirer";
import { currentUid, currentUsername, getCurrentUserGroups } from "./groups";
import { daemon } from "./daemon/client";
import { runDaemon } from "./daemon/server";
import { requireLinuxRoot } from "./utils/platform";
import { runEnroll } from "./commands/enroll";
import { runSetup } from "./commands/setup";
import { runUpdate } from "./commands/update";
import { CA } from "./ca";
import { createGroupAll } from "./commands/admin/group";
import { listServices } from "./services/discover";
import { forgetUserKeysAll } from "./commands/admin/user";
import { deleteUser } from "./groups";

const CA_KEY_PATH = "/etc/mad/ca/ca.key";

function buildCtx(mode: "shell" | "exec"): Ctx {
    const input = process.stdin;
    const output = process.stdout;
    return {
        username: currentUsername(),
        uid: currentUid(),
        groups: getCurrentUserGroups(),
        input,
        output,
        inquirer: fixedInquirer({ input, output }),
        mode,
    };
}

async function main() {
    const program = new Command();
    program.name("mad").description("Linux-native SSH gateway helper");

    program.command("daemon")
        .description("Run the privileged daemon (root)")
        .action(async () => {
            requireLinuxRoot("mad daemon");
            await runDaemon();
        });

    program.command("setup")
        .description("Idempotently provision groups, dirs, CA, sshd snippet, and systemd unit (root)")
        .action(async () => {
            requireLinuxRoot("mad setup");
            await runSetup();
        });

    program.command("update")
        .description("git pull + bun install + setup + restart daemon (root)")
        .action(async () => {
            requireLinuxRoot("mad update");
            await runUpdate();
        });

    program.command("enroll")
        .description("First-time enrollment: writes your pubkey to authorized_keys and locks the OTP password")
        .action(async () => {
            await runEnroll();
        });

    program.command("help")
        .description("Render a doc page in the terminal")
        .argument("[topic]", "doc file under docs/ (omit for the index)")
        .action((topic) => runHelpCli(topic));

    const gateway = program.command("gateway").description("Add / list / remove mad gateways in ~/.ssh/config");
    gateway.command("add")
        .description("Append a Host block for a gateway")
        .argument("<user@host>")
        .option("--alias <name>", "Host alias")
        .action(async (spec, opts) => {
            const { appendHostBlock } = await import("./utils/sshConfig");
            const m = spec.match(/^([^@]+)@(.+)$/);
            if (!m) throw new Error(`expected user@host, got '${spec}'`);
            const alias = opts.alias ?? m[2].split(".")[0];
            appendHostBlock(alias, m[2], m[1]);
            process.stdout.write(`added Host ${alias} → ${m[1]}@${m[2]}\n`);
            const { spawnSync } = await import("child_process");
            const r = spawnSync("ssh", ["-o", "StrictHostKeyChecking=accept-new", alias, "ca", "pubkey"], { encoding: "utf-8" });
            if (r.status === 0) process.stdout.write(`✔ ${alias} CA: ${(r.stdout ?? "").trim()}\n`);
            else process.stderr.write(`! ssh ${alias} ca pubkey failed: ${(r.stderr ?? "").trim()}\n`);
        });
    gateway.command("ls")
        .description("List mad gateways in ssh_config")
        .action(async () => {
            const { listMadGateways } = await import("./utils/sshConfig");
            const gws = listMadGateways();
            if (!gws.length) { process.stdout.write("(no gateways)\n"); return; }
            for (const g of gws) process.stdout.write(`${g.alias}\t${g.user}@${g.hostName}\n`);
        });
    gateway.command("rm")
        .description("Remove a gateway's Host block")
        .argument("<alias>")
        .action(async (alias) => {
            const { removeHostBlock } = await import("./utils/sshConfig");
            const ok = removeHostBlock(alias);
            process.stdout.write(ok ? `removed Host ${alias}\n` : `no Host '${alias}' found\n`);
        });
    gateway.command("test")
        .description("Round-trip-ping a gateway")
        .argument("<alias>")
        .action(async (alias) => {
            const { spawnSync } = await import("child_process");
            const t0 = Date.now();
            const r = spawnSync("ssh", [alias, "ca", "pubkey"], { encoding: "utf-8" });
            const ms = Date.now() - t0;
            if (r.status === 0) process.stdout.write(`✔ ${alias} ${ms}ms\n  ${(r.stdout ?? "").trim()}\n`);
            else { process.stderr.write(`✘ ${alias}: ${(r.stderr ?? "").trim()}\n`); process.exit(1); }
        });

    program.command("ssh-config")
        .description("Print an ssh_config Host block for paste-into-~/.ssh/config")
        .option("--alias <name>", "Host alias", "mad")
        .option("--host <hostname>", "Override the gateway hostname")
        .action(async (opts) => {
            const { gatewayHost, sshConfigBlock } = await import("./utils/sshConfig");
            const host = gatewayHost(opts.host);
            process.stdout.write(sshConfigBlock(opts.alias!, host, currentUsername()));
        });

    const ca = program.command("ca");
    ca.command("pubkey")
        .description("Print the CA public key")
        .action(async () => {
            if (process.getuid?.() === 0) {
                const c = new CA(CA_KEY_PATH);
                process.stdout.write(c.publicKey() + "\n");
            } else {
                const r = await daemon.caPubkey();
                process.stdout.write(r.pubkey + "\n");
            }
        });
    ca.command("sign")
        .description("Sign a public key on stdin (root)")
        .argument("<username>", "Username the cert binds to")
        .action(async (username) => {
            const pubkey = readFileSync(0, "utf-8");
            if (process.getuid?.() === 0) {
                const c = new CA(CA_KEY_PATH);
                process.stdout.write(c.signSSHKey(pubkey, username) + "\n");
            } else {
                const r = await daemon.caSign(pubkey, username);
                process.stdout.write(r.cert + "\n");
            }
        });

    ca.command("krl")
        .description("Print the current signed KRL (binary, base64-encoded). Devices fetch this to refresh /etc/ssh/mad_krl.")
        .option("--raw", "Emit raw binary KRL instead of base64", false)
        .action(async (opts) => {
            const r = await daemon.caKrl();
            if (opts.raw) process.stdout.write(Buffer.from(r.krl, "base64"));
            else process.stdout.write(r.krl + "\n");
        });

    const cert = program.command("cert");
    cert.command("refresh")
        .description("Re-sign your pubkey (from stdin) with your current mad-group memberships as principals")
        .action(async () => {
            const pubkey = readFileSync(0, "utf-8");
            const r = await daemon.refreshCert(pubkey);
            process.stdout.write(r.cert + "\n");
        });
    cert.command("ls")
        .description("List certs issued by the CA")
        .option("--user <user>", "Filter by username")
        .action(async (opts) => {
            const certs = await daemon.listCerts(opts.user);
            const revoked = new Set((await daemon.listRevoked()).map(r => r.serial));
            if (certs.length === 0) { process.stdout.write("(none)\n"); return; }
            const now = Date.now();
            for (const c of certs) {
                const expired = c.expiresAt < now;
                const status = revoked.has(c.serial) ? "revoked" : expired ? "expired" : "active";
                process.stdout.write(`${c.serial}\t${c.username}\t${status}\t${new Date(c.issuedAt).toISOString().slice(0, 10)}..${new Date(c.expiresAt).toISOString().slice(0, 10)}\t${c.fingerprint}\n`);
            }
        });
    cert.command("revoke")
        .description("Revoke a cert by serial, or all certs for a user (root)")
        .option("--serial <n>", "Cert serial to revoke")
        .option("--user <user>", "Revoke all currently-issued certs for this user")
        .option("--reason <text>", "Free-text reason")
        .action(async (opts) => {
            if (!opts.serial && !opts.user) throw new Error("pass --serial or --user");
            const r = await daemon.revokeCert({
                serial: opts.serial ? parseInt(opts.serial as string, 10) : undefined,
                username: opts.user,
                reason: opts.reason,
            });
            process.stdout.write(`revoked ${r.revoked.length} cert(s):\n`);
            for (const rec of r.revoked) process.stdout.write(`  serial=${rec.serial} user=${rec.username}\n`);
        });
    cert.command("unrevoke")
        .description("Un-revoke a cert by serial (root)")
        .argument("<serial>")
        .action(async (serialStr) => {
            const serial = parseInt(serialStr, 10);
            await daemon.unrevokeCert(serial);
            process.stdout.write(`unrevoked serial ${serial}\n`);
        });

    const group = program.command("group");
    group.command("create")
        .description("Create a Linux group + /run/mad/groups directory")
        .argument("<name>")
        .option("--subnet <cidr>", "Optional L2 VPN subnet")
        .action(async (name, opts) => {
            await createGroupAll(name, opts.subnet);
            process.stdout.write(`created group ${name}\n`);
        });
    group.command("ls")
        .description("List mad groups")
        .action(() => {
            if (!existsSync("/run/mad/groups")) { process.stdout.write("(none)\n"); return; }
            const { readdirSync, statSync } = require("fs");
            for (const e of readdirSync("/run/mad/groups")) {
                const s = statSync(`/run/mad/groups/${e}`);
                process.stdout.write(`${e}\tuid=${s.uid} gid=${s.gid} mode=${(s.mode & 0o7777).toString(8)}\n`);
            }
        });
    group.command("members")
        .description("List members of a group")
        .argument("<name>")
        .action((name) => {
            const { getGroupMembers } = require("./groups");
            const m = getGroupMembers(name);
            if (!m.length) process.stdout.write("(no members)\n");
            for (const u of m) process.stdout.write(u + "\n");
        });
    group.command("add")
        .description("Add a user to a group")
        .argument("<group>").argument("<user>")
        .action((g, u) => {
            const { addUserToGroup } = require("./groups");
            addUserToGroup(u, g);
        });
    group.command("rm")
        .description("Remove a user from a group")
        .argument("<group>").argument("<user>")
        .action((g, u) => {
            const { removeUserFromGroup } = require("./groups");
            removeUserFromGroup(u, g);
        });

    const user = program.command("user");
    user.command("del")
        .description("Delete a Linux user")
        .argument("<name>")
        .action((name) => deleteUser(name, true));
    user.command("forget-keys")
        .description("Wipe a user's authorized_keys (blocks GATEWAY login; doesn't touch the KRL)")
        .argument("<name>")
        .action((name) => forgetUserKeysAll(name));
    user.command("lockout")
        .description("Block both gateway AND device access: cert revoke --user + user forget-keys")
        .argument("<name>")
        .option("--reason <text>", "Reason recorded with the revocation")
        .action(async (name, opts) => {
            const r = await daemon.revokeCert({ username: name, reason: opts.reason ?? "lockout" });
            process.stdout.write(`revoked ${r.revoked.length} cert(s) on the KRL\n`);
            forgetUserKeysAll(name);
            process.stdout.write(`cleared ${name}'s authorized_keys\n`);
        });

    const service = program.command("service");
    service.command("ls")
        .description("List visible services (filters orphan sockets; fans out across mad gateways by default)")
        .argument("[group]")
        .option("--gateway <alias>", "Query a single gateway instead of all")
        .option("--local-only", "Skip the fan-out; just read /run/mad/groups here")
        .option("--json", "Emit JSON for scripting / cross-gateway fanout")
        .option("--orphans", "Include orphan socket files (no live listener)")
        .action(async (group, opts) => {
            const { listMadGateways } = await import("./utils/sshConfig");
            const { listServicesAcross } = await import("./services/discoverRemote");

            const fanoutTargets = opts.localOnly
                ? []
                : (opts.gateway
                    ? listMadGateways().filter(g => g.alias === opts.gateway)
                    : listMadGateways());

            if (fanoutTargets.length === 0) {
                const list = listServices(group, !!opts.orphans);
                if (opts.json) { process.stdout.write(JSON.stringify(list) + "\n"); return; }
                if (!list.length) { process.stdout.write("(none visible)\n"); return; }
                for (const s of list) process.stdout.write(`${s.group}/${s.name}\t${s.socketPath}\n`);
                return;
            }

            const result = await listServicesAcross(fanoutTargets, group);
            if (opts.json) { process.stdout.write(JSON.stringify(result) + "\n"); return; }

            if (result.services.length === 0 && result.errors.length === 0) {
                process.stdout.write("(none visible)\n");
            }
            for (const s of result.services) {
                process.stdout.write(`${s.gateway}/${s.group}/${s.name}\t${s.socketPath}\n`);
            }
            for (const e of result.errors) {
                process.stderr.write(`! ${e.gateway}: ${e.error}\n`);
            }
        });
    service.command("register")
        .description("Print the ssh -R command to register a service (accepts gateway/group/name or group/name)")
        .argument("<spec>", "gateway/group/name or group/name")
        .argument("<target>", "local addr:port")
        .action((spec, target) => {
            const parts = spec.split("/");
            const alias = parts.length === 3 ? parts[0] : "mad";
            const g = parts.length === 3 ? parts[1] : parts[0];
            const n = parts.length === 3 ? parts[2] : parts[1];
            if (!g || !n) throw new Error("expected <gateway>/<group>/<name> or <group>/<name>");
            process.stdout.write(`ssh -R /run/mad/groups/${g}/${n}.sock:${target} ${alias} service hold ${g}/${n}\n`);
        });
    service.command("use")
        .description("Print the ssh -L command to use a service (accepts gateway/group/name or group/name)")
        .argument("<spec>", "gateway/group/name or group/name")
        .argument("<localport>")
        .action((spec, localport) => {
            const parts = spec.split("/");
            const alias = parts.length === 3 ? parts[0] : "mad";
            const g = parts.length === 3 ? parts[1] : parts[0];
            const n = parts.length === 3 ? parts[2] : parts[1];
            if (!g || !n) throw new Error("expected <gateway>/<group>/<name> or <group>/<name>");
            process.stdout.write(`ssh -L ${localport}:/run/mad/groups/${g}/${n}.sock ${alias} service ping ${g}/${n}\n`);
        });
    service.command("hold")
        .description("Hold an ssh -R session; on boot, sweep any orphan sockets in the same group dir")
        .argument("<groupname>", "group/name (the path = /run/mad/groups/<group>/<name>.sock)")
        .action(async (groupname) => {
            const [g, n] = groupname.split("/");
            if (!g || !n) throw new Error("expected <group>/<name>");
            const dir = `/run/mad/groups/${g}`;
            const path = `${dir}/${n}.sock`;
            const { existsSync, readdirSync, unlinkSync } = await import("fs");
            const { spawnSync } = await import("child_process");
            // sshd reaps the entire session cgroup on disconnect — even
            // detached/setsid children get killed — so we can't reliably
            // clean up THIS socket at our own death. Instead, cleanup
            // happens at the *next* hold: sweep dead siblings in the same
            // group dir on startup. Combined with sshd's own pre-bind
            // unlink, the steady-state behaviour is "orphan sockets exist
            // briefly between disconnect and next registration".
            try {
                const ssOut = (spawnSync("ss", ["-xlH"], { encoding: "utf-8" }).stdout ?? "");
                let swept = 0;
                if (existsSync(dir)) {
                    for (const entry of readdirSync(dir)) {
                        if (!entry.endsWith(".sock")) continue;
                        const p = `${dir}/${entry}`;
                        if (p === path) continue;
                        if (!ssOut.includes(p)) {
                            try { unlinkSync(p); swept++; } catch {}
                        }
                    }
                }
                if (swept > 0) process.stderr.write(`mad service hold: swept ${swept} orphan socket(s) in ${dir}\n`);
            } catch {}
            setInterval(() => {}, 60_000);
        });

    service.command("ping")
        .description("Check the registered socket is bound; hold while it is. Use with ssh -L instead of -N.")
        .argument("<groupname>", "group/name")
        .option("--interval <s>", "Re-check interval in seconds", "5")
        .action(async (groupname, opts) => {
            const [g, n] = groupname.split("/");
            if (!g || !n) throw new Error("expected <group>/<name>");
            const path = `/run/mad/groups/${g}/${n}.sock`;
            const { spawnSync } = await import("child_process");
            const isLive = () => {
                const r = spawnSync("ss", ["-xlH"], { encoding: "utf-8" });
                return (r.stdout ?? "").split("\n").some(l => l.includes(path));
            };
            if (!isLive()) {
                process.stderr.write(`mad service ping: ${path} is not bound by any process\n`);
                process.exit(1);
            }
            const intervalMs = Math.max(1, parseInt(opts.interval as string, 10)) * 1000;
            const originalPpid = process.ppid;
            const t = setInterval(() => {
                if (process.ppid !== originalPpid) { clearInterval(t); process.exit(0); }
                if (!isLive()) {
                    process.stderr.write(`mad service ping: ${path} disappeared, exiting\n`);
                    clearInterval(t);
                    process.exit(1);
                }
            }, intervalMs);
        });

    service.command("install")
        .description("Print install script: auto-forward a local service to mad via systemd")
        .argument("<groupname>", "<group>/<name>")
        .argument("<target>", "local addr:port")
        .option("--scope <scope>", "user | system", "user")
        .option("--server-host <host>", "mad server hostname for ssh_config")
        .option("--server-user <user>", "mad username on the server")
        .action(async (groupname, target, opts) => {
            const { forwardingScript } = await import("./commands/install");
            const [g, n] = groupname.split("/");
            if (!g || !n) throw new Error("expected <group>/<name>");
            const fromOriginal = (process.env.SSH_CONNECTION ?? "").split(" ")[2] || "mad-server";
            const sshUser = opts.serverUser ?? currentUsername();
            process.stdout.write(forwardingScript({
                group: g, name: n, target,
                serverHost: opts.serverHost ?? fromOriginal,
                sshUser,
                scope: (opts.scope as "user" | "system"),
            }));
        });
    service.command("install-ssh")
        .description("Print install script: share this device's sshd through mad")
        .argument("<group/device>", "e.g. demo/dev01")
        .option("--tech-user <name>", "Linux user techs log in as", "mad-tech")
        .option("--scope <scope>", "user | system", "system")
        .option("--server-host <host>", "mad server hostname")
        .option("--server-user <user>", "mad username on the server")
        .action(async (groupDevice, opts) => {
            const { sshShareScript } = await import("./commands/install");
            const [group, deviceName] = groupDevice.split("/");
            if (!group || !deviceName) throw new Error("expected <group>/<device>");
            const fromOriginal = (process.env.SSH_CONNECTION ?? "").split(" ")[2] || "mad-server";
            const sshUser = opts.serverUser ?? currentUsername();
            const [caResp, krlResp] = await Promise.all([daemon.caPubkey(), daemon.caKrl()]);
            process.stdout.write(sshShareScript({
                group,
                deviceName,
                techUser: opts.techUser ?? "mad-tech",
                serverHost: opts.serverHost ?? fromOriginal,
                sshUser,
                scope: (opts.scope as "user" | "system"),
            }, caResp.pubkey, krlResp.krl));
        });

    program.command("tun-attach")
        .description("Gateway-side glue for `ssh <gw> mad tun-attach <group>` — pipes Ethernet frames between stdio and a daemon-allocated tap")
        .argument("<group>")
        .option("--l3", "Use L3 (TUN) instead of L2 (TAP)")
        .action(async (group, opts) => {
            const mode: "l2" | "l3" = opts.l3 ? "l3" : "l2";
            const r = await daemon.tapAllocate(group, mode);

            // Single control line on stderr — the client parses this; stdout
            // is now the frame channel and must stay clean.
            process.stderr.write(`MAD_TUN_OK ${r.ifname} ${r.ip} peer=${r.peerIp} group=${r.group} mode=${r.mode}\n`);

            const { createConnection } = await import("net");
            const sock = createConnection(r.socketPath);

            // Switch stdin to raw byte mode (avoid TTY line discipline if
            // present; here it's a plain pipe from sshd but be safe).
            (process.stdin as any).setRawMode?.(true);

            sock.on("connect", () => {
                process.stdin.pipe(sock);
                sock.pipe(process.stdout);
            });

            let cleaning = false;
            const cleanup = async () => {
                if (cleaning) return;
                cleaning = true;
                try { sock.destroy(); } catch {}
                try { await daemon.tunRelease(r.ifname); } catch {}
                process.exit(0);
            };
            sock.on("error", e => { process.stderr.write(`mad tun-attach socket: ${e.message}\n`); cleanup(); });
            sock.on("close", cleanup);
            process.stdin.on("end", cleanup);
            process.on("SIGHUP", cleanup);
            process.on("SIGTERM", cleanup);
            process.on("SIGINT", cleanup);
            const originalPpid = process.ppid;
            setInterval(() => {
                if (process.ppid !== originalPpid) cleanup();
            }, 1000);
        });

    const tun = program.command("tun").description("L2/L3 tunnel from this machine into a group's network via ssh -w");
    tun.command("join")
        .description("Open a tun/tap tunnel into <gateway>/<group> — L2 by default (Linux/macOS, root required)")
        .argument("<gw/group>", "gateway alias + group name, e.g. mad/marc")
        .option("--l3", "Force L3 mode (point-to-point TUN, no broadcast). Default is L2 (TAP, bridged, carries broadcast/ARP — needed for LAN-discovery P2P games).")
        .action(async (spec, opts) => {
            const { tunJoin } = await import("./commands/tunClient");
            await tunJoin(spec, opts.l3 ? "l3" : "l2");
        });
    tun.command("leave")
        .description("Close a tun tunnel previously opened by `tun join`")
        .argument("<gw/group>")
        .action(async (spec) => {
            const { tunLeave } = await import("./commands/tunClient");
            await tunLeave(spec);
        });
    tun.command("ls")
        .description("List active tun tunnels on this machine")
        .action(async () => {
            const { tunList } = await import("./commands/tunClient");
            await tunList();
        });

    program.command("otp")
        .description("Create a one-time enrollment code (root)")
        .argument("<username>")
        .action(async (username) => {
            const r = await daemon.createOtp(username);
            process.stdout.write(`${r.otp}\n`);
        });

    program.action(async () => {
        const ctx = buildCtx("shell");
        const code = await runMenu(ctx, menu);
        process.exit(code);
    });

    program.exitOverride();

    const original = process.env.SSH_ORIGINAL_COMMAND;
    const argv = original
        ? ["node", "mad", ...original.split(/\s+/).filter(Boolean)]
        : process.argv;

    try {
        await program.parseAsync(argv);
    } catch (e: any) {
        if (e?.code === "commander.helpDisplayed" || e?.code === "commander.help") return;
        process.stderr.write((e?.message ?? String(e)) + "\n");
        process.exit(e?.exitCode ?? 1);
    }
}

main().catch((e) => {
    process.stderr.write((e?.message ?? String(e)) + "\n");
    process.exit(1);
});
