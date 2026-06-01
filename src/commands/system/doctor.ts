import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("doctor")
        .summary("Diagnose mad client setup; can install missing Windows L2 driver")
        .option("--install-l2-driver", "Download and run the TAP-Windows6 installer (Windows only, UAC)"),
    async pty() { return [[] as const, {}] as any; },
    async run(_ctx, opts) {
        const { runDoctor } = await import("../doctor");
        await runDoctor(opts as any);
    },
});
