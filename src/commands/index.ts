import { MenuNodeParent } from "../menu";
import help from "./help";
import gateway from "./gateway";
import services from "./services";
import ca from "./ca";
import cert from "./cert";
import tap from "./tap";
import tun from "./tun";
import usage from "./usage";
import system from "./system";
import admin from "./admin";

// Menu and CLI now mirror each other exactly: every node in this tree
// is reachable both as a menu item AND as `mad <cliName> [child]`.
// The Admin and System subtrees nest under their respective cliNames
// (so `mad admin group create`, `mad system setup`), and Help topics
// nest under `mad help` rather than spilling out to root.
export default {
    text: "Menu",
    children: [
        help,
        gateway,
        services,
        ca,
        cert,
        tap,
        tun,
        usage,
        system,
        admin,
    ],
} satisfies MenuNodeParent;
