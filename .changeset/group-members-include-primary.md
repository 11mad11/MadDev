---
"mad": patch
---

`mad admin group members <name>` now also lists users whose primary group is `<name>`.

`getent group` only fills the members field with supplementary members, so users created with `useradd -g <group>` (mad's own service-account pattern, e.g. `smb` whose primary group is `smb`) didn't show up — even though they have full kernel-level access to the group's `/run/mad/groups/<g>/` directory. Misleading enough to send debugging in the wrong direction.

`getGroupMembers()` in `src/groups.ts` now walks `getent passwd` for entries whose gid matches the group's gid and merges them with the supplementary list (deduped).
