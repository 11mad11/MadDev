import { cmdMenu } from "../menu";
import pubkey from "./ca/pubkey";
import sign from "./ca/sign";
import krl from "./ca/krl";

export default cmdMenu({
    text: "CA",
    cliName: "ca",
    children: [pubkey, sign, krl],
});
