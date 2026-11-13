/**
 * HROne 웹 패널용 개발 전용 가짜 API 서버.
 *
 *   npm run dev:mock
 *   HRONE_DEV_API=http://127.0.0.1:7799 npm run dev:web
 *
 * server/ 의 실제 라우트와 같은 모양의 응답을 메모리 데이터로 돌려준다.
 * 셸 실행 / 파일 접근은 하지 않는다. 구현하지 않은 /api 경로는 stderr 에 남기고 404 를 준다.
 */
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';

type Body = Record<string, any>;
type RunState = 'running' | 'starting' | 'restarting' | 'stopping' | 'stopped' | 'failed' | 'not-deployed' | 'unknown';

const PORT = Number(process.env.MOCK_PORT ?? 7799);
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

// ---------- 작은 도구 ----------

let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)]!;
const hex = (n = 40) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

// ---------- 유닛 상태 ----------

interface UnitStatus {
  unit: string;
  state: RunState;
  activeState: string;
  subState: string;
  pid: number;
  restarts: number;
  memory: number | null;
  cpu: number | null;
  tasks: number | null;
  since: number | null;
  enabled: boolean;
  exitStatus: number | null;
  result: string;
  listen: { addr: string; port: number }[];
}

const UNIT = {
  panel: 'hrone.service',
  rootSlice: 'hrone.slice',
  appsSlice: 'hrone-apps.slice',
  dbsSlice: 'hrone-dbs.slice',
  app: (slug: string) => `hrone-app-${slug}.service`,
  db: (slug: string) => `hrone-db-${slug}.service`,
};

const units: Record<string, UnitStatus> = {};
/** 유닛별 기준 CPU(%) / 메모리(bytes) — 매 틱 조금씩 흔든다 */
const base: Record<string, { cpu: number; mem: number }> = {};

function runningUnit(unit: string, opts: { cpu: number; mem: number; port?: number | null; since?: number; restarts?: number; tasks?: number }): UnitStatus {
  base[unit] = { cpu: opts.cpu, mem: opts.mem };
  return {
    unit,
    state: 'running',
    activeState: 'active',
    subState: 'running',
    pid: 1000 + Math.floor(rand() * 60000),
    restarts: opts.restarts ?? 0,
    memory: opts.mem,
    cpu: opts.cpu,
    tasks: opts.tasks ?? 11,
    since: opts.since ?? NOW - 3 * DAY - Math.floor(rand() * DAY),
    enabled: true,
    exitStatus: null,
    result: 'success',
    listen: opts.port ? [{ addr: '0.0.0.0', port: opts.port }] : [],
  };
}

function stoppedUnit(unit: string, enabled = false): UnitStatus {
  return { unit, state: 'stopped', activeState: 'inactive', subState: 'dead', pid: 0, restarts: 0, memory: null, cpu: null, tasks: null, since: null, enabled, exitStatus: 0, result: 'success', listen: [] };
}

function failedUnit(unit: string): UnitStatus {
  return { unit, state: 'failed', activeState: 'failed', subState: 'failed', pid: 0, restarts: 5, memory: null, cpu: null, tasks: null, since: NOW - 47 * MIN, enabled: true, exitStatus: 1, result: 'exit-code', listen: [] };
}

function setRunning(unit: string, port: number | null) {
  const b = base[unit] ?? { cpu: 1.2, mem: 90 * MB };
  units[unit] = runningUnit(unit, { ...b, port, since: Date.now(), restarts: units[unit]?.restarts ?? 0 });
}

// ---------- 앱 ----------

interface AppConfig {
  runtime: 'node' | 'python';
  runtimeVersion: string;
  repoUrl: string;
  branch: string;
  auth: 'none' | 'token' | 'deploykey';
  rootDir: string;
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  releaseCmd: string;
  installAlways: boolean;
  allowInstallScripts: boolean;
  port: number | null;
  publicUrl: string;
  writeDotenv: boolean;
  deployMode: 'auto' | 'delay' | 'manual';
  deployDelaySec: number;
  pollEnabled: boolean;
  pollIntervalSec: number;
  watchPaths: string[];
  preservePaths: string[];
  localChanges: 'overwrite' | 'keep';
  autostart: boolean;
  restartPolicy: 'always' | 'on-failure' | 'no';
  healthPath: string;
  healthTimeoutSec: number;
  autoRollback: boolean;
  runAsRoot: boolean;
  forceColor: boolean;
  resources: { cpu: number | null; memoryMB: number | null; swapMB: number | null; tasks: number | null; cpuWeight: number | null };
  notify: { push: boolean; pending: boolean; start: boolean; success: boolean; failure: boolean; crash: boolean };
  backup: { enabled: boolean; mode: 'daily' | 'interval'; time: string; intervalHours: number; keep: number };
}

interface App {
  id: number;
  slug: string;
  name: string;
  config: AppConfig;
  desired_state: 'running' | 'stopped';
  deployed_sha: string | null;
  deployed_at: number | null;
  last_poll_at: number | null;
  last_poll_error: string | null;
  created_at: number;
  rejected_sha: string | null;
  last_seen_sha: string | null;
  env: { key: string; value: string }[];
  links: { db: string; prefix: string }[];
  secrets: { webhookSecret: string; discordWebhook: string; gitTokenSet: boolean };
}

function mkConfig(o: Partial<AppConfig> & { runtime: 'node' | 'python'; repoUrl: string }): AppConfig {
  const node = o.runtime === 'node';
  return {
    runtimeVersion: node ? '24' : '3.13',
    branch: 'main',
    auth: 'token',
    rootDir: '',
    installCmd: node ? 'npm ci' : 'uv sync --frozen',
    buildCmd: node ? 'npm run build' : '',
    startCmd: node ? 'npm start' : 'uv run python main.py',
    releaseCmd: '',
    installAlways: false,
    allowInstallScripts: false,
    port: null,
    publicUrl: '',
    writeDotenv: true,
    deployMode: 'auto',
    deployDelaySec: 0,
    pollEnabled: true,
    pollIntervalSec: 60,
    watchPaths: [],
    preservePaths: ['data/', '*.sqlite'],
    localChanges: 'overwrite',
    autostart: true,
    restartPolicy: 'always',
    healthPath: '',
    healthTimeoutSec: 30,
    autoRollback: true,
    runAsRoot: false,
    forceColor: true,
    resources: { cpu: null, memoryMB: null, swapMB: null, tasks: null, cpuWeight: null },
    notify: { push: true, pending: true, start: false, success: true, failure: true, crash: true },
    backup: { enabled: true, mode: 'daily', time: '04:00', intervalHours: 6, keep: 7 },
    ...o,
  };
}

const gh = (slug: string) => `https://github.com/example/${slug}`;

const apps: App[] = [];
function addApp(a: Omit<App, 'id' | 'created_at' | 'last_poll_at' | 'last_poll_error' | 'rejected_sha' | 'last_seen_sha' | 'secrets'> & Partial<App>) {
  const app: App = {
    id: apps.length + 1,
    created_at: NOW - (40 + apps.length * 3) * DAY,
    last_poll_at: NOW - Math.floor(rand() * 50_000),
    last_poll_error: null,
    rejected_sha: null,
    last_seen_sha: a.deployed_sha,
    secrets: { webhookSecret: hex(32), discordWebhook: '', gitTokenSet: true },
    ...a,
  };
  apps.push(app);
  return app;
}

const SHA: Record<string, string> = {};
for (const s of ['buildcontest', 'chatfilter', 'forms', 'shop', 'hrbot', 'rewards', 'stock', 'ticket']) SHA[s] = hex();

addApp({
  slug: 'buildcontest',
  name: '건축 콘테스트',
  config: mkConfig({ runtime: 'node', repoUrl: gh('buildcontest'), port: 3001, publicUrl: 'https://build.example.com' }),
  desired_state: 'running',
  deployed_sha: SHA.buildcontest!,
  deployed_at: NOW - 2 * DAY - 3 * HOUR,
  env: [
    { key: 'DISCORD_TOKEN', value: 'MTE4' + hex(48) },
    { key: 'GUILD_ID', value: '1180394822153310259' },
    { key: 'VOTE_CHANNEL_ID', value: '1201139482215331025' },
  ],
  links: [{ db: 'buildcontest-db', prefix: '' }],
});
addApp({
  slug: 'chatfilter',
  name: '채팅 필터',
  config: mkConfig({ runtime: 'python', repoUrl: gh('chatfilter'), port: 3002, runtimeVersion: '3.12', startCmd: 'uv run uvicorn app:app --host 0.0.0.0 --port $PORT', resources: { cpu: 1, memoryMB: 1024, swapMB: null, tasks: null, cpuWeight: null } }),
  desired_state: 'running',
  deployed_sha: SHA.chatfilter!,
  deployed_at: NOW - 6 * DAY,
  env: [
    { key: 'MODEL_PATH', value: 'data/model.onnx' },
    { key: 'BLOCK_THRESHOLD', value: '0.82' },
    { key: 'API_KEY', value: 'cf_' + hex(32) },
  ],
  links: [{ db: 'cache', prefix: '' }],
});
addApp({
  slug: 'forms',
  name: '신청서',
  config: mkConfig({ runtime: 'node', repoUrl: gh('forms'), port: 3003, publicUrl: 'https://forms.example.com', autostart: false }),
  desired_state: 'stopped',
  deployed_sha: SHA.forms!,
  deployed_at: NOW - 12 * DAY,
  env: [{ key: 'SESSION_SECRET', value: hex(48) }],
  links: [{ db: 'forms-db', prefix: '' }],
});
addApp({
  slug: 'shop',
  name: '온라인 상점',
  config: mkConfig({
    runtime: 'node',
    repoUrl: gh('shop'),
    port: 3000,
    publicUrl: 'https://store.example.com',
    healthPath: '/api/health',
    deployMode: 'delay',
    deployDelaySec: 300,
    watchPaths: ['server/', 'web/', 'package.json'],
    resources: { cpu: 1.5, memoryMB: 2048, swapMB: 512, tasks: null, cpuWeight: 200 },
    backup: { enabled: true, mode: 'interval', time: '04:00', intervalHours: 6, keep: 14 },
  }),
  desired_state: 'running',
  deployed_sha: SHA['shop']!,
  deployed_at: NOW - 5 * HOUR,
  env: [
    { key: 'NODE_ENV', value: 'production' },
    { key: 'PUBLIC_URL', value: 'https://store.example.com' },
    { key: 'PAYMENT_API_KEY', value: 'pk_live_' + hex(32) },
    { key: 'PUSHBULLET_TOKEN', value: 'o.' + hex(32) },
    { key: 'SMTP_HOST', value: 'smtp.example.com' },
    { key: 'SMTP_USER', value: 'store@example.com' },
    { key: 'SMTP_PASS', value: hex(16) },
    { key: 'DISCORD_BOT_TOKEN', value: 'MTE5' + hex(48) },
  ],
  links: [
    { db: 'store-db', prefix: '' },
    { db: 'cache', prefix: 'CACHE_' },
  ],
});
addApp({
  slug: 'hrbot',
  name: 'HR 봇',
  config: mkConfig({ runtime: 'python', repoUrl: gh('hrbot'), port: 3004, startCmd: 'uv run python -m hrbot' }),
  desired_state: 'running',
  deployed_sha: SHA.hrbot!,
  deployed_at: NOW - 1 * DAY,
  env: [
    { key: 'DISCORD_TOKEN', value: 'MTE2' + hex(48) },
    { key: 'OWNER_IDS', value: '402938475839201, 738291029384756' },
    { key: 'LOG_LEVEL', value: 'INFO' },
  ],
  links: [{ db: 'hrbot-db', prefix: '' }],
});
addApp({
  slug: 'rewards',
  name: '보상 / 닉네임',
  config: mkConfig({ runtime: 'node', repoUrl: gh('rewards'), port: 3005, publicUrl: 'https://rewards.example.com', runtimeVersion: '22' }),
  desired_state: 'running',
  deployed_sha: SHA.rewards!,
  deployed_at: NOW - 3 * DAY,
  env: [{ key: 'REDEEM_SECRET', value: hex(32) }],
  links: [{ db: 'rewards-db', prefix: '' }],
});
addApp({
  slug: 'stock',
  name: '주식 시뮬레이터',
  config: mkConfig({ runtime: 'node', repoUrl: gh('stock'), port: 3006, deployMode: 'manual' }),
  desired_state: 'running',
  deployed_sha: SHA.stock!,
  deployed_at: NOW - 4 * DAY,
  env: [
    { key: 'TICK_MS', value: '5000' },
    { key: 'MARKET_OPEN', value: '09:00' },
    { key: 'MARKET_CLOSE', value: '23:00' },
  ],
  links: [
    { db: 'stock-db', prefix: '' },
    { db: 'cache', prefix: 'REDIS_' },
  ],
  last_seen_sha: hex(),
});
addApp({
  slug: 'ticket',
  name: '티켓 봇',
  config: mkConfig({ runtime: 'python', repoUrl: gh('ticket'), port: 3007, startCmd: 'uv run python bot.py' }),
  desired_state: 'running',
  deployed_sha: SHA.ticket!,
  deployed_at: NOW - 50 * MIN,
  env: [
    { key: 'DISCORD_TOKEN', value: 'MTE3' + hex(48) },
    { key: 'TICKET_CATEGORY_ID', value: '1190023948572019384' },
  ],
  links: [{ db: 'ticket-db', prefix: '' }],
});

const APP_LOAD: Record<string, { cpu: number; mem: number; tasks: number }> = {
  buildcontest: { cpu: 0.6, mem: 96 * MB, tasks: 11 },
  chatfilter: { cpu: 7.8, mem: 612 * MB, tasks: 23 },
  'shop': { cpu: 3.4, mem: 284 * MB, tasks: 13 },
  hrbot: { cpu: 1.1, mem: 148 * MB, tasks: 9 },
  rewards: { cpu: 0.4, mem: 78 * MB, tasks: 11 },
  stock: { cpu: 2.2, mem: 132 * MB, tasks: 12 },
};
for (const a of apps) {
  const u = UNIT.app(a.slug);
  const l = APP_LOAD[a.slug];
  if (a.slug === 'forms') units[u] = stoppedUnit(u);
  else if (a.slug === 'ticket') {
    units[u] = failedUnit(u);
    base[u] = { cpu: 0.8, mem: 64 * MB };
  } else units[u] = runningUnit(u, { cpu: l!.cpu, mem: l!.mem, port: a.config.port, tasks: l!.tasks, restarts: a.slug === 'hrbot' ? 2 : 0 });
}

// ---------- 데이터베이스 ----------

interface MariaLimits {
  maxConnections: number;
  maxUserConnections: number;
  maxConnectErrors: number;
  waitTimeout: number;
  maxAllowedPacketMB: number;
  innodbBufferPoolMB: number;
  tableOpenCache: number;
  threadCacheSize: number;
}
interface RedisLimits {
  maxClients: number;
  maxMemoryMB: number;
  maxMemoryPolicy: string;
  timeout: number;
  appendonly: boolean;
  save: string;
}
interface Db {
  id: number;
  slug: string;
  name: string;
  type: 'mariadb' | 'redis';
  initialized: boolean;
  desired_state: 'running' | 'stopped';
  created_at: number;
  config: {
    port: number;
    bind: 'local' | 'all';
    autostart: boolean;
    resources: { cpu: number | null; memoryMB: number | null; swapMB: number | null; tasks: number | null; cpuWeight: number | null };
    limits: MariaLimits | RedisLimits;
    backup: { enabled: boolean; mode: 'daily' | 'interval'; time: string; intervalHours: number; keep: number };
    defaultDb: string;
    appUser: string;
    adminUser: string;
  };
  passwords: { admin: string; app: string };
  schemas: { name: string; tables: { name: string; view?: boolean; rows: number; size: number; columns: [string, string, string, string, boolean][]; data: (string | null)[][] }[] }[];
  users: { user: string; host: string; maxConnections: number }[];
}

const MARIA_LIMITS = (): MariaLimits => ({
  maxConnections: 151,
  maxUserConnections: 0,
  maxConnectErrors: 100,
  waitTimeout: 28800,
  maxAllowedPacketMB: 16,
  innodbBufferPoolMB: 128,
  tableOpenCache: 2000,
  threadCacheSize: 16,
});

const dbs: Db[] = [];
function addMaria(slug: string, name: string, port: number, schemas: Db['schemas'], opts: Partial<Db['config']> = {}) {
  const defaultDb = slug.replace(/-db$/, '').replace(/-/g, '_');
  const db: Db = {
    id: dbs.length + 1,
    slug,
    name,
    type: 'mariadb',
    initialized: true,
    desired_state: 'running',
    created_at: NOW - (45 - dbs.length * 2) * DAY,
    config: {
      port,
      bind: 'local',
      autostart: true,
      resources: { cpu: null, memoryMB: 768, swapMB: null, tasks: null, cpuWeight: null },
      limits: MARIA_LIMITS(),
      backup: { enabled: true, mode: 'daily', time: '04:30', intervalHours: 6, keep: 14 },
      defaultDb,
      appUser: `${defaultDb}_app`,
      adminUser: 'admin',
      ...opts,
    },
    passwords: { admin: hex(24), app: hex(24) },
    schemas: schemas.length ? schemas : [{ name: defaultDb, tables: [] }],
    users: [
      { user: 'admin', host: '%', maxConnections: 0 },
      { user: `${defaultDb}_app`, host: '%', maxConnections: 50 },
      { user: 'root', host: 'localhost', maxConnections: 0 },
    ],
  };
  if (!schemas.length) db.schemas[0]!.name = defaultDb;
  dbs.push(db);
  return db;
}

const tsStr = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

const storeTables: Db['schemas'][0]['tables'] = [
  {
    name: 'products',
    rows: 42,
    size: 64 * 1024,
    columns: [
      ['id', 'int', 'int(11)', 'PRI', false],
      ['name', 'varchar', 'varchar(120)', '', false],
      ['price', 'int', 'int(11)', '', false],
      ['category', 'varchar', 'varchar(40)', 'MUL', false],
      ['stock', 'int', 'int(11)', '', true],
      ['created_at', 'datetime', 'datetime', '', false],
    ],
    data: [
      ['1', 'VIP 30일', '9900', 'rank', null, tsStr(NOW - 90 * DAY)],
      ['2', 'VIP+ 30일', '19900', 'rank', null, tsStr(NOW - 90 * DAY)],
      ['3', 'MVP 영구', '49000', 'rank', null, tsStr(NOW - 80 * DAY)],
      ['4', '닉네임 변경권', '3000', 'item', null, tsStr(NOW - 70 * DAY)],
      ['5', '할로윈 상자', '2500', 'crate', '340', tsStr(NOW - 20 * DAY)],
      ['6', '전설 곡괭이 스킨', '5500', 'cosmetic', '120', tsStr(NOW - 18 * DAY)],
      ['7', '펫: 아기 여우', '7700', 'cosmetic', '80', tsStr(NOW - 12 * DAY)],
      ['8', '건축 부스터 7일', '4400', 'boost', null, tsStr(NOW - 6 * DAY)],
    ],
  },
  {
    name: 'orders',
    rows: 1824,
    size: 2.4 * MB,
    columns: [
      ['id', 'int', 'int(11)', 'PRI', false],
      ['buyer', 'varchar', 'varchar(32)', 'MUL', false],
      ['product_id', 'int', 'int(11)', 'MUL', false],
      ['amount', 'int', 'int(11)', '', false],
      ['status', 'enum', "enum('pending','paid','refunded')", '', false],
      ['paid_at', 'datetime', 'datetime', '', true],
    ],
    data: Array.from({ length: 30 }, (_, i) => {
      const st = i === 2 ? 'pending' : i === 9 ? 'refunded' : 'paid';
      return [String(1824 - i), pick(['서연', 'minji', '하늘별', 'player01', '초코우유', '달빛고양이', 'Steve_KR', '라임']), String(1 + (i % 8)), pick(['9900', '3000', '2500', '19900', '5500']), st, st === 'pending' ? null : tsStr(NOW - i * 37 * MIN)];
    }),
  },
  {
    name: 'deposit_accounts',
    rows: 3,
    size: 16 * 1024,
    columns: [
      ['id', 'int', 'int(11)', 'PRI', false],
      ['bank', 'varchar', 'varchar(20)', '', false],
      ['holder', 'varchar', 'varchar(20)', '', false],
      ['enabled', 'tinyint', 'tinyint(1)', '', false],
    ],
    data: [
      ['1', '카카오뱅크', '하람', '1'],
      ['2', '토스뱅크', '하람', '1'],
      ['3', '국민은행', '하람', '0'],
    ],
  },
  { name: 'order_summary', view: true, rows: 0, size: 0, columns: [['day', 'date', 'date', '', true], ['total', 'decimal', 'decimal(32,0)', '', true]], data: [] },
];

addMaria('store-db', '스토어 DB', 3307, [
  { name: 'shop', tables: storeTables },
  { name: 'store_staging', tables: [storeTables[0]!] },
]);
addMaria('rewards-db', '보상 DB', 3308, [
  {
    name: 'rewards',
    tables: [
      {
        name: 'redeem_codes',
        rows: 512,
        size: 96 * 1024,
        columns: [
          ['code', 'varchar', 'varchar(16)', 'PRI', false],
          ['reward', 'varchar', 'varchar(60)', '', false],
          ['used_by', 'varchar', 'varchar(32)', '', true],
        ],
        data: [
          ['HALLOWEEN26', '할로윈 상자 x1', '초코우유'],
          ['WELCOME', '시작 키트', null],
          ['LUNAR2', 'iLunar 2.0 기념 칭호', 'minji'],
        ],
      },
      { name: 'nicknames', rows: 211, size: 48 * 1024, columns: [['uuid', 'char', 'char(36)', 'PRI', false], ['nick', 'varchar', 'varchar(24)', 'UNI', false]], data: [[crypto.randomUUID(), '달빛고양이'], [crypto.randomUUID(), '하늘별']] },
    ],
  },
]);
addMaria('hrbot-db', 'HR 봇 DB', 3309, [
  { name: 'hrbot', tables: [{ name: 'warnings', rows: 87, size: 32 * 1024, columns: [['id', 'int', 'int(11)', 'PRI', false], ['user_id', 'bigint', 'bigint(20)', 'MUL', false], ['reason', 'text', 'text', '', true]], data: [['87', '402938475839201', '도배'], ['86', '738291029384756', '욕설 필터 우회']] }] },
]);
addMaria('forms-db', '신청서 DB', 3310, [
  { name: 'forms', tables: [{ name: 'submissions', rows: 340, size: 128 * 1024, columns: [['id', 'int', 'int(11)', 'PRI', false], ['form', 'varchar', 'varchar(40)', '', false], ['nick', 'varchar', 'varchar(24)', '', false], ['answer', 'json', 'longtext', '', true]], data: [['340', 'staff-apply', '라임', '{"age":19,"reason":"서버를 오래 해서"}'], ['339', 'builder-apply', 'Steve_KR', '{"portfolio":"imgur.com/a/x"}']] }] },
]);
addMaria('ticket-db', '티켓 DB', 3311, [
  { name: 'ticket', tables: [{ name: 'tickets', rows: 1203, size: 512 * 1024, columns: [['id', 'int', 'int(11)', 'PRI', false], ['channel_id', 'bigint', 'bigint(20)', '', false], ['opened_by', 'varchar', 'varchar(32)', '', false], ['closed', 'tinyint', 'tinyint(1)', '', false]], data: [['1203', '1201139482215331025', '하늘별', '0'], ['1202', '1201139482215331011', 'player01', '1']] }] },
]);
addMaria('stock-db', '주식 DB', 3312, [
  { name: 'stock', tables: [{ name: 'prices', rows: 88213, size: 18 * MB, columns: [['symbol', 'varchar', 'varchar(8)', 'PRI', false], ['t', 'bigint', 'bigint(20)', 'PRI', false], ['price', 'int', 'int(11)', '', false]], data: Array.from({ length: 12 }, (_, i) => ['DIAM', String(NOW - i * 5000), String(12400 + Math.round((rand() - 0.5) * 300))]) }] },
]);
addMaria('buildcontest-db', '건축 콘테스트 DB', 3313, [
  { name: 'buildcontest', tables: [{ name: 'entries', rows: 64, size: 32 * 1024, columns: [['id', 'int', 'int(11)', 'PRI', false], ['team', 'varchar', 'varchar(40)', '', false], ['votes', 'int', 'int(11)', '', false]], data: [['1', '호박마을', '128'], ['2', '유령의 저택', '97'], ['3', '마녀의 정원', '84']] }] },
]);
dbs.push({
  id: dbs.length + 1,
  slug: 'cache',
  name: '공용 캐시',
  type: 'redis',
  initialized: true,
  desired_state: 'running',
  created_at: NOW - 30 * DAY,
  config: {
    port: 6380,
    bind: 'local',
    autostart: true,
    resources: { cpu: null, memoryMB: 512, swapMB: null, tasks: null, cpuWeight: null },
    limits: { maxClients: 10000, maxMemoryMB: 256, maxMemoryPolicy: 'allkeys-lru', timeout: 0, appendonly: true, save: '3600 1 300 100 60 10000' },
    backup: { enabled: true, mode: 'daily', time: '04:30', intervalHours: 6, keep: 7 },
    defaultDb: '',
    appUser: '',
    adminUser: 'default',
  },
  passwords: { admin: hex(24), app: '' },
  schemas: [],
  users: [],
});
// 하나는 모든 인터페이스에서 받는다 (Tailscale 로 PC DB 툴 접속)
dbs.find((d) => d.slug === 'store-db')!.config.bind = 'all';

const DB_LOAD: Record<string, [number, number]> = {
  'store-db': [2.1, 412 * MB],
  'rewards-db': [0.3, 168 * MB],
  'hrbot-db': [0.2, 151 * MB],
  'forms-db': [0.1, 139 * MB],
  'ticket-db': [0.2, 144 * MB],
  'stock-db': [1.4, 301 * MB],
  'buildcontest-db': [0.1, 133 * MB],
  cache: [0.5, 38 * MB],
};
for (const d of dbs) units[UNIT.db(d.slug)] = runningUnit(UNIT.db(d.slug), { cpu: DB_LOAD[d.slug]![0], mem: DB_LOAD[d.slug]![1], port: d.config.port, tasks: d.type === 'redis' ? 6 : 34 });
units[UNIT.panel] = runningUnit(UNIT.panel, { cpu: 0.9, mem: 118 * MB, port: 7700, tasks: 12, since: NOW - 9 * DAY });
units[UNIT.rootSlice] = { ...runningUnit(UNIT.rootSlice, { cpu: 0, mem: 0 }), pid: 0 };
units[UNIT.appsSlice] = { ...runningUnit(UNIT.appsSlice, { cpu: 0, mem: 0 }), pid: 0 };
units[UNIT.dbsSlice] = { ...runningUnit(UNIT.dbsSlice, { cpu: 0, mem: 0 }), pid: 0 };

function linksForDb(d: Db) {
  return apps.flatMap((a) => a.links.filter((l) => l.db === d.slug).map((l) => ({ slug: a.slug, name: a.name, prefix: l.prefix })));
}

function connectionEnv(d: Db, prefix = '') {
  const p = prefix.toUpperCase();
  const host = '127.0.0.1';
  const port = String(d.config.port);
  if (d.type === 'mariadb') {
    const { appUser: user, defaultDb: name } = d.config;
    const pass = d.passwords.app;
    return [
      { key: `${p}DB_HOST`, value: host },
      { key: `${p}DB_PORT`, value: port },
      { key: `${p}DB_USER`, value: user },
      { key: `${p}DB_PASSWORD`, value: pass },
      { key: `${p}DB_NAME`, value: name },
      { key: `${p}DATABASE_URL`, value: `mysql://${user}:${pass}@${host}:${port}/${name}` },
    ];
  }
  return [
    { key: `${p}REDIS_HOST`, value: host },
    { key: `${p}REDIS_PORT`, value: port },
    { key: `${p}REDIS_PASSWORD`, value: d.passwords.admin },
    { key: `${p}REDIS_URL`, value: `redis://:${d.passwords.admin}@${host}:${port}/0` },
  ];
}

// ---------- 배포 ----------

type DeployStatus = 'pending' | 'scheduled' | 'queued' | 'running' | 'success' | 'failed' | 'rolled_back' | 'rejected' | 'cancelled' | 'superseded';
interface Commit {
  sha: string;
  author: string;
  date: number;
  message: string;
}
interface Deploy {
  id: number;
  app_id: number;
  trigger: 'push' | 'webhook' | 'manual' | 'rollback' | 'initial' | 'config';
  status: DeployStatus;
  from_sha: string | null;
  to_sha: string | null;
  commits: Commit[];
  scheduled_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  triggered_by: string | null;
  approved_by: string | null;
  error: string | null;
}

const MESSAGES = [
  '결제 완료 DM 문구 다듬기',
  '일괄 할인 기간이 끝나면 원래 가격으로 되돌리기',
  '입금 계좌 여러 개 지원',
  '닉네임 변경 쿨타임 7일로 변경',
  '관리자 페이지 로그 필터 추가',
  'Pushbullet 알림 중복 수신 수정',
  '할로윈 이벤트 상품 추가',
  '의존성 업데이트 (fastify 5.12)',
  '세션 만료 시간 늘리기',
  '투표 마감 시각 KST 기준으로 수정',
  '티켓 닫기 버튼 권한 확인',
  '욕설 필터 모델 갱신',
  'README 설치 방법 정리',
  '주가 변동폭 상한 적용',
  '헬스 체크 엔드포인트 추가',
  '로그 색상 정리',
  'SMTP 실패 시 재시도',
  '구매 내역 CSV 내보내기',
];
const AUTHORS = ['minji', '서연', 'dependabot[bot]'];

const deploys: Deploy[] = [];
function commitsFor(n: number, end: number): Commit[] {
  return Array.from({ length: n }, (_, i) => ({ sha: hex(), author: pick(AUTHORS), date: end - i * 17 * MIN, message: pick(MESSAGES) }));
}
function addDeploy(app: App, d: Partial<Deploy> & { status: DeployStatus; created_at: number }) {
  const commits = d.commits ?? commitsFor(1 + Math.floor(rand() * 3), d.created_at - 2 * MIN);
  const dep: Deploy = {
    id: deploys.length + 1,
    app_id: app.id,
    trigger: 'push',
    from_sha: hex(),
    to_sha: commits[0]?.sha ?? hex(),
    scheduled_at: null,
    started_at: d.status === 'pending' || d.status === 'scheduled' ? null : d.created_at + 1000,
    finished_at: ['success', 'failed', 'rolled_back'].includes(d.status) ? d.created_at + 30_000 + Math.floor(rand() * 60_000) : d.status === 'rejected' || d.status === 'superseded' || d.status === 'cancelled' ? d.created_at + 10 * MIN : null,
    triggered_by: 'github',
    approved_by: null,
    error: null,
    ...d,
    commits,
  };
  deploys.push(dep);
  return dep;
}

// 앱별 배포 이력 (오래된 것부터)
for (const a of apps) {
  const deployedAt = a.deployed_at!;
  addDeploy(a, { status: 'success', trigger: 'initial', created_at: a.created_at + 5 * MIN, from_sha: null, triggered_by: 'admin' });
  const n = 3 + Math.floor(rand() * 3);
  for (let i = n; i >= 1; i--) {
    const t = deployedAt - i * (1 + rand() * 2) * DAY;
    if (t <= a.created_at) continue;
    const status: DeployStatus = i === 2 && a.slug === 'hrbot' ? 'rolled_back' : i === 3 && a.slug === 'shop' ? 'failed' : 'success';
    addDeploy(a, { status, created_at: t, error: status === 'failed' ? '빌드 실패: npm run build 종료 코드 2' : status === 'rolled_back' ? '헬스 체크 실패 → 이전 버전으로 되돌림' : null });
  }
  // 지금 배포된 버전
  if (a.slug === 'ticket') {
    addDeploy(a, { status: 'success', created_at: deployedAt - 10 * MIN, to_sha: hex(), commits: commitsFor(1, deployedAt - 12 * MIN) });
    addDeploy(a, { status: 'failed', created_at: deployedAt, to_sha: a.deployed_sha, commits: [{ sha: a.deployed_sha!, author: 'minji', date: deployedAt - MIN, message: '티켓 닫기 버튼 권한 확인' }], error: '앱이 시작 직후 종료됨 (exit 1) — ModuleNotFoundError: No module named "discord.ui"' });
  } else {
    addDeploy(a, { status: 'success', created_at: deployedAt, to_sha: a.deployed_sha, commits: [{ sha: a.deployed_sha!, author: pick(AUTHORS.slice(0, 2)), date: deployedAt - 2 * MIN, message: pick(MESSAGES) }], trigger: a.slug === 'hrbot' ? 'webhook' : 'push' });
  }
}
// stock: 수동 승인 대기
const stockApp = apps.find((a) => a.slug === 'stock')!;
addDeploy(stockApp, {
  status: 'pending',
  created_at: NOW - 25 * MIN,
  from_sha: stockApp.deployed_sha,
  to_sha: stockApp.last_seen_sha,
  commits: [
    { sha: stockApp.last_seen_sha!, author: 'minji', date: NOW - 27 * MIN, message: '주가 변동폭 상한 적용' },
    { sha: hex(), author: '서연', date: NOW - 52 * MIN, message: '장 마감 공지 문구 수정' },
  ],
});
// shop: 지연 배포 예약
const storeApp = apps.find((a) => a.slug === 'shop')!;
addDeploy(storeApp, {
  status: 'scheduled',
  created_at: NOW - 1 * MIN,
  scheduled_at: NOW + 4 * MIN,
  from_sha: storeApp.deployed_sha,
  commits: [{ sha: hex(), author: 'minji', date: NOW - 2 * MIN, message: '구매 내역 CSV 내보내기' }],
});
deploys.sort((a, b) => a.created_at - b.created_at).forEach((d, i) => (d.id = i + 1));

const OPEN: DeployStatus[] = ['pending', 'scheduled', 'queued', 'running'];
const appById = (id: number) => apps.find((a) => a.id === id);
const withApp = (d: Deploy) => ({ ...d, appSlug: appById(d.app_id)?.slug, appName: appById(d.app_id)?.name });

function deployLog(d: Deploy) {
  const app = appById(d.app_id)!;
  const node = app.config.runtime === 'node';
  const lines = [
    `[HROne] 배포 #${d.id} 시작 (${d.trigger})`,
    `$ git fetch origin ${app.config.branch}`,
    `$ git checkout --force ${d.to_sha?.slice(0, 7)}`,
    `HEAD is now at ${d.to_sha?.slice(0, 7)} ${d.commits[0]?.message ?? ''}`,
    node ? `$ ${app.config.installCmd}` : '$ uv sync --frozen',
    node ? '\x1b[2madded 214 packages, and audited 215 packages in 6s\x1b[0m' : '\x1b[2mResolved 38 packages in 1.2s\x1b[0m',
    node ? 'found \x1b[32m0\x1b[0m vulnerabilities' : 'Installed 38 packages in 412ms',
  ];
  if (node && app.config.buildCmd) lines.push(`$ ${app.config.buildCmd}`, '\x1b[36mvite v8.3.5\x1b[0m building for production...', '\x1b[32m✓\x1b[0m 1284 modules transformed.', 'dist/index.html  0.62 kB', '\x1b[32m✓ built in 4.81s\x1b[0m');
  if (d.status === 'failed') lines.push(`\x1b[31m${d.error}\x1b[0m`, '[HROne] 배포 실패');
  else if (d.status === 'rolled_back') lines.push('[HROne] 헬스 체크 실패 (30초)', '[HROne] 이전 버전으로 되돌렸습니다');
  else if (d.status === 'success') lines.push(`[HROne] ${UNIT.app(app.slug)} 재시작`, `[HROne] 포트 ${app.config.port} 응답 확인`, '[HROne] 배포 완료');
  else if (d.status === 'running') lines.push('[HROne] 진행 중...');
  return lines.join('\n');
}

// ---------- 백업 / 작업 / 감사 ----------

interface Backup {
  id: number;
  kind: 'database' | 'app';
  target_slug: string;
  file: string;
  size: number;
  trigger: 'manual' | 'schedule' | 'predeploy' | 'terminate';
  status: 'running' | 'done' | 'failed';
  note: string | null;
  created_at: number;
}
const backups: Backup[] = [];
function addBackup(kind: Backup['kind'], slug: string, trigger: Backup['trigger'], at: number, size: number, status: Backup['status'] = 'done', note: string | null = null) {
  const stamp = new Date(at).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  backups.push({
    id: backups.length + 1,
    kind,
    target_slug: slug,
    file: `/var/lib/hrone/backups/${kind === 'database' ? 'db' : 'app'}/${slug}/${slug}-${stamp}.${kind === 'database' ? 'sql.gz' : 'tar.gz'}`,
    size,
    trigger,
    status,
    note,
    created_at: at,
  });
}
const today4 = (() => {
  const d = new Date(NOW);
  d.setHours(4, 30, 0, 0);
  return d.getTime() > NOW ? d.getTime() - DAY : d.getTime();
})();
addBackup('database', 'store-db', 'schedule', today4 - DAY, 3.1 * MB);
addBackup('database', 'stock-db', 'schedule', today4 - DAY, 7.4 * MB);
addBackup('app', 'shop', 'predeploy', NOW - 26 * HOUR, 1.2 * MB);
addBackup('database', 'rewards-db', 'schedule', today4, 410 * 1024);
addBackup('database', 'store-db', 'schedule', today4, 3.3 * MB);
addBackup('database', 'stock-db', 'schedule', today4, 7.6 * MB);
addBackup('database', 'ticket-db', 'schedule', today4, 220 * 1024, 'failed', 'mariadb-dump: 연결 시간 초과');
addBackup('app', 'shop', 'schedule', NOW - 6 * HOUR, 1.3 * MB);
addBackup('database', 'store-db', 'manual', NOW - 3 * HOUR, 3.4 * MB, 'done', '할인 이벤트 전');
addBackup('app', 'chatfilter', 'manual', NOW - 2 * HOUR, 46 * MB, 'done', 'model.onnx 포함');
addBackup('database', 'cache', 'schedule', today4, 2.2 * MB);

interface Job {
  id: number;
  kind: string;
  target: string;
  title: string;
  status: 'running' | 'done' | 'failed';
  lines: string[];
  error: string | null;
  result: Record<string, unknown> | null;
  startedAt: number;
  finishedAt: number | null;
}
const jobs = new Map<number, Job>();
let jobSeq = 100;

interface AuditRow {
  id: number;
  ts: number;
  username: string;
  ip: string;
  action: string;
  target: string;
  detail: string;
}
const auditRows: AuditRow[] = [];
const AUDIT_SEED: [string, string, string, string][] = [
  ['admin', 'auth.login', '', ''],
  ['admin', 'deploy.approve', 'rewards', '#18'],
  ['github', 'hook.bad_signature', 'forms', ''],
  ['admin', 'app.env', 'shop', '["PAYMENT_API_KEY"]'],
  ['admin', 'app.restart', 'shop', ''],
  ['seoyeon', 'auth.login', '', ''],
  ['seoyeon', 'db.reveal', 'store-db', ''],
  ['seoyeon', 'db.query', 'store-db', 'SELECT * FROM orders WHERE status = \'pending\''],
  ['admin', 'backup.create', 'store-db', ''],
  ['system', 'backup.create', 'stock-db', '{"trigger":"schedule"}'],
  ['admin', 'app.stop', 'forms', ''],
  ['admin', 'app.autostart', 'forms', '{"enabled":false}'],
  ['admin', 'deploy.manual', 'ticket', ''],
  ['admin', 'app.update', 'shop', '["deployMode","deployDelaySec"]'],
  ['admin', 'db.limits', 'store-db', '{"maxConnections":151}'],
  ['admin', 'app.link', 'stock', 'cache (REDIS_)'],
  ['admin', 'system.tuning', '', '[{"key":"vm.swappiness","ok":true}]'],
  ['admin', 'settings.update', '', '["alerts"]'],
  ['admin', 'auth.login_failed', '', ''],
  ['admin', 'auth.login', '', ''],
  ['seoyeon', 'app.file_edit', 'hrbot', 'config.yml'],
  ['seoyeon', 'app.git_commit', 'hrbot', 'config: 경고 채널 변경'],
  ['seoyeon', 'app.git_push', 'hrbot', ''],
  ['admin', 'db.create', 'buildcontest-db', ''],
  ['admin', 'db.init', 'buildcontest-db', ''],
  ['admin', 'app.create', 'buildcontest', ''],
  ['admin', 'deploy.initial', 'buildcontest', ''],
  ['admin', 'user.create', 'seoyeon', ''],
  ['admin', 'auth.totp_enable', '', ''],
  ['admin', 'db.password', 'rewards-db', '{"which":"app"}'],
  ['admin', 'app.secrets', 'rewards', '["discordWebhook"]'],
  ['admin', 'deploy.rollback', 'hrbot', ''],
  ['admin', 'deploy.reject', 'stock', ''],
  ['admin', 'db.restart', 'cache', ''],
  ['admin', 'backup.download', 'chatfilter', '{"id":10}'],
  ['admin', 'app.kill', 'chatfilter', ''],
  ['admin', 'app.start', 'chatfilter', ''],
  ['admin', 'system.limits', '', '{"apps":{"memoryMB":8192}}'],
  ['seoyeon', 'db.schema_create', 'store-db', 'store_staging'],
  ['admin', 'auth.login', '', ''],
];
AUDIT_SEED.forEach(([user, action, target, detail], i) => {
  auditRows.push({ id: i + 1, ts: NOW - (AUDIT_SEED.length - i) * 2.7 * HOUR, username: user, ip: user === 'system' ? '' : user === 'github' ? '140.82.115.12' : user === 'seoyeon' ? '100.88.12.4' : '100.101.32.7', action, target, detail });
});
function audit(action: string, target = '', detail: unknown = '') {
  auditRows.push({ id: auditRows.length + 1, ts: Date.now(), username: 'admin', ip: '127.0.0.1', action, target, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
}

// ---------- 설정 / 사용자 / 세션 ----------

const settings = {
  panel: { port: 7700, access: 'private' as 'private' | 'all' | 'custom', allowedCidrs: ['100.64.0.0/10'], baseUrl: 'https://panel.example.com' },
  defaults: { pollIntervalSec: 60, notify: { push: true, pending: true, start: false, success: true, failure: true, crash: true } as Record<string, boolean> },
  alerts: { enabled: true, diskPercent: 90, memPercent: 95 },
  githubToken: 'ghp_' + hex(36),
  discordWebhook: 'https://discord.com/api/webhooks/000000000000000000/' + hex(60),
};
let limits = {
  total: { cpu: null as number | null, memoryMB: 10240 as number | null, swapMB: null as number | null, tasks: null as number | null, cpuWeight: null as number | null },
  apps: { cpu: 1.6 as number | null, memoryMB: 8192 as number | null, swapMB: 1024 as number | null, tasks: null as number | null, cpuWeight: null as number | null },
  dbs: { cpu: null as number | null, memoryMB: 3072 as number | null, swapMB: null as number | null, tasks: null as number | null, cpuWeight: null as number | null },
};
const update = {
  settings: { enabled: true, intervalHours: 6 },
  current: { sha: hex(), message: '설정: 업데이트 탭 정리', date: NOW - 2 * DAY },
};

const users = [
  { id: 1, username: 'admin', totpEnabled: true, createdAt: NOW - 60 * DAY, lastLoginAt: NOW - 20 * MIN },
  { id: 2, username: 'seoyeon', totpEnabled: false, createdAt: NOW - 33 * DAY, lastLoginAt: NOW - 2 * DAY },
];
const sessions = [
  { id: hex(16), created_at: NOW - 20 * MIN, last_seen_at: NOW - 5_000, ip: '100.101.32.7', user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', current: true },
  { id: hex(16), created_at: NOW - 3 * DAY, last_seen_at: NOW - 7 * HOUR, ip: '100.88.40.19', user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1', current: false },
  { id: hex(16), created_at: NOW - 6 * DAY, last_seen_at: NOW - 2 * DAY, ip: '211.36.142.88', user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', current: false },
];
let loggedIn = true;
const publicUser = (u: (typeof users)[0]) => ({ ...u });

// ---------- 시스템 ----------

const MEM_TOTAL = 11 * GB + 512 * MB;
const DISK_TOTAL = 96 * GB;
const SWAP_TOTAL = 2 * GB;
let sysCpu = 18;
let sysMem = 58;
let uptime = 9 * 86400 + 4 * 3600;
let diskUsed = 41.3 * GB;

function systemNow() {
  sysCpu = clamp(sysCpu + (rand() - 0.5) * 8, 6, 55);
  sysMem = clamp(sysMem + (rand() - 0.5) * 1.2, 52, 66);
  const c1 = clamp(sysCpu + (rand() - 0.5) * 12, 1, 100);
  const c2 = clamp(sysCpu * 2 - c1, 1, 100);
  return {
    t: Date.now(),
    cpu: round(sysCpu),
    mem: round(sysMem),
    memUsed: Math.round((MEM_TOTAL * sysMem) / 100),
    rx: Math.round(40_000 + rand() * 220_000),
    tx: Math.round(25_000 + rand() * 160_000),
    load: round(0.3 + sysCpu / 40, 2),
    memTotal: MEM_TOTAL,
    swapTotal: SWAP_TOTAL,
    swapUsed: 182 * MB,
    cores: [round(c1), round(c2)],
    disk: [
      { mount: '/', total: DISK_TOTAL, used: Math.round(diskUsed) },
      { mount: '/boot/efi', total: 1.1 * GB, used: 6.4 * MB },
    ],
    uptime,
  };
}
let lastSys = systemNow();

function sysHistory(range: '1h' | '24h') {
  const n = range === '1h' ? 360 : 1440;
  const step = range === '1h' ? 10_000 : 60_000;
  const out = [];
  let cpu = 20;
  let mem = 57;
  for (let i = n; i > 0; i--) {
    const t = Date.now() - i * step;
    const hour = new Date(t).getHours();
    const daily = range === '24h' ? (hour >= 19 && hour <= 23 ? 14 : hour < 6 ? -8 : 0) : 0;
    cpu = clamp(cpu + (rand() - 0.5) * 6, 5, 60);
    mem = clamp(mem + (rand() - 0.5) * 0.8, 50, 68);
    const c = round(clamp(cpu + daily + (rand() < 0.02 ? 30 : 0), 2, 98));
    out.push({ t, cpu: c, mem: round(mem), memUsed: Math.round((MEM_TOTAL * mem) / 100), rx: Math.round(30_000 + rand() * 250_000 + daily * 8000), tx: Math.round(20_000 + rand() * 180_000), load: round(0.2 + c / 40, 2) });
  }
  return out;
}

function unitHistory(unit: string) {
  const b = base[unit];
  if (!b || units[unit]?.state !== 'running') return [];
  const out = [];
  let cpu = b.cpu;
  let mem = b.mem;
  for (let i = 150; i > 0; i--) {
    cpu = clamp(cpu + (rand() - 0.5) * b.cpu * 0.4, 0, 100);
    mem = clamp(mem + (rand() - 0.5) * b.mem * 0.02, b.mem * 0.85, b.mem * 1.15);
    out.push({ t: Date.now() - i * 4000, cpu: round(cpu, 2), mem: Math.round(mem) });
  }
  return out;
}

function tick() {
  lastSys = systemNow();
  uptime += 2;
  for (const u of Object.values(units)) {
    const b = base[u.unit];
    if (u.state !== 'running' || !b || u.unit.endsWith('.slice')) continue;
    u.cpu = round(clamp(b.cpu * (0.7 + rand() * 0.6), 0, 100), 2);
    u.memory = Math.round(b.mem * (0.97 + rand() * 0.06));
  }
  // 슬라이스 = 합계
  const sum = (pre: string) => {
    const list = Object.values(units).filter((u) => u.unit.startsWith(pre) && u.unit.endsWith('.service') && u.state === 'running');
    return { cpu: round(list.reduce((a, u) => a + (u.cpu ?? 0), 0), 2), memory: list.reduce((a, u) => a + (u.memory ?? 0), 0) };
  };
  Object.assign(units[UNIT.appsSlice]!, sum('hrone-app-'));
  Object.assign(units[UNIT.dbsSlice]!, sum('hrone-db-'));
  const a = units[UNIT.appsSlice]!;
  const d = units[UNIT.dbsSlice]!;
  const p = units[UNIT.panel]!;
  Object.assign(units[UNIT.rootSlice]!, { cpu: round((a.cpu ?? 0) + (d.cpu ?? 0) + (p.cpu ?? 0), 2), memory: (a.memory ?? 0) + (d.memory ?? 0) + (p.memory ?? 0) });
}
tick();

// ---------- 로그 ----------

interface LogEntry {
  t: number;
  m: string;
  s: 'a' | 's' | 'h';
  p: number;
}

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m', m: '\x1b[35m' };

function appLine(slug: string): { m: string; p: number } {
  const nick = pick(['서연', 'minji', '하늘별', 'player01', '초코우유', '달빛고양이', 'Steve_KR', '라임']);
  const ms = Math.floor(3 + rand() * 120);
  const r = rand();
  if (slug === 'shop') {
    if (r < 0.45) return { m: `${C.d}${new Date().toISOString()}${C.x} ${C.g}INFO${C.x} GET /api/products ${C.g}200${C.x} ${ms}ms`, p: 6 };
    if (r < 0.65) return { m: `${C.g}INFO${C.x} 주문 #${1825 + Math.floor(rand() * 40)} 입금 확인 (${nick}, ${pick(['9,900', '3,000', '19,900'])}원)`, p: 6 };
    if (r < 0.8) return { m: `${C.c}DM${C.x} 구매 안내 메시지 전송 → ${nick}`, p: 6 };
    if (r < 0.9) return { m: `${C.y}WARN${C.x} Pushbullet 응답 지연 ${ms * 20}ms (재시도 1/3)`, p: 4 };
    return { m: `${C.d}${new Date().toISOString()}${C.x} ${C.g}INFO${C.x} POST /api/checkout ${C.g}201${C.x} ${ms}ms`, p: 6 };
  }
  if (slug === 'ticket') {
    if (r < 0.5) return { m: 'Traceback (most recent call last):', p: 3 };
    return { m: `${C.r}ModuleNotFoundError${C.x}: No module named 'discord.ui'`, p: 3 };
  }
  if (slug === 'chatfilter') {
    if (r < 0.6) return { m: `INFO:     127.0.0.1:${40000 + Math.floor(rand() * 9999)} - "POST /check HTTP/1.1" ${C.g}200 OK${C.x}`, p: 6 };
    if (r < 0.85) return { m: `${C.m}차단${C.x} score=${(0.82 + rand() * 0.17).toFixed(2)} user=${nick}`, p: 5 };
    return { m: `${C.y}WARNING${C.x}  추론 시간 ${ms * 3}ms (기준 200ms 초과)`, p: 4 };
  }
  if (slug === 'stock') return { m: `${C.c}[tick]${C.x} DIAM ${12000 + Math.floor(rand() * 900)} ${rand() > 0.5 ? C.g + '▲' : C.r + '▼'}${(rand() * 3).toFixed(2)}%${C.x}  EMRL ${3000 + Math.floor(rand() * 200)}`, p: 6 };
  if (slug === 'hrbot') return r < 0.8 ? { m: `${C.g}[INFO]${C.x} /${pick(['경고', '정보', '랭킹', '출석'])} 실행 by ${nick}`, p: 6 } : { m: `${C.y}[WARN]${C.x} rate limited, ${ms}ms 대기`, p: 4 };
  return r < 0.85 ? { m: `${C.g}info${C.x} ${pick(['GET', 'POST'])} /${pick(['vote', 'entries', 'health', 'api/me'])} ${C.g}200${C.x} - ${ms} ms`, p: 6 } : { m: `${C.y}warn${C.x} 세션 만료: ${nick}`, p: 4 };
}

function dbLine(slug: string): { m: string; p: number } {
  if (slug === 'cache') return pick([{ m: `${process.pid}:M ${new Date().toUTCString()} * 100 changes in 300 seconds. Saving...`, p: 6 }, { m: `${process.pid}:M * Background saving terminated with success`, p: 6 }, { m: `${process.pid}:C * DB saved on disk`, p: 6 }]);
  return pick([
    { m: `[Note] Aborted connection ${Math.floor(rand() * 9000)} to db: '${slug.replace(/-db$/, '')}' user: 'app' host: '127.0.0.1' (Got timeout reading communication packets)`, p: 5 },
    { m: '[Note] InnoDB: Buffer pool(s) load completed', p: 6 },
    { m: `[Warning] Aborted connection ${Math.floor(rand() * 9000)} (Got an error reading communication packets)`, p: 4 },
  ]);
}

function backlog(kind: 'app' | 'db', slug: string): LogEntry[] {
  const out: LogEntry[] = [];
  const start = Date.now() - 60 * 47_000;
  const svc = kind === 'app' ? UNIT.app(slug) : UNIT.db(slug);
  out.push({ t: start - 3000, m: `Started ${svc} - HROne ${kind === 'app' ? 'app' : 'database'} ${slug}.`, s: 's', p: 6 });
  if (kind === 'app') {
    const app = apps.find((a) => a.slug === slug);
    out.push({ t: start - 2000, m: `배포 ${app?.deployed_sha?.slice(0, 7) ?? ''} 실행`, s: 'h', p: 6 });
    if (app?.config.runtime === 'node') out.push({ t: start - 1500, m: `${C.d}> ${slug}@1.0.0 start${C.x}\n`.trim(), s: 'a', p: 6 });
    out.push({ t: start - 1000, m: `${C.b}${C.g}✓${C.x} 서버 시작: http://0.0.0.0:${app?.config.port ?? 3000}`, s: 'a', p: 6 });
  }
  for (let i = 0; i < 60; i++) {
    const l = kind === 'app' ? appLine(slug) : dbLine(slug);
    out.push({ t: start + i * 47_000, m: l.m, s: 'a', p: l.p });
  }
  if (kind === 'app' && slug === 'ticket') {
    out.push({ t: Date.now() - 47 * MIN, m: `${UNIT.app(slug)}: Main process exited, code=exited, status=1/FAILURE`, s: 's', p: 3 });
    out.push({ t: Date.now() - 47 * MIN, m: `${UNIT.app(slug)}: Start request repeated too quickly.`, s: 's', p: 3 });
    out.push({ t: Date.now() - 47 * MIN, m: `Failed to start ${UNIT.app(slug)} - HROne app ${slug}.`, s: 's', p: 3 });
  }
  return out;
}

// ---------- 파일 ----------

interface FEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
  text?: string;
}
function fileTree(app: App): Record<string, FEntry[]> {
  const t = app.deployed_at ?? NOW;
  if (app.config.runtime === 'python') {
    const main = `import asyncio\nimport logging\nimport os\n\nfrom ${app.slug.replace(/-/g, '_')}.bot import create_bot\n\nlogging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))\n\n\nasync def main() -> None:\n    bot = create_bot()\n    await bot.start(os.environ["DISCORD_TOKEN"])\n\n\nif __name__ == "__main__":\n    asyncio.run(main())\n`;
    return {
      '': [
        { name: '.venv', type: 'dir', size: 4096, mtime: t },
        { name: 'data', type: 'dir', size: 4096, mtime: NOW - HOUR },
        { name: 'src', type: 'dir', size: 4096, mtime: t },
        { name: '.env', type: 'file', size: 214, mtime: t, text: '# HROne 이 관리합니다\nLOG_LEVEL=INFO\n' },
        { name: 'README.md', type: 'file', size: 612, mtime: t, text: `# ${app.name}\n\n디스코드 봇.\n\n## 실행\n\n\`\`\`bash\nuv sync\nuv run python main.py\n\`\`\`\n` },
        { name: 'main.py', type: 'file', size: main.length, mtime: t, text: main },
        { name: 'pyproject.toml', type: 'file', size: 288, mtime: t, text: `[project]\nname = "${app.slug}"\nversion = "1.4.0"\nrequires-python = ">=3.12"\ndependencies = [\n    "discord.py>=2.5",\n    "aiomysql>=0.2",\n]\n` },
        { name: 'uv.lock', type: 'file', size: 58_211, mtime: t, text: 'version = 1\nrequires-python = ">=3.12"\n' },
      ],
      src: [{ name: 'bot.py', type: 'file', size: 1840, mtime: t, text: 'import discord\nfrom discord.ext import commands\n\n\ndef create_bot() -> commands.Bot:\n    intents = discord.Intents.default()\n    intents.message_content = True\n    return commands.Bot(command_prefix="!", intents=intents)\n' }],
      data: [{ name: 'state.sqlite', type: 'file', size: 286_720, mtime: NOW - HOUR }],
      '.venv': [],
    };
  }
  const pkg = JSON.stringify(
    {
      name: app.slug,
      version: '1.6.2',
      private: true,
      type: 'module',
      scripts: { dev: 'tsx watch src/index.ts', build: 'tsc -p .', start: 'node dist/index.js' },
      dependencies: { fastify: '^5.12.7', mysql2: '^3.15.0', 'discord.js': '^14.22.0' },
      devDependencies: { typescript: '^5.9.3', tsx: '^4.20.0' },
    },
    null,
    2,
  );
  const index = `import Fastify from 'fastify';\nimport { createPool } from 'mysql2/promise';\nimport { registerRoutes } from './routes/index.js';\n\nconst app = Fastify({ logger: true });\nconst db = createPool(process.env.DATABASE_URL!);\n\napp.get('/api/health', async () => ({ ok: true }));\nregisterRoutes(app, db);\n\nconst port = Number(process.env.PORT ?? ${app.config.port ?? 3000});\nawait app.listen({ host: '0.0.0.0', port });\nconsole.log(\`✓ 서버 시작: http://0.0.0.0:\${port}\`);\n`;
  return {
    '': [
      { name: 'dist', type: 'dir', size: 4096, mtime: t },
      { name: 'node_modules', type: 'dir', size: 4096, mtime: t },
      { name: 'src', type: 'dir', size: 4096, mtime: t },
      { name: '.env', type: 'file', size: 341, mtime: t, text: '# HROne 이 관리합니다\nNODE_ENV=production\n' },
      { name: 'README.md', type: 'file', size: 702, mtime: t, text: `# ${app.name}\n\n\`${app.slug}\` — 예제 서비스.\n\n## 개발\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n\n## 배포\n\nmain 브랜치에 push 하면 HROne 이 자동으로 배포합니다.\n` },
      { name: 'package-lock.json', type: 'file', size: 184_330, mtime: t, text: '{\n  "name": "' + app.slug + '",\n  "lockfileVersion": 3\n}\n' },
      { name: 'package.json', type: 'file', size: pkg.length, mtime: t, text: pkg + '\n' },
      { name: 'tsconfig.json', type: 'file', size: 260, mtime: t, text: '{\n  "compilerOptions": {\n    "target": "es2023",\n    "module": "nodenext",\n    "outDir": "dist",\n    "strict": true\n  }\n}\n' },
    ],
    src: [
      { name: 'routes', type: 'dir', size: 4096, mtime: t },
      { name: 'index.ts', type: 'file', size: index.length, mtime: t, text: index },
    ],
    'src/routes': [{ name: 'index.ts', type: 'file', size: 420, mtime: t, text: "import type { FastifyInstance } from 'fastify';\nimport type { Pool } from 'mysql2/promise';\n\nexport function registerRoutes(app: FastifyInstance, db: Pool) {\n  app.get('/api/products', async () => {\n    const [rows] = await db.query('SELECT * FROM products');\n    return rows;\n  });\n}\n" }],
    dist: [{ name: 'index.js', type: 'file', size: 1204, mtime: t, text: '// built\n' }],
    node_modules: [{ name: '.package-lock.json', type: 'file', size: 90_112, mtime: t, text: '{}\n' }],
  };
}
const fileEdits = new Map<string, Map<string, FEntry[]>>();
function treeOf(app: App) {
  let t = fileEdits.get(app.slug);
  if (!t) {
    t = new Map(Object.entries(fileTree(app)));
    fileEdits.set(app.slug, t);
  }
  return t;
}
function splitPath(p: string) {
  const clean = String(p ?? '').replace(/^\/+|\/+$/g, '');
  const i = clean.lastIndexOf('/');
  return { clean, dir: i < 0 ? '' : clean.slice(0, i), name: i < 0 ? clean : clean.slice(i + 1) };
}

// ---------- 서버 ----------

const server = Fastify({ logger: false });
await server.register(cookie);
await server.register(websocket);

server.setErrorHandler((err: Error & { status?: number; statusCode?: number }, _req, reply) => {
  const code = err instanceof HttpError ? err.status : (err.statusCode ?? 500);
  if (code >= 500) process.stderr.write(`[mock] error: ${err.stack ?? err.message}\n`);
  reply.code(code).send({ error: err.message });
});

server.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) process.stderr.write(`[mock] 404 not implemented: ${req.method} ${req.url}\n`);
  reply.code(404).send({ error: 'mock: not implemented' });
});

// 로그아웃 상태에서는 인증이 필요한 API 를 막는다 (실제 서버와 같게)
server.addHook('onRequest', async (req, reply) => {
  const url = req.url.split('?')[0]!;
  if (loggedIn || !url.startsWith('/api/') || url.startsWith('/api/auth/state') || url.startsWith('/api/auth/login') || url.startsWith('/api/auth/logout') || url === '/api/ws') return;
  reply.code(401).send({ error: '로그인이 필요합니다' });
});

// ----- WebSocket -----

const sockets = new Set<{ send: (s: string) => void; subs: Set<string>; open: () => boolean }>();
function emit(ch: string, data: unknown) {
  const msg = JSON.stringify({ ch, data });
  for (const s of sockets) if (s.subs.has(ch) && s.open()) s.send(msg);
}
const refresh = (...chs: string[]) => chs.forEach((c) => emit(c, { t: Date.now() }));
const statusPayload = () => ({ units, system: lastSys });

server.get('/api/ws', { websocket: true }, (socket) => {
  const client = { send: (s: string) => socket.send(s), subs: new Set<string>(), open: () => socket.readyState === socket.OPEN };
  sockets.add(client);
  socket.on('message', (raw: unknown) => {
    let msg: { op?: string; ch?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const ch = String(msg.ch ?? '');
    if (msg.op === 'sub') {
      client.subs.add(ch);
      if (ch === 'status') client.send(JSON.stringify({ ch, data: statusPayload() }));
    } else if (msg.op === 'unsub') client.subs.delete(ch);
  });
  socket.on('close', () => sockets.delete(client));
});

setInterval(() => {
  tick();
  emit('status', statusPayload());
}, 2000);

// 실시간 로그: 구독 중인 채널마다 3초에 한 줄
setInterval(() => {
  const chans = new Set<string>();
  for (const s of sockets) for (const ch of s.subs) chans.add(ch);
  for (const ch of chans) {
    const m = ch.match(/^logs:(app|db):(.+)$/);
    if (m) {
      const [, kind, slug] = m;
      if (kind === 'app' && units[UNIT.app(slug!)]?.state !== 'running') continue;
      if (kind === 'db' && units[UNIT.db(slug!)]?.state !== 'running') continue;
      const l = kind === 'app' ? appLine(slug!) : dbLine(slug!);
      emit(ch, [{ t: Date.now(), m: l.m, s: 'a', p: l.p }]);
      continue;
    }
    const d = ch.match(/^deploy:(\d+)$/);
    if (d) emit(ch, { line: `${C.d}[${new Date().toLocaleTimeString('ko-KR')}]${C.x} 진행 중...` });
  }
}, 3000);

function startJob(kind: string, target: string, title: string, steps: string[], result: Record<string, unknown> | null = null, after?: () => void) {
  const job: Job = { id: ++jobSeq, kind, target, title, status: 'running', lines: [], error: null, result: null, startedAt: Date.now(), finishedAt: null };
  jobs.set(job.id, job);
  refresh('jobs');
  steps.forEach((line, i) =>
    setTimeout(() => {
      job.lines.push(line);
      emit(`job:${job.id}`, { line });
    }, 400 * (i + 1)),
  );
  setTimeout(() => {
    job.status = 'done';
    job.result = result;
    job.finishedAt = Date.now();
    after?.();
    emit(`job:${job.id}`, { done: true, status: 'done', result });
    refresh('jobs');
  }, 400 * (steps.length + 1));
  return job;
}

// ----- 헬퍼 -----

const P = (req: FastifyRequest) => req.params as Record<string, string>;
const Q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string>;
const B = (req: FastifyRequest) => (req.body ?? {}) as Body;

function getApp(slug: string) {
  const a = apps.find((x) => x.slug === slug);
  if (!a) throw new HttpError(404, '앱이 없습니다');
  return a;
}
function getDb(slug: string) {
  const d = dbs.find((x) => x.slug === slug);
  if (!d) throw new HttpError(404, 'DB 가 없습니다');
  return d;
}
const repoWeb = (url: string) => url.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');

function appSummary(app: App) {
  const mine = deploys.filter((d) => d.app_id === app.id).sort((a, b) => b.id - a.id);
  const open = mine.find((d) => OPEN.includes(d.status));
  const last = mine.find((d) => !OPEN.includes(d.status) && d.status !== 'superseded');
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    runtime: app.config.runtime,
    runtimeVersion: app.config.runtimeVersion,
    repoUrl: app.config.repoUrl,
    repoWeb: repoWeb(app.config.repoUrl),
    branch: app.config.branch,
    port: app.config.port,
    publicUrl: app.config.publicUrl,
    deployMode: app.config.deployMode,
    deployDelaySec: app.config.deployDelaySec,
    autostart: app.config.autostart,
    desiredState: app.desired_state,
    deployedSha: app.deployed_sha,
    deployedAt: app.deployed_at,
    lastPollAt: app.last_poll_at,
    lastPollError: app.last_poll_error,
    status: units[UNIT.app(app.slug)] ?? null,
    openDeploy: open ? { id: open.id, status: open.status, to_sha: open.to_sha, scheduled_at: open.scheduled_at } : null,
    lastDeploy: last ? { id: last.id, status: last.status, finished_at: last.finished_at } : null,
    busy: !!mine.find((d) => d.status === 'running' || d.status === 'queued'),
  };
}

function dbSummary(d: Db) {
  return {
    id: d.id,
    slug: d.slug,
    name: d.name,
    type: d.type,
    port: d.config.port,
    bind: d.config.bind,
    autostart: d.config.autostart,
    initialized: d.initialized,
    desiredState: d.desired_state,
    status: units[UNIT.db(d.slug)] ?? null,
    job: null,
    linkedApps: linksForDb(d),
  };
}

function systemEnv(app: App) {
  return [
    { key: 'PORT', value: String(app.config.port ?? '') },
    { key: 'HOST', value: '0.0.0.0' },
    ...(app.config.runtime === 'node' ? [{ key: 'NODE_ENV', value: 'production' }] : [{ key: 'PYTHONUNBUFFERED', value: '1' }]),
    { key: 'FORCE_COLOR', value: app.config.forceColor ? '1' : '0' },
    { key: 'HRONE_APP', value: app.slug },
    { key: 'HRONE_DATA_DIR', value: `/var/lib/hrone/app-data/${app.slug}` },
  ].filter((v) => !app.env.some((e) => e.key === v.key));
}
const toDotenv = (vars: { key: string; value: string }[]) => vars.map((v) => `${v.key}=${/[\s#"']/.test(v.value) ? JSON.stringify(v.value) : v.value}`).join('\n') + (vars.length ? '\n' : '');

function lifecycle(app: App, action: string) {
  const u = UNIT.app(app.slug);
  if (action === 'stop' || action === 'kill') {
    app.desired_state = 'stopped';
    units[u] = stoppedUnit(u, app.config.autostart);
  } else {
    app.desired_state = 'running';
    setRunning(u, app.config.port);
    if (action === 'restart') units[u]!.restarts += 0;
  }
  emit('status', statusPayload());
  refresh('apps');
}

function sendText(reply: FastifyReply, name: string, text: string) {
  reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${name}"`);
  return reply.send(text);
}

// ----- 인증 -----

server.get('/api/auth/state', async () => ({ hasUsers: true, user: loggedIn ? publicUser(users[0]!) : null }));
server.post('/api/auth/login', async () => {
  loggedIn = true;
  audit('auth.login');
  return { user: publicUser(users[0]!) };
});
server.post('/api/auth/logout', async () => {
  loggedIn = false;
  return { ok: true };
});
server.get('/api/auth/me', async () => ({ user: publicUser(users[0]!) }));
server.post('/api/auth/password', async () => ({ ok: true }));
server.post('/api/auth/totp/begin', async () => {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  return { secret, uri: `otpauth://totp/HROne:admin?secret=${secret}&issuer=HROne&algorithm=SHA1&digits=6&period=30` };
});
server.post('/api/auth/totp/enable', async () => {
  users[0]!.totpEnabled = true;
  return { ok: true };
});
server.post('/api/auth/totp/disable', async () => {
  users[0]!.totpEnabled = false;
  return { ok: true };
});
server.get('/api/auth/sessions', async () => sessions);
server.delete('/api/auth/sessions/:id', async (req) => {
  const i = sessions.findIndex((s) => s.id === P(req).id && !s.current);
  if (i >= 0) sessions.splice(i, 1);
  return { ok: true };
});
server.get('/api/users', async () => users.map(publicUser));
server.post('/api/users', async (req) => {
  const username = String(B(req).username ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new HttpError(400, '아이디는 영문/숫자/_.- 3~32자');
  users.push({ id: users.length + 1, username, totpEnabled: false, createdAt: Date.now(), lastLoginAt: null as unknown as number });
  return { ok: true };
});
server.post('/api/users/:id/delete', async (req) => {
  const i = users.findIndex((u) => u.id === Number(P(req).id));
  if (i <= 0) throw new HttpError(400, '자기 자신은 삭제할 수 없습니다');
  users.splice(i, 1);
  return { ok: true };
});

// ----- 대시보드 / 시스템 -----

server.get('/api/dashboard', async () => ({
  apps: apps.map(appSummary),
  databases: dbs.map(dbSummary),
  open: deploys.filter((d) => OPEN.includes(d.status)).map((d) => ({ ...d, appSlug: appById(d.app_id)?.slug })),
  recent: [...deploys]
    .filter((d) => !OPEN.includes(d.status))
    .sort((a, b) => b.id - a.id)
    .slice(0, 10)
    .map(withApp),
  system: lastSys,
  units,
}));

let timezone = 'Asia/Seoul';
server.get('/api/system/info', async () => ({
  hostname: 'hrone-demo',
  os: 'Ubuntu 26.04 LTS',
  kernel: '7.0.0-1009-oracle',
  arch: 'arm64',
  cpuModel: 'Neoverse-N1',
  cores: 2,
  memTotal: MEM_TOTAL,
  virtualization: 'kvm',
  container: false,
  timezone,
  uptime,
  networks: [
    { name: 'enp0s6', address: '10.0.0.48' },
    { name: 'tailscale0', address: '100.101.32.1' },
  ],
  panelNode: 'v24.11.1',
  panelVersion: '1.0.0',
  tailscale: { installed: true, ip: '100.101.32.1', dnsName: 'hrone-demo.tail3c9e1.ts.net', state: 'Running', service: 'active' },
  cloudflared: {
    installed: true,
    version: '2026.10.1',
    service: 'active',
    ingress: [
      { hostname: 'store.example.com', service: 'http://localhost:3000' },
      { hostname: 'build.example.com', service: 'http://localhost:3001' },
      { hostname: 'forms.example.com', service: 'http://localhost:3003' },
      { hostname: 'rewards.example.com', service: 'http://localhost:3005' },
      { hostname: 'panel.example.com', service: 'http://localhost:7700' },
    ],
  },
  cgroupControllers: ['cpuset', 'cpu', 'io', 'memory', 'hugetlb', 'pids', 'rdma', 'misc'],
}));

server.get('/api/system/metrics', async (req) => ({ now: lastSys, history: sysHistory(Q(req).range === '24h' ? '24h' : '1h'), units }));
server.get('/api/system/limits', async () => limits);
server.put('/api/system/limits', async (req) => {
  const b = B(req);
  limits = { total: { ...limits.total, ...b.total }, apps: { ...limits.apps, ...b.apps }, dbs: { ...limits.dbs, ...b.dbs } };
  audit('system.limits', '', limits);
  return limits;
});

const TUNING = [
  { key: 'net.core.somaxconn', value: '65535', why: '대기 연결 큐 (동시 접속 많을 때)', current: '65535' },
  { key: 'net.ipv4.tcp_max_syn_backlog', value: '65535', why: 'SYN 대기 큐', current: '65535' },
  { key: 'net.ipv4.ip_local_port_range', value: '1024 65535', why: '아웃바운드 연결용 포트 범위', current: '32768 60999' },
  { key: 'net.ipv4.tcp_tw_reuse', value: '1', why: 'TIME_WAIT 소켓 재사용', current: '2' },
  { key: 'fs.file-max', value: '2097152', why: '시스템 전체 파일 핸들 상한', current: '2097152' },
  { key: 'fs.inotify.max_user_watches', value: '524288', why: '파일 감시 (개발 서버/번들러)', current: '524288' },
  { key: 'vm.overcommit_memory', value: '1', why: 'Redis 권장 (백그라운드 저장 실패 방지)', current: '1' },
  { key: 'vm.swappiness', value: '10', why: '스왑 사용 최소화', current: '60' },
];
server.get('/api/system/tuning', async () => TUNING);
server.post('/api/system/tuning', async () => {
  for (const t of TUNING) t.current = t.value;
  return TUNING.map((t) => ({ key: t.key, ok: true }));
});

let swap = [{ name: '/swapfile-hrone', size: SWAP_TOTAL, used: 182 * MB, type: 'file' }];
server.get('/api/system/swap', async () => ({ list: swap, managed: swap.length > 0, container: false }));
server.post('/api/system/swap', async (req) => {
  swap = [{ name: '/swapfile-hrone', size: Number(B(req).sizeMB ?? 2048) * MB, used: 0, type: 'file' }];
  return { list: swap, managed: true, container: false };
});
server.delete('/api/system/swap', async () => {
  swap = [];
  return { list: swap, managed: false, container: false };
});

server.get('/api/system/timezones', async () => ['UTC', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney']);
server.put('/api/system/timezone', async (req) => {
  timezone = String(B(req).timezone ?? timezone);
  return { ok: true, restartRecommended: true };
});
let journalUsage = 'Archived and active journals take up 1.4G in the file system.';
server.get('/api/system/journal', async () => ({ usage: journalUsage }));
server.post('/api/system/journal/vacuum', async () => {
  journalUsage = 'Archived and active journals take up 496.0M in the file system.';
  return { usage: journalUsage };
});

const components = {
  node: ['v24.11.1', 'v22.21.0'],
  python: [
    { version: '3.13.7', path: '/usr/bin/python3', managed: false },
    { version: '3.12.11', path: '/opt/hrone/runtimes/python/3.12.11/bin/python3', managed: true },
  ],
  uv: 'uv 0.9.8',
  mariadb: '11.8.3-MariaDB',
  redis: 'valkey 8.1.4',
  git: '2.51.0',
  buildEssential: true,
};
server.get('/api/system/components', async () => components);
server.get('/api/system/node-versions', async () => [
  { version: 'v25.2.0', lts: false },
  { version: 'v24.11.1', lts: 'Krypton' },
  { version: 'v23.11.1', lts: false },
  { version: 'v22.21.0', lts: 'Jod' },
  { version: 'v21.7.3', lts: false },
  { version: 'v20.19.5', lts: 'Iron' },
  { version: 'v19.9.0', lts: false },
  { version: 'v18.20.8', lts: 'Hydrogen' },
]);
server.post('/api/system/components/install', async (req) => {
  const b = B(req);
  const c = String(b.component);
  const v = String(b.version ?? '');
  const job = startJob('install', c, `${c} ${v} 설치`, [`${c} ${v} 내려받는 중...`, '압축 푸는 중...', '완료'], null, () => {
    if (c === 'node' && v && !components.node.includes(v)) components.node.push(v);
  });
  return { jobId: job.id };
});
server.post('/api/system/components/remove', async (req) => {
  const b = B(req);
  if (b.component === 'node') components.node = components.node.filter((x) => x !== b.version);
  return { ok: true };
});

server.get('/api/system/update/check', async () => ({
  available: true,
  local: update.current.sha.slice(0, 7),
  remote: hex(7),
  branch: 'main',
  commits: [
    { sha: hex(7), message: 'DB: 연결 수 그래프 추가', when: '3 hours ago' },
    { sha: hex(7), message: '앱 콘솔 검색 속도 개선', when: '9 hours ago' },
  ],
}));
server.post('/api/system/update', async () => ({ ok: true }));
server.get('/api/system/update/status', async () => ({
  version: '1.0.0',
  current: update.current,
  settings: update.settings,
  state: {
    lastCheckAt: NOW - 40 * MIN,
    lastResult: 'latest',
    message: '최신 버전입니다',
    pending: null,
    lastUpdate: { from: hex(7), to: update.current.sha.slice(0, 7), at: update.current.date + 10 * MIN, by: 'auto' },
  },
  busy: null,
}));
server.put('/api/system/update/settings', async (req) => {
  const b = B(req);
  if (typeof b.enabled === 'boolean') update.settings.enabled = b.enabled;
  if (b.intervalHours !== undefined) update.settings.intervalHours = Number(b.intervalHours);
  return update.settings;
});
server.get('/api/system/update/log', async () => ({ log: '[HROne] git pull\nAlready up to date.\n[HROne] npm ci\n[HROne] vite build\n[HROne] 재시작\n' }));
server.post('/api/system/restart-panel', async () => ({ ok: true }));
server.post('/api/system/verify', async () => ({ ok: true }));

// ----- 설정 -----

const maskHook = (u: string) => (u ? u.replace(/\/[\w-]{20,}$/, '/••••••') : '');
server.get('/api/settings', async () => ({
  panel: settings.panel,
  defaults: settings.defaults,
  alerts: settings.alerts,
  githubTokenSet: !!settings.githubToken,
  discordWebhook: maskHook(settings.discordWebhook),
  discordSet: !!settings.discordWebhook,
}));
server.put('/api/settings', async (req) => {
  const b = B(req);
  let restartNeeded = false;
  if (b.panel) {
    restartNeeded = b.panel.port !== undefined && Number(b.panel.port) !== settings.panel.port;
    settings.panel = { ...settings.panel, ...b.panel };
  }
  if (b.defaults) settings.defaults = { ...settings.defaults, ...b.defaults };
  if (b.alerts) settings.alerts = { ...settings.alerts, ...b.alerts };
  if (typeof b.githubToken === 'string') settings.githubToken = b.githubToken;
  if (typeof b.discordWebhook === 'string') settings.discordWebhook = b.discordWebhook;
  audit('settings.update', '', Object.keys(b));
  return { ok: true, restartNeeded };
});
server.post('/api/settings/test-discord', async () => ({ ok: true }));

server.get('/api/audit', async (req) => {
  const limit = clamp(Number(Q(req).limit) || 100, 1, 500);
  const before = Number(Q(req).before) || Number.MAX_SAFE_INTEGER;
  return auditRows
    .filter((r) => r.id < before)
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
});

server.get('/api/jobs', async () => [...jobs.values()].sort((a, b) => b.id - a.id));
server.get('/api/jobs/:id', async (req) => {
  const j = jobs.get(Number(P(req).id));
  if (!j) throw new HttpError(404, '작업이 없습니다 (완료 후 1시간이 지났을 수 있습니다)');
  return j;
});

// ----- 백업 -----

server.get('/api/backups', async (req) => {
  const { kind, slug } = Q(req);
  const k = kind === 'app' ? 'app' : kind === 'database' ? 'database' : null;
  return backups.filter((b) => (!k || b.kind === k) && (!slug || b.target_slug === slug)).sort((a, b) => b.created_at - a.created_at);
});
server.post('/api/backups', async (req) => {
  const b = B(req);
  const slug = String(b.slug ?? '');
  const kind: Backup['kind'] = b.kind === 'app' ? 'app' : 'database';
  const name = kind === 'app' ? getApp(slug).name : getDb(slug).name;
  const id = backups.length + 1;
  const job = startJob('backup', slug, `${name} ${kind === 'app' ? '데이터 ' : ''}백업`, ['덤프 시작...', '압축 중...', `완료: ${slug}-${Date.now()}.${kind === 'app' ? 'tar.gz' : 'sql.gz'}`], { download: `/api/backups/${id}/download`, name: `${slug}.gz` }, () => {
    addBackup(kind, slug, 'manual', Date.now(), (1 + rand() * 5) * MB, 'done', b.note ? String(b.note) : null);
    refresh('backups');
  });
  audit('backup.create', slug);
  return { jobId: job.id };
});
server.post('/api/backups/:id/restore', async (req) => {
  const bk = backups.find((b) => b.id === Number(P(req).id));
  if (!bk) throw new HttpError(404, '백업이 없습니다');
  const job = startJob(bk.kind === 'database' ? 'db-restore' : 'app-restore', bk.target_slug, `${bk.target_slug} 복원`, ['서비스 정지', '백업 푸는 중...', '복원 완료', '서비스 시작'], null);
  return { jobId: job.id };
});
server.delete('/api/backups/:id', async (req) => {
  const i = backups.findIndex((b) => b.id === Number(P(req).id));
  if (i >= 0) backups.splice(i, 1);
  refresh('backups');
  return { ok: true };
});
server.get('/api/backups/:id/download', async (req, reply) => {
  const bk = backups.find((b) => b.id === Number(P(req).id));
  if (!bk) throw new HttpError(404, '파일이 없습니다');
  return sendText(reply, bk.file.split('/').pop()!, '-- mock backup\n');
});

// ----- 앱 -----

server.get('/api/apps', async () => apps.map(appSummary));

server.post('/api/repo/deploykey', async () => ({ keyId: hex(16), publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${hex(40)} hrone-deploy` }));
server.post('/api/repo/inspect', async (req) => {
  const b = B(req);
  const url = String(b.repoUrl ?? '').trim();
  const py = /bot|py|ticket|filter/.test(url);
  const branches = [
    { name: 'main', sha: hex() },
    { name: 'dev', sha: hex() },
    { name: 'feat/halloween', sha: hex() },
  ];
  const branch = String(b.branch || 'main');
  if (!branches.some((x) => x.name === branch)) return { url, branches, defaultBranch: 'main', detection: null, error: `브랜치 ${branch} 가 없습니다` };
  return {
    url,
    branches,
    defaultBranch: 'main',
    detection: py
      ? { runtime: 'python', runtimeVersion: '3.12', packageManager: 'uv', installCmd: 'uv sync --frozen', buildCmd: '', startCmd: 'uv run python main.py', notes: ['pyproject.toml 과 uv.lock 을 찾았습니다'], files: ['pyproject.toml', 'uv.lock', 'main.py'] }
      : { runtime: 'node', runtimeVersion: '24', packageManager: 'npm', installCmd: 'npm ci', buildCmd: 'npm run build', startCmd: 'npm start', notes: ['package.json 의 engines.node = ">=24"', 'build 스크립트가 있어 빌드 명령을 채웠습니다'], files: ['package.json', 'package-lock.json', 'tsconfig.json'] },
  };
});
server.get('/api/github/repos', async () => {
  if (!settings.githubToken) return { tokenSet: false, repos: [] };
  const list = ['shop', 'rewards', 'hrbot', 'buildcontest', 'chatfilter', 'forms', 'stock', 'ticket', 'wiki', 'site', 'advancedstore', 'detectengine'];
  return {
    tokenSet: true,
    repos: list.map((r, i) => ({ fullName: `example/${r}`, private: i % 3 !== 2, defaultBranch: 'main', pushedAt: new Date(NOW - i * 7 * HOUR).toISOString(), description: i % 2 ? null : `예제 ${r}` })),
  };
});

server.post('/api/apps', async (req) => {
  const b = B(req);
  const slug = String(b.slug ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug)) throw new HttpError(400, '앱 ID 는 영문 소문자/숫자/- 2~31자');
  if (apps.some((a) => a.slug === slug)) throw new HttpError(409, '이미 있는 앱 ID 입니다');
  const config = (b.config ?? {}) as Partial<AppConfig>;
  const app = addApp({
    slug,
    name: String(b.name || slug),
    config: mkConfig({ runtime: 'node', repoUrl: gh(slug), ...config } as AppConfig),
    desired_state: 'running',
    deployed_sha: null,
    deployed_at: null,
    env: Array.isArray(b.env) ? b.env : [],
    links: Array.isArray(b.links) ? b.links.map((l: Body) => ({ db: String(l.database), prefix: String(l.prefix ?? '') })) : [],
  });
  app.created_at = Date.now();
  units[UNIT.app(slug)] = stoppedUnit(UNIT.app(slug));
  let deployId: number | null = null;
  if (b.deployNow !== false) {
    const d = addDeploy(app, { status: 'running', trigger: 'initial', created_at: Date.now(), from_sha: null, triggered_by: 'admin' });
    deployId = d.id;
    setTimeout(() => {
      d.status = 'success';
      d.finished_at = Date.now();
      app.deployed_sha = d.to_sha;
      app.deployed_at = Date.now();
      base[UNIT.app(slug)] = { cpu: 1, mem: 80 * MB };
      setRunning(UNIT.app(slug), app.config.port);
      refresh('deploys', 'apps');
    }, 8000);
  }
  audit('app.create', slug);
  refresh('apps', 'deploys');
  return { app: appSummary(app), deployId };
});

server.get('/api/apps/:slug', async (req) => {
  const app = getApp(P(req).slug!);
  return {
    ...appSummary(app),
    config: app.config,
    createdAt: app.created_at,
    deployKey: app.config.auth === 'deploykey' ? `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${hex(40)} hrone-${app.slug}` : null,
    webhookPath: `/api/hooks/github/${app.slug}`,
    links: app.links.map((l) => {
      const d = dbs.find((x) => x.slug === l.db);
      return { slug: d?.slug, name: d?.name, type: d?.type, prefix: l.prefix, port: d?.config.port, keys: d ? connectionEnv(d, l.prefix).map((v) => v.key) : [] };
    }),
    envCount: app.env.length,
    history: unitHistory(UNIT.app(app.slug)),
    dir: `/var/lib/hrone/apps/${app.slug}`,
    dataDir: `/var/lib/hrone/app-data/${app.slug}`,
    rejectedSha: app.rejected_sha,
    lastSeenSha: app.last_seen_sha,
  };
});

server.patch('/api/apps/:slug', async (req) => {
  const app = getApp(P(req).slug!);
  const b = B(req);
  if (typeof b.name === 'string' && b.name.trim()) app.name = b.name.trim();
  let redeploy = false;
  if (b.config && typeof b.config === 'object') {
    for (const k of ['installCmd', 'buildCmd', 'startCmd', 'runtimeVersion', 'rootDir', 'branch', 'repoUrl'] as const) if (k in b.config && b.config[k] !== app.config[k]) redeploy = true;
    app.config = { ...app.config, ...b.config };
  }
  audit('app.update', app.slug, Object.keys(b.config ?? {}));
  refresh('apps');
  return { app: appSummary(app), redeploy };
});

server.get('/api/apps/:slug/detect', async (req) => {
  const app = getApp(P(req).slug!);
  return { runtime: app.config.runtime, runtimeVersion: app.config.runtimeVersion, packageManager: app.config.runtime === 'node' ? 'npm' : 'uv', installCmd: app.config.installCmd, buildCmd: app.config.buildCmd, startCmd: app.config.startCmd, notes: [], files: [] };
});

server.post('/api/apps/:slug/action', async (req) => {
  const app = getApp(P(req).slug!);
  const action = String(B(req).action);
  if (!['start', 'stop', 'restart', 'kill'].includes(action)) throw new HttpError(400, '알 수 없는 동작');
  lifecycle(app, action);
  audit(`app.${action}`, app.slug);
  return { ok: true };
});
server.post('/api/apps/:slug/autostart', async (req) => {
  const app = getApp(P(req).slug!);
  app.config.autostart = !!B(req).enabled;
  units[UNIT.app(app.slug)]!.enabled = app.config.autostart;
  refresh('apps');
  return { ok: true };
});

server.get('/api/apps/:slug/env', async (req) => {
  const app = getApp(P(req).slug!);
  const linked = app.links.flatMap((l) => {
    const d = dbs.find((x) => x.slug === l.db);
    return d ? connectionEnv(d, l.prefix) : [];
  });
  return { vars: app.env, linked, system: systemEnv(app).filter((s) => !linked.some((l) => l.key === s.key)), text: toDotenv(app.env) };
});
server.put('/api/apps/:slug/env', async (req) => {
  const app = getApp(P(req).slug!);
  const b = B(req);
  if (Array.isArray(b.vars)) app.env = b.vars.map((v: Body) => ({ key: String(v.key), value: String(v.value ?? '') }));
  const running = units[UNIT.app(app.slug)]?.state === 'running';
  if (b.restart && running) lifecycle(app, 'restart');
  audit('app.env', app.slug, app.env.map((v) => v.key));
  refresh('apps');
  return { ok: true, count: app.env.length, restartNeeded: running && !b.restart };
});

server.get('/api/apps/:slug/secrets', async (req) => getApp(P(req).slug!).secrets);
server.put('/api/apps/:slug/secrets', async (req) => {
  const app = getApp(P(req).slug!);
  const b = B(req);
  if (b.regenerateWebhook) app.secrets.webhookSecret = hex(32);
  if (typeof b.discordWebhook === 'string') app.secrets.discordWebhook = b.discordWebhook;
  if (typeof b.gitToken === 'string') app.secrets.gitTokenSet = !!b.gitToken;
  return app.secrets;
});
server.post('/api/apps/:slug/deploykey', async (req) => ({ publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${hex(40)} hrone-${P(req).slug}` }));
server.post('/api/apps/:slug/test-notify', async () => ({ ok: true }));

server.get('/api/apps/:slug/logs', async (req) => {
  getApp(P(req).slug!);
  return backlog('app', P(req).slug!);
});
server.get('/api/apps/:slug/logs/download', async (req, reply) =>
  sendText(
    reply,
    `${P(req).slug}.log`,
    backlog('app', P(req).slug!)
      .map((e) => `${new Date(e.t).toISOString()} ${e.m.replace(/\x1b\[[0-9;]*m/g, '')}`)
      .join('\n'),
  ),
);
server.post('/api/apps/:slug/logs/clear', async () => ({ ok: true }));
server.get('/api/apps/:slug/metrics', async (req) => ({ status: units[UNIT.app(P(req).slug!)] ?? null, history: unitHistory(UNIT.app(P(req).slug!)) }));

// 파일
server.get('/api/apps/:slug/files', async (req) => {
  const app = getApp(P(req).slug!);
  if (!app.deployed_sha) throw new HttpError(404, '아직 받아 온 파일이 없습니다. 첫 배포가 끝나면 보입니다.');
  const { clean } = splitPath(Q(req).path ?? '');
  const list = treeOf(app).get(clean);
  if (!list) throw new HttpError(404, '폴더가 없습니다');
  const entries = [...list].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)).map(({ name, type, size, mtime }) => ({ name, type, size, mtime, target: null }));
  return { path: clean, entries, truncated: false };
});
server.get('/api/apps/:slug/files/content', async (req) => {
  const app = getApp(P(req).slug!);
  const { clean, dir, name } = splitPath(Q(req).path ?? '');
  const f = treeOf(app)
    .get(dir)
    ?.find((e) => e.name === name);
  if (!f || f.type !== 'file') throw new HttpError(404, '파일이 없습니다');
  const binary = /\.(sqlite|onnx|lock)$/.test(name) && f.text === undefined;
  return { path: clean, size: f.size, mtime: f.mtime, binary, truncated: false, text: binary ? null : (f.text ?? '') };
});
server.get('/api/apps/:slug/files/download', async (req, reply) => {
  const { name } = splitPath(Q(req).path ?? '');
  return sendText(reply, name || `${P(req).slug}.tar.gz`, 'mock file\n');
});
server.put('/api/apps/:slug/files/content', async (req) => {
  const app = getApp(P(req).slug!);
  const b = B(req);
  const { clean, dir, name } = splitPath(b.path);
  const f = treeOf(app)
    .get(dir)
    ?.find((e) => e.name === name);
  if (!f) throw new HttpError(404, '파일이 없습니다');
  if (typeof b.mtime === 'number' && b.mtime !== f.mtime) throw new HttpError(409, '그사이 파일이 바뀌었습니다');
  f.text = String(b.text ?? '');
  f.size = Buffer.byteLength(f.text);
  f.mtime = Date.now();
  audit('app.file_edit', app.slug, clean);
  return { path: clean, size: f.size, mtime: f.mtime };
});
server.post('/api/apps/:slug/files/create', async (req) => {
  const app = getApp(P(req).slug!);
  const b = B(req);
  const dir = splitPath(b.dir ?? '').clean;
  const name = String(b.name ?? '').trim();
  if (!name || name.includes('/')) throw new HttpError(400, '잘못된 이름');
  const list = treeOf(app).get(dir);
  if (!list) throw new HttpError(404, '폴더가 없습니다');
  if (list.some((e) => e.name === name)) throw new HttpError(409, '이미 있습니다');
  const mtime = Date.now();
  list.push({ name, type: 'file', size: 0, mtime, text: '' });
  return { path: dir ? `${dir}/${name}` : name, size: 0, mtime };
});

server.get('/api/apps/:slug/git/status', async (req) => {
  const app = getApp(P(req).slug!);
  if (!app.deployed_sha) throw new HttpError(404, '아직 받아 온 저장소가 없습니다');
  return { branch: app.config.branch, head: app.deployed_sha.slice(0, 7), ahead: 0, unpushed: [], files: [], truncated: false, auth: app.config.auth, localChanges: app.config.localChanges };
});
server.post('/api/apps/:slug/git/commit', async (req) => {
  const app = getApp(P(req).slug!);
  const b = B(req);
  audit('app.git_commit', app.slug, String(b.message ?? ''));
  return b.push ? { sha: hex(7), pushed: true, deployMode: app.config.deployMode } : { sha: hex(7), pushed: false };
});
server.post('/api/apps/:slug/git/push', async (req) => ({ pushed: true, deployMode: getApp(P(req).slug!).config.deployMode }));

server.post('/api/apps/:slug/links', async (req) => {
  const app = getApp(P(req).slug!);
  const b = B(req);
  const d = getDb(String(b.database));
  const prefix = String(b.prefix ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '');
  app.links = app.links.filter((l) => l.db !== d.slug).concat({ db: d.slug, prefix });
  refresh('apps', 'databases');
  return { ok: true, restartNeeded: units[UNIT.app(app.slug)]?.state === 'running' };
});
server.delete('/api/apps/:slug/links/:db', async (req) => {
  const app = getApp(P(req).slug!);
  app.links = app.links.filter((l) => l.db !== P(req).db);
  refresh('apps', 'databases');
  return { ok: true, restartNeeded: units[UNIT.app(app.slug)]?.state === 'running' };
});
server.post('/api/apps/:slug/terminate', async (req) => {
  const app = getApp(P(req).slug!);
  apps.splice(apps.indexOf(app), 1);
  delete units[UNIT.app(app.slug)];
  refresh('apps', 'deploys');
  return { ok: true, backupFile: B(req).backup ? `/var/lib/hrone/backups/app/${app.slug}/${app.slug}-final.tar.gz` : null, databases: [] };
});

// ----- 배포 -----

server.get('/api/apps/:slug/deploys', async (req) => {
  const app = getApp(P(req).slug!);
  const limit = Number(Q(req).limit ?? 50);
  return deploys
    .filter((d) => d.app_id === app.id)
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
});

function runDeploy(app: App, d: Deploy) {
  d.status = 'running';
  d.started_at = Date.now();
  refresh('deploys', 'apps');
  const steps = ['$ git fetch origin main', '$ npm ci', 'added 214 packages in 6s', '$ npm run build', '✓ built in 4.81s', `[HROne] ${UNIT.app(app.slug)} 재시작`, '[HROne] 배포 완료'];
  steps.forEach((line, i) => setTimeout(() => emit(`deploy:${d.id}`, { line }), 700 * (i + 1)));
  setTimeout(
    () => {
      d.status = 'success';
      d.finished_at = Date.now();
      app.deployed_sha = d.to_sha;
      app.deployed_at = Date.now();
      app.last_seen_sha = d.to_sha;
      if (app.desired_state === 'running') setRunning(UNIT.app(app.slug), app.config.port);
      emit('status', statusPayload());
      refresh('deploys', 'apps');
    },
    700 * (steps.length + 1),
  );
}

function requestDeploy(app: App, trigger: Deploy['trigger'], sha: string | null) {
  for (const o of deploys) if (o.app_id === app.id && (o.status === 'pending' || o.status === 'scheduled')) o.status = 'superseded';
  const to = sha ?? app.last_seen_sha ?? app.deployed_sha;
  const d = addDeploy(app, {
    status: 'queued',
    trigger,
    created_at: Date.now(),
    from_sha: app.deployed_sha,
    to_sha: to,
    commits: trigger === 'manual' || trigger === 'config' ? [] : [{ sha: to!, author: 'minji', date: Date.now() - MIN, message: pick(MESSAGES) }],
    triggered_by: 'admin',
  });
  d.started_at = null;
  setTimeout(() => runDeploy(app, d), 500);
  audit(`deploy.${trigger}`, app.slug);
  refresh('deploys', 'apps');
  return d.id;
}

server.post('/api/apps/:slug/deploy', async (req) => {
  const app = getApp(P(req).slug!);
  const b = B(req);
  const sha = typeof b.sha === 'string' && /^[0-9a-f]{7,40}$/.test(b.sha) ? b.sha : null;
  return { id: requestDeploy(app, b.trigger === 'config' ? 'config' : 'manual', sha) };
});
server.post('/api/apps/:slug/check', async (req) => {
  const app = getApp(P(req).slug!);
  if (!app.deployed_sha) throw new HttpError(409, '첫 배포가 끝난 뒤에 확인할 수 있습니다');
  app.last_poll_at = Date.now();
  const sha = app.last_seen_sha ?? app.deployed_sha;
  return { sha, upToDate: sha === app.deployed_sha };
});
server.post('/api/apps/:slug/rollback', async (req) => {
  const app = getApp(P(req).slug!);
  const target = deploys.find((d) => d.id === Number(B(req).deployId));
  if (!target || target.app_id !== app.id || !target.to_sha) throw new HttpError(400, '이 앱의 배포가 아닙니다');
  if (target.status !== 'success') throw new HttpError(400, '성공한 배포로만 되돌릴 수 있습니다');
  return { id: requestDeploy(app, 'rollback', target.to_sha) };
});

server.get('/api/deploys/open', async () => deploys.filter((d) => OPEN.includes(d.status)).map(withApp));
server.get('/api/deploys/recent', async (req) =>
  [...deploys]
    .sort((a, b) => b.id - a.id)
    .slice(0, Number(Q(req).limit ?? 20))
    .map(withApp),
);
function getDeploy(id: number) {
  const d = deploys.find((x) => x.id === id);
  if (!d) throw new HttpError(404, '배포가 없습니다');
  return d;
}
server.get('/api/deploys/:id', async (req) => {
  const d = getDeploy(Number(P(req).id));
  return { ...withApp(d), log: deployLog(d) };
});
server.get('/api/deploys/:id/diff', async (req) => {
  const d = getDeploy(Number(P(req).id));
  const app = appById(d.app_id)!;
  if (!d.from_sha) return { stat: [], patch: '' };
  const node = app.config.runtime === 'node';
  const stat = node
    ? [
        { file: 'src/index.ts', add: 12, del: 3 },
        { file: 'src/routes/index.ts', add: 41, del: 8 },
        { file: 'package.json', add: 1, del: 1 },
      ]
    : [
        { file: 'bot.py', add: 9, del: 2 },
        { file: 'pyproject.toml', add: 1, del: 1 },
      ];
  const file = Q(req).file;
  const patch = file
    ? `diff --git a/${file} b/${file}\nindex ${d.from_sha.slice(0, 7)}..${d.to_sha?.slice(0, 7)} 100644\n--- a/${file}\n+++ b/${file}\n@@ -10,7 +10,12 @@\n   const port = Number(process.env.PORT ?? 3000);\n-  app.get('/api/health', async () => 'ok');\n+  app.get('/api/health', async () => ({ ok: true, version: process.env.npm_package_version }));\n+\n+  // ${d.commits[0]?.message ?? ''}\n+  app.get('/api/orders/export', async (req, reply) => {\n+    reply.header('content-type', 'text/csv; charset=utf-8');\n+    return toCsv(await listOrders());\n+  });\n   await app.listen({ host: '0.0.0.0', port });\n`
    : '';
  return { stat, patch, from: d.from_sha, to: d.to_sha, web: repoWeb(app.config.repoUrl) };
});
server.post('/api/deploys/:id/approve', async (req) => {
  const d = getDeploy(Number(P(req).id));
  const app = appById(d.app_id)!;
  d.approved_by = 'admin';
  d.status = 'queued';
  audit('deploy.approve', app.slug, `#${d.id}`);
  refresh('deploys', 'apps');
  setTimeout(() => runDeploy(app, d), 500);
  return { ok: true };
});
server.post('/api/deploys/:id/run-now', async (req) => {
  const d = getDeploy(Number(P(req).id));
  d.status = 'queued';
  setTimeout(() => runDeploy(appById(d.app_id)!, d), 500);
  refresh('deploys', 'apps');
  return { ok: true };
});
server.post('/api/deploys/:id/reject', async (req) => {
  const d = getDeploy(Number(P(req).id));
  const app = appById(d.app_id)!;
  d.status = d.status === 'pending' ? 'rejected' : 'cancelled';
  d.finished_at = Date.now();
  if (d.status === 'rejected') app.rejected_sha = d.to_sha;
  audit(d.status === 'rejected' ? 'deploy.reject' : 'deploy.cancel', app.slug, `#${d.id}`);
  refresh('deploys', 'apps');
  return { ok: true };
});

// ----- 데이터베이스 -----

server.get('/api/databases', async () => dbs.map(dbSummary));
server.get('/api/databases/engines', async () => ({ mariadb: components.mariadb, redis: components.redis }));
server.post('/api/databases', async (req) => {
  const b = B(req);
  const slug = String(b.slug ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug)) throw new HttpError(400, 'DB ID 는 영문 소문자/숫자/- 2~31자');
  if (dbs.some((d) => d.slug === slug)) throw new HttpError(409, '이미 있는 DB ID 입니다');
  const port = b.port ? Number(b.port) : 3314 + dbs.length;
  let db: Db;
  if (b.type === 'redis') {
    db = { ...structuredClone(dbs.find((d) => d.type === 'redis')!), id: dbs.length + 1, slug, name: String(b.name || slug), created_at: Date.now() };
    db.config.port = port;
    dbs.push(db);
  } else db = addMaria(slug, String(b.name || slug), port, []);
  db.config.bind = b.bind === 'all' ? 'all' : 'local';
  db.initialized = false;
  units[UNIT.db(slug)] = stoppedUnit(UNIT.db(slug));
  const job = startJob('db-init', slug, `${db.name} 초기화`, ['데이터 폴더 만드는 중...', '시스템 테이블 설치...', '계정 만드는 중...', '시작'], null, () => {
    db.initialized = true;
    units[UNIT.db(slug)] = runningUnit(UNIT.db(slug), { cpu: 0.2, mem: 120 * MB, port, since: Date.now() });
    emit('status', statusPayload());
    refresh('databases');
  });
  refresh('databases');
  return { db: dbSummary(db), jobId: job.id };
});
server.get('/api/databases/:slug', async (req) => {
  const d = getDb(P(req).slug!);
  return { ...dbSummary(d), config: d.config, createdAt: d.created_at, history: unitHistory(UNIT.db(d.slug)), dataDir: `/var/lib/hrone/databases/${d.slug}` };
});
server.patch('/api/databases/:slug', async (req) => {
  const d = getDb(P(req).slug!);
  const b = B(req);
  if (typeof b.name === 'string' && b.name.trim()) d.name = b.name.trim();
  for (const k of ['port', 'bind', 'autostart'] as const) if (k in b) (d.config as Body)[k] = b[k];
  if (b.resources) d.config.resources = { ...d.config.resources, ...b.resources };
  if (b.backup) d.config.backup = { ...d.config.backup, ...b.backup };
  refresh('databases');
  return { db: dbSummary(d), restarted: 'port' in b || 'bind' in b };
});
server.get('/api/databases/:slug/credentials', async (req) => {
  const d = getDb(P(req).slug!);
  audit('db.reveal', d.slug);
  if (d.type === 'mariadb')
    return {
      admin: { user: d.config.adminUser, password: d.passwords.admin },
      app: { user: d.config.appUser, password: d.passwords.app, database: d.config.defaultDb },
      url: `mysql://${d.config.appUser}:${d.passwords.app}@127.0.0.1:${d.config.port}/${d.config.defaultDb}`,
    };
  return { admin: { user: 'default', password: d.passwords.admin }, url: `redis://:${d.passwords.admin}@127.0.0.1:${d.config.port}/0` };
});
server.post('/api/databases/:slug/action', async (req) => {
  const d = getDb(P(req).slug!);
  const action = String(B(req).action);
  if (!['start', 'stop', 'restart'].includes(action)) throw new HttpError(400, '알 수 없는 동작');
  const u = UNIT.db(d.slug);
  if (action === 'stop') {
    d.desired_state = 'stopped';
    units[u] = stoppedUnit(u, d.config.autostart);
  } else {
    d.desired_state = 'running';
    setRunning(u, d.config.port);
  }
  audit(`db.${action}`, d.slug);
  emit('status', statusPayload());
  refresh('databases');
  return { ok: true };
});
server.post('/api/databases/:slug/init', async (req) => {
  const d = getDb(P(req).slug!);
  const job = startJob('db-init', d.slug, `${d.name} 초기화`, ['데이터 폴더 만드는 중...', '계정 만드는 중...', '완료'], null, () => {
    d.initialized = true;
    refresh('databases');
  });
  return { jobId: job.id };
});
server.get('/api/databases/:slug/status', async (req) => {
  const d = getDb(P(req).slug!);
  const unit = units[UNIT.db(d.slug)] ?? null;
  if (!d.initialized || unit?.state !== 'running') return { status: null, unit };
  if (d.type === 'redis') {
    const l = d.config.limits as RedisLimits;
    return {
      status: {
        version: '8.1.4',
        uptime: Math.round((Date.now() - (unit.since ?? NOW)) / 1000),
        connectedClients: 14 + Math.floor(rand() * 4),
        maxClients: l.maxClients,
        blockedClients: 0,
        rejectedConnections: 0,
        usedMemory: 31 * MB + Math.floor(rand() * MB),
        usedMemoryPeak: 44 * MB,
        maxMemory: l.maxMemoryMB * MB,
        totalCommands: 18_204_331,
        opsPerSec: 40 + Math.floor(rand() * 90),
        aofEnabled: l.appendonly,
        lastSave: Date.now() - 4 * MIN,
        keyspace: { db0: 12_480, db1: 312 },
      },
      unit,
    };
  }
  const l = d.config.limits as MariaLimits;
  const conn = d.slug === 'store-db' ? 23 : d.slug === 'stock-db' ? 11 : 3 + Math.floor(rand() * 4);
  return {
    status: {
      Threads_connected: String(conn + Math.floor(rand() * 3)),
      Threads_running: String(1 + Math.floor(rand() * 2)),
      Max_used_connections: String(conn + 18),
      Uptime: String(Math.round((Date.now() - (unit.since ?? NOW)) / 1000)),
      Questions: String(4_812_331 + Math.floor(rand() * 1000)),
      Slow_queries: d.slug === 'stock-db' ? '7' : '0',
      Aborted_connects: '2',
      Connection_errors_max_connections: '0',
      version: '11.8.3-MariaDB-ubu2604',
      max_connections: String(l.maxConnections),
      max_user_connections: String(l.maxUserConnections),
      open_files_limit: '32768',
      innodb_buffer_pool_size: String(l.innodbBufferPoolMB * MB),
      max_connect_errors: String(l.maxConnectErrors),
      wait_timeout: String(l.waitTimeout),
      max_allowed_packet: String(l.maxAllowedPacketMB * MB),
    },
    unit,
  };
});
server.put('/api/databases/:slug/limits', async (req) => {
  const d = getDb(P(req).slug!);
  d.config.limits = { ...d.config.limits, ...B(req) } as MariaLimits | RedisLimits;
  audit('db.limits', d.slug, B(req));
  refresh('databases');
  return { limits: d.config.limits, warnings: [] };
});
server.post('/api/databases/:slug/unlimit', async (req) => {
  const d = getDb(P(req).slug!);
  if (d.type === 'mariadb') d.config.limits = { ...(d.config.limits as MariaLimits), maxConnections: 2000, maxUserConnections: 0, maxConnectErrors: 1_000_000 };
  else d.config.limits = { ...(d.config.limits as RedisLimits), maxClients: 50000 };
  refresh('databases');
  return { limits: d.config.limits, warnings: ['open_files_limit(32768) 때문에 실제 연결 수가 더 낮을 수 있습니다'] };
});
server.post('/api/databases/:slug/flush-hosts', async (req) => {
  const d = getDb(P(req).slug!);
  if (d.type !== 'mariadb') throw new HttpError(400, 'MariaDB 전용');
  return { ok: true };
});
server.post('/api/databases/:slug/password', async (req) => {
  const d = getDb(P(req).slug!);
  const which = B(req).which === 'app' ? 'app' : 'admin';
  d.passwords[which] = hex(24);
  return { ok: true, linkedApps: linksForDb(d).length };
});

const maria = (slug: string) => {
  const d = getDb(slug);
  if (d.type !== 'mariadb') throw new HttpError(400, 'MariaDB 전용 기능입니다');
  return d;
};
server.get('/api/databases/:slug/schemas', async (req) => {
  const d = getDb(P(req).slug!);
  if (d.type !== 'mariadb') return [];
  return d.schemas.map((s) => ({ name: s.name, size: s.tables.reduce((a, t) => a + t.size, 0), tables: s.tables.length }));
});
server.get('/api/databases/:slug/schemas/:schema/tables', async (req) => {
  const d = maria(P(req).slug!);
  const s = d.schemas.find((x) => x.name === P(req).schema);
  if (!s) throw new HttpError(404, 'DB 가 없습니다');
  return s.tables.map((t) => ({ name: t.name, view: !!t.view, rows: t.rows, size: t.size }));
});
server.get('/api/databases/:slug/schemas/:schema/tables/:table/rows', async (req) => {
  const d = maria(P(req).slug!);
  const t = d.schemas.find((x) => x.name === P(req).schema)?.tables.find((x) => x.name === P(req).table);
  if (!t) throw new HttpError(404, '테이블이 없습니다');
  const qs = Q(req);
  const page = Math.max(0, Number(qs.page) || 0);
  const size = clamp(Number(qs.size) || 50, 1, 500);
  let rows = t.data;
  const search = String(qs.q ?? '').trim();
  const fi = t.columns.findIndex((c) => c[0] === qs.fcol);
  if (search) rows = rows.filter((r) => (fi >= 0 ? [r[fi]] : r).some((c) => c?.toLowerCase().includes(search.toLowerCase())));
  const ci = t.columns.findIndex((c) => c[0] === qs.order);
  if (ci >= 0) {
    rows = [...rows].sort((a, b) => String(a[ci] ?? '').localeCompare(String(b[ci] ?? ''), 'ko', { numeric: true }));
    if (qs.dir === 'desc') rows.reverse();
  }
  const slice = rows.slice(page * size, (page + 1) * size);
  return {
    columns: t.columns.map(([name, type, columnType, key, nullable]) => ({ name, type, columnType, key, nullable })),
    rows: slice,
    page,
    size,
    hasMore: rows.length > (page + 1) * size,
    total: search ? rows.length : Math.max(t.rows, t.data.length),
    exact: !!search || t.rows <= t.data.length,
  };
});
server.post('/api/databases/:slug/schemas', async (req) => {
  const d = maria(P(req).slug!);
  const name = String(B(req).name ?? '');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new HttpError(400, 'DB 이름은 영문/숫자/_ 1~64자');
  if (!d.schemas.some((s) => s.name === name)) d.schemas.push({ name, tables: [] });
  return { ok: true };
});
server.post('/api/databases/:slug/schemas/:name/drop', async (req) => {
  const d = maria(P(req).slug!);
  d.schemas = d.schemas.filter((s) => s.name !== P(req).name);
  return { ok: true };
});
server.get('/api/databases/:slug/users', async (req) => {
  const d = getDb(P(req).slug!);
  return d.type === 'mariadb' ? d.users : [];
});
server.post('/api/databases/:slug/users', async (req) => {
  const d = maria(P(req).slug!);
  const user = String(B(req).user ?? '');
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(user)) throw new HttpError(400, '계정 이름은 영문/숫자/_.- 1~80자');
  d.users.push({ user, host: '%', maxConnections: 0 });
  return { user, password: hex(24) };
});
server.post('/api/databases/:slug/users/:user/password', async () => ({ password: hex(24) }));
server.post('/api/databases/:slug/users/:user/drop', async (req) => {
  const d = maria(P(req).slug!);
  d.users = d.users.filter((u) => u.user !== P(req).user);
  return { ok: true };
});
server.post('/api/databases/:slug/query', async (req) => {
  const d = getDb(P(req).slug!);
  const text = String(B(req).text ?? '').trim();
  if (!text) throw new HttpError(400, '실행할 내용을 입력하세요');
  const started = Date.now();
  let output: string;
  if (d.type === 'redis') {
    const cmd = text.split(/\s+/)[0]!.toUpperCase();
    output = cmd === 'PING' ? 'PONG' : cmd === 'DBSIZE' ? '(integer) 12480' : cmd === 'KEYS' ? '1) "session:9f2c"\n2) "rate:store:checkout"\n3) "stock:DIAM"' : cmd === 'GET' ? '"12480"' : 'OK';
  } else if (/^\s*select/i.test(text)) {
    output = 'id\tname\tprice\n1\tVIP 30일\t9900\n2\tVIP+ 30일\t19900\n3\tMVP 영구\t49000';
  } else if (/^\s*show\s+tables/i.test(text)) {
    output = 'Tables_in_' + d.config.defaultDb + '\n' + (d.schemas[0]?.tables.map((t) => t.name).join('\n') ?? '');
  } else output = 'Query OK';
  audit('db.query', d.slug, text.slice(0, 200));
  return { output, ms: Date.now() - started + 3 };
});
server.get('/api/databases/:slug/logs', async (req) => {
  getDb(P(req).slug!);
  return backlog('db', P(req).slug!);
});
server.get('/api/databases/:slug/logs/download', async (req, reply) => sendText(reply, `${P(req).slug}.log`, 'mock log\n'));
server.post('/api/databases/:slug/logs/clear', async () => ({ ok: true }));
server.post('/api/databases/:slug/terminate', async (req) => {
  const d = getDb(P(req).slug!);
  dbs.splice(dbs.indexOf(d), 1);
  delete units[UNIT.db(d.slug)];
  for (const a of apps) a.links = a.links.filter((l) => l.db !== d.slug);
  refresh('databases', 'apps');
  return { ok: true, backupFile: B(req).backup ? `/var/lib/hrone/backups/db/${d.slug}/${d.slug}-final.sql.gz` : null };
});
server.get('/api/databases/:slug/backups', async (req) => backups.filter((b) => b.kind === 'database' && b.target_slug === P(req).slug).sort((a, b) => b.created_at - a.created_at));

// 웹후크 (UI 는 부르지 않지만 404 로그를 줄인다)
server.post('/api/hooks/github/:slug', async () => ({ ok: true, pong: true }));

await server.listen({ host: '127.0.0.1', port: PORT });
process.stdout.write(`[mock] HROne mock API on http://127.0.0.1:${PORT}\n[mock] run the UI with: HRONE_DEV_API=http://127.0.0.1:${PORT} npm run dev:web\n`);
