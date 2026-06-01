import { cmdMenu } from "../menu";
import add from "./gateway/add";
import ls from "./gateway/ls";
import rm from "./gateway/rm";
import test from "./gateway/test";

export default cmdMenu({
    text: "Gateways",
    cliName: "gateway",
    children: [add, ls, rm, test],
});
