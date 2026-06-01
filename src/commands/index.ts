import { MenuNodeParent } from "../menu";
import help from "./help";
import gateway from "./gateway";
import services from "./services";
import ca from "./ca";
import cert from "./cert";
import tap from "./tap";
import tun from "./tun";
import usage from "./usage";
import admin from "./admin";

// `usage` must come BEFORE `admin`: the admin tree includes an
// "Usage" parent with cliName="usage", and menuToTree reuses any
// existing Commander subcommand with that name. Registering the
// self-serve leaf first means `mad usage` runs the leaf action
// for everyone, while `mad usage report` / `mad usage export`
// dispatch into the admin subcommands.
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
        admin,
    ],
} satisfies MenuNodeParent;
