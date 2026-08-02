const COLLECTIONS = {
  clans: "clans",
  clanDirectory: ["clans_directory", "index"],
  clanNotices: "clan_notices",
  clanMemberships: "clan_memberships",
  clanDevices: "clan_devices",
  clanNameKeys: "clan_name_keys",
  clanTagKeys: "clan_tag_keys",
};

function normalizeClanName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeClanTag(value) {
  return String(value ?? "").trim().toUpperCase();
}

export async function clanNameKey(name) {
  const bytes = new TextEncoder().encode(normalizeClanName(name));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

function directoryWithoutClan(clans, clanId) {
  return (Array.isArray(clans) ? clans : [])
    .filter(clan => clan?.id !== clanId);
}

function clanDeviceIds(clan) {
  const ids = new Set();
  for (const member of clan?.members ?? []) {
    if (member?.deviceId) ids.add(member.deviceId);
    for (const deviceId of member?.deviceIds ?? []) ids.add(deviceId);
    const stats = clan?.memberStats?.[member?.userId];
    if (stats?.deviceId) ids.add(stats.deviceId);
    for (const deviceId of stats?.deviceIds ?? []) ids.add(deviceId);
  }
  return [...ids].filter(Boolean);
}

export async function disbandClan({
  fb,
  clanId,
  message = "",
  now = new Date().toISOString(),
  noticeType = "admin_disbanded",
  releaseReservations = false,
}) {
  if (!fb?.db || !clanId) throw new Error("Missing clan details.");

  const clanRef = fb.doc(fb.db, COLLECTIONS.clans, clanId);
  const directoryRef = fb.doc(fb.db, ...COLLECTIONS.clanDirectory);
  let result = null;

  await fb.runTransaction(fb.db, async transaction => {
    const clanSnapshot = await transaction.get(clanRef);
    const directorySnapshot = await transaction.get(directoryRef);
    if (!clanSnapshot.exists()) {
      throw new Error("That clan no longer exists.");
    }

    const clan = { id: clanId, ...clanSnapshot.data() };
    const nameKey = releaseReservations ? await clanNameKey(clan.name) : "";
    const tagKey = releaseReservations ? normalizeClanTag(clan.tag) : "";
    const members = clan.members ?? [];
    const memberIds = [...new Set(
      members.map(member => member?.userId).filter(Boolean),
    )];
    const deviceIds = releaseReservations ? clanDeviceIds(clan) : [];
    const cleanMessage = String(message ?? "").trim().slice(0, 300);

    for (const userId of memberIds) {
      transaction.set(
        fb.doc(fb.db, COLLECTIONS.clanNotices, userId),
        {
          type: noticeType,
          clanId,
          clanName: clan.name ?? "Unknown clan",
          message: cleanMessage,
          at: now,
        },
      );
      if (releaseReservations) {
        transaction.delete(
          fb.doc(fb.db, COLLECTIONS.clanMemberships, userId),
        );
      }
    }
    for (const deviceId of deviceIds) {
      transaction.delete(fb.doc(fb.db, COLLECTIONS.clanDevices, deviceId));
    }
    if (nameKey) {
      transaction.delete(fb.doc(fb.db, COLLECTIONS.clanNameKeys, nameKey));
    }
    if (tagKey) {
      transaction.delete(fb.doc(fb.db, COLLECTIONS.clanTagKeys, tagKey));
    }

    const currentDirectory = directorySnapshot.exists()
      ? (directorySnapshot.data().clans ?? [])
      : [];
    transaction.set(directoryRef, {
      clans: directoryWithoutClan(currentDirectory, clanId),
    });
    transaction.delete(clanRef);
    result = {
      clanId,
      clanName: clan.name ?? "Unknown clan",
      notified: memberIds.length,
    };
  });

  return result;
}
