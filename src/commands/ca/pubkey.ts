import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { daemon } from "../../daemon/client";
import { CA } from "../../ca";

const CA_KEY_PATH = "/etc/mad/ca/ca.key";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("pubkey").summary("Print the CA public key"),
    async pty() { return [[] as const, {}]; },
    async run(ctx) {
        if (process.getuid?.() === 0) {
            const c = new CA(CA_KEY_PATH);
            ctx.output.write(c.publicKey() + "\n");
        } else {
            const r = await daemon.caPubkey();
            ctx.output.write(r.pubkey + "\n");
        }
    },
});
