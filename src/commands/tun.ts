import { cmdMenu } from "../menu";
import join from "./tun/join";
import leave from "./tun/leave";
import ls from "./tun/ls";

export default cmdMenu({
    text: "L3 (TUN) tunnel",
    cliName: "tun",
    children: [join, leave, ls],
});
