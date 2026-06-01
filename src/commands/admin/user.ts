import { createCommand } from "@commander-js/extra-typings";
import { writeFileSync, existsSync } from "fs";
import { Cmd, cmdDef } from "../../menu";
import { assertValidName, deleteUser, userExists } from "../../groups";

const isAdmin = (ctx: { groups: string[] }) => ctx.groups.includes("mad-admin");

export function forgetUserKeysAll(username: string) {
    assertValidName(username, "user");
    if (!userExists(username)) throw new Error(`no such user: ${username}`);
    const path = `/home/${username}/.ssh/authorized_keys`;
    if (existsSync(path)) writeFileSync(path, "");
}

export const userDelete = cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("user-del").summary("Delete a Linux user").argument("<name>"),
    async pty(ctx) {
        const name = await ctx.inquirer.input({
            message: "Username to delete",
            validate: (v) => userExists(v) || "User does not exist",
        });
        const ok = await ctx.inquirer.confirm({ message: `Really delete user '${name}' and their home?` });
        if (!ok) return false;
        return [[name] as const, {}];
    },
    async run(ctx, _opts, name) {
        deleteUser(name, true);
        ctx.output.write(`deleted user ${name}\n`);
    },
});

export const userForgetKeys = cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("user-forget-keys").summary("Wipe a user's authorized_keys").argument("<name>"),
    async pty(ctx) {
        const name = await ctx.inquirer.input({
            message: "Username",
            validate: (v) => userExists(v) || "User does not exist",
        });
        return [[name] as const, {}];
    },
    async run(ctx, _opts, name) {
        forgetUserKeysAll(name);
        ctx.output.write(`cleared authorized_keys for ${name}\n`);
    },
});

export default {
    text: "Users",
    cliName: "user",
    children: [userDelete, userForgetKeys],
};
