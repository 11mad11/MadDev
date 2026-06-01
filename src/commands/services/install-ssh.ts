import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { daemon } from "../../daemon/client";
import { currentUsername } from "../../groups";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("install-ssh")
        .summary("Print install script: share this device's sshd through mad")
        .argument("<group/device>", "e.g. demo/dev01")
        .option("--tech-user <name>", "Linux user techs log in as", "mad-tech")
        .option("--scope <scope>", "user | system", "system")
        .option("--server-host <host>", "mad server hostname")
        .option("--server-user <user>", "mad username on the server"),
    async pty(ctx) {
        const groupDevice = await ctx.inquirer.input({
            message: "group/device (e.g. demo/dev01)",
            validate: (v: string) => /^[^/]+\/[^/]+$/.test(v.trim()) || "expected <group>/<device>",
        });
        return [[groupDevice.trim()] as const, {}] as any;
    },
    async run(ctx, opts, groupDevice) {
        // In the interactive menu, the install script is a multi-page
        // bash blob that's awkward to scrape out of the SSH session.
        // Print a one-liner the user can paste into their local shell
        // instead, redirecting the output to a file for review.
        if (ctx.mode === "shell") {
            const fname = `install-ssh-${groupDevice.replace("/", "-")}.sh`;
            ctx.output.write(`\nRun this from your local shell to save the install script:\n\n`);
            ctx.output.write(`  ssh mad service install-ssh ${groupDevice} > ${fname}\n\n`);
            ctx.output.write(`Review it, then run: sh ${fname}\n`);
            return;
        }
        const { sshShareScript } = await import("../install");
        const [group, deviceName] = groupDevice.split("/");
        if (!group || !deviceName) throw new Error("expected <group>/<device>");
        const fromOriginal = (process.env.SSH_CONNECTION ?? "").split(" ")[2] || "mad-server";
        const sshUser = (opts as any).serverUser ?? currentUsername();
        const [caResp, krlResp] = await Promise.all([daemon.caPubkey(), daemon.caKrl()]);
        ctx.output.write(sshShareScript({
            group,
            deviceName,
            techUser: (opts as any).techUser ?? "mad-tech",
            serverHost: (opts as any).serverHost ?? fromOriginal,
            sshUser,
            scope: ((opts as any).scope as "user" | "system"),
        }, caResp.pubkey, krlResp.krl));
    },
});
