import chalk from 'chalk';
import { createCommand } from "@commander-js/extra-typings";
import { Cmd, cmdDef } from "../menu";
import { prettyTerm } from '../utils/term';

export default cmdDef({
    perm() {
        return true;
    },
    cmd: () => createCommand("help").summary("Help"),
    async pty() {
        return [[] as const, {}];
    },
    async run({ output }) {
        const { cmd, h1, h2, line } = prettyTerm(output);

        h1("== mad ==");
        line("mad runs as your login program; system sshd handles auth via certs signed by mad's CA.");

        h2("Enroll a new user (sysadmin)");
        cmd("sudo mad otp create " + chalk.white.underline("username"));
        line("Hand the OTP to the new user. They then run:");
        cmd("ssh otp@" + chalk.white.underline("server"));
        line("…and enter the OTP + their public key. Save the returned cert as ~/.ssh/id_rsa-cert.pub.");

        h2("Register a TCP service for a group");
        cmd("ssh -R /run/mad/groups/" + chalk.white.underline("group") + "/" + chalk.white.underline("name") + ".sock:localhost:" + chalk.white.underline("port") + " server");

        h2("Use a TCP service from a group you belong to");
        cmd("ssh -L " + chalk.white.underline("localport") + ":/run/mad/groups/" + chalk.white.underline("group") + "/" + chalk.white.underline("name") + ".sock server");

        h2("Join a group's L2 VPN");
        cmd("mad tap join " + chalk.white.underline("group"));
    },
} satisfies Cmd);
