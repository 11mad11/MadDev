import { MenuNodeParent } from "../shell";
import admin from "./admin";
import help from "./help";
import install from "./install";
import signsshkey from "./signsshkey";
import tun from "./tun";
import update from "./update";

export default {
    text: "Menu",
    children: [
        help,
        admin,
        signsshkey,
        ...tun,
        install,
        update
    ]
} satisfies MenuNodeParent