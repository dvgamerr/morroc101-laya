// Equipment and Inventory are separate client lists. Remember the equipped
// instance before a monster moves it back into the bag.
export function createWeaponRecovery(initial = null, onChange = () => {}) {
  let previous = initial;
  const worn = (s) => s.worn?.find(i => i.slot === 'weapon');
  const same = (i) => previous && i.index === previous.index && i.ITID === previous.ITID;
  function observe(s) {
    const weapon = worn(s);
    if (weapon && !same(weapon)) {
      previous = { index: weapon.index, ITID: weapon.ITID, loc: weapon.loc || 2, name: weapon.name };
      onChange(previous);
    }
  }
  function pending(s) {
    observe(s);
    return !!previous && Array.isArray(s.worn) && !worn(s);
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
      const item = s.inventory.find(i => same(i) && i.count > 0 && !i.equipped && i.gear?.identified && !i.gear.damaged);
      return item ? { index: item.index, loc: previous.loc, name: item.name, why: 'restore previously worn weapon' } : null;
    },
  };
}
