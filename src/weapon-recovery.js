// Equipment and Inventory are separate client lists. Remember the equipped
// instance before a monster moves it back into the bag.
// A remembered weapon that never comes back (broken, refined away, index changed after a relog)
// must not block hunting, travel and selling forever: give up on it after a while.
const GIVE_UP_MS = 60000; // nothing in the bag to restore
const GIVE_UP_HARD_MS = 10 * 60000; // something to restore, but the server keeps refusing
export function createWeaponRecovery(initial = null, onChange = () => {}, now = Date.now) {
  let previous = initial;
  let missingSince = null;
  const worn = (s) => s.worn?.find(i => i.slot === 'weapon');
  const same = (i) => previous && i.index === previous.index && i.ITID === previous.ITID;
  function observe(s) {
    const weapon = worn(s);
    if (weapon && !same(weapon)) {
      previous = { index: weapon.index, ITID: weapon.ITID, loc: weapon.loc || 2, name: weapon.name };
      onChange(previous);
    }
  }
  const usable = (s) => (s.inventory || []).find(i => same(i) && i.count > 0 && !i.equipped && i.gear?.identified && !i.gear.damaged);
  function pending(s) {
    observe(s);
    if (!(previous && Array.isArray(s.worn) && !worn(s))) { missingSince = null; return false; }
    missingSince ??= now();
    const waited = now() - missingSince;
    if (waited > GIVE_UP_HARD_MS || (waited > GIVE_UP_MS && !usable(s))) {
      previous = null;
      missingSince = null;
      onChange(null);
      return false;
    }
    return true;
  }
  return {
    observe,
    pending,
    ready: (s) => Array.isArray(s.worn) && !pending(s),
    protected(s, item) {
      observe(s);
      return item.type === 5 && (!Array.isArray(s.worn) || (!worn(s) && (!previous || same(item))));
    },
    pick(s) {
      if (!pending(s)) return null;
      const item = usable(s);
      return item ? { index: item.index, loc: previous.loc, name: item.name, why: 'restore previously worn weapon' } : null;
    },
  };
}
