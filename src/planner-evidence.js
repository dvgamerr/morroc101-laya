// Only a single-map completed hunt supports a measured rate for that map.
export function moneyEvidence(map, results = {}) {
  const r = results[map];
  if (!r || r.routeFailure || r.maps?.length !== 1 || r.maps[0] !== map ||
      !Number.isFinite(r.net) || !Number.isFinite(r.zenyPerMinute) || !Number.isFinite(r.finishedAt)) return null;
  return { map, net: r.net, zenyPerMinute: r.zenyPerMinute, finishedAt: r.finishedAt };
}

export function moneyReason(plan, results = {}) {
  const evidence = moneyEvidence(plan.hunt_map, results);
  // The model selects the map. Evidence comes exclusively from our records;
  // missing copied fields or numbers in its prose must not block navigation.
  return evidence
    ? `เลือก ${evidence.map} เพื่อหาเงิน; ผลวัด ${evidence.map}: สุทธิ ${evidence.net} zeny/รอบ, ${evidence.zenyPerMinute} zeny/นาที`
    : `เลือก ${plan.hunt_map} เพื่อหาเงิน; ยังไม่มีผลวัดกำไรต่อเวลา เป็นการทดลอง`;
}
