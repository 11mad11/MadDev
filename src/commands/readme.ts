import { readFile } from "fs/promises";
import { cmd } from "./_helper";
import chalk from 'chalk';

export default cmd(({ channel, user, prog, gateway }) => {
    if (!user.permission.canGenerateOTP())
        return;
    prog.command("readme").action(async () => {
        h1("== All command needed to have fun ==");
        h2("Install Linux");
        cmd("ssh none@SERVER mad download | sudo tee /usr/bin/mad > /dev/null");
        cmd("sudo chmod +x /usr/bin/mad");
        cmd("mad config SERVER PORT");
        cmd("mad sign");

        h2("Install Nix");
        cmd("ssh none@SERVER mad nix | tee >(sed -n $'/\\f/,$p' | sed '1d' > mad.nix)");
        line("if you want to test the cmd in the current shell:", false);
        cmd("nix-env -i -f mad.nix");
        line("The next step is to install it the way you prefer. (See nix documentation for more help)");
        cmd("mad sign");

        h2("VPN");
        cmd("mad tun " + chalk.white.underline("service"));

        h2("Port forward");
        h3("Server");
        cmd("mad register " + chalk.white.underline("name") + " " + chalk.white.underline("port"));
        h3("Client");
        cmd("mad use " + chalk.white.underline("name") + " " + chalk.white.underline("local_port"));

        h2("Admin Task");
        cmd("mad admin");
    });

    function h1(txt: string) {
        channel.write(chalk.bgWhite.underline.black(txt) + "\n");
    }

    function h3(txt: string) {
        channel.write(chalk.underline.italic(txt) + "\n");
    }

    function h2(txt: string) {
        channel.write("\n" + chalk.underline.bold(txt) + "\n");
    }

    function line(txt: string = "", newline = true) {
        channel.write(txt + (newline ? "\n" : " "));
    }

    function cmd(txt: string, newline = true) {
        channel.write(chalk.yellow(txt) + (newline ? "\n" : " "));
    }
});