import { cmdMenu } from "../menu";
import join from "./tap/join";
import leave from "./tap/leave";
import ls from "./tap/ls";

export default cmdMenu({
    text: "L2 (TAP) tunnel",
    cliName: "tap",
    children: [join, leave, ls],
});
