import { cmdMenu } from "../menu";
import refresh from "./cert/refresh";
import ls from "./cert/ls";
import revoke from "./cert/revoke";
import unrevoke from "./cert/unrevoke";

export default cmdMenu({
    text: "Certs",
    cliName: "cert",
    children: [refresh, ls, revoke, unrevoke],
});
