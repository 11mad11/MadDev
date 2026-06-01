import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("ls").summary("List active TAP tunnels on this machine"),
    async pty() { return [[] as const, {}]; },
    async run() {
        const { tunList } = await import("../tunClient");
        await tunList("tap");
    },
});
