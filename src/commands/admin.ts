import { cmdMenu } from "../menu";
import group from "./admin/group";
import user from "./admin/user";
import otp from "./admin/otp";
import usage from "./admin/usage";

// Admin nests in both menu and CLI:
//   mad admin group create …
//   mad admin user del …
//   mad admin otp <user>
//   mad admin usage report …
// Non-admin users won't see this whole subtree in the interactive menu
// (each leaf's `perm: isAdmin` filters it out); the CLI dispatch
// wrapper also rejects non-admin callers with `permission denied`.
export default cmdMenu({
    text: "Admin",
    cliName: "admin",
    children: [group, user, otp, usage],
});
