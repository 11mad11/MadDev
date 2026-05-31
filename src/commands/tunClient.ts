import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
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

function nextLocalIfname(): string {
    const used = new Set(loadState().entries.map(e => e.localIfname));
    for (let i = 0; i < 100; i++) {
        const name = `tun${i}`;
        if (!used.has(name)) return name;
    }
    throw new Error("ran out of tun ifnames (tun0..tun99 all in use)");
}

function ifnameNumber(name: string): number {
    const m = name.match(/^tun(\d+)$/);
    if (!m) throw new Error(`bad ifname: ${name}`);
    return parseInt(m[1], 10);
}

function pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
}

export async function tunJoin(gwGroup: string): Promise<void> {
    if (process.platform !== "linux" && process.platform !== "darwin") {
        process.stderr.write(`mad tun join requires Linux or macOS (you are on ${process.platform}).\n`);
        process.stderr.write("  Use port forwarding instead — see `mad service register/use`.\n");
        process.exit(2);
    }
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
        process.stderr.write("mad tun join requires root for `ip link` (try sudo).\n");
        process.exit(2);
    }
    const parts = gwGroup.split("/");
    if (parts.length !== 2) throw new Error("expected <gateway>/<group>");
    const [gateway, group] = parts;

    const localIfname = nextLocalIfname();
    const tunNum = ifnameNumber(localIfname);

    // ssh -w <local>:<remote> ⇒ both ends get tun<N> with matching numbers.
    // Use the same number on both sides so paths are predictable.
    const sshArgs = [
        "-w", `${tunNum}:${tunNum}`,
        "-o", "ServerAliveInterval=30",
        "-o", "ExitOnForwardFailure=yes",
        gateway,
        "tun-attach", group, localIfname,
    ];

    process.stdout.write(`opening tun ${localIfname} via ssh ${gateway}…\n`);
    const ssh = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });

    let stdoutBuf = "";
    let assigned: { ip: string; peerIp: string } | null = null;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            ssh.kill("SIGTERM");
            reject(new Error("timed out waiting for gateway to allocate IP"));
        }, 10_000);
        ssh.stdout.on("data", (c) => {
            stdoutBuf += c.toString();
            const m = stdoutBuf.match(/MAD_TUN_OK\s+\S+\s+(\S+)\s+peer=(\S+)/);
            if (m) {
                assigned = { ip: m[1], peerIp: m[2] };
                clearTimeout(timer);
                resolve();
            }
        });
        ssh.stderr.on("data", (c) => process.stderr.write(c));
        ssh.on("exit", (code) => {
            clearTimeout(timer);
            if (!assigned) reject(new Error(`ssh exited with code ${code} before allocating IP`));
        });
    });

    if (!assigned) throw new Error("no allocation");

    // Configure the client-side tun. ssh -w already created it (and set it
    // down by default on Linux). We give it the peer IP and bring it up.
    const peerIpNoPrefix = (assigned as any).peerIp.split("/")[0];
    const localPrefix = (assigned as any).ip.split("/")[1];
    const localIpForUs = `${peerIpNoPrefix}/${localPrefix}`;
    spawnSync("ip", ["addr", "add", localIpForUs, "dev", localIfname], { stdio: "inherit" });
    spawnSync("ip", ["link", "set", "dev", localIfname, "up"], { stdio: "inherit" });

    const state = loadState();
    state.entries.push({
        gateway, group,
        localIfname,
        localIp: localIpForUs,
        peerIp: (assigned as any).ip,
        sshPid: ssh.pid ?? -1,
        startedAt: Date.now(),
    });
    saveState(state);

    process.stdout.write("\n" + chalk.green(`✔ ${gateway}/${group} ${localIfname} ${localIpForUs}`) + "\n");
    process.stdout.write(`  ssh pid ${ssh.pid} — leave with: ${chalk.yellow(`mad tun leave ${gateway}/${group}`)}\n`);
    ssh.unref();
    // Detach: our own process can exit; the ssh keeps running in the background.
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
        // ssh torn down → kernel removes the tun device. Belt-and-suspenders:
        if (process.platform === "linux") {
            spawnSync("ip", ["link", "delete", e.localIfname], { stdio: "ignore" });
        }
        process.stdout.write(`✔ left ${e.gateway}/${e.group} (${e.localIfname})\n`);
    }
    state.entries = state.entries.filter(e => !matches.includes(e));
    saveState(state);
}

export async function tunList(): Promise<void> {
    const state = loadState();
    if (state.entries.length === 0) {
        process.stdout.write("(no active tun sessions)\n");
        return;
    }
    process.stdout.write("gateway\tgroup\tifname\tip\tsshPid\tstatus\n");
    for (const e of state.entries) {
        const alive = pidAlive(e.sshPid);
        process.stdout.write(`${e.gateway}\t${e.group}\t${e.localIfname}\t${e.localIp}\t${e.sshPid}\t${alive ? "alive" : "dead"}\n`);
    }
}
