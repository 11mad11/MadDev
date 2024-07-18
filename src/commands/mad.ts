import { cmd, getInquirerContext, inquirer } from "./_helper";
import { readFile } from "fs/promises";
import { quote } from "shescape/stateless";

export default cmd(({ user, prog, channel }) => {
    const cmd = prog.command("mad")

    cmd.command("config <ip> [port]").action(async (defaultIp, defaultPort) => {
        const ctx = getInquirerContext(channel);
        const username = await inquirer.input({
            message: "Username",
            required: true,
            default: user.username
        }, ctx);
        const ip = await inquirer.input({
            message: "Server Address",
            required: true,
            default: defaultIp
        }, ctx);
        const port = await inquirer.input({
            message: "Port",
            validate(value) {
                return String(parseInt(value, 10)) == value || "Should be a number"
            },
            default: defaultPort ?? "22",
            required: true
        }, ctx);
        const key = await inquirer.input({
            message: "Private key location",
            default: "~/.ssh/id_rsa",
            required: true
        }, ctx);

        channel.write("Writting config file...\n");
        channel.write("\f\n");
        channel.write("key=" + quote(key, { shell: true }));
        channel.write("\n");
        channel.write("ssh_server=" + quote(`${username}@${ip} -p ${port}`, { shell: true }));
        channel.write("\n");
        channel.write("ssh_user=" + quote(username, { shell: true }));
        channel.write("\n");
        channel.write("ssh_ip=" + quote(ip, { shell: true }));
        channel.write("\n");
        channel.write("ssh_port=" + quote(port, { shell: true }));
        channel.write("\n");
        channel.eof();
    })

    cmd.command("download").action(async () => {
        channel.write(await readFile("./src/bash/templates/mad.sh"));
        channel.eof();
    })
})