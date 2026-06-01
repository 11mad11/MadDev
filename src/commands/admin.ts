import { cmdMenu } from "../menu";
import group from "./admin/group";
import user from "./admin/user";
import otp from "./admin/otp";
import usage from "./admin/usage";

// "Admin" is a menu grouping only — no cliName, so its children
// (groups, users, otp, usage) surface at the root of the CLI:
//   mad group create …
//   mad user del …
//   mad otp <user>
//   mad usage report …
// Non-admin users won't see these in the interactive menu (their
// per-Cmd `perm: isAdmin` filters them out).
export default cmdMenu({
    text: "Admin",
    children: [group, user, otp, usage],
});
