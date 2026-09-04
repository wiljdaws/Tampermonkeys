
// ---------- Clan role permissions (server-driven) ----------
// defaults match the old hardcoded behavior. admin/clanPerms can override
// any subset, e.g. { elder: { kick: true } }, no redeploy needed.
export const CLAN_ROLE_PERM_DEFAULTS = {
    leader:   { editClanInfo: true,  tagStyle: true,  kick: true,  approve: true,  roleChange: true,  transfer: true,  disband: true  },
    coleader: { editClanInfo: false, tagStyle: false, kick: true,  approve: true,  roleChange: true,  transfer: false, disband: false },
    elder:    { editClanInfo: false, tagStyle: false, kick: false, approve: true,  roleChange: false, transfer: false, disband: false },
    member:   { editClanInfo: false, tagStyle: false, kick: false, approve: false, roleChange: false, transfer: false, disband: false },
};


// stored bool wins, missing = default. unknown role -> member (most restrictive).
export function rolePerm(role, key) {
    const r = (role && CLAN_ROLE_PERM_DEFAULTS[role]) ? role : "member";
    const stored = clanRolePerms?.[r]?.[key];
    if (typeof stored === "boolean") return stored;
    return CLAN_ROLE_PERM_DEFAULTS[r][key] === true;
}


export function myClanRole() {
    const me = clanMembers(myClan).find(m => m.userId === myUserId());
    return me?.role ?? "member";
}


export function canManageRequests(role) {
    return rolePerm(role, "approve");
}


// ---------- Role management ----------
// leader > coleader > elder > member. Rules also check officer on writes.

export const ROLE_RANK = { leader: 3, coleader: 2, elder: 1, member: 0 };


// can `actorRole` set `targetCurrentRole` to `newRole`?
export function canSetRole(actorRole, targetCurrentRole, newRole) {
    const a = ROLE_RANK[actorRole] ?? -1;
    if (!rolePerm(actorRole, "roleChange")) return false;
    // can't touch someone at/above your own rank
    if ((ROLE_RANK[targetCurrentRole] ?? 0) >= a) return false;
    // can't promote someone to at/above your own rank
    if ((ROLE_RANK[newRole] ?? 0) >= a) return false;
    // leader can only be assigned via transferLeadership
    if (newRole === "leader") return false;
    return true;
}
