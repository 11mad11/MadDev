import { MenuNodeParent } from "../shell";
import admin from "./admin";
import help from "./help";
import signsshkey from "./signsshkey";
import tun from "./tun";

export default {
    text: "Menu",
    children: [
        help,
        admin,
        signsshkey,
        ...tun
    ]
} satisfies MenuNodeParent