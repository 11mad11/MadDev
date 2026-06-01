import { MenuNodeParent } from "../menu";
import help from "./help";
import gateway from "./gateway";
import services from "./services";
import ca from "./ca";
import cert from "./cert";
import tap from "./tap";
import tun from "./tun";
import admin from "./admin";

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
        admin,
    ],
} satisfies MenuNodeParent;
