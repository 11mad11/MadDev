import { createCommand } from "@commander-js/extra-typings";
import { mkdirSync, chmodSync, chownSync, existsSync } from "fs";
import { Cmd, cmdDef } from "../../menu";
import {
    addUserToGroup,
    assertValidName,
    createGroup,
    getGroupGid,
    getGroupMembers,
    groupExists,
    removeUserFromGroup,
} from "../../groups";
import { daemon } from "../../daemon/client";

const isAdmin = (ctx: { groups: string[] }) => ctx.groups.includes("mad-admin");

function groupDir(name: string) {
    return `/run/mad/groups/${name}`;
}

/**
 * Create or re-bless a mad-managed group:
 * 1. groupadd if missing
 * 2. mkdir /run/mad/groups/<name>, chown root:<gid>, chmod 2770
 * 3. if subnet given, daemon records it in state.json and ensures the bridge
 *
 * No /etc/mad/groups/*.json file is written. Linux's /etc/group is the
 * source of truth for membership; subnets live in state.json with the
 * other daemon state; everything else is derived from those.
 */
export async function createGroupAll(name: string, subnet?: string) {
    assertValidName(name);
    if (!groupExists(name)) createGroup(name);
    const gid = getGroupGid(name);
    if (gid === undefined) throw new Error(`gid lookup failed for ${name}`);

    mkdirSync("/run/mad/groups", { recursive: true });
    const dir = groupDir(name);
    if (!existsSync(dir)) mkdirSync(dir);
    chownSync(dir, 0, gid);
    chmodSync(dir, 0o2770);

    if (subnet) await daemon.createGroupNetns(name, subnet);
    return { dir, gid };
}

export const groupCreate = cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("group-create").summary("Create a group").argument("<name>").argument("[subnet]"),
    async pty(ctx) {
        const name = await ctx.inquirer.input({ message: "Group name" });
        const subnet = await ctx.inquirer.input({ message: "TUN/TAP subnet (optional, e.g. 10.42.0.0/24)", default: "" });
        return [[name, subnet || undefined], {}] as [[string, string | undefined], {}];
    },
    async run(ctx: any, _opts: any, name: string, subnet?: string) {
        const r = await createGroupAll(name, subnet);
        ctx.output.write(`created /run/mad/groups/${name} (gid=${r.gid})\n`);
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
