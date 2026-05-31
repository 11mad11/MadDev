import chalk from "chalk";
import { fixedInquirer } from "../utils/inquirer";
import { daemon } from "../daemon/client";

export async function runEnroll(): Promise<void> {
    const inq = fixedInquirer({ input: process.stdin, output: process.stdout });

    process.stdout.write("\n" + chalk.bgWhite.underline.black("  mad enrollment  ") + "\n\n");
    process.stdout.write("Enter the OTP your sysadmin gave you and your SSH public key.\n\n");

    const otp = await inq.input({
        message: "OTP",
        validate: (v) => v.trim().length >= 4 || "Required",
    });
    const pubkey = await inq.input({
        message: "Paste your SSH public key (one line: 'ssh-… AAA… [comment]')",
        validate: (v) => /^(ssh-(ed25519|rsa|dss)|ecdsa-)/.test(v.trim()) || "Looks malformed",
    });

    try {
        const r = await daemon.consumeOtp(otp.trim(), pubkey.trim());
        process.stdout.write("\n" + chalk.green("Cert issued for ") + chalk.bold(r.username) + "\n\n");
        process.stdout.write(r.cert + "\n\n");
        process.stdout.write("Save the block above as " + chalk.yellow("~/.ssh/id_rsa-cert.pub") + " on your client.\n");
        process.stdout.write("Then you can: " + chalk.yellow(`ssh ${r.username}@<server>`) + "\n");
    } catch (e: any) {
        process.stderr.write(chalk.red("Enrollment failed: " + (e?.message ?? e)) + "\n");
        process.exit(1);
    }
}
