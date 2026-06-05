import { execFileSync, spawnSync } from "child_process";
import { userInfo } from "os";

export function currentUsername(): string {
    return userInfo().username;
}

export function currentUid(): number {
    return process.getuid?.() ?? -1;
}

export function userExists(username: string): boolean {
    return spawnSync("id", ["-u", username], { stdio: "ignore" }).status === 0;
}

export function groupExists(groupname: string): boolean {
    return spawnSync("getent", ["group", groupname], { stdio: "ignore" }).status === 0;
}

export function getUserGroups(username: string): string[] {
    const r = spawnSync("id", ["-nG", username], { encoding: "utf-8" });
    if (r.status !== 0)
        return [];
    return r.stdout.trim().split(/\s+/).filter(Boolean);
}

export function getCurrentUserGroups(): string[] {
    return getUserGroups(currentUsername());
}

export function getGroupMembers(groupname: string): string[] {
    const groupRes = spawnSync("getent", ["group", groupname], { encoding: "utf-8" });
    if (groupRes.status !== 0)
        return [];
    const parts = groupRes.stdout.trim().split(":");
    const gid = parts[2] ?? "";
    const supplementary = (parts[3] ?? "").split(",").map(s => s.trim()).filter(Boolean);

    // Also include users whose PRIMARY group is this one — `/etc/group`'s
    // members field only lists supplementary members, so users created with
    // `useradd -g <group>` (mad's own enrollment path for service-scoped
    // accounts like `smb`) don't appear there even though they have full
    // group access via getgroups(2).
    const primary: string[] = [];
    if (gid) {
        const passwdRes = spawnSync("getent", ["passwd"], { encoding: "utf-8" });
        if (passwdRes.status === 0) {
            for (const line of passwdRes.stdout.split("\n")) {
                const f = line.split(":");
                if (f[3] === gid && f[0]) primary.push(f[0]);
            }
        }
    }

    return [...new Set([...primary, ...supplementary])];
}

export function getGroupGid(groupname: string): number | undefined {
    const r = spawnSync("getent", ["group", groupname], { encoding: "utf-8" });
    if (r.status !== 0) return undefined;
    const parts = r.stdout.trim().split(":");
    const gid = parseInt(parts[2] ?? "", 10);
    return Number.isFinite(gid) ? gid : undefined;
}

export function getUserUid(username: string): number | undefined {
    const r = spawnSync("id", ["-u", username], { encoding: "utf-8" });
    if (r.status !== 0) return undefined;
    const uid = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(uid) ? uid : undefined;
}

export function getUserGid(username: string): number | undefined {
    const r = spawnSync("id", ["-g", username], { encoding: "utf-8" });
    if (r.status !== 0) return undefined;
    const gid = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(gid) ? gid : undefined;
}

export function getUserPrimaryGroup(username: string): string | undefined {
    const r = spawnSync("id", ["-gn", username], { encoding: "utf-8" });
    if (r.status !== 0) return undefined;
    return r.stdout.trim() || undefined;
}

export function getUserHome(username: string): string | undefined {
    const r = spawnSync("getent", ["passwd", username], { encoding: "utf-8" });
    if (r.status !== 0) return undefined;
    const parts = r.stdout.trim().split(":");
    return parts[5] || undefined;
}

export function createGroup(name: string): void {
    execFileSync("groupadd", [name], { stdio: "inherit" });
}

export function deleteGroup(name: string): void {
    execFileSync("groupdel", [name], { stdio: "inherit" });
}

export function addUserToGroup(username: string, groupname: string): void {
    execFileSync("usermod", ["-aG", groupname, username], { stdio: "inherit" });
}

export function removeUserFromGroup(username: string, groupname: string): void {
    execFileSync("gpasswd", ["-d", username, groupname], { stdio: "inherit" });
}

export function deleteUser(username: string, removeHome = true): void {
    const args = removeHome ? ["-r", username] : [username];
    execFileSync("userdel", args, { stdio: "inherit" });
}

const VALID_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

export function assertValidName(name: string, kind: "user" | "group" = "group"): void {
    if (!VALID_NAME.test(name))
        throw new Error(`Invalid ${kind} name: ${name}`);
}
