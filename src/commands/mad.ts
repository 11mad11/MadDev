import { cmd, getInquirerContext, inquirer } from "./_helper";
import { readFile } from "fs/promises";
import { quote } from "shescape/stateless";

export default cmd(({ user, prog, channel }) => {
    const cmd = prog.command("mad").action(async () => {
        const ctx = getInquirerContext(channel);
        const username = await inquirer.input({
            message: "Username",
            required: true,
            default: user.username
        }, ctx);
        const ip = await inquirer.input({
            message: "Server Address",
            required: true
        }, ctx);
        const port = await inquirer.input({
            message: "Port",
            validate(value) {
                return String(parseInt(value, 10)) == value || "Should be a number"
            },
            default: "22",
            required: true
        }, ctx);
        const key = await inquirer.input({
            message: "Private key location",
            default: "~/.ssh/id_rsa",
            required: true
        }, ctx);

        channel.write("Enter these command to download the utility script:\n");
        {
            channel.write(`ssh none@${ip}`)
            if (port != "22")
                channel.write(` -p ${port}`)
            channel.write(` mad download ${key} ${ip} ${port} ${username}`);
            channel.write(` > mad.sh\n`);
            channel.write(`chmod +x mad.sh\n\n`);
        }

        channel.write(`If you do not want to use a password:\n`);
        {
            channel.write(`./mad.sh sign`);
        }
    });

    function complete(raw: string, list: [start: string, end: string][]) {
        for (const item of list) {
            raw = raw.replace(item[0], item[0] + quote(item[1], { shell: true }))
        }
        return raw;
    }

    cmd.command("download <key> <ip> <port> <username>").action(async (key, ip, port, username) => {
        const raw = (await readFile("./src/bash/templates/mad.sh")).toString();
        const modified = complete(raw, [
            ["key=", key],
            ["ssh_server=", `${username}@${ip} -p ${port}`],
            ["ssh_user=", username],
            ["ssh_ip=", ip],
            ["ssh_port=", port],
        ]);

        channel.write(modified);
        channel.eof();
    })
})