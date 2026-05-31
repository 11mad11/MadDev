import { createCommand } from "@commander-js/extra-typings";
import { mkdirSync, chmodSync, chownSync, existsSync, writeFileSync } from "fs";
import { Cmd, cmdDef } from "../../menu";
import {
    addUserToGroup,
    assertValidName,
    createGroup,
    getGroupGid,
    getGroupMembers,
    getUserUid,
    groupExists,
    removeUserFromGroup,
    userExists,
} from "../../groups";
import { daemon } from "../../daemon/client";

const isAdmin = (ctx: { groups: string[] }) => ctx.groups.includes("mad-admin");

function groupDir(name: string) {
    return `/run/mad/groups/${name}`;
}

function metaPath(name: string) {
    return `/etc/mad/groups/${name}.json`;
}

export async function createGroupAll(name: string, owner: string, subnet?: string) {
    assertValidName(name);
    assertValidName(owner, "user");
    if (!userExists(owner)) throw new Error(`user does not exist: ${owner}`);
    if (!groupExists(name)) createGroup(name);
    const dir = groupDir(name);
    mkdirSync(dir, { recursive: true });
    const ownerUid = getUserUid(owner);
    const gid = getGroupGid(name);
    if (ownerUid === undefined || gid === undefined) throw new Error("uid/gid lookup failed");
    chownSync(dir, ownerUid, gid);
    chmodSync(dir, 0o2770);
    mkdirSync("/etc/mad/groups", { recursive: true });
    const meta = { name, owner, subnet: subnet ?? null };
    writeFileSync(metaPath(name), JSON.stringify(meta, null, 2));
    chmodSync(metaPath(name), 0o640);
    if (gid !== undefined) chownSync(metaPath(name), 0, gid);
    if (subnet) await daemon.createGroupNetns(name, subnet);
    return { dir, gid, ownerUid };
}

export const groupCreate = cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("group-create").summary("Create a group").argument("<name>").argument("<owner>").argument("[subnet]"),
    async pty(ctx) {
        const name = await ctx.inquirer.input({ message: "Group name" });
        const owner = await ctx.inquirer.input({ message: "Owner username", default: ctx.username });
        const subnet = await ctx.inquirer.input({ message: "TUN/TAP subnet (optional, e.g. 10.42.0.0/24)", default: "" });
        return [[name, owner, subnet || undefined], {}] as [[string, string, string | undefined], {}];
    },
    async run(ctx: any, _opts: any, name: string, owner: string, subnet?: string) {
        const r = await createGroupAll(name, owner, subnet);
        ctx.output.write(`created /run/mad/groups/${name} (uid=${r.ownerUid} gid=${r.gid})\n`);
    },
});

export const groupList = cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("group-ls").summary("List mad groups"),
    async pty() { return [[] as const, {}]; },
    async run(ctx) {
        const { readdirSync, statSync } = await import("fs");
        if (!existsSync("/run/mad/groups")) {
            ctx.output.write("(no groups)\n");
            return;
        }
        for (const entry of readdirSync("/run/mad/groups")) {
            const s = statSync(`/run/mad/groups/${entry}`);
            ctx.output.write(`${entry}\tuid=${s.uid} gid=${s.gid} mode=${(s.mode & 0o7777).toString(8)}\n`);
        }
    },
});

export const groupMembers = cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("group-members").summary("Show group members").argument("<name>"),
    async pty(ctx) {
        const name = await ctx.inquirer.input({ message: "Group name" });
        return [[name] as const, {}];
    },
    async run(ctx, _opts, name) {
        const members = getGroupMembers(name);
        if (!members.length) ctx.output.write("(no members)\n");
        for (const m of members) ctx.output.write(m + "\n");
    },
});

export const groupAddUser = cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("group-add").summary("Add a user to a group").argument("<group>").argument("<user>"),
    async pty(ctx) {
        const group = await ctx.inquirer.input({ message: "Group name" });
        const user = await ctx.inquirer.input({ message: "Username to add" });
        return [[group, user] as const, {}];
    },
    async run(ctx, _opts, group, user) {
        addUserToGroup(user, group);
        ctx.output.write(`added ${user} to ${group}\n`);
    },
});

export const groupRemoveUser = cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("group-rm").summary("Remove a user from a group").argument("<group>").argument("<user>"),
    async pty(ctx) {
        const group = await ctx.inquirer.input({ message: "Group name" });
        const user = await ctx.inquirer.input({ message: "Username to remove" });
        return [[group, user] as const, {}];
    },
    async run(ctx, _opts, group, user) {
        removeUserFromGroup(user, group);
        ctx.output.write(`removed ${user} from ${group}\n`);
    },
});

export default {
    text: "Groups",
    children: [groupCreate, groupList, groupMembers, groupAddUser, groupRemoveUser],
};
