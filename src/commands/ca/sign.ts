import { createCommand } from "@commander-js/extra-typings";
import { readFileSync } from "fs";
import { cmdDef } from "../../menu";
import { daemon } from "../../daemon/client";
import { CA } from "../../ca";

const CA_KEY_PATH = "/etc/mad/ca/ca.key";
const isAdmin = (ctx: { groups: string[] }) => ctx.groups.includes("mad-admin");

export default cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("sign")
        .summary("Sign a public key on stdin (admin/root)")
        .argument("<username>", "Username the cert binds to"),
    async pty(ctx) {
        const username = await ctx.inquirer.input({ message: "Username the cert is for" });
        const pubkey = await ctx.inquirer.editor({ message: "Paste the public key" });
        const r = await daemon.caSign(pubkey, username);
        ctx.output.write(r.cert + "\n");
        return false;
    },
    async run(ctx, _opts, username) {
        const pubkey = readFileSync(0, "utf-8");
        if (process.getuid?.() === 0) {
            const c = new CA(CA_KEY_PATH);
            ctx.output.write(c.signSSHKey(pubkey, username) + "\n");
        } else {
            const r = await daemon.caSign(pubkey, username);
            ctx.output.write(r.cert + "\n");
        }
    },
});
