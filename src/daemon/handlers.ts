import { execFileSync, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync, chownSync, appendFileSync, statSync } from "fs";
import { CA } from "../ca";
import { assertValidName, getGroupGid, getGroupMembers, getUserGid, getUserGroups, getUserHome, getUserPrimaryGroup, getUserUid, userExists } from "../groups";
import { CertRecord, DaemonState, GroupNetns, OtpRecord, PeerCred, Request, Response, RevocationRecord, TapRecord } from "./protocol";
import { saveState } from "./state";

const KRL_PATH = "/etc/ssh/mad_krl";
const CERT_VALIDITY_WEEKS = parseEnvInt(process.env.MAD_CERT_VALIDITY_WEEKS, 520);

function parseEnvInt(v: string | undefined, fallback: number): number {
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

const OTP_TTL_MS = 15 * 60 * 1000;

export interface HandlerCtx {
    state: DaemonState;
    ca: CA;
    peer: PeerCred;
    isRootSocket: boolean;
}

function requireRoot(ctx: HandlerCtx): void {
    if (!ctx.isRootSocket || ctx.peer.uid !== 0)
        throw new Error("root only");
}

function requireGroup(ctx: HandlerCtx, group: string): void {
    assertValidName(group);
    if (ctx.peer.uid === 0) return;
    const username = usernameFromUid(ctx.peer.uid);
    if (!username) throw new Error("unknown caller");
    const groups = getUserGroups(username);
    if (!groups.includes(group))
        throw new Error(`not a member of group: ${group}`);
}

function usernameFromUid(uid: number): string | undefined {
    const r = spawnSync("id", ["-nu", String(uid)], { encoding: "utf-8" });
    if (r.status !== 0) return undefined;
    return r.stdout.trim();
}

function bridgeName(group: string): string {
    return `mad-${group}`.slice(0, 15);
}

function tapName(group: string, uid: number): string {
    return `tap-${group.slice(0, 6)}-${uid}`.slice(0, 15);
}

function ip(args: string[]): void {
    execFileSync("ip", args, { stdio: ["ignore", "ignore", "pipe"] });
}

function ipExists(args: string[]): boolean {
    return spawnSync("ip", args, { stdio: "ignore" }).status === 0;
}

function ensureBridge(group: string, subnet: string): GroupNetns {
    const br = bridgeName(group);
    if (!ipExists(["link", "show", "dev", br])) {
        ip(["link", "add", "name", br, "type", "bridge"]);
        ip(["link", "set", "dev", br, "up"]);
        const gateway = subnetHost(subnet, 1);
        const prefix = subnet.split("/")[1];
        ip(["addr", "add", `${gateway}/${prefix}`, "dev", br]);
    }
    return { group, subnet, nextHost: 2 };
}

function subnetHost(subnet: string, host: number): string {
    const [base] = subnet.split("/");
    const parts = base.split(".");
    parts[3] = String(host);
    return parts.join(".");
}

export function handle(req: Request, ctx: HandlerCtx): Response {
    try {
        const data = dispatch(req, ctx);
        return { ok: true, data };
    } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
    }
}

function dispatch(req: Request, ctx: HandlerCtx): any {
    switch (req.op) {
        case "create-group-netns": return createGroupNetns(req, ctx);
        case "delete-group-netns": return deleteGroupNetns(req, ctx);
        case "allocate-tap":       return allocateTap(req, ctx);
        case "release-tap":        return releaseTap(req, ctx);
        case "list-taps":          return listTaps(ctx);
        case "create-otp":         return createOtp(req, ctx);
        case "enroll-self":        return enrollSelf(req, ctx);
        case "ca-sign":            return caSign(req, ctx);
        case "ca-pubkey":          return { pubkey: ctx.ca.publicKey() };
        case "ca-krl":             return { krl: ctx.ca.generateKrl(ctx.state.revoked.map(r => r.serial)).toString("base64") };
        case "refresh-cert":       return refreshCert(req, ctx);
        case "list-certs":         return listCerts(req, ctx);
        case "list-revoked":       return ctx.state.revoked;
        case "revoke-cert":        return revokeCert(req, ctx);
        case "unrevoke-cert":      return unrevokeCert(req, ctx);
        default: throw new Error(`unknown op: ${(req as any).op}`);
    }
}

function createGroupNetns(req: { group: string; subnet: string }, ctx: HandlerCtx) {
    requireRoot(ctx);
    assertValidName(req.group);
    if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(req.subnet))
        throw new Error("invalid subnet");

    const existing = ctx.state.netns.find(n => n.group === req.group);
    if (existing) return { group: existing.group, subnet: existing.subnet, bridge: bridgeName(req.group) };

    const record = ensureBridge(req.group, req.subnet);
    ctx.state.netns.push(record);
    saveState(ctx.state);
    return { group: req.group, subnet: req.subnet, bridge: bridgeName(req.group) };
}

function deleteGroupNetns(req: { group: string }, ctx: HandlerCtx) {
    requireRoot(ctx);
    assertValidName(req.group);
    const br = bridgeName(req.group);
    if (ipExists(["link", "show", "dev", br]))
        ip(["link", "delete", "dev", br]);
    ctx.state.netns = ctx.state.netns.filter(n => n.group !== req.group);
    ctx.state.taps = ctx.state.taps.filter(t => t.group !== req.group);
    saveState(ctx.state);
    return {};
}

function allocateTap(req: { group: string }, ctx: HandlerCtx): TapRecord {
    requireGroup(ctx, req.group);
    const netns = ctx.state.netns.find(n => n.group === req.group);
    if (!netns) throw new Error(`group has no network: ${req.group}`);

    const uid = ctx.peer.uid;
    const existing = ctx.state.taps.find(t => t.group === req.group && t.uid === uid);
    if (existing) return existing;

    const username = usernameFromUid(uid);
    if (!username) throw new Error("unknown caller");

    const ifname = tapName(req.group, uid);
    if (ipExists(["link", "show", "dev", ifname]))
        ip(["link", "delete", "dev", ifname]);

    ip(["tuntap", "add", "mode", "tap", "user", username, "group", req.group, "name", ifname]);
    ip(["link", "set", "dev", ifname, "master", bridgeName(req.group)]);
    ip(["link", "set", "dev", ifname, "up"]);

    const host = netns.nextHost++;
    const ip4 = `${subnetHost(netns.subnet, host)}/${netns.subnet.split("/")[1]}`;
    ip(["addr", "add", ip4, "dev", ifname]);

    const record: TapRecord = { group: req.group, uid, username, ifname, ip: ip4 };
    ctx.state.taps.push(record);
    saveState(ctx.state);
    return record;
}

function releaseTap(req: { group: string }, ctx: HandlerCtx) {
    requireGroup(ctx, req.group);
    const uid = ctx.peer.uid;
    const idx = ctx.state.taps.findIndex(t => t.group === req.group && t.uid === uid);
    if (idx < 0) throw new Error("no tap allocated");
    const tap = ctx.state.taps[idx];
    if (ipExists(["link", "show", "dev", tap.ifname]))
        ip(["link", "delete", "dev", tap.ifname]);
    ctx.state.taps.splice(idx, 1);
    saveState(ctx.state);
    return {};
}

function listTaps(ctx: HandlerCtx): TapRecord[] {
    if (ctx.peer.uid === 0) return ctx.state.taps;
    return ctx.state.taps.filter(t => t.uid === ctx.peer.uid);
}

function createOtp(req: { username: string }, ctx: HandlerCtx) {
    requireRoot(ctx);
    assertValidName(req.username, "user");
    pruneOtps(ctx.state);

    // Ensure the user exists and is in the right groups so they hit
    // `Match Group mad-users` (password auth + ForceCommand) on next ssh.
    if (!userExists(req.username)) {
        execFileSync("useradd", ["-m", "-G", "mad,mad-users", req.username], { stdio: "inherit" });
    } else {
        execFileSync("usermod", ["-aG", "mad,mad-users", req.username], { stdio: "ignore" });
    }

    // Generate OTP and set it as the user's Linux password. sshd will
    // accept it via standard PAM password auth; no /etc/pam.d/sshd tweak.
    const otp = randomBytes(4).readUInt32BE(0).toString().padStart(8, "0").slice(-8);
    const r = spawnSync("chpasswd", { input: `${req.username}:${otp}`, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`chpasswd failed: ${(r.stderr ?? "").trim() || `exit ${r.status}`}`);

    // Drop older pending OTPs for this user.
    ctx.state.otps = ctx.state.otps.filter(o => o.username !== req.username);
    const record: OtpRecord = {
        otp,
        username: req.username,
        expiresAt: Date.now() + OTP_TTL_MS,
    };
    ctx.state.otps.push(record);
    saveState(ctx.state);

    // The new user is in mad-users + has a primary group now; bless their
    // personal /run/mad/groups/<primary>/ dir immediately so they can
    // ssh -R into it on first login without waiting for the 60s timer.
    try { syncGroupDirs(); } catch (e) { console.error("syncGroupDirs after createOtp:", e); }

    return { otp, expiresAt: record.expiresAt };
}

/**
 * Called from `mad enroll` after the user has already authenticated to
 * sshd (via their OTP-as-password). The daemon trusts SO_PEERCRED for
 * identity, writes the supplied pubkey into the user's authorized_keys,
 * and locks the OTP password so it can't be reused.
 *
 * We deliberately do NOT mint a cert here — the cert is only useful for
 * authenticating to other servers (field devices). Users who need one
 * call `mad cert refresh` themselves later.
 */
function enrollSelf(req: { pubkey: string }, ctx: HandlerCtx) {
    const username = usernameFromUid(ctx.peer.uid);
    if (!username) throw new Error("unknown caller");

    // Parse the pubkey before any mutation so a malformed key fails cleanly.
    ctx.ca.fingerprint(req.pubkey);

    appendAuthorizedKey(username, req.pubkey);
    try { execFileSync("passwd", ["-l", username], { stdio: "ignore" }); } catch {}

    ctx.state.otps = ctx.state.otps.filter(o => o.username !== username);
    saveState(ctx.state);
    return { username };
}

/**
 * Append `pubkey` to ~user/.ssh/authorized_keys so the user can SSH into the
 * gateway without depending on their cert (which is only useful for proving
 * identity to other servers). Idempotent — skips if the same key already
 * appears on a line. Best-effort: silently no-ops if the home dir doesn't
 * exist yet, leaving cert-only auth as the fallback.
 */
function appendAuthorizedKey(username: string, pubkey: string): void {
    const home = getUserHome(username);
    if (!home || !existsSync(home)) return;
    const uid = getUserUid(username);
    const gid = getUserGid(username);
    if (uid === undefined || gid === undefined) return;

    const sshDir = `${home}/.ssh`;
    if (!existsSync(sshDir)) {
        mkdirSync(sshDir, { recursive: true, mode: 0o700 });
        chownSync(sshDir, uid, gid);
    }
    chmodSync(sshDir, 0o700);

    const akPath = `${sshDir}/authorized_keys`;
    const trimmed = pubkey.trim();
    if (existsSync(akPath)) {
        const existing = readFileSync(akPath, "utf-8");
        if (existing.split("\n").some(l => l.trim() === trimmed)) return;
        appendFileSync(akPath, (existing.endsWith("\n") || existing.length === 0 ? "" : "\n") + trimmed + "\n");
    } else {
        writeFileSync(akPath, trimmed + "\n");
    }
    chmodSync(akPath, 0o600);
    chownSync(akPath, uid, gid);
}

function mintCert(pubkey: string, username: string, ctx: HandlerCtx): { cert: string; record: CertRecord } {
    const principals = madGroupsOf(username);
    const serial = ctx.state.nextSerial++;
    const cert = ctx.ca.signSSHKey(pubkey, username, principals, `+${CERT_VALIDITY_WEEKS}w`, serial);
    const issuedAt = Date.now();
    const record: CertRecord = {
        serial,
        username,
        keyId: `user_${username}`,
        fingerprint: ctx.ca.fingerprint(pubkey),
        principals: [username, ...principals.filter(p => p && p !== username)],
        issuedAt,
        expiresAt: issuedAt + CERT_VALIDITY_WEEKS * 7 * 24 * 60 * 60 * 1000,
    };
    ctx.state.certs.push(record);
    saveState(ctx.state);
    return { cert, record };
}


function caSign(req: { pubkey: string; username: string }, ctx: HandlerCtx) {
    requireRoot(ctx);
    assertValidName(req.username, "user");
    const { cert, record } = mintCert(req.pubkey, req.username, ctx);
    appendAuthorizedKey(req.username, req.pubkey);
    return { cert, serial: record.serial };
}

function refreshCert(req: { pubkey: string }, ctx: HandlerCtx) {
    const username = usernameFromUid(ctx.peer.uid);
    if (!username) throw new Error("unknown caller");
    const { cert, record } = mintCert(req.pubkey, username, ctx);
    return { username, cert, serial: record.serial };
}

function listCerts(req: { username?: string }, ctx: HandlerCtx): CertRecord[] {
    const all = ctx.state.certs;
    if (ctx.peer.uid === 0) return req.username ? all.filter(c => c.username === req.username) : all;
    const me = usernameFromUid(ctx.peer.uid);
    return all.filter(c => c.username === me);
}

function revokeCert(req: { serial?: number; username?: string; reason?: string }, ctx: HandlerCtx) {
    requireRoot(ctx);
    const candidates = ctx.state.certs.filter(c => {
        if (req.serial !== undefined && c.serial !== req.serial) return false;
        if (req.username !== undefined && c.username !== req.username) return false;
        return req.serial !== undefined || req.username !== undefined;
    });
    if (candidates.length === 0) throw new Error("no matching certs");

    const now = Date.now();
    const added: RevocationRecord[] = [];
    for (const c of candidates) {
        if (ctx.state.revoked.find(r => r.serial === c.serial)) continue;
        const r: RevocationRecord = { serial: c.serial, username: c.username, revokedAt: now, reason: req.reason };
        ctx.state.revoked.push(r);
        added.push(r);
    }
    saveState(ctx.state);
    writeKrlFile(ctx);
    return { revoked: added };
}

function unrevokeCert(req: { serial: number }, ctx: HandlerCtx) {
    requireRoot(ctx);
    const before = ctx.state.revoked.length;
    ctx.state.revoked = ctx.state.revoked.filter(r => r.serial !== req.serial);
    if (ctx.state.revoked.length === before) throw new Error(`serial ${req.serial} was not revoked`);
    saveState(ctx.state);
    writeKrlFile(ctx);
    return { serial: req.serial };
}

export function writeKrlFile(ctx: HandlerCtx): void {
    const krl = ctx.ca.generateKrl(ctx.state.revoked.map(r => r.serial));
    mkdirSync("/etc/ssh", { recursive: true });
    writeFileSync(KRL_PATH, krl);
    chmodSync(KRL_PATH, 0o644);
}

/**
 * Subset of the caller's Linux groups that mad cares about as cert principals:
 * anything that has a /run/mad/groups/<g>/ entry. Skip the housekeeping groups
 * (mad, mad-users, mad-admin) — those are gates, not service identities.
 */
function madGroupsOf(username: string): string[] {
    const housekeeping = new Set(["mad", "mad-users", "mad-admin"]);
    return getUserGroups(username).filter(g => !housekeeping.has(g));
}

/**
 * Make sure /run/mad/groups/<g>/ exists for every Linux group that has at
 * least one mad-users member — plus each user's primary group, which is
 * how "personal" per-user dirs come into being for free under
 * USERGROUPS_ENAB. Run on daemon startup (recovers from /run tmpfs reset
 * on reboot), on a periodic timer, and synchronously right after
 * `mad otp` adds a user to mad-users.
 */
export function syncGroupDirs(): { changed: number; skipped: number } {
    const HOUSEKEEPING = new Set(["mad", "mad-users", "mad-admin", "root", "shadow", "wheel", "sudo"]);

    const members = getGroupMembers("mad-users");
    const want = new Set<string>();
    for (const user of members) {
        const primary = getUserPrimaryGroup(user);
        if (primary && !HOUSEKEEPING.has(primary)) want.add(primary);
        for (const g of getUserGroups(user)) {
            if (!HOUSEKEEPING.has(g)) want.add(g);
        }
    }

    let changed = 0, skipped = 0;
    mkdirSync("/run/mad/groups", { recursive: true });

    for (const name of want) {
        const gid = getGroupGid(name);
        if (gid === undefined) { skipped++; continue; }
        const dir = `/run/mad/groups/${name}`;
        try {
            let touched = false;
            if (!existsSync(dir)) { mkdirSync(dir); touched = true; }
            const s = statSync(dir);
            if (s.uid !== 0 || s.gid !== gid) { chownSync(dir, 0, gid); touched = true; }
            if ((s.mode & 0o7777) !== 0o2770) { chmodSync(dir, 0o2770); touched = true; }
            if (touched) changed++;
        } catch {
            skipped++;
        }
    }
    return { changed, skipped };
}

export function pruneOtps(state: DaemonState) {
    const now = Date.now();
    const expired = state.otps.filter(o => o.expiresAt <= now);
    for (const o of expired) {
        // Expired without being consumed → lock the password so the OTP
        // can't be used as a login. If the user was a brand-new account
        // we created, they're now effectively dormant until an admin
        // mints them a fresh OTP.
        try { execFileSync("passwd", ["-l", o.username], { stdio: "ignore" }); } catch {}
    }
    if (expired.length > 0) {
        state.otps = state.otps.filter(o => o.expiresAt > now);
    }
}
