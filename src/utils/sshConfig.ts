import { hostname, homedir } from "os";
import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";

/**
 * Best-effort lookup of the gateway hostname so generated ssh_config
 * snippets point at something the user can actually connect to.
 *
 * Order of preference:
 * 1. Explicit override
 * 2. $SSH_CONNECTION's server-side IP (the address the user just dialed)
 * 3. Local hostname (works on the gateway box itself)
 */
export function gatewayHost(override?: string): string {
    if (override) return override;
    const conn = process.env.SSH_CONNECTION;
    if (conn) {
        const parts = conn.split(" ");
        if (parts.length >= 3 && parts[2]) return parts[2];
    }
    return hostname();
}

export function sshConfigBlock(alias: string, host: string, user: string): string {
    return `Host ${alias}
    HostName ${host}
    User ${user}
    IdentityFile ~/.ssh/id_ed25519
    # CertificateFile ~/.ssh/id_ed25519-cert.pub   # uncomment after \`mad cert refresh\`
    ServerAliveInterval 30
    ExitOnForwardFailure yes
    SetEnv MAD_GATEWAY=1
`;
}

export interface GatewayEntry {
    alias: string;
    hostName: string;
    user: string;
}

function sshConfigPath(): string {
    return join(homedir(), ".ssh", "config");
}

/**
 * Crude `Host …` scanner: collects every literal alias (no wildcards) from
 * the top-level ssh_config. Doesn't follow Include directives — `ssh -G`
 * later resolves the full effective config for each one so include chains
 * still get queried correctly when the alias matches an included block.
 */
function readHostAliases(): string[] {
    const path = sshConfigPath();
    if (!existsSync(path)) return [];
    const aliases: string[] = [];
    for (const raw of readFileSync(path, "utf-8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^Host\s+(.+)$/i);
        if (!m) continue;
        for (const token of m[1].split(/\s+/)) {
            if (token.includes("*") || token.includes("?") || token.startsWith("!")) continue;
            aliases.push(token);
        }
    }
    return aliases;
}

/** `ssh -G <alias>` dumps the effective config; SetEnv values come back lowercased. */
function effectiveConfig(alias: string): Map<string, string> {
    const r = spawnSync("ssh", ["-G", alias], { encoding: "utf-8" });
    const map = new Map<string, string>();
    if (r.status !== 0) return map;
    for (const line of (r.stdout ?? "").split("\n")) {
        const m = line.match(/^(\S+)\s+(.*)$/);
        if (m) {
            const k = m[1].toLowerCase();
            if (!map.has(k)) map.set(k, m[2]);
        }
    }
    return map;
}

/** Does this Host alias carry `SetEnv MAD_GATEWAY=1`? */
export function isMadGateway(alias: string): boolean {
    const cfg = effectiveConfig(alias);
    const setenv = cfg.get("setenv");
    if (!setenv) return false;
    return /\bmad_gateway=1\b/i.test(setenv);
}

export function listMadGateways(): GatewayEntry[] {
    const out: GatewayEntry[] = [];
    const seen = new Set<string>();
    for (const alias of readHostAliases()) {
        if (seen.has(alias)) continue;
        seen.add(alias);
        const cfg = effectiveConfig(alias);
        const setenv = cfg.get("setenv") ?? "";
        if (!/\bmad_gateway=1\b/i.test(setenv)) continue;
        out.push({
            alias,
            hostName: cfg.get("hostname") ?? alias,
            user: cfg.get("user") ?? process.env.USER ?? "root",
        });
    }
    return out;
}

export function appendHostBlock(alias: string, host: string, user: string): void {
    const path = sshConfigPath();
    const block = "\n" + sshConfigBlock(alias, host, user);
    if (existsSync(path)) {
        // Refuse to overwrite an existing Host block silently.
        for (const a of readHostAliases()) {
            if (a === alias) {
                throw new Error(`Host '${alias}' already exists in ${path}; remove it first or pick a different --alias`);
            }
        }
        appendFileSync(path, block);
    } else {
        writeFileSync(path, block);
    }
}

/**
 * Remove the `Host <alias>` block. Idempotent. Returns true if it removed
 * anything. Only matches blocks whose `Host` line is exactly the alias —
 * doesn't touch wildcards or multi-alias lines.
 */
export function removeHostBlock(alias: string): boolean {
    const path = sshConfigPath();
    if (!existsSync(path)) return false;
    const lines = readFileSync(path, "utf-8").split("\n");
    const out: string[] = [];
    let skipping = false;
    let removed = false;
    for (const line of lines) {
        const m = line.match(/^Host\s+(.+)$/i);
        if (m) {
            const tokens = m[1].trim().split(/\s+/);
            if (tokens.length === 1 && tokens[0] === alias) {
                skipping = true;
                removed = true;
                continue;
            }
            skipping = false;
            out.push(line);
            continue;
        }
        if (skipping) {
            if (/^\s*$/.test(line)) { skipping = false; continue; }
            // Body lines (indented or `Match`/`Host` boundaries handled above).
            continue;
        }
        out.push(line);
    }
    if (removed) writeFileSync(path, out.join("\n"));
    return removed;
}
