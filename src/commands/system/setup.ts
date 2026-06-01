import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { requireLinuxRoot } from "../../utils/platform";
import { runSetup } from "../setup";

export default cmdDef({
    perm() { return process.getuid?.() === 0; },
    cmd: () => createCommand("setup")
        .summary("Provision groups, dirs, CA, sshd snippet, and systemd unit (root, idempotent)"),
    async pty() { return [[] as const, {}]; },
    async run() {
        requireLinuxRoot("mad system setup");
        await runSetup();
    },
});
