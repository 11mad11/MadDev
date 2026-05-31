import { MenuNodeParent } from "../menu";
import help from "./help";
import admin from "./admin";
import services from "./services";
import gateway from "./gateway";

export default {
    text: "Menu",
    children: [
        help,
        gateway,
        services,
        admin,
    ],
} satisfies MenuNodeParent;
