import { config } from './config.js';
import { openGame, waitForInGame, snapshot, drainEvents, act } from './browser.js';
import { createReflex } from './reflex.js';
import { createChat } from './chat.js';
import { createTravel } from './travel.js';
import { loadWorld, pickHuntingGrounds, isTown } from './world.js';
import { plan, planFromCandidate, DEFAULT_PLAN } from './planner.js';
import { log } from './logger.js';
import * as llm from './llm.js';

const REPICK_EVERY_LEVELS = 3;
const EXCLUDE_FOR_MS = 30 * 60 * 1000;
const DEATHS_TO_ABANDON_MAP = 2;

const brain = {
  plan: { ...DEFAULT_PLAN },
  // farm (default) | follow a player | wait in place — set by chat
  mode: { kind: 'farm' },
  planning: false,
  lastPlanAt: 0,
  huntLevel: 0,
  excluded: new Map(), // map -> until (maps we couldn't reach or kept dying on)
  deathsOn: new Map(), // map -> [timestamps]
  counters: { deaths: 0, actions: {} },
};

// Ctrl+C stops the agent only. The browser is its own process and keeps the session.
process.on('SIGINT', () => {
  log('exit', { note: 'browser left open' });
  process.exit(0);
});

const { page, reused, launched } = await openGame();
log('boot', { url: config.game.url, laya: config.laya.model, llm: config.llm.model, browser: launched ? 'launched' : 'reconnected', session: reused ? 'reused' : 'new' });

// A cold oMLX model takes ~40s to load; do it while the player is still logging in.
llm.chat([{ role: 'user', content: 'ping' }], { maxTokens: 1, timeoutMs: 120000 })
  .then(() => log('llm_warm'))
  .catch((err) => log('llm_warm_error', { error: err.message }));

const world = await loadWorld()
  .then((w) => (log('world_loaded', { maps: w.spawnsByMap.size, mobs: w.mobs.size }), w))
  .catch((err) => (log('world_error', { error: err.message }), null));

if (!reused) console.log('>> ล็อกอินและเลือกตัวละครในหน้าต่างเบราว์เซอร์ได้เลย agent จะเริ่มเมื่อเข้าแมพแล้ว');
await waitForInGame(page, (snap) => {
  if (snap && snap.ready === false) process.stdout.write('.');
});
log('in_game');

const reflex = createReflex(page, brain);
const chat = createChat(page, brain);
const travel = createTravel(page);
const getSnap = () => snapshot(page);

function excluded() {
  const now = Date.now();
  for (const [map, until] of brain.excluded) if (until < now) brain.excluded.delete(map);
  return [...brain.excluded.keys()];
}

function candidates(snap) {
  if (!world) return [];
  return pickHuntingGrounds(world, {
    level: snap.me.baseLevel || 1,
    fromMap: snap.me.map,
    canGo: travel.canGo,
    exclude: excluded(),
    limit: 5,
  });
}

function replan(snap, why) {
  if (brain.planning) return;
  brain.planning = true;
  brain.lastPlanAt = Date.now();
  const recent = `actions ${JSON.stringify(brain.counters.actions)}, deaths ${brain.counters.deaths}`;
  const ctx = { candidates: candidates(snap), inTown: world ? isTown(world, snap.me.map) : false };
  plan(snap, why, recent, brain.plan, ctx)
    .then((next) => {
      brain.plan = next;
      brain.counters.actions = {};
    })
    .catch((err) => log('planner_error', { error: err.message }))
    .finally(() => (brain.planning = false));
}

/** Pick a hunting ground right away from the data, then let the planner refine it. */
function chooseHunt(snap, why) {
  const list = candidates(snap);
  brain.huntLevel = snap.me.baseLevel || 1;
  brain.plan = { ...planFromCandidate(list[0]), todo: brain.plan.todo };
  log('hunt_pick', {
    why,
    map: brain.plan.hunt_map,
    level: brain.huntLevel,
    candidates: list.map((c) => `${c.map}(h${c.hops}) ${c.targets.map((t) => `${t.name}/${t.level}`).join(',')}`),
  });
  replan(snap, why);
}

function exclude(map, why) {
  if (!map) return;
  brain.excluded.set(map, Date.now() + EXCLUDE_FOR_MS);
  log('map_excluded', { map, why });
}

let lastFollowMoveAt = 0;
async function followTick(snap) {
  const leader = snap.players.find((p) => p.name === brain.mode.name);
  if (!leader) {
    // Out of sight (warped, changed map): give up after a while instead of standing forever.
    brain.mode.lostAt ??= Date.now();
    if (Date.now() - brain.mode.lostAt > 30000) {
      log('follow_lost', { name: brain.mode.name });
      brain.mode = { kind: 'farm' };
    }
    return;
  }
  brain.mode.lostAt = undefined;
  if (leader.dist > 3 && Date.now() - lastFollowMoveAt > 1000) {
    lastFollowMoveAt = Date.now();
    await act(page, 'move', { x: leader.x, y: leader.y });
  }
}

async function farmTick(snap) {
  const hp = snap.me.maxHp ? snap.me.hp / snap.me.maxHp : 1;
  const huntMap = brain.plan.hunt_map;
  const away = !!huntMap && snap.me.map !== huntMap;

  // Survival first, wherever we are. On the way somewhere, only fight back.
  if (snap.me.dead || snap.attackers.length || hp < 0.4) {
    const { action } = await reflex(snap, { defendOnly: away });
    brain.counters.actions[action] = (brain.counters.actions[action] || 0) + 1;
    return;
  }

  if (world && (!huntMap || (snap.me.baseLevel || 1) - brain.huntLevel >= REPICK_EVERY_LEVELS)) {
    chooseHunt(snap, huntMap ? `เลเวลขึ้นเป็น ${snap.me.baseLevel}` : 'เริ่มเล่น');
    return;
  }

  if (away) {
    if (travel.dest !== huntMap) await travel.start(huntMap);
    if ((await travel.tick(snap)) === 'failed') {
      exclude(huntMap, 'เดินทางไปไม่ได้');
      chooseHunt(snap, `ไป ${huntMap} ไม่ได้`);
    }
    return;
  }

  if (travel.dest) await travel.stop();
  const { action, stuck } = await reflex(snap);
  brain.counters.actions[action] = (brain.counters.actions[action] || 0) + 1;
  if (stuck) {
    exclude(huntMap, 'หามอนไม่เจอ/เดินไม่ไป');
    chooseHunt(snap, `ติดอยู่ที่ ${snap.me.map}`);
  }
}

function onDeath(snap) {
  brain.counters.deaths++;
  const map = snap.me.map;
  const recent = (brain.deathsOn.get(map) || []).filter((t) => Date.now() - t < EXCLUDE_FOR_MS);
  recent.push(Date.now());
  brain.deathsOn.set(map, recent);
  log('died', { map, timesHere: recent.length });
  if (recent.length >= DEATHS_TO_ABANDON_MAP && map === brain.plan.hunt_map) {
    exclude(map, `ตาย ${recent.length} ครั้ง`);
    chooseHunt(snap, `ตายที่ ${map} บ่อย`);
  } else {
    replan(snap, 'ตัวละครตาย');
  }
}

for (;;) {
  const started = Date.now();
  try {
    const snap = await snapshot(page);
    if (!snap.inGame) {
      await Bun.sleep(1000);
      continue;
    }

    for (const ev of await drainEvents(page)) {
      if (ev.type === 'chat') chat.push(ev, getSnap);
      else if (ev.type === 'level_up') log('level_up', { kind: ev.kind, level: ev.level });
      else if (ev.type === 'died') onDeath(snap);
    }

    if (brain.mode.kind !== 'farm' && Date.now() > brain.mode.until) brain.mode = { kind: 'farm' };
    const hp = snap.me.maxHp ? snap.me.hp / snap.me.maxHp : 1;
    const safe = !snap.attackers.length && hp >= 0.4 && !snap.me.dead;

    if (brain.mode.kind === 'follow' && safe) await followTick(snap);
    else if (brain.mode.kind === 'wait' && safe) {
      // stand still, chat keeps working
    } else await farmTick(snap);

    if (Date.now() - brain.lastPlanAt > config.plannerIntervalMs) replan(snap, 'ทบทวนแผนตามรอบ');
  } catch (err) {
    log('loop_error', { error: err.message });
    if (/Target (page|closed)|has been closed|browser has disconnected/i.test(err.message)) break;
    await Bun.sleep(1000);
  }
  await Bun.sleep(Math.max(0, config.tickMs - (Date.now() - started)));
}
