// Bun loads .env automatically.
const env = (key, fallback) => {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (fallback === undefined) throw new Error(`Missing env ${key} (copy .env.example to .env)`);
    return fallback;
  }
  return value;
};

export const config = {
  laya: {
    url: env('LAYA_API_URL', 'https://nlp.wedolabs.net/laya/v1/systemone'),
    key: env('LAYA_API_KEY'),
    model: env('LAYA_MODEL', 'laya-multilingual'),
  },
  llm: {
    baseUrl: env('OMLX_BASE_URL', 'http://10.203.1.91:8000/v1').replace(/\/$/, ''),
    key: env('OMLX_API_KEY'),
    model: env('OMLX_MODEL', 'Qwen3.8-9B-mlx-4Bit'),
  },
  game: {
    url: env('GAME_URL', 'https://morroc101.duckdns.org/play/'),
    // Where the client loads data/navi_*.txt from (Config.local.js remoteClient + data/).
    dataUrl: env('GAME_DATA_URL', 'https://morroc101.duckdns.org/client/data/'),
    ownerName: env('OWNER_NAME', 'พี่เขม'),
    browserChannel: env('BROWSER_CHANNEL', 'chrome'),
    // The browser stays open between agent runs; the agent reconnects on this port.
    cdpPort: Number(env('CDP_PORT', '9333')),
  },
  // The job path to walk, one job change at a time (names as in goals.js JOB_TABLE).
  classPath: env('CLASS_PATH', 'Merchant,Blacksmith,High Novice,High Merchant,Whitesmith,Mechanic,Meister')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Stat/skill build for the whole path (build.js BUILDS key) and how to describe it to the LLM.
  build: env('BUILD', 'axe_meister'),
  buildDescription: env('BUILD_DESCRIPTION', 'Two-handed Axe Meister: STR main, DEX to hit, VIT to survive, some AGI; axe skills'),
  // Optional: goal changes are posted here.
  discordWebhook: env('DISCORD_WEBHOOK_URL', ''),
  tickMs: Number(env('TICK_MS', '300')),
  plannerIntervalMs: Number(env('PLANNER_INTERVAL_MS', '300000')),
};
