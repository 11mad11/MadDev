import { createCommand } from "@commander-js/extra-typings";
import { Cmd, cmdDef } from "../../shell";


export default cmdDef({
    perm(ctx) {
        return ctx.user.permission.canChangeRole()
    },
    cmd: () => createCommand("role")
        .summary("Change user's roles")
        .argument("<name>")
        .option("-a <roles...>", "List of roles to add")
        .option("-r <roles...>", "List of roles to remove"),
    async pty(ctx) {
        const username = await ctx.inquirer.input({
            message: "Username",
            validate: (value) => !!ctx.gateway.users.users[value] || "User does not exist"
        });

        const userRoles = ctx.gateway.users.users[username].roles;
        const roles = [...new Set([...ctx.gateway.users.roles.keys(), ...userRoles])];
        roles.sort();

        const chosenRole = await ctx.inquirer.checkbox({
            message: "Roles",
            choices: roles.map(role => ({
                value: role,
                checked: userRoles.indexOf(role) !== -1
            }))
        });

        ctx.gateway.users.users[username].roles = chosenRole;
        ctx.gateway.users.usersConfig.save();

        return false;
    },
    async run(ctx, opts, username) {
        throw new Error("not implemented")
    },
});