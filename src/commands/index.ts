import { MenuNodeParent } from "../menu";
import help from "./help";
import admin from "./admin";
import services from "./services";
import networking from "./networking";

export default {
    text: "Menu",
    children: [
        help,
        services,
        networking,
        admin,
    ],
} satisfies MenuNodeParent;
