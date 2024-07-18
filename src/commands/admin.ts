import { cmd, getInquirerContext, inquirer } from "./_helper";

export default cmd(({ channel, user, prog, gateway }) => {


    prog.command("admin").action(async () => {
        const ctx = getInquirerContext(channel);
        
        await inquirer.select({
            message: "What",
            choices: [
                { value: "otp" as const, name: "Generate a One Time Password", action: otp, disabled: !user.permission.canGenerateOTP() },
                { value: "delete" as const, name: "Remove a user", action: deleteUser, disabled: !user.permission.canDeleteUser() },
                { value: "forget" as const, name: "Forget user's keys", action: forgetUser, disabled: !user.permission.canChangeAuth() },
                { value: "role" as const, name: "Change user's roles", action: roleUser, disabled: !user.permission.canChangeRole() },
                { value: "perm" as const, name: "Change user's permissions", disabled: true },
                { value: "log" as const, name: "See logs", disabled: true },
            ]
        }, ctx)
    });

    async function forgetUser(){
        if (!user.permission.canChangeAuth())
            return;

        const ctx = getInquirerContext(channel);
        const username = await inquirer.input({
            message: "Username",
            validate(value) {
                return !!gateway.users.users[value] || "User does not exist"
            },
        }, ctx);

        gateway.users.users[username].publicKeys = []
        gateway.users.usersConfig.save();
    }

    async function otp() {
        if (!user.permission.canGenerateOTP())
            return;

        const ctx = getInquirerContext(channel);
        const username = await inquirer.input({
            message: "Username"
        }, ctx);
        const register = await inquirer.confirm({
            message: "Register public key on connection? (User will need to have a public key)",
            default: true
        }, ctx);

        const otp = gateway.authsProvider.password.setOTPUser(username, register);
        channel.write("Here's the one time password: " + otp + "\n");
    }

    async function deleteUser() {
        if (!user.permission.canDeleteUser())
            return;

        const ctx = getInquirerContext(channel);
        const username = await inquirer.input({
            message: "Username"
        }, ctx);

        gateway.users.removeUser(username);
    }

    async function roleUser() {
        if (!user.permission.canChangeRole())
            return;

        const ctx = getInquirerContext(channel);
        const username = await inquirer.input({
            message: "Username",
            validate(value) {
                return !!gateway.users.users[value] || "User does not exist"
            },
        }, ctx);

        const userRoles = gateway.users.users[username].roles;
        const roles = [...new Set([...gateway.users.roles.keys(), ...userRoles])];
        roles.sort();

        const chosenRole = await inquirer.checkbox({
            message: "Roles",
            choices: roles.map(role => ({
                value: role,
                checked: userRoles.indexOf(role) !== -1
            }))
        }, ctx);

        gateway.users.users[username].roles = chosenRole;
        gateway.users.usersConfig.save();
    }
});
