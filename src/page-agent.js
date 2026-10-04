/**
 * Runs INSIDE the game page (Playwright addInitScript). Everything here talks to
 * the client's own `window.RO` debug bridge, which roBrowser only installs when
 * `development: true` — browser.js forces that by rewriting Config.local.js.
 *
 * Exposes window.__agent:
 *   snapshot()      game state for the decision loop
 *   drain()         chat / combat events since the last call
 *   act(name, arg)  run one action
 */
export function installPageAgent() {
  // Re-installing over an older copy (agent restarted, browser kept) replaces it
  // and re-points the packet observer here, keeping the stats it has learned.
  const prev = window.__agent;

  const TYPE = { PC: 0, ITEM: 2, MOB: 5, NPC: 6, ITEM2: 11 };
  // ZC_PAR_CHANGE / ZC_LONGPAR_CHANGE varID -> name (StatusProperty in the client)
  const STAT = {
    1: 'baseExp', 2: 'jobExp', 9: 'statusPoints', 11: 'baseLevel', 12: 'skillPoints',
    19: 'job', 20: 'zeny', 22: 'baseExpNext', 23: 'jobExpNext', 24: 'weight',
    25: 'maxWeight', 55: 'jobLevel',
  };

  const A = {
    events: [],
    stats: { ...(prev && prev.stats) },
    // Restarting the agent does not end an NPC conversation on the server.
    dialog: prev?.dialog,
    shop: prev?.shop,
    storage: prev?.storage,
    identify: prev?.identify,
    refine: prev?.refine,
    // Skill list, buffs and stats arrive once at map load; keep them across a re-install.
    skills: { ...(prev && prev.skills) },
    status: { ...(prev && prev.status) },
    cooldowns: {},
    base: { ...(prev && prev.base) },
    cost: { ...(prev && prev.cost) },
    hits: [],
    // What our own hits and skills did to each monster (GID -> {dmg, hits, misses, at}): tells a
    // fight that goes nowhere (every swing misses, skills land for 0) from one that's just long.
    dealt: {},
    selfLines: [],
    attached: false,
    // Last non-empty inventory: the list blinks empty on every map load.
    lastInv: prev && prev.lastInv,
    lastInvAt: prev && prev.lastInvAt,
  };
  function noteDealt(gid, damage) {
    const now = Date.now();
    const d = A.dealt[gid] || (A.dealt[gid] = { dmg: 0, hits: 0, misses: 0, at: now });
    d.dmg += damage;
    if (damage > 0) d.hits++;
    else d.misses++;
    d.at = now;
    for (const [k, v] of Object.entries(A.dealt)) if (now - v.at > 120000) delete A.dealt[k];
  }
  const STAT_NAMES = ['str', 'agi', 'vit', 'int', 'dex', 'luk'];
  // NPC text carries colour codes (^0055FF) and the odd control char; keep the words.
  const npcText = (s) => String(s || '').replace(/\^[0-9a-fA-F]{6}/g, '').replace(/[\0-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  // One conversation at a time; a new NPC id starts a fresh transcript.
  const dialogFor = (naid) => {
    if (!A.dialog || A.dialog.naid !== naid || A.dialog.state === 'ended') {
      A.dialog = { naid, lines: [], state: 'text', menu: null, input: null, at: Date.now() };
    }
    A.dialog.at = Date.now();
    return A.dialog;
  };
  // ZC_SKILLINFO type is the skill's target kind: 1 enemy, 2 ground, 4 self, 16 ally (bit flags).
  const skillRow = (s) => ({
    id: s.SKID,
    // Newer clients get no name in the skill list; the client's own SkillInfo gives the display name.
    name: String(s.skillName || '').replace(/\0.*$/, ''),
    label: (window.RO.DB.getSkillName && window.RO.DB.getSkillName(s.SKID)) || '',
    inf: s.type,
    level: s.level,
    sp: s.spcost,
    range: s.attackRange,
    upgradable: !!s.upgradable,
  });
  window.__agent = A;

  const push = (e) => {
    A.events.push({ t: Date.now(), ...e });
    if (A.events.length > 200) A.events.shift();
  };
  const clean = (s) => String(s || '').replace(/\|\d{2}/g, '').replace(/<[^>]+>/g, '').trim();
  const split = (msg) => {
    const i = msg.indexOf(' : ');
    return i === -1 ? [null, msg] : [msg.slice(0, i).trim(), msg.slice(i + 3).trim()];
  };
  const myName = () => window.RO?.Session?.Entity?.display?.name;
  const myGID = () => window.RO?.Session?.Entity?.GID;

  function observe(name, p) {
    const RO = window.RO;
    switch (name) {
      case 'PACKET_ZC_PAR_CHANGE':
      case 'PACKET_ZC_LONGPAR_CHANGE':
      case 'PACKET_ZC_LONGLONGPAR_CHANGE': {
        const key = STAT[p.varID];
        if (key) {
          const prev = A.stats[key];
          // Renewal sends EXP as int64 (LONGLONGPAR); keep everything a plain number.
          A.stats[key] = Number(p.count ?? p.amount);
          if (key === 'baseLevel' && prev && A.stats[key] > prev) push({ type: 'level_up', kind: 'base', level: A.stats[key] });
          if (key === 'jobLevel' && prev && A.stats[key] > prev) push({ type: 'level_up', kind: 'job', level: A.stats[key] });
        }
        break;
      }
      case 'PACKET_ZC_NOTIFY_CHAT': {
        const ent = RO.EntityManager.get(p.GID);
        if (!ent || ent.objecttype !== TYPE.PC || p.GID === myGID()) break;
        const [from, text] = split(clean(p.msg));
        push({ type: 'chat', channel: 'public', from: from || ent.display?.name, gid: p.GID, text });
        break;
      }
      case 'PACKET_ZC_WHISPER':
      case 'PACKET_ZC_WHISPER2':
        push({ type: 'chat', channel: 'whisper', from: clean(p.sender), text: clean(p.msg) });
        break;
      case 'PACKET_ZC_NOTIFY_CHAT_PARTY': {
        const [from, text] = split(clean(p.msg));
        if (from && from === myName()) break;
        push({ type: 'chat', channel: 'party', from, gid: p.AID, text });
        break;
      }
      case 'PACKET_ZC_GUILD_CHAT': {
        const [from, text] = split(clean(p.msg));
        if (from && from === myName()) break;
        push({ type: 'chat', channel: 'guild', from, text });
        break;
      }
      case 'PACKET_ZC_NOTIFY_ACT':
      case 'PACKET_ZC_NOTIFY_ACT2':
      case 'PACKET_ZC_NOTIFY_ACT3':
        if (p.targetGID && p.targetGID === myGID() && p.damage > 0) {
          A.hits.push({ t: Date.now(), from: p.GID, damage: p.damage + (p.leftDamage || 0) });
          if (A.hits.length > 100) A.hits.shift();
        } else if (p.targetGID && p.GID === myGID() && p.targetGID !== myGID()) {
          noteDealt(p.targetGID, (p.damage || 0) + (p.leftDamage || 0));
        }
        break;
      // Skill damage too: Dryads, plants and shooters hurt with skills, and counting only plain hits
      // left us "not attacked" (no escape) while HP went from 31% to 0.
      case 'PACKET_ZC_NOTIFY_SKILL':
      case 'PACKET_ZC_NOTIFY_SKILL2':
      case 'PACKET_ZC_NOTIFY_SKILL_POSITION':
        if (p.targetID && p.targetID === myGID() && p.AID !== myGID() && p.damage > 0) {
          A.hits.push({ t: Date.now(), from: p.AID, damage: p.damage });
          if (A.hits.length > 100) A.hits.shift();
        } else if (p.targetID && p.AID === myGID() && p.targetID !== myGID()) {
          noteDealt(p.targetID, p.damage > 0 ? p.damage : 0);
        }
        break;
      case 'PACKET_ZC_NOTIFY_VANISH':
        if (p.GID === myGID() && p.type === 1) push({ type: 'died' });
        break;

      // ---- skills: what we have, what failed, when each can be used again
      case 'PACKET_ZC_SKILLINFO_LIST':
      case 'PACKET_ZC_SKILLINFO_LIST2':
        A.skills = {};
        for (const s of p.skillList || []) A.skills[s.SKID] = skillRow(s);
        break;
      case 'PACKET_ZC_ADD_SKILL':
        if (p.data) A.skills[p.data.SKID] = skillRow(p.data);
        break;
      case 'PACKET_ZC_SKILLINFO_UPDATE':
      case 'PACKET_ZC_SKILLINFO_UPDATE2':
      case 'PACKET_ZC_SKILLINFO_UPDATE3': {
        const s = A.skills[p.SKID];
        if (s) {
          Object.assign(s, { level: p.level ?? s.level, sp: p.spcost ?? s.sp, range: p.attackRange ?? s.range });
          if (p.type !== undefined) s.inf = p.type;
          if (p.upgradable !== undefined) s.upgradable = !!p.upgradable;
        }
        break;
      }
      case 'PACKET_ZC_SKILLINFO_DELETE':
        delete A.skills[p.SKID];
        break;
      case 'PACKET_ZC_SKILL_POSTDELAY':
        A.cooldowns[p.SKID] = Date.now() + (p.DelayTM || 0);
        break;
      case 'PACKET_ZC_ACK_TOUSESKILL':
        if (p.result === 0) push({ type: 'skill_fail', SKID: p.SKID, cause: p.cause });
        break;

      // ---- status effects on us (buffs/debuffs), by EFST index
      case 'PACKET_ZC_MSG_STATE_CHANGE':
      case 'PACKET_ZC_MSG_STATE_CHANGE2':
      case 'PACKET_ZC_MSG_STATE_CHANGE3':
      case 'PACKET_ZC_MSG_STATE_CHANGE4':
      case 'PACKET_ZC_MSG_STATE_CHANGE5':
        if (p.AID === myGID() && p.index !== undefined) {
          if (p.state) A.status[p.index] = { since: Date.now(), until: p.RemainMS ? Date.now() + p.RemainMS : 0 };
          else delete A.status[p.index];
          push({ type: 'status', index: p.index, on: !!p.state, remain: p.RemainMS || 0 });
        }
        break;

      // ---- body states that stop us acting (stone/freeze/stun/sleep...) and silence
      case 'PACKET_ZC_STATE_CHANGE':
      case 'PACKET_ZC_STATE_CHANGE3':
        if (p.AID === myGID()) {
          const BODY = { 1: 'stone', 2: 'freeze', 3: 'stun', 4: 'sleep', 6: 'stone', 8: 'imprison' };
          const state = BODY[p.bodyState] || (p.healthState & 4 ? 'silence' : null);
          if (state && state !== A.disabledState) {
            // Who was hitting us when it happened: the likely cause.
            const from = [...new Set(A.hits.filter((h) => Date.now() - h.t < 4000).map((h) => h.from))];
            const names = from.map((g) => window.RO.EntityManager.get(g)).filter(Boolean).map((e) => e.display && e.display.name).filter(Boolean);
            push({ type: 'disabled', state, from: names });
          }
          A.disabledState = state;
        }
        break;

      // ---- player trades (someone offers us zeny/items)
      case 'PACKET_ZC_REQ_EXCHANGE_ITEM':
      case 'PACKET_ZC_REQ_EXCHANGE_ITEM2':
        A.trade = { stage: 'requested', from: clean(p.name), at: Date.now(), zeny: 0, items: [], otherLocked: false, selfLocked: false };
        push({ type: 'trade_request', from: A.trade.from });
        break;
      case 'PACKET_ZC_ACK_EXCHANGE_ITEM':
      case 'PACKET_ZC_ACK_EXCHANGE_ITEM2':
        if (A.trade) A.trade.stage = p.result === 3 ? 'open' : 'closed';
        break;
      case 'PACKET_ZC_ADD_EXCHANGE_ITEM':
      case 'PACKET_ZC_ADD_EXCHANGE_ITEM2':
      case 'PACKET_ZC_ADD_EXCHANGE_ITEM3':
      case 'PACKET_ZC_ADD_EXCHANGE_ITEM4':
        if (A.trade) {
          if (!p.ITID) A.trade.zeny = p.count; // index 0 is the zeny field
          else A.trade.items.push({ ITID: p.ITID, count: p.count });
        }
        break;
      case 'PACKET_ZC_CONCLUDE_EXCHANGE_ITEM':
        if (A.trade) A.trade[p.who ? 'otherLocked' : 'selfLocked'] = true;
        break;
      case 'PACKET_ZC_EXEC_EXCHANGE_ITEM':
        push({ type: 'trade_done', ok: p.result === 0, from: A.trade && A.trade.from, zeny: A.trade && A.trade.zeny, items: A.trade ? A.trade.items.length : 0 });
        A.trade = null;
        break;
      case 'PACKET_ZC_CANCEL_EXCHANGE_ITEM':
        push({ type: 'trade_cancelled', from: A.trade && A.trade.from });
        A.trade = null;
        break;

      // ---- NPC dialogs: text, Next, menus, input boxes, Close, end of script
      case 'PACKET_ZC_SAY_DIALOG':
        dialogFor(p.NAID).lines.push(npcText(p.msg));
        A.dialog.state = 'text';
        break;
      case 'PACKET_ZC_WAIT_DIALOG':
        dialogFor(p.NAID).state = 'next';
        break;
      case 'PACKET_ZC_MENU_LIST':
        Object.assign(dialogFor(p.NAID), { state: 'menu', menu: String(p.msg || '').split(':').map(npcText) });
        break;
      case 'PACKET_ZC_OPEN_EDITDLG':
        Object.assign(dialogFor(p.NAID), { state: 'input', input: 'number' });
        break;
      case 'PACKET_ZC_OPEN_EDITDLGSTR':
        Object.assign(dialogFor(p.NAID), { state: 'input', input: 'text' });
        break;
      case 'PACKET_ZC_CLOSE_DIALOG':
        dialogFor(p.NAID).state = 'close';
        break;
      case 'PACKET_ZC_CLOSE_SCRIPT':
        if (A.dialog && (!p.NAID || A.dialog.naid === p.NAID)) A.dialog.state = 'ended';
        break;

      case 'PACKET_ZC_ITEMIDENTIFY_LIST':
        A.identify = { indices: [...(p.ITIDList || [])], at: Date.now() };
        break;
      case 'PACKET_ZC_ACK_ITEMIDENTIFY':
        A.identify = null;
        push({ type: 'identified', index: p.index, ok: p.result === 0 });
        break;
      case 'PACKET_ZC_OPEN_REFINING_UI':
        A.refine = { open: true, at: Date.now() };
        break;
      case 'PACKET_ZC_REFINING_MATERIAL_LIST':
        A.refine = { ...A.refine, open: true, at: Date.now(), index: p.itemIndex, materials: (p.MaterialInfo || []).map(i => ({ ...i })) };
        break;
      case 'PACKET_ZC_ACK_ITEMREFINING':
        if (A.refine) A.refine = { open: true, at: Date.now(), resultAt: Date.now(), result: p.result, resultIndex: p.itemIndex, level: p.RefiningLevel };
        break;
      // ---- NPC shops: buy/sell choice, the lists with prices, the results
      case 'PACKET_ZC_NPC_BARTER_MARKET_ITEMINFO':
      case 'PACKET_ZC_NPC_EXPANDED_BARTER_MARKET_ITEMINFO':
        A.shop = { kind: name.includes('EXPANDED') ? 'expanded_barter' : 'barter', stage: 'barter', at: Date.now(), list: (p.itemList || []).map(i => ({ ...i })) };
        break;
      case 'PACKET_ZC_SELECT_DEALTYPE':
        A.shop = { naid: p.NAID, stage: 'select', at: Date.now() };
        break;
      case 'PACKET_ZC_PC_PURCHASE_ITEMLIST':
      case 'PACKET_ZC_PC_PURCHASE_ITEMLIST2': // newer clients (this server) use the "2" list
        A.shop = { ...A.shop, kind: 'npc', stage: 'buy', at: Date.now(), list: (p.itemList || []).map((i) => ({ ITID: i.ITID, price: i.discountprice || i.price })) };
        break;
      case 'PACKET_ZC_NPC_MARKET_OPEN':
      case 'PACKET_ZC_NPC_MARKET_OPEN2':
        // Market shops open straight to a buy list (no buy/sell choice) and have stock.
        A.shop = { naid: A.shop && A.shop.naid, kind: 'market', stage: 'buy', at: Date.now(), list: (p.itemList || []).map((i) => ({ ITID: i.ITID, price: i.price, stock: i.qty })) };
        break;
      case 'PACKET_ZC_NPC_MARKET_PURCHASE_RESULT':
      case 'PACKET_ZC_NPC_MARKET_PURCHASE_RESULT2':
        push({ type: 'shop_result', kind: 'buy', ok: p.result === 1, result: p.result });
        // Keep kind until close_shop, which still has to send NPC_MARKET_CLOSE.
        A.shop = { ...A.shop, stage: 'done' };
        break;
      case 'PACKET_ZC_PC_SELL_ITEMLIST':
        A.shop = { ...A.shop, stage: 'sell', at: Date.now(), list: (p.itemList || []).map((i) => ({ index: i.index, price: i.overchargeprice || i.price })) };
        break;
      case 'PACKET_ZC_PC_PURCHASE_RESULT':
        push({ type: 'shop_result', kind: 'buy', ok: p.result === 0, result: p.result });
        A.shop = null;
        break;
      case 'PACKET_ZC_PC_SELL_RESULT':
        push({ type: 'shop_result', kind: 'sell', ok: p.result === 0, result: p.result });
        A.shop = null;
        break;

      // ---- Kafra storage: the item lists arrive when it opens; ZC_CLOSE_STORE when it shuts.
      case 'PACKET_ZC_STORE_NORMAL_ITEMLIST':
      case 'PACKET_ZC_STORE_NORMAL_ITEMLIST2':
      case 'PACKET_ZC_STORE_NORMAL_ITEMLIST3':
      case 'PACKET_ZC_STORE_NORMAL_ITEMLIST4':
      case 'PACKET_ZC_STORE_EQUIPMENT_ITEMLIST':
      case 'PACKET_ZC_STORE_EQUIPMENT_ITEMLIST2':
      case 'PACKET_ZC_STORE_EQUIPMENT_ITEMLIST3':
      case 'PACKET_ZC_STORE_EQUIPMENT_ITEMLIST4':
      case 'PACKET_ZC_STORE_EQUIPMENT_ITEMLIST5':
      case 'PACKET_ZC_NOTIFY_STOREITEM_COUNTINFO':
        A.storage = { open: true, at: Date.now(), added: (A.storage && A.storage.added) || 0, count: p.curCount ?? (A.storage && A.storage.count), max: p.maxCount ?? (A.storage && A.storage.max) };
        break;
      case 'PACKET_ZC_ADD_ITEM_TO_STORE':
      case 'PACKET_ZC_ADD_ITEM_TO_STORE2':
      case 'PACKET_ZC_ADD_ITEM_TO_STORE3':
      case 'PACKET_ZC_ADD_ITEM_TO_STORE4':
        if (A.storage) A.storage.added += 1;
        push({ type: 'storage_added', ITID: p.ITID ?? p.itemId, count: p.count });
        break;
      case 'PACKET_ZC_CLOSE_STORE':
        A.storage = null;
        break;

      // ---- base stats (STR..LUK) and what the next point of each costs
      case 'PACKET_ZC_STATUS':
        A.stats.statusPoints = p.point;
        A.base = { str: p.str, agi: p.agi, vit: p.vit, int: p.Int, dex: p.dex, luk: p.luk };
        A.cost = { str: p.standardStr, agi: p.standardAgi, vit: p.standardVit, int: p.standardInt, dex: p.standardDex, luk: p.standardLuk };
        break;
      case 'PACKET_ZC_STATUS_CHANGE_ACK':
        if (p.result && STAT_NAMES[p.statusID - 13]) A.base[STAT_NAMES[p.statusID - 13]] = p.value;
        break;
      case 'PACKET_ZC_COUPLESTATUS':
        if (STAT_NAMES[p.statusType - 13]) A.base[STAT_NAMES[p.statusType - 13]] = p.defaultStatus;
        break;
      default:
        // @command replies come back as our own chat line (clif_displaymessage) or a
        // system message; keep the recent ones so query() can read them.
        if (typeof p.msg === 'string' && /PLAYERCHAT|MSG|BROADCAST/.test(name)) {
          A.selfLines.push({ t: Date.now(), text: clean(p.msg) });
          if (A.selfLines.length > 100) A.selfLines.shift();
        }
    }
  }

  function attach() {
    if (A.attached || !window.RO?.Network?.setPacketObserver) return;
    window.RO.Network.setPacketObserver(observe);
    A.attached = true;
  }
  window.addEventListener('robrowser-debug-ready', attach);
  attach();

  // getComponent throws until the UI has been built.
  function component(name) {
    try {
      return window.RO.UIManager.getComponent(name);
    } catch {
      return null;
    }
  }

  /** Why the client's junk rules (RO.JunkData) say never to sell this stack, or null. */
  function keepReason(it) {
    const J = window.RO.JunkData;
    try {
      if (!J || !J.isReady || !J.isReady()) return null;
      const R = J.REASON;
      const c = J.classify(it.ITID, 0, null, it);
      return [R.REFINED, R.CARDED, R.SIGNED, R.NEVER].includes(c.reason) ? c.reason : null;
    } catch {
      return null;
    }
  }

  /**
   * What a piece of gear is, read off the client's item description (iteminfo):
   * slot bitmask, weapon/armour kind, Atk/Def, who can wear it, level needed, refine.
   */
  function gearInfo(it) {
    const d = window.RO.DB.getItemInfo(it.ITID) || {};
    const identified = it.IsIdentified === true || it.IsIdentified === 1;
    const text = String(identified ? d.identifiedDescriptionName || '' : d.unidentifiedDescriptionName || '').replace(/\^[0-9a-fA-F]{6}/g, '');
    const field = (re) => (text.match(re) || [])[1]?.trim() || '';
    return {
      loc: it.location || 0,
      kind: field(/(?:ประเภท|Type)\s*:\s*([^\n]+)/i),
      atk: Number(field(/\bAtk\s*:\s*(\d+)/i)) || 0,
      def: Number(field(/\bDef\s*:\s*(\d+)/i)) || 0,
      jobs: field(/(?:อาชีพที่ใช้ได้|Jobs?)\s*:\s*([^\n]+)/i), // '' = everyone
      reqLv: Number(field(/(?:Lv\. ที่ต้องการ|Required Level|Base Level)\s*:\s*(\d+)/i)) || 0,
      refine: it.RefiningLevel || 0,
      description: text,
      cards: it.slot ? { ...it.slot } : {},
      options: (it.Options || []).filter(Boolean).map((o) => ({ ...o })),
      damaged: !!it.IsDamaged,
      slots: d.slotCount ?? null,
      identified, // unidentified gear can't be worn until appraised
    };
  }

  /** What we're wearing, slot by slot (the Equipment window keeps it; isInEquipList(mask) finds it). */
  const WORN_SLOTS = { head_low: 1, weapon: 2, garment: 4, acc_left: 8, armor: 16, shield: 32, shoes: 64, acc_right: 128, head_top: 256, head_mid: 512 };
  function worn() {
    const eq = component('Equipment');
    if (!eq || typeof eq.isInEquipList !== 'function') return null;
    const out = [];
    const seen = new Set();
    for (const [slot, mask] of Object.entries(WORN_SLOTS)) {
      const it = eq.isInEquipList(mask);
      if (!it || seen.has(it.index)) continue;
      seen.add(it.index);
      out.push({ slot, index: it.index, ITID: it.ITID, name: (window.RO.DB.getItemInfo(it.ITID) || {}).identifiedDisplayName || String(it.ITID), ...gearInfo(it) });
    }
    return out;
  }

  const INVENTORY_BLINK_MS = 5 * 60 * 1000;
  function inventory() {
    const RO = window.RO;
    const inv = component('Inventory');
    let list = (inv && inv.list) || [];
    // The client empties and refills the list while it refreshes (around shop windows, and for a
    // while after a Fly Wing warp): "nothing in the bag" must not read as "out of potions". It once
    // stayed empty 13s after a wing — past the old 10s — and the character fought on without drinking.
    // We always carry potions or wings, so a truly empty bag is not a case worth trusting quickly.
    if (list.length) {
      // A copy: the client empties this very array in place on a warp, and a kept reference
      // emptied with it — the cache read 0 items 0.7s after it was taken.
      A.lastInv = list.map((it) => ({ ...it }));
      A.lastInvAt = Date.now();
    } else if (A.lastInv && Date.now() - A.lastInvAt < INVENTORY_BLINK_MS) {
      list = A.lastInv;
    }
    return list.map((it) => ({
      index: it.index,
      ITID: it.ITID,
      name: (RO.DB.getItemInfo(it.ITID) || {}).identifiedDisplayName || String(it.ITID),
      // Gear doesn't stack and carries no count: one piece.
      count: it.count ?? 1,
      type: it.type,
      // Worn gear lives in the equipment window, not here. On a card, WearState is the slot it
      // can be compounded into — it once made every loose card look "worn" (never stored).
      equipped: !!it.WearState && it.type !== 6,
      keep: keepReason(it),
      ...((RO.DB.getItemInfo(it.ITID) || {}).identifiedDescriptionName ? { description: String(RO.DB.getItemInfo(it.ITID).identifiedDescriptionName).replace(/\^[0-9a-fA-F]{6}/g, '') } : {}),
      ...((RO.DB.getItemInfo(it.ITID) || {}).weight > 0 ? { weight: RO.DB.getItemInfo(it.ITID).weight } : {}),
      ...(it.type === 4 || it.type === 5 ? { gear: gearInfo(it) } : {}),
    }));
  }

  A.snapshot = () => {
    const RO = window.RO;
    if (!RO) return { ready: false };
    const me = RO.me();
    if (!me || !me.playing || !me.map || me.x === undefined) return { ready: true, inGame: false };

    const now = Date.now();
    // Hits from the map we just left (portal, @go, fly wing) are not a fight here.
    const map = String(me.map || '');
    if (A.mapNow !== map) {
      A.mapNow = map;
      A.mapSince = now;
    }
    if (A.hitsMap === undefined) A.hitsMap = map; // first look: these hits are from here
    else if (A.hitsMap !== map) {
      A.hits = [];
      A.hitsMap = map;
    }
    A.hits = A.hits.filter((h) => now - h.t < 6000);
    // A wing warp (same map, position jumps): the hits came from where we were, not from here.
    if (A.lastPos && Math.max(Math.abs(me.x - A.lastPos.x), Math.abs(me.y - A.lastPos.y)) > 15) A.hits = [];
    A.lastPos = { x: me.x, y: me.y };
    const ents = RO.entities();
    // Only attackers we can still see count as "being attacked": a monster that died,
    // walked off screen or was left behind would otherwise keep us fighting nothing.
    const visible = new Set(ents.filter((e) => e.type === TYPE.MOB && e.hp !== 0).map((e) => e.GID));
    const attackers = [...new Set(A.hits.filter((h) => visible.has(h.from)).map((h) => h.from))];
    // Who hit us in the last few seconds but isn't in the entity list (it reads empty for a while
    // after a wing warp: four Wootan Fighters beat us for 15s while we saw "0 monsters").
    const unseenAttackers = new Set(A.hits.filter((h) => now - h.t < 4000 && !visible.has(h.from)).map((h) => h.from)).size;
    const target = RO.AutoCombat.target && RO.AutoCombat.target();
    const pick = (e) => ({ GID: e.GID, name: e.name, x: e.x, y: e.y, dist: e.dist, hp: e.hp, maxHp: e.maxHp });
    const session = RO.Session.Entity || {};
    const selfIds = new Set([me.GID, session.GID, RO.Session.AID, RO.Session.GID, RO.Session.Character?.GID].filter((v) => v !== undefined && v !== null));
    const myName = me.name || session.display?.name || RO.Session.Character?.name || '';

    return {
      ready: true,
      inGame: true,
      me: {
        ...me,
        // MapRenderer.currentMap is "prontera.gat"; the navigation data and the server say "prontera".
        map: String(me.map || '').replace(/\.(gat|rsw)$/i, ''),
        baseLevel: A.stats.baseLevel ?? session.clevel,
        jobLevel: A.stats.jobLevel ?? session.joblevel,
        // The entity is updated by the sprite-change packet on a job change; the status value may be stale.
        jobId: session._job ?? session.job ?? A.stats.job,
        zeny: A.stats.zeny ?? RO.Session.zeny,
        baseExp: A.stats.baseExp, baseExpNext: A.stats.baseExpNext,
        jobExp: A.stats.jobExp, jobExpNext: A.stats.jobExpNext,
        weight: A.stats.weight, maxWeight: A.stats.maxWeight,
        statusPoints: A.stats.statusPoints, skillPoints: A.stats.skillPoints,
        stats: { ...A.base },
        statCost: { ...A.cost },
        skills: Object.values(A.skills).filter((s) => s.level > 0),
        // Everything in the tree the server sent, learned or not, with whether a point can go in now.
        skillTree: Object.values(A.skills).map(({ id, name, label, level, upgradable }) => ({ id, name, label, level, upgradable })),
        // Active status effects (EFST index -> ms left, 0 = unknown/permanent).
        status: Object.fromEntries(Object.entries(A.status).map(([k, v]) => [k, v.until ? Math.max(0, v.until - now) : 0])),
        cooldowns: Object.fromEntries(Object.entries(A.cooldowns).filter(([, t]) => t > now).map(([k, t]) => [k, t - now])),
        sitting: !!session.ACTION && session.action === session.ACTION.SIT,
        walking: !!session.ACTION && session.action === session.ACTION.WALK,
        // hp is 0 for a moment after login, before the first status packet; that isn't death.
        dead: (me.maxHp > 0 && me.hp === 0) || (!!session.ACTION && session.action === session.ACTION.DIE),
      },
      target: target ? { GID: target.GID, name: target.display?.name } : null,
      autoCombat: !!(RO.AutoCombat.isChaining && RO.AutoCombat.isChaining()),
      damageTaken6s: A.hits.reduce((s, h) => s + h.damage, 0),
      dealt: { ...A.dealt },
      attackers,
      unseenAttackers,
      monsters: ents.filter((e) => e.type === TYPE.MOB && e.hp !== 0).slice(0, 15).map(pick),
      items: ents.filter((e) => e.type === TYPE.ITEM || e.type === TYPE.ITEM2).slice(0, 10).map(pick),
      // The bridge's me.GID isn't always the id our own entity carries (char id vs account id):
      // drop ourselves by every id and by name, or we end up begging from our own character.
      players: ents.filter((e) => e.type === TYPE.PC && !selfIds.has(e.GID) && !(myName && e.name === myName)).slice(0, 10).map(pick),
      // rAthena NPC names carry a hidden "#suffix" (Healer#mor); the navigation data says "Healer".
      npcs: ents.filter((e) => e.type === TYPE.NPC).slice(0, 15).map((e) => ({ ...pick(e), name: String(e.name || '').replace(/#.*$/, '').trim() })),
      inventory: inventory(),
      worn: worn(),
      navi: navi(),
      shop: A.shop || null,
      trade: A.trade ? { ...A.trade, items: [...A.trade.items] } : null,
      storage: A.storage ? { ...A.storage, items: Array.isArray(component('Storage')?.list) ? component('Storage').list.map(it => ({
        index: it.index, ITID: it.ITID, count: it.count ?? 1, type: it.type,
        name: (RO.DB.getItemInfo(it.ITID) || {}).identifiedDisplayName || String(it.ITID),
        ...(it.type === 4 || it.type === 5 ? { gear: gearInfo(it) } : {}),
      })) : null } : null,
      identify: A.identify ? { ...A.identify, indices: [...A.identify.indices] } : null,
      refine: A.refine ? { ...A.refine } : null,
      // How long we've been on this map: the inventory reloads in pieces after a map change.
      mapAgeMs: now - (A.mapSince || now),
      dialog: A.dialog ? { ...A.dialog, lines: [...A.dialog.lines], idleMs: Date.now() - A.dialog.at } : null,
    };
  };

  // The client's own cross-map route planner (the /navi window). It plans; we walk.
  function navi() {
    const N = window.RO.NaviRoute;
    const dest = N && N.getDestination();
    if (!dest) return null;
    const leg = N.getLeg();
    return {
      dest: dest.map,
      lost: N.isLost(),
      leg: leg ? { kind: leg.kind, x: leg.x, y: leg.y, toMap: leg.toMap, goIndex: leg.goIndex } : null,
      ahead: N.getAheadCell(12) || null,
      remaining: N.getRemainingCells(),
    };
  }

  A.drain = () => A.events.splice(0, A.events.length);

  /**
   * Send an @command and collect what the server says back within `waitMs`.
   * Replies arrive as our own chat lines, so anything after the send is the answer.
   */
  A.query = async (command, waitMs = 1500) => {
    const since = Date.now();
    window.RO.say(command);
    await new Promise((r) => setTimeout(r, waitMs));
    return A.selfLines.filter((l) => l.t >= since && !l.text.includes(command)).map((l) => l.text);
  };

  // ---- Walking on the map grid -------------------------------------------------
  // The client's PathFinding.search stops at ~145 nodes, like the server's own
  // walk limit; fine for one step, useless for getting round a long wall. This is
  // a plain BFS over the same GAT cells, so it finds the way round anything.

  function grid() {
    const g = window.RO.PathFinding.getGat();
    if (!g || !g.cells || !g.width) return null;
    const WALK = g.type.WALKABLE;
    return { w: g.width, h: g.height, ok: (x, y) => x >= 0 && y >= 0 && x < g.width && y < g.height && (g.cells[x + y * g.width] & WALK) !== 0 };
  }

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  /** BFS from (sx,sy); stops at `goal(x,y)` or after `maxSteps`. Returns {found, prev, dist, g}. */
  function bfs(sx, sy, goal, maxSteps) {
    const g = grid();
    if (!g || !g.ok(sx, sy)) return null;
    const size = g.w * g.h;
    const dist = new Int16Array(size).fill(-1);
    const prev = new Int32Array(size).fill(-1);
    const queue = new Int32Array(size);
    let head = 0;
    let tail = 0;
    const start = sx + sy * g.w;
    dist[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++];
      const x = i % g.w;
      const y = (i / g.w) | 0;
      if (goal && goal(x, y)) return { found: i, prev, dist, g };
      if (dist[i] >= maxSteps) continue;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        // No corner cutting: a diagonal needs both sides open, as in the client.
        if (!g.ok(nx, ny) || (dx && dy && (!g.ok(x + dx, y) || !g.ok(x, y + dy)))) continue;
        const j = nx + ny * g.w;
        if (dist[j] !== -1) continue;
        dist[j] = dist[i] + 1;
        prev[j] = i;
        queue[tail++] = j;
      }
    }
    return { found: -1, prev, dist, g };
  }

  /** Path cells from start to `end` index, start excluded. */
  function trace(r, end) {
    const out = [];
    for (let i = end; i !== -1 && r.dist[i] > 0; i = r.prev[i]) out.push([i % r.g.w, (i / r.g.w) | 0]);
    return out.reverse();
  }

  /**
   * The next waypoint (at most `step` cells along the real path) toward (tx,ty),
   * or toward the nearest walkable cell to it. null when there is no way at all.
   */
  A.waypoint = (tx, ty, step = 12, maxSteps = 600) => {
    const me = window.RO.me();
    const sx = Math.round(me.x);
    const sy = Math.round(me.y);
    const r = bfs(sx, sy, (x, y) => Math.abs(x - tx) <= 1 && Math.abs(y - ty) <= 1, maxSteps);
    if (!r) return null;
    let end = r.found;
    if (end === -1) {
      // Target itself unreachable (wall, water): go to the reachable cell closest to it.
      let best = Infinity;
      for (let i = 0; i < r.dist.length; i++) {
        if (r.dist[i] < 0) continue;
        const d = Math.max(Math.abs((i % r.g.w) - tx), Math.abs(((i / r.g.w) | 0) - ty));
        if (d < best) {
          best = d;
          end = i;
        }
      }
      if (end === -1 || r.dist[end] === 0) return null;
    }
    const path = trace(r, end);
    if (!path.length) return { x: sx, y: sy, length: 0, exact: true }; // already there
    const [x, y] = path[Math.min(step, path.length) - 1];
    return { x, y, length: path.length, exact: r.found !== -1 };
  };

  /** A random cell we can actually walk to, between minSteps and maxSteps away. */
  A.exploreTarget = (minSteps = 10, maxSteps = 35, avoid = []) => {
    const me = window.RO.me();
    const r = bfs(Math.round(me.x), Math.round(me.y), null, maxSteps);
    if (!r) return null;
    const far = [];
    for (let i = 0; i < r.dist.length; i++) {
      if (r.dist[i] < minSteps) continue;
      const x = i % r.g.w;
      const y = (i / r.g.w) | 0;
      // Prefer places we haven't just been (coarse 20-cell buckets).
      if (avoid.some(([ax, ay]) => Math.abs(ax - x) < 20 && Math.abs(ay - y) < 20)) continue;
      far.push([x, y]);
    }
    if (!far.length) for (let i = 0; i < r.dist.length; i++) if (r.dist[i] >= minSteps) far.push([i % r.g.w, (i / r.g.w) | 0]);
    if (!far.length) return null;
    const [x, y] = far[(Math.random() * far.length) | 0];
    return { x, y };
  };

  const send = (Struct, fields) => {
    const pkt = new Struct();
    Object.assign(pkt, fields);
    window.RO.Network.sendPacket(pkt);
  };

  A.act = (name, arg = {}) => {
    const RO = window.RO;
    const { PACKET } = RO;
    switch (name) {
      case 'attack':
        return RO.attack(arg.GID);
      case 'move':
        return RO.moveTo(arg.x, arg.y);
      case 'walk_to': {
        // Walk toward any cell, round walls: next waypoint on the BFS path, <=12 cells
        // so rAthena's 17-cell walk limit never drops the request.
        const wp = A.waypoint(arg.x, arg.y, arg.step || 12);
        if (wp) RO.moveTo(wp.x, wp.y);
        return wp;
      }
      case 'stop_auto':
        return RO.AutoCombat.stop();
      case 'pickup':
        return send(PACKET.CZ.ITEM_PICKUP, { ITAID: arg.GID });
      case 'use_item': {
        const inv = component('Inventory');
        const item = inv && inv.list.find((it) => it.index === arg.index);
        if (!item) return false;
        // Straight packet, not inv.useItem(): that one equips/refines when handed gear.
        // Same version switch as the client's own onUseItem.
        const Struct = RO.PACKETVER.value >= 20180307 ? PACKET.CZ.USE_ITEM2 : PACKET.CZ.USE_ITEM;
        send(Struct, { index: item.index, AID: RO.Session.Entity.GID });
        return true;
      }
      case 'sit':
        return send(PACKET.CZ.REQUEST_ACT2 || PACKET.CZ.REQUEST_ACT, { targetGID: 0, action: 2 });
      case 'stand':
        return send(PACKET.CZ.REQUEST_ACT2 || PACKET.CZ.REQUEST_ACT, { targetGID: 0, action: 3 });
      case 'skill': {
        // Same version switch as the client's own skill use.
        if (arg.x !== undefined) {
          const Struct = RO.PACKETVER.value >= 20190904 ? PACKET.CZ.USE_SKILL_TOGROUND3
            : RO.PACKETVER.value >= 20180307 ? PACKET.CZ.USE_SKILL_TOGROUND2
            : PACKET.CZ.USE_SKILL_TOGROUND;
          return send(Struct, { SKID: arg.SKID, selectedLevel: arg.level, xPos: arg.x, yPos: arg.y });
        }
        const Struct = RO.PACKETVER.value >= 20180307 ? PACKET.CZ.USE_SKILL2 : PACKET.CZ.USE_SKILL;
        return send(Struct, { SKID: arg.SKID, selectedLevel: arg.level, targetID: arg.targetID || RO.Session.Entity.GID });
      }
      case 'talk':
        A.shop = null;
        return RO.talkTo(arg.GID);
      case 'deal': // 0 buy, 1 sell — answers ZC_SELECT_DEALTYPE without the dialog
        return send(PACKET.CZ.ACK_SELECT_DEALTYPE, { NAID: arg.naid, type: arg.type });
      case 'buy':
        if (A.shop && A.shop.kind === 'market') {
          return send(PACKET.CZ.NPC_MARKET_PURCHASE, { itemList: arg.items.map((i) => ({ itemId: i.ITID, amount: i.count })) });
        }
        return send(PACKET.CZ.PC_PURCHASE_ITEMLIST, { itemList: arg.items.map((i) => ({ ITID: i.ITID, count: i.count })) });
      case 'barter_smelt': {
        const rough = arg.ITID === 984 ? 756 : arg.ITID === 985 ? 757 : null;
        const offer = A.shop?.stage === 'barter' && A.shop.at === arg.quoteAt && A.shop.list.find(i => i.ITID === arg.ITID && i.index === arg.shopIndex);
        if (!rough || !offer || !Number.isInteger(arg.count) || arg.count < 1) return false;
        const costs = offer.currencyList || [{ ITID: offer.currencyITID, amount: offer.currencyamount }];
        const material = inventory().find(i => i.ITID === rough && i.count >= 5*arg.count);
        if (!material || (offer.price || 0) !== 0 || costs.length !== 1 || costs[0].ITID !== rough || costs[0].amount !== 5) return false;
        return send(A.shop.kind === 'expanded_barter' ? PACKET.CZ.NPC_EXPANDED_BARTER_MARKET_PURCHASE : PACKET.CZ.NPC_BARTER_MARKET_PURCHASE,
          { itemList: [{ itemId: arg.ITID, amount: arg.count, shopIndex: offer.index, invIndex: material.index }] });
      }
      case 'barter_close':
        if (A.shop?.kind === 'expanded_barter') send(PACKET.CZ.NPC_EXPANDED_BARTER_MARKET_CLOSE, {});
        else if (A.shop?.kind === 'barter') send(PACKET.CZ.NPC_BARTER_MARKET_CLOSE, {});
        component('NpcStore')?.remove?.();
        A.shop = null;
        return true;
      case 'sell':
        return send(PACKET.CZ.PC_SELL_ITEMLIST, { itemList: arg.items.map((i) => ({ index: i.index, count: i.count })) });
      case 'close_shop':
        // A market shop keeps the NPC session open until told otherwise.
        if (A.shop && A.shop.kind === 'market' && PACKET.CZ.NPC_MARKET_CLOSE) send(PACKET.CZ.NPC_MARKET_CLOSE, {});
        // The client opened its own buy/sell windows when the packets arrived; put them away.
        for (const name of ['NpcStore', 'NpcMenu']) {
          const c = component(name);
          if (c && c.__active && c.remove) c.remove();
        }
        A.shop = null;
        return true;
      // ---- wear a piece of gear from the bag in the slot(s) it goes to
      case 'identify':
        if (!A.identify?.indices.includes(arg.index)) return false;
        A.identify = null;
        return send(PACKET.CZ.REQ_ITEMIDENTIFY, { index: arg.index });
      case 'equip':
        return send(PACKET.CZ.REQ_WEAR_EQUIP, { index: arg.index, wearLocation: arg.loc });
      case 'unequip':
        if (!(worn() || []).some(i => i.index === arg.index && i.ITID === arg.ITID)) return false;
        return send(PACKET.CZ.REQ_TAKEOFF_EQUIP, { index: arg.index });
      case 'refine_select':
        // The refine UI dereferences its live Inventory list on the reply.
        // Equipped/cached items aren't there and cause item.ITID on null.
        if (!A.refine?.open || !component('Inventory')?.getItemByIndex?.(arg.index) ||
            (worn() || []).some(i => i.index === arg.index)) return false;
        return send(PACKET.CZ.REFINING_SELECT_ITEM, { index: arg.index });
      case 'refine_attempt': {
        const item = [...inventory(), ...(worn() || []).map(i => ({ ...i, gear: i }))].find(i => i.index === arg.index && i.ITID === arg.ITID);
        const material = A.refine?.materials?.find(i => i.itemId === arg.material);
        if (!item?.gear?.identified || item.gear.damaged || item.gear.refine >= 7 || A.refine?.index !== arg.index || A.refine.at !== arg.quoteAt || !material || material.chance <= 0) return false;
        if ((A.stats.zeny ?? RO.me()?.zeny ?? 0) - material.zeny < 100000) return false;
        A.refine.materials = null; // one submission per server quote
        return send(PACKET.CZ.REQ_REFINING, { index: arg.index, itemId: arg.material, blacksmithBlessing: 0 });
      }
      case 'refine_close':
        send(PACKET.CZ.CLOSE_REFINING_UI, {});
        component('Refine')?.remove?.();
        A.refine = null;
        return true;
      case 'storage_get': {
        const item = component('Storage')?.list?.find(i => i.index === arg.index && i.ITID === arg.ITID);
        if (!A.storage?.open || !item || !Number.isInteger(arg.count) || arg.count < 1 || arg.count > (item.count ?? 1)) return false;
        const ver = (RO.PACKETVER && (RO.PACKETVER.value ?? RO.PACKETVER)) || 0;
        return send(ver >= 20180307 ? PACKET.CZ.MOVE_ITEM_FROM_STORE_TO_BODY2 : PACKET.CZ.MOVE_ITEM_FROM_STORE_TO_BODY, { index: arg.index, count: arg.count });
      }
      // ---- Kafra storage (open it by talking to a Kafra; these only work while it's open).
      // Same choice as the client's StorageController.reqAddItem: the "2" packet from packetver
      // 20180307 (this server: 20211103). The old one went out and the server ignored it.
      case 'storage_put': {
        const ver = (RO.PACKETVER && (RO.PACKETVER.value ?? RO.PACKETVER)) || 0;
        const Struct = ver >= 20180307 && PACKET.CZ.MOVE_ITEM_FROM_BODY_TO_STORE2 ? PACKET.CZ.MOVE_ITEM_FROM_BODY_TO_STORE2 : PACKET.CZ.MOVE_ITEM_FROM_BODY_TO_STORE;
        return send(Struct, { index: arg.index, Index: arg.index, count: arg.count });
      }
      case 'storage_close': {
        send(PACKET.CZ.CLOSE_STORE, {});
        A.storage = null;
        const c = component('Storage');
        if (c && c.__active && c.remove) c.remove();
        return true;
      }
      // ---- NPC dialog answers (what the client's NpcBox/NpcMenu buttons send)
      case 'npc_next':
        return send(PACKET.CZ.REQ_NEXT_SCRIPT, { NAID: arg.naid });
      case 'npc_menu': // 1-based option, 255 = cancel
        if (A.dialog) A.dialog.state = 'text';
        return send(PACKET.CZ.CHOOSE_MENU, { NAID: arg.naid, num: arg.num });
      case 'npc_input':
        if (A.dialog) A.dialog.state = 'text';
        if (typeof arg.value === 'number') return send(PACKET.CZ.INPUT_EDITDLG, { NAID: arg.naid, value: arg.value });
        return send(PACKET.CZ.INPUT_EDITDLGSTR, { NAID: arg.naid, msg: String(arg.value) });
      case 'npc_close':
        send(PACKET.CZ.CLOSE_DIALOG, { NAID: arg.naid });
        if (A.dialog) A.dialog.state = 'ended';
        for (const name of ['NpcBox', 'NpcMenu']) {
          const c = component(name);
          if (c && c.__active && c.remove) c.remove();
        }
        return true;
      case 'hotkey_set': {
        // Show it on the bar and save it on the server, as a drag-and-drop would.
        const bar = component('ShortCut');
        if (bar && bar.addElement) bar.addElement(arg.index, arg.isSkill, arg.ID, arg.count);
        const Struct = RO.PACKETVER.value >= 20190522 ? PACKET.CZ.SHORTCUT_KEY_CHANGE2 : PACKET.CZ.SHORTCUT_KEY_CHANGE1;
        send(Struct, { Index: arg.index, ShortCutKey: { isSkill: arg.isSkill ? 1 : 0, ID: arg.ID, count: arg.count } });
        return true;
      }
      case 'hotkey_press': {
        // Exactly what pressing the slot's key does (ShortCut.onShortCut -> EXECUTE<n>).
        const bar = component('ShortCut');
        if (!bar || !bar.onShortCut) return false;
        bar.onShortCut({ cmd: 'EXECUTE' + arg.index });
        return true;
      }
      // ---- player trade. There is deliberately no "add item/zeny": the agent only receives.
      case 'trade_accept':
        return send(PACKET.CZ.ACK_EXCHANGE_ITEM, { result: 3 });
      case 'trade_reject':
        return send(PACKET.CZ.ACK_EXCHANGE_ITEM, { result: 4 });
      case 'trade_lock':
        return send(PACKET.CZ.CONCLUDE_EXCHANGE_ITEM, {});
      case 'trade_ok':
        return send(PACKET.CZ.EXEC_EXCHANGE_ITEM, {});
      case 'trade_cancel':
        A.trade = null;
        return send(PACKET.CZ.CANCEL_EXCHANGE_ITEM, {});
      case 'upgrade_skill':
        return send(PACKET.CZ.UPGRADE_SKILLLEVEL, { SKID: arg.SKID });
      case 'raise_stat': {
        const i = STAT_NAMES.indexOf(arg.stat);
        if (i === -1) return false;
        send(PACKET.CZ.STATUS_CHANGE, { statusID: 13 + i, changeAmount: 1 });
        return true;
      }
      case 'respawn':
        return send(PACKET.CZ.RESTART, { type: 0 });
      case 'navi_start':
        // Kafra and NPC warps need dialog handling the agent doesn't do: plan around them.
        RO.NaviRoute.setOptions({ useGo: !!arg.useGo, useKafra: false, useTalk: false });
        RO.NaviRoute.setDestination({ map: arg.map, x: 0, y: 0, name: arg.map });
        return true;
      case 'navi_clear':
        return RO.NaviRoute.clear();
      case 'say':
        return RO.say(arg.text);
      case 'party':
        return send(PACKET.CZ.REQUEST_CHAT_PARTY, { msg: `${myName()} : ${arg.text}` });
      case 'guild':
        return send(PACKET.CZ.GUILD_CHAT, { msg: `${myName()} : ${arg.text}` });
      case 'whisper':
        return send(PACKET.CZ.WHISPER, { receiver: arg.to, msg: arg.text });
      default:
        throw new Error(`unknown action ${name}`);
    }
  };
}
