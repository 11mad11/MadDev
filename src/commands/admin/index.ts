import { cmdMenu } from "../../menu";
import group from "./group";
import user from "./user";
import otp from "./otp";
import ca from "./ca";

export default cmdMenu({
    text: "Admin",
    children: [group, user, ca, otp],
});
