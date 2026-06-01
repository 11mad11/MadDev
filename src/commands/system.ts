import { MenuNodeParent } from "../menu";
import setup from "./system/setup";
import update from "./system/update";
import sshConfig from "./system/ssh-config";
import doctor from "./system/doctor";

// System bundles host-side provisioning + client diagnostics under a
// single subtree in both surfaces:
//   mad system setup
//   mad system update
//   mad system ssh-config
//   mad system doctor
// (`mad daemon`, `mad enroll`, and `mad tun-attach` stay at the root —
// daemon is started by systemd, enroll is a one-shot first-connect flow,
// and tun-attach is sshd ForceCommand glue invoked by the tun client.)
export default {
    text: "System",
    cliName: "system",
    children: [setup, update, sshConfig, doctor],
} satisfies MenuNodeParent;
