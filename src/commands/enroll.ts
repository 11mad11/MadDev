import chalk from "chalk";
import { fixedInquirer } from "../utils/inquirer";
import { daemon } from "../daemon/client";
import { currentUsername } from "../groups";

export async function runEnroll(): Promise<void> {
    const inq = fixedInquirer({ input: process.stdin, output: process.stdout });
    const username = currentUsername();

    process.stdout.write("\n" + chalk.bgWhite.underline.black("  mad enrollment  ") + "\n\n");
    process.stdout.write(`enrolling as ${chalk.bold(username)}\n\n`);
    process.stdout.write("Paste your SSH public key. Mad will sign it, add it to your\n");
    process.stdout.write("authorized_keys, and lock the OTP password you just used.\n\n");

    const pubkey = await inq.input({
        message: "Public key (one line: 'ssh-… AAA… [comment]')",
        validate: (v) => /^(ssh-(ed25519|rsa|dss)|ecdsa-)/.test(v.trim()) || "Looks malformed",
    });

    try {
        const r = await daemon.enrollSelf(pubkey.trim());
        process.stdout.write("\n" + chalk.green(`✔ enrolled ${r.username} (serial ${r.serial})`) + "\n\n");
        process.stdout.write(r.cert + "\n\n");
        process.stdout.write(
            "On your client:\n" +
            `  - Save the block above as ${chalk.yellow("~/.ssh/id_ed25519-cert.pub")}\n` +
            `  - Or just SSH back in: your pubkey is in authorized_keys now, the cert is optional for gateway login\n` +
            `  - The cert is what lets you reach field devices through the gateway\n`
        );
    } catch (e: any) {
        process.stderr.write(chalk.red("Enrollment failed: " + (e?.message ?? e)) + "\n");
        process.exit(1);
    }
}
