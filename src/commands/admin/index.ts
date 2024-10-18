import { cmdDef, cmdMenu } from "../../shell";
import deleteUser from "./deleteUser";
import forgetUserKey from "./forgetUserKey";
import otp from "./otp";
import role from "./role";

export default cmdMenu({
    text: "Admin",
    children: [
        otp,
        deleteUser,
        forgetUserKey,
        role
    ]
});