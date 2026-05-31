import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import chalk from "chalk";

interface TunStateEntry {
    gateway: string;
    group: string;
    localIfname: string;
    localIp: string;
    peerIp: string;
    sshPid: number;
    startedAt: number;
}
interface TunState { entries: TunStateEntry[]; }

const STATE_DIR = join(homedir(), ".config", "mad");
const STATE_FILE = join(STATE_DIR, "tun-state.json");

function loadState(): TunState {
    if (!existsSync(STATE_FILE)) return { entries: [] };
    try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); }
    catch { return { entries: [] }; }
}
function saveState(s: TunState): void {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function nextLocalIfname(prefix: "tap" | "tun"): string {
    const used = new Set(loadState().entries.map(e => e.localIfname));
    for (let i = 0; i < 100; i++) {
        const name = `${prefix}${i}`;
        if (!used.has(name) && spawnSync("ip", ["link", "show", "dev", name], { stdio: "ignore" }).status !== 0)
            return name;
    }
    throw new Error(`ran out of ${prefix} ifnames`);
}

function pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
}

export type TunMode = "l2" | "l3";

export async function tunJoin(gwGroup: string, requestedMode?: TunMode): Promise<void> {
    if (process.platform === "win32") {
        process.stderr.write("mad tun join is not yet supported on Windows.\n");
        process.stderr.write("  Workaround for direct-IP P2P games:\n");
        process.stderr.write("    mad service register <group>/<name> localhost:<gamePort>   (host)\n");
        process.stderr.write("    mad service use <gw>/<group>/<name> <gamePort>            (guests)\n");
        process.exit(2);
    }
    if (process.platform !== "linux" && process.platform !== "darwin") {
        process.stderr.write(`mad tun join requires Linux or macOS (you are on ${process.platform}).\n`);
        process.exit(2);
    }
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
        process.stderr.write("mad tun join requires root for `ip link` (try sudo).\n");
        process.exit(2);
    }

    let mode: TunMode = requestedMode ?? "l2";
    if (mode === "l2" && process.platform === "darwin") {
        if (requestedMode === "l2") {
            process.stderr.write("note: macOS has no native TAP driver — falling back to --l3 (point-to-point).\n");
        }
        mode = "l3";
    }

    const parts = gwGroup.split("/");
    if (parts.length !== 2) throw new Error("expected <gateway>/<group>");
    const [gateway, group] = parts;

    const ifPrefix: "tap" | "tun" = mode === "l2" ? "tap" : "tun";
    const localIfname = nextLocalIfname(ifPrefix);

    // Pre-create the local tap; socat below will TUNSETIFF onto it and
    // become the fd holder. Bump txqueuelen so the kernel doesn't drop
    // frames when the SSH socket briefly stalls.
    const tuntapAdd = spawnSync("ip", ["tuntap", "add", "mode", ifPrefix, "name", localIfname], { stdio: ["ignore", "ignore", "pipe"] });
    if (tuntapAdd.status !== 0) {
        process.stderr.write(`ip tuntap add ${localIfname}: ${(tuntapAdd.stderr ?? "").toString().trim()}\n`);
        process.exit(1);
    }
    spawnSync("ip", ["link", "set", "dev", localIfname, "txqueuelen", "10000"], { stdio: "inherit" });
    spawnSync("ip", ["link", "set", "dev", localIfname, "up"], { stdio: "inherit" });
    // fq_codel drops aggressively to keep its 5ms latency target; over a
    // high-RTT tunnel that destroys TCP. pfifo_fast: queue + drop only on
    // txqueuelen overflow.
    spawnSync("tc", ["qdisc", "replace", "dev", localIfname, "root", "pfifo_fast"], { stdio: "ignore" });

    // socat does the heavy lifting: spawn ssh, forward stdio↔tap. socat's
    // SYSTEM address opens a child process and pipes; TUN address opens
    // /dev/net/tun and TUNSETIFFs to the existing local tap.
    // SSH_ORIGINAL_COMMAND only carries the subcommand — no leading "mad"
    // (ForceCommand prepends the binary path itself).
    const modeFlag = mode === "l3" ? "--l3" : "";
    const sshArgs = [
        "-o", "ServerAliveInterval=30",
        "-o", "ExitOnForwardFailure=yes",
        gateway,
        "tun-attach", group, modeFlag,
    ].filter(Boolean);

    process.stdout.write(`opening ${ifPrefix} ${localIfname} (${mode === "l2" ? "L2 bridged" : "L3 routed"}) via ssh ${gateway}…\n`);
    const ssh = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });

    let stderrBuf = "";
    let assigned: { ip: string; peerIp: string } | null = null;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            ssh.kill("SIGTERM");
            reject(new Error("timed out waiting for gateway to allocate IP"));
        }, 15_000);
        ssh.stderr.on("data", (c) => {
            const s = c.toString();
            stderrBuf += s;
            process.stderr.write(s);
            const m = stderrBuf.match(/MAD_TUN_OK\s+\S+\s+(\S+)\s+peer=(\S+)/);
            if (m && !assigned) {
                assigned = { ip: m[1], peerIp: m[2] };
                clearTimeout(timer);
                resolve();
            }
        });
        ssh.on("exit", (code) => {
            clearTimeout(timer);
            if (!assigned) reject(new Error(`ssh exited (${code}) before allocating IP`));
        });
    });

    if (!assigned) throw new Error("no allocation");
    const ourIp = assigned.peerIp;
    if (mode === "l3") {
        // /32 with the gateway end as explicit peer — matches the daemon
        // side and gives us a clean point-to-point route.
        const ourBase = ourIp.split("/")[0];
        const peerBase = assigned.ip.split("/")[0];
        spawnSync("ip", ["addr", "add", `${ourBase}/32`, "peer", `${peerBase}/32`, "dev", localIfname], { stdio: "inherit" });
    } else {
        spawnSync("ip", ["addr", "add", ourIp, "dev", localIfname], { stdio: "inherit" });
    }

    // Open the local tap and start pumping length-prefixed frames between
    // it and ssh's stdio. See utils/tapPipe.ts for the framing rationale
    // (socat over a byte stream loses TUN frame boundaries).
    const { openTap, pump } = await import("../utils/tapPipe");
    const fd = openTap(localIfname, mode);

    const state = loadState();
    state.entries.push({
        gateway, group,
        localIfname,
        localIp: ourIp,
        peerIp: assigned.ip,
        sshPid: ssh.pid ?? -1,
        startedAt: Date.now(),
    });
    saveState(state);

    process.stdout.write("\n" + chalk.green(`✔ ${gateway}/${group} ${localIfname} ${ourIp} (${mode.toUpperCase()})`) + "\n");
    process.stdout.write(`  ssh pid ${ssh.pid} — leave with: ${chalk.yellow(`mad tap leave ${gateway}/${group}`)}\n`);

    // Detach: pump runs in this process until ssh exits or fd closes.
    // We deliberately don't `ssh.unref()` here — the pump keeps the
    // event loop alive on its own.
    pump({ fd, remoteIn: ssh.stdout, remoteOut: ssh.stdin })
        .catch(e => process.stderr.write(`mad tap pump: ${e.message}\n`));
}

export async function tunLeave(gwGroup: string): Promise<void> {
    const parts = gwGroup.split("/");
    if (parts.length !== 2) throw new Error("expected <gateway>/<group>");
    const [gateway, group] = parts;
    const state = loadState();
    const matches = state.entries.filter(e => e.gateway === gateway && e.group === group);
    if (matches.length === 0) {
        process.stderr.write(`no active tun for ${gwGroup}\n`);
        process.exit(1);
    }
    for (const e of matches) {
        if (pidAlive(e.sshPid)) {
            try { process.kill(e.sshPid, "SIGTERM"); } catch {}
        }
        if (process.platform === "linux") {
            spawnSync("ip", ["link", "delete", e.localIfname], { stdio: "ignore" });
        }
        process.stdout.write(`✔ left ${e.gateway}/${e.group} (${e.localIfname})\n`);
    }
    state.entries = state.entries.filter(e => !matches.includes(e));
    saveState(state);
}

export async function tunList(filter?: "tap" | "tun"): Promise<void> {
    const state = loadState();
    const entries = filter
        ? state.entries.filter(e => e.localIfname.startsWith(filter))
        : state.entries;
    if (entries.length === 0) {
        process.stdout.write(`(no active ${filter ?? "tun/tap"} sessions)\n`);
        return;
    }
    process.stdout.write("gateway\tgroup\tifname\tip\tsocatPid\tstatus\n");
    for (const e of entries) {
        const alive = pidAlive(e.sshPid);
        process.stdout.write(`${e.gateway}\t${e.group}\t${e.localIfname}\t${e.localIp}\t${e.sshPid}\t${alive ? "alive" : "dead"}\n`);
    }
}
