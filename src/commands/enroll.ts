import chalk from "chalk";
import { fixedInquirer } from "../utils/inquirer";
import { daemon } from "../daemon/client";
import { currentUsername } from "../groups";
import { gatewayHost, sshConfigBlock } from "../utils/sshConfig";

export async function runEnroll(): Promise<void> {
    const inq = fixedInquirer({ input: process.stdin, output: process.stdout });
    const username = currentUsername();

    process.stdout.write("\n" + chalk.bgWhite.underline.black("  mad enrollment  ") + "\n\n");
    process.stdout.write(`enrolling as ${chalk.bold(username)}\n\n`);
    process.stdout.write("Paste your SSH public key. Mad will write it to your\n");
    process.stdout.write("authorized_keys and lock the OTP password you just used.\n\n");

    const pubkey = await inq.input({
        message: "Public key (one line: 'ssh-… AAA… [comment]')",
        validate: (v) => /^(ssh-(ed25519|rsa|dss)|ecdsa-)/.test(v.trim()) || "Looks malformed",
    });

    try {
        const r = await daemon.enrollSelf(pubkey.trim());
        const host = gatewayHost();
        process.stdout.write("\n" + chalk.green(`✔ enrolled ${r.username}`) + "\n\n");
        process.stdout.write("Add this to " + chalk.yellow("~/.ssh/config") + " on your client so " +
            chalk.yellow("ssh mad") + " Just Works:\n\n");
        process.stdout.write(chalk.dim(sshConfigBlock("mad", host, r.username)) + "\n");
        process.stdout.write("If/when you need a cert (only required to reach field devices through the gateway):\n");
        process.stdout.write(chalk.yellow(
            "  ssh mad cert refresh < ~/.ssh/id_ed25519.pub > ~/.ssh/id_ed25519-cert.pub\n"));
    } catch (e: any) {
        process.stderr.write(chalk.red("Enrollment failed: " + (e?.message ?? e)) + "\n");
        process.exit(1);
    }
}
