import { cmdMenu } from "../menu";
import ls from "./services/ls";
import register from "./services/register";
import use from "./services/use";
import hold from "./services/hold";
import ping from "./services/ping";
import install from "./services/install";
import installSsh from "./services/install-ssh";

export default cmdMenu({
    text: "Services",
    cliName: "service",
    children: [ls, register, use, hold, ping, install, installSsh],
});
