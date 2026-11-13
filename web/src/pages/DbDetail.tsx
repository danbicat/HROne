import { Eraser, KeyRound, Play, Plus, RotateCw, Save, Square, Trash2, Unlock, Upload, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DataBrowser } from '../components/DataBrowser';
import { DangerDialog, JobDialog } from '../components/Dialogs';
import type { Me } from '../components/Layout';
import { LogViewer } from '../components/LogViewer';
import {
  Badge,
  Button,
  Card,
  CopyField,
  Disclosure,
  ErrorBox,
  Field,
  IconButton,
  KV,
  List,
  Loading,
  Meter,
  Modal,
  Notice,
  PageHeader,
  Row,
  SectionHeader,
  Stats,
  StatusBadge,
  Tabs,
  Toggle,
  toast,
  useAction,
  useConfirm,
  cx,
} from '../components/ui';
import { api, errorText } from '../lib/api';
import { bytes, dateTime, duration, josa } from '../lib/format';
import { Link, navigate, setQuery, useLocation, useTitle } from '../lib/router';
import { useApi, useUnit } from '../lib/store';
import { BackupList, type Backup } from './Backups';
import { DbIcon, type DbSummary } from './Dashboard';

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
interface DbDetailData extends DbSummary {
  config: {
    port: number;
    bind: string;
    autostart: boolean;
    resources: { cpu: number | null; memoryMB: number | null; swapMB: number | null; tasks: number | null; cpuWeight: number | null };
    limits: MariaLimits | RedisLimits;
    backup: { enabled: boolean; mode: 'daily' | 'interval'; time: string; intervalHours: number; keep: number };
    defaultDb: string;
    appUser: string;
    adminUser: string;
  };
  createdAt: number;
  dataDir: string;
}

type Tab = 'overview' | 'data' | 'query' | 'backups' | 'console' | 'settings';

// 예전 탭 주소로 들어와도 맞는 곳을 보여 준다
const OLD_TABS: Record<string, Tab> = { limits: 'settings', danger: 'settings', schemas: 'settings' };

export function DbDetail({ slug, me }: { slug: string; me: Me }) {
  const { query } = useLocation();
  const raw = query.get('tab') ?? 'overview';
  const tab = (OLD_TABS[raw] ?? raw) as Tab;
  const { data: db, error, loading, reload } = useApi<DbDetailData>(`/api/databases/${slug}`, { refreshOn: ['databases', 'jobs'] });
  const unit = useUnit(`hrone-db-${slug}.service`);
  const st = unit ?? db?.status ?? null;
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [job, setJob] = useState<number | null>(null);
  useTitle(db?.name ?? slug);
  if (loading && !db) return <Loading />;
  if (error && !db) return <ErrorBox error={error} onRetry={reload} />;
  if (!db) return null;
  const maria = db.type === 'mariadb';
  const act = (a: string) => run(a, () => api.post(`/api/databases/${slug}/action`, { action: a }), a === 'start' ? '시작했습니다' : a === 'stop' ? '정지했습니다' : '재시작했습니다');
  const on = st?.state === 'running' || st?.state === 'starting';

  return (
    <div>
      <PageHeader
        back={{ to: '/databases', label: '데이터베이스' }}
        icon={<DbIcon type={db.type} size={56} />}
        title={db.name}
        sub={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {db.job ? <Badge tone="blue">준비 중</Badge> : <StatusBadge state={db.initialized ? st?.state : 'not-deployed'} />}
            <span>{maria ? 'MariaDB' : 'Redis'}</span>
            <span className="mono">{db.bind === 'local' ? '127.0.0.1' : db.bind === 'all' ? '0.0.0.0' : db.bind}:{db.port}</span>
          </span>
        }
        actions={
          db.initialized ? (
            <>
              {!on ? (
                <Button size="sm" variant="success" icon={<Play size={14} />} loading={busy === 'start'} onClick={() => act('start')}>
                  시작
                </Button>
              ) : (
                <Button
                  size="sm"
                  icon={<Square size={13} />}
                  loading={busy === 'stop'}
                  onClick={async () => {
                    if (await confirm({ title: `${josa(db.name, '을', '를')} 정지할까요?`, body: db.linkedApps.length ? `연결된 앱(${db.linkedApps.map((a) => a.name).join(', ')})이 DB에 접속하지 못하게 됩니다.` : '접속 중인 클라이언트의 연결이 끊어집니다.', confirm: '정지' })) act('stop');
                  }}
                >
                  정지
                </Button>
              )}
              <Button size="sm" icon={<RotateCw size={14} />} loading={busy === 'restart'} onClick={() => act('restart')}>
                <span className="max-sm:hidden">재시작</span>
              </Button>
            </>
          ) : (
            !db.job && (
              <Button size="sm" variant="primary" loading={busy === 'init'} onClick={() => run('init', async () => setJob((await api.post<{ jobId: number }>(`/api/databases/${slug}/init`)).jobId))}>
                초기화 다시 시도
              </Button>
            )
          )
        }
      />

      {db.job && (
        <div className="mb-6">
          <Notice tone="blue" title={db.job.title}>
            설치/초기화가 진행 중입니다.{' '}
            <button type="button" className="text-accent-2 cursor-pointer hover:opacity-75" onClick={() => setJob(db.job!.id)}>
              진행 상황 보기
            </button>
          </Notice>
        </div>
      )}

      <Tabs
        value={tab}
        onChange={(t) => {
          // 데이터 탭의 위치(?schema, ?table)는 다른 탭으로 넘어가면 지운다
          setQuery('schema', null);
          setQuery('table', null);
          setQuery('tab', t === 'overview' ? null : t);
        }}
        tabs={[
          { value: 'overview', label: '개요' },
          ...(maria ? [{ value: 'data' as Tab, label: '데이터' }] : []),
          { value: 'query', label: maria ? 'SQL 콘솔' : 'Redis 콘솔' },
          { value: 'backups', label: '백업' },
          { value: 'console', label: '로그' },
          { value: 'settings', label: '설정' },
        ]}
      />

      {tab === 'overview' && <Overview db={db} running={st?.state === 'running'} reload={reload} />}
      {tab === 'console' && <LogViewer kind="db" slug={slug} />}
      {tab === 'query' && <QueryConsole db={db} />}
      {tab === 'data' && maria && <DataBrowser slug={slug} defaultDb={db.config.defaultDb} running={st?.state === 'running'} />}
      {tab === 'backups' && <DbBackups db={db} me={me} reload={reload} />}
      {tab === 'settings' && (
        <div className="space-y-9">
          <DbSettings db={db} reload={reload} />
          {maria && <Schemas db={db} me={me} />}
          <Limits db={db} reload={reload} running={st?.state === 'running'} />
          <Danger db={db} me={me} />
        </div>
      )}
      <JobDialog jobId={job} onClose={() => setJob(null)} onDone={reload} />
    </div>
  );
}

function useDbStatus(slug: string, running: boolean) {
  return useApi<{ status: Record<string, any> | null }>(running ? `/api/databases/${slug}/status` : null, { interval: 5000 });
}

function Overview({ db, running, reload }: { db: DbDetailData; running: boolean; reload: () => void }) {
  const { data } = useDbStatus(db.slug, running);
  const s = data?.status;
  const maria = db.type === 'mariadb';
  const [creds, setCreds] = useState<any>(null);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const reveal = async () => {
    const c = creds ?? (await api.get(`/api/databases/${db.slug}/credentials`));
    setCreds(c);
    return c;
  };
  const conn = s && !s.error ? (maria ? { cur: Number(s.Threads_connected), max: Number(s.max_connections), peak: Number(s.Max_used_connections) } : { cur: s.connectedClients, max: s.maxClients, peak: null }) : null;

  const connPct = conn ? (conn.cur / Math.max(1, conn.max)) * 100 : 0;
  const tiles = [
    {
      label: '연결',
      value: conn ? String(conn.cur) : '-',
      unit: conn ? `/ ${conn.max}` : undefined,
      sub: conn?.peak !== null && conn ? `최대 사용 ${conn.peak}` : maria ? undefined : '클라이언트',
      chart: conn ? (
        <span className="flex h-7 items-end pb-1">
          <Meter value={connPct} />
        </span>
      ) : undefined,
    },
    { label: '메모리', value: s ? (maria ? bytes(Number(s?.innodb_buffer_pool_size ?? 0), 0) : bytes(s?.usedMemory)) : '-', sub: maria ? '버퍼 풀' : s?.maxMemory ? `상한 ${bytes(s.maxMemory)}` : '상한 없음' },
    { label: '가동 시간', value: s ? duration(maria ? Number(s.Uptime) : s.uptime) : '-', sub: `버전 ${(maria ? String(s?.version ?? '').split('-')[0] : s?.version) || '-'}` },
    {
      label: maria ? '쿼리' : '초당 명령',
      value: s ? String(maria ? Number(s.Questions).toLocaleString() : s.opsPerSec) : '-',
      sub: maria ? `느린 쿼리 ${s?.Slow_queries ?? '-'}` : `키 ${s ? Object.values((s.keyspace ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0) : '-'}`,
    },
  ];
  const secret = (label: ReactNode, value: string, onReveal: () => Promise<string>, hint?: ReactNode) => <ConnRow label={label} hint={hint}><CopyField value={value} secret onReveal={onReveal} /></ConnRow>;

  return (
    <div className="space-y-9">
      <div className="space-y-4">
        <Stats items={tiles} />
        {s?.error && <ErrorBox error={s.error} />}
        {maria && s && Number(s.Connection_errors_max_connections) > 0 && (
          <Notice tone="yellow" title={`연결 수 초과로 거부된 접속이 ${s.Connection_errors_max_connections}번 있었습니다`}>
            <Link to={`/databases/${db.slug}?tab=settings`} className="text-accent-2 hover:opacity-75">연결 제한 설정</Link>에서 제한 해제를 누르거나 max_connections를 올리세요.
          </Notice>
        )}
        {!maria && s && s.rejectedConnections > 0 && <Notice tone="yellow" title={`거부된 연결 ${s.rejectedConnections}회`}><Link to={`/databases/${db.slug}?tab=settings`} className="text-accent-2 hover:opacity-75">연결 제한 설정</Link>에서 maxclients를 올리세요.</Notice>}
      </div>

      <div className="grid gap-9 lg:grid-cols-[1fr_360px] lg:gap-6">
        <div className="min-w-0 space-y-4">
          <Card
            title="접속 정보"
            pad={false}
            actions={
              <Button size="sm" variant="plain" className="h-7" onClick={reveal}>
                비밀번호 보기
              </Button>
            }
          >
            <div className="px-5 py-1">
              <ConnRow label="호스트 / 포트">
                <CopyField value={`127.0.0.1:${db.config.port}`} />
              </ConnRow>
              {maria ? (
                <>
                  <ConnRow label="기본 DB">
                    <CopyField value={db.config.defaultDb} />
                  </ConnRow>
                  <ConnRow label="앱 계정" hint={`${db.config.defaultDb} DB 에만 권한`}>
                    <CopyField value={db.config.appUser} />
                  </ConnRow>
                  {secret('앱 계정 비밀번호', creds?.app.password ?? '********', async () => (await reveal()).app.password)}
                  <ConnRow label="관리자 계정" hint="모든 권한 (DB 툴 접속용)">
                    <CopyField value={db.config.adminUser} />
                  </ConnRow>
                  {secret('관리자 비밀번호', creds?.admin.password ?? '********', async () => (await reveal()).admin.password)}
                  {secret('DATABASE_URL', creds?.url ?? `mysql://${db.config.appUser}:********@127.0.0.1:${db.config.port}/${db.config.defaultDb}`, async () => (await reveal()).url)}
                </>
              ) : (
                <>
                  {secret('비밀번호', creds?.admin.password ?? '********', async () => (await reveal()).admin.password, 'requirepass')}
                  {secret('REDIS_URL', creds?.url ?? `redis://:********@127.0.0.1:${db.config.port}/0`, async () => (await reveal()).url)}
                </>
              )}
            </div>
          </Card>
          {db.bind !== 'local' && <Notice tone="yellow">모든 인터페이스에서 접속을 받고 있습니다. Tailscale IP 로 PC 의 DB 툴에서 접속할 수 있습니다.</Notice>}
        </div>

        <div className="min-w-0 space-y-9">
          <section>
            <SectionHeader title="연결된 앱" />
            {db.linkedApps.length === 0 ? (
              <div className="card px-5 py-4 text-footnote text-muted">이 DB를 쓰는 앱이 여기에 나옵니다. 앱의 환경변수 탭에서 이 DB를 연결하면 접속 정보가 자동으로 들어갑니다.</div>
            ) : (
              <List>
                {db.linkedApps.map((a) => (
                  <Row key={a.slug} to={`/apps/${a.slug}?tab=env`} title={a.name} trailing={a.prefix ? <Badge>{a.prefix}</Badge> : undefined} />
                ))}
              </List>
            )}
          </section>
          <Card title="관리">
            <div className="space-y-4">
              <KV
                items={[
                  ['데이터 폴더', <span className="mono text-footnote break-all">{db.dataDir}</span>],
                  ['만든 날', dateTime(db.createdAt)],
                  ['자동 백업', db.config.backup.enabled ? (db.config.backup.mode === 'daily' ? `매일 ${db.config.backup.time}` : `${db.config.backup.intervalHours}시간마다`) + `, ${db.config.backup.keep}개 보관` : '꺼짐'],
                ]}
              />
              <div className="hairline-t pt-4">
                <Toggle
                  checked={db.config.autostart}
                  onChange={(v) => run('auto', () => api.patch(`/api/databases/${db.slug}`, { autostart: v }), v ? '재부팅 시 자동 시작합니다' : '자동 시작을 껐습니다').then(reload)}
                  label="재부팅 시 자동 시작"
                />
              </div>
              <div className="flex flex-wrap gap-2 hairline-t pt-4">
                {(maria ? (['app', 'admin'] as const) : (['admin'] as const)).map((w) => (
                  <Button
                    key={w}
                    size="sm"
                    icon={<KeyRound size={14} />}
                    loading={busy === w}
                    disabled={!running}
                    onClick={async () => {
                      if (!(await confirm({ title: `${w === 'app' ? '앱 계정' : maria ? '관리자' : ''} 비밀번호를 변경할까요?`.trimStart(), body: '연결된 앱의 환경변수도 바뀌며, 앱은 재시작해야 새 비밀번호를 씁니다.', confirm: '변경' }))) return;
                      run(w, async () => {
                        await api.post(`/api/databases/${db.slug}/password`, { which: w });
                        setCreds(null);
                      }, '비밀번호를 변경했습니다. 연결된 앱을 재시작하세요.');
                    }}
                  >
                    {maria ? (w === 'app' ? '앱 계정 비밀번호 변경' : '관리자 비밀번호 변경') : '비밀번호 변경'}
                  </Button>
                ))}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** 접속 정보 한 줄: 왼쪽 이름, 오른쪽 복사 칸 (폰에서는 위아래) */
function ConnRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 py-3 sm:grid-cols-[150px_minmax(0,1fr)] sm:items-center sm:gap-4 [&+&]:shadow-[inset_0_0.5px_0_var(--color-line-2)]">
      <div className="min-w-0">
        <div className="text-body">{label}</div>
        {hint && <div className="text-footnote text-muted">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function QueryConsole({ db }: { db: DbDetailData }) {
  const maria = db.type === 'mariadb';
  const [text, setText] = useState(maria ? 'SHOW TABLES;' : 'INFO keyspace');
  const [database, setDatabase] = useState(maria ? db.config.defaultDb : '0');
  const [out, setOut] = useState<{ output: string; ms: number } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(`hrone:q:${db.slug}`) ?? '[]');
    } catch {
      return [];
    }
  });
  const { data: schemas } = useApi<{ name: string }[]>(maria ? `/api/databases/${db.slug}/schemas` : null);
  const exec = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post<{ output: string; ms: number }>(`/api/databases/${db.slug}/query`, { text, database });
      setOut(r);
      const h = [text, ...history.filter((x) => x !== text)].slice(0, 20);
      setHistory(h);
      localStorage.setItem(`hrone:q:${db.slug}`, JSON.stringify(h));
    } catch (e) {
      setErr(errorText(e));
      setOut(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-6">
      <Card
        title={maria ? 'SQL' : 'redis-cli'}
        actions={
          maria ? (
            <select className="input h-8 min-h-8 w-44 py-0 text-footnote sm:w-52" value={database} onChange={(e) => setDatabase(e.target.value)} aria-label="DB">
              <option value="">(DB 선택 안 함)</option>
              {(schemas ?? []).map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : (
            <select className="input h-8 min-h-8 w-24 py-0 text-footnote" value={database} onChange={(e) => setDatabase(e.target.value)} aria-label="DB 번호">
              {Array.from({ length: 16 }, (_, i) => (
                <option key={i} value={String(i)}>
                  db{i}
                </option>
              ))}
            </select>
          )
        }
        footer={maria ? 'root 권한으로 실행됩니다.' : '한 줄에 명령 하나씩 실행합니다.'}
      >
        <textarea
          className="input mono min-h-[160px] resize-y rounded-control px-4 py-3 text-footnote"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              exec();
            }
          }}
          spellCheck={false}
          aria-label={maria ? 'SQL' : 'Redis 명령'}
        />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<Play size={14} />} loading={busy} onClick={exec}>
            실행 <span className="text-caption font-normal opacity-75 max-sm:hidden">⌘/Ctrl+Enter</span>
          </Button>
          {history.length > 0 && (
            <select className="input h-9 w-auto min-w-0 max-w-full flex-1 py-0 text-footnote sm:max-w-72" value="" onChange={(e) => e.target.value && setText(e.target.value)} aria-label="최근 실행">
              <option value="">최근 실행...</option>
              {history.map((h, i) => (
                <option key={i} value={h}>
                  {h.replace(/\s+/g, ' ').slice(0, 60)}
                </option>
              ))}
            </select>
          )}
          {out && <span className="ml-auto text-footnote text-muted">{out.ms}ms</span>}
        </div>
      </Card>
      {err && <div className="mono whitespace-pre-wrap break-words rounded-card bg-bad/10 px-4 py-3 text-footnote text-bad">{err}</div>}
      {out && (
        <section>
          <SectionHeader title="결과" />
          <pre className="console mono max-h-[60vh] overflow-auto rounded-card p-4 text-footnote leading-[1.55]">{out.output || '(출력 없음)'}</pre>
        </section>
      )}
    </div>
  );
}

function Schemas({ db, me }: { db: DbDetailData; me: Me }) {
  const { data: schemas, reload } = useApi<{ name: string; size: number; tables: number }[]>(`/api/databases/${db.slug}/schemas`);
  const { data: users, reload: reloadUsers } = useApi<{ user: string; host: string; maxConnections: number }[]>(`/api/databases/${db.slug}/users`);
  const [newDb, setNewDb] = useState('');
  const [grant, setGrant] = useState(true);
  const [drop, setDrop] = useState<string | null>(null);
  const [userModal, setUserModal] = useState(false);
  const [created, setCreated] = useState<{ user: string; password: string } | null>(null);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  return (
    <div className="grid gap-9 xl:grid-cols-2 xl:gap-6">
      <Card title="데이터베이스" pad={false}>
        {(schemas ?? []).map((s, i) => (
          <div key={s.name} className={cx('flex min-h-[52px] items-center gap-3 py-2 pl-5 pr-3', i > 0 && 'hairline-t')}>
            <span className="min-w-0 flex-1">
              <span className="mono block truncate text-body">{s.name}</span>
              <span className="flex gap-x-3 text-footnote text-muted">
                <span>테이블 {s.tables}개</span>
                <span>{bytes(s.size)}</span>
              </span>
            </span>
            <IconButton title="삭제" onClick={() => setDrop(s.name)} className="hover:text-bad">
              <Trash2 size={16} />
            </IconButton>
          </div>
        ))}
        <div className={cx('space-y-3 bg-fill/40 px-5 py-4', (schemas ?? []).length > 0 && 'hairline-t')}>
          <div className="flex flex-wrap items-center gap-2">
            <input className="input mono min-w-0 flex-1 sm:max-w-60" placeholder="새 DB 이름" value={newDb} onChange={(e) => setNewDb(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))} aria-label="새 DB 이름" />
            <Button size="sm" icon={<Plus size={14} />} disabled={!newDb} loading={busy === 'db'} onClick={() => run('db', () => api.post(`/api/databases/${db.slug}/schemas`, { name: newDb, grantApp: grant }).then(() => (setNewDb(''), reload())), '만들었습니다')}>
              만들기
            </Button>
          </div>
          <Toggle checked={grant} onChange={setGrant} label={<span className="text-body">앱 계정({db.config.appUser})에 권한</span>} />
        </div>
      </Card>
      <Card
        title="계정"
        pad={false}
        actions={
          <Button size="sm" variant="plain" className="h-7" icon={<UserPlus size={14} />} onClick={() => setUserModal(true)}>
            계정 추가
          </Button>
        }
      >
        {(users ?? []).map((u, i) => (
          <div key={`${u.user}@${u.host}`} className={cx('flex min-h-[52px] items-center gap-2 py-2 pl-5 pr-3', i > 0 && 'hairline-t')}>
            <span className="mono min-w-0 flex-1 truncate text-body">
              {u.user}
              <span className="text-muted">@{u.host}</span>
            </span>
            {u.user === db.config.appUser && <Badge tone="purple">앱</Badge>}
            {u.user === db.config.adminUser && <Badge tone="yellow">관리자</Badge>}
            {u.user === 'root' && <Badge>소켓 전용</Badge>}
            {u.user !== 'root' && u.user !== db.config.adminUser && u.user !== db.config.appUser && (
              <>
                <IconButton
                  title="비밀번호 재설정"
                  onClick={() => run(`pw${u.user}`, async () => setCreated(await api.post(`/api/databases/${db.slug}/users/${encodeURIComponent(u.user)}/password`, { host: u.host }).then((r: any) => ({ user: u.user, password: r.password }))))}
                >
                  <KeyRound size={16} />
                </IconButton>
                <IconButton
                  title="삭제"
                  className="hover:text-bad"
                  onClick={async () => {
                    if (!(await confirm({ title: `${josa(`계정 ${u.user}`, '을', '를')} 삭제할까요?`, body: '이 계정으로 접속하던 클라이언트는 더 이상 접속할 수 없습니다.', confirm: '삭제', danger: true }))) return;
                    run(`rm${u.user}`, () => api.post(`/api/databases/${db.slug}/users/${encodeURIComponent(u.user)}/drop`, { host: u.host }).then(reloadUsers), '삭제했습니다');
                  }}
                >
                  <Trash2 size={16} />
                </IconButton>
              </>
            )}
          </div>
        ))}
      </Card>
      <DangerDialog
        open={!!drop}
        onClose={() => setDrop(null)}
        title={`${josa(`DB ${drop ?? ''}`, '을', '를')} 삭제할까요?`}
        target={drop ?? ''}
        needTotp={me.totpEnabled}
        items={[`데이터베이스 ${drop} 의 모든 테이블과 데이터 (삭제 직전에 전체 백업을 자동으로 만듭니다)`]}
        onConfirm={async (auth) => {
          await api.post(`/api/databases/${db.slug}/schemas/${drop}/drop`, auth);
          toast.ok('삭제했습니다');
          reload();
        }}
      />
      <NewUserModal open={userModal} onClose={() => setUserModal(false)} db={db} schemas={(schemas ?? []).map((s) => s.name)} onCreated={(c) => (setCreated(c), reloadUsers())} />
      <Modal open={!!created} onClose={() => setCreated(null)} title="계정 정보" width={460} footer={<Button onClick={() => setCreated(null)}>닫기</Button>}>
        <div className="space-y-5">
          <Notice tone="yellow">비밀번호는 지금만 보여 줍니다. 복사해 두세요.</Notice>
          <Field label="계정">
            <CopyField value={created?.user ?? ''} />
          </Field>
          <Field label="비밀번호">
            <CopyField value={created?.password ?? ''} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

function NewUserModal({ open, onClose, db, schemas, onCreated }: { open: boolean; onClose: () => void; db: DbDetailData; schemas: string[]; onCreated: (c: { user: string; password: string }) => void }) {
  const [user, setUser] = useState('');
  const [all, setAll] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setUser('');
      setAll(false);
      setSel([db.config.defaultDb]);
    }
  }, [open, db]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="계정 추가"
      width={460}
      footer={
        <>
          <Button onClick={onClose}>
            취소
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!user}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.post<{ user: string; password: string }>(`/api/databases/${db.slug}/users`, { user, all, databases: sel });
                onClose();
                onCreated(r);
              } catch (e) {
                toast.error(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            만들기
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="계정 이름" hint="비밀번호는 자동으로 만듭니다">
          <input className="input mono" value={user} onChange={(e) => setUser(e.target.value)} autoFocus />
        </Field>
        <Toggle checked={all} onChange={setAll} label="모든 DB 권한" />
        {!all && (
          <Field label="권한을 줄 DB">
            <div className="overflow-hidden rounded-control bg-fill">
              {schemas.map((s, i) => (
                <label key={s} className={cx('flex cursor-pointer items-center gap-3 px-3.5 py-2.5 text-body', i > 0 && 'hairline-t')}>
                  <input type="checkbox" checked={sel.includes(s)} onChange={(e) => setSel(e.target.checked ? [...sel, s] : sel.filter((x) => x !== s))} className="accent-[var(--color-accent)]" />
                  <span className="mono">{s}</span>
                </label>
              ))}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function NumField({ label, hint, value, onChange, suffix }: { label: string; hint?: string; value: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input className="input mono" inputMode="numeric" value={value} onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, '')) || 0)} />
        {suffix && <span className="shrink-0 text-body text-muted">{suffix}</span>}
      </div>
    </Field>
  );
}

function Limits({ db, reload, running }: { db: DbDetailData; reload: () => void; running: boolean }) {
  const maria = db.type === 'mariadb';
  const [l, setL] = useState<any>(db.config.limits);
  useEffect(() => setL(db.config.limits), [db]);
  const { data } = useDbStatus(db.slug, running);
  const s = data?.status;
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const showWarnings = (w: string[], done: string) => (w.length ? toast.info(`${done} 참고: ${w.join(' / ')}`) : toast.ok(`${done} 재시작 없이 바로 적용됩니다.`));
  const set = (k: string, v: unknown) => setL((x: any) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(l) !== JSON.stringify(db.config.limits);

  const stat = (label: string, value: ReactNode) => (
    <div key={label} className="min-w-0">
      <div className="text-footnote text-muted">{label}</div>
      <div className="mt-1 truncate text-title">{value}</div>
    </div>
  );

  return (
    <div className="space-y-9">
      <Card title="연결 제한" footer={limitSummary(db)}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 max-w-2xl">
            <div className="text-body font-semibold">한 번에 해제</div>
            <p className="mt-1 text-footnote text-muted">
              {maria
                ? 'max_connections 10000, 계정별 제한 없음, max_connect_errors 최대(호스트 차단 방지), 패킷 1GB 로 올립니다. 파일 핸들(LimitNOFILE) 은 이미 1,048,576 입니다.'
                : 'maxclients 100000, 메모리 상한 없음, 유휴 타임아웃 없음으로 바꿉니다.'}{' '}
              재시작 없이 바로 적용됩니다.
            </p>
          </div>
          <Button
            icon={<Unlock size={15} />}
            loading={busy === 'unlimit'}
            onClick={async () => {
              if (!(await confirm({ title: `${db.name}의 연결 제한을 해제할까요?`, body: '메모리가 부족한 서버라면 접속이 몰릴 때 느려질 수 있습니다.', confirm: '제한 해제' }))) return;
              run('unlimit', async () => {
                const r = await api.post<{ warnings: string[] }>(`/api/databases/${db.slug}/unlimit`);
                showWarnings(r.warnings, '제한을 해제했습니다.');
                reload();
              });
            }}
          >
            제한 해제
          </Button>
        </div>
      </Card>

      {maria && s && !s.error && (Number(s.max_user_connections) !== l.maxUserConnections || Number(s.max_connections) !== l.maxConnections) && !dirty && (
        <Notice tone="yellow" title="재시작해야 적용되는 값이 있습니다">
          {Number(s.max_user_connections) !== l.maxUserConnections && `max_user_connections: 현재 ${s.max_user_connections} → 설정 ${l.maxUserConnections}. `}
          {Number(s.max_connections) !== l.maxConnections && `max_connections: 현재 ${s.max_connections} → 설정 ${l.maxConnections} (파일 핸들 한도에 맞춰 줄었을 수 있음). `}
          MariaDB 는 시작할 때 0(무제한)이던 계정별 연결 제한을 실행 중에 바꿀 수 없습니다. 위의 재시작 버튼을 누르세요.
        </Notice>
      )}
      {s && !s.error && (
        <Card title="현재 상태">
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
            {maria
              ? [
                  stat('현재 연결', s.Threads_connected),
                  stat('최대 사용 (재시작 후)', `${s.Max_used_connections} / ${s.max_connections}`),
                  stat('한도 초과로 거부', s.Connection_errors_max_connections),
                  stat('파일 핸들 한도', Number(s.open_files_limit).toLocaleString()),
                ]
              : [
                  stat('현재 클라이언트', `${s.connectedClients} / ${s.maxClients}`),
                  stat('거부된 연결', s.rejectedConnections),
                  stat('메모리', `${bytes(s.usedMemory)} ${s.maxMemory ? `/ ${bytes(s.maxMemory)}` : ''}`),
                  stat('AOF', s.aofEnabled ? '켜짐' : '꺼짐'),
                ]}
          </div>
        </Card>
      )}

      <Card
        title="세부 설정"
        actions={
          maria && (
            <Button size="sm" variant="plain" className="h-7" icon={<Eraser size={14} />} loading={busy === 'flush'} onClick={() => run('flush', () => api.post(`/api/databases/${db.slug}/flush-hosts`), '차단된 호스트를 풀었습니다')}>
              차단 호스트 풀기
            </Button>
          )
        }
      >
        {maria ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <NumField label="max_connections" hint="서버 전체 동시 연결" value={l.maxConnections} onChange={(v) => set('maxConnections', v)} />
            <NumField label="max_user_connections" hint="계정당 연결 (0 = 무제한)" value={l.maxUserConnections} onChange={(v) => set('maxUserConnections', v)} />
            <NumField label="max_connect_errors" hint="이만큼 실패하면 그 호스트 차단" value={l.maxConnectErrors} onChange={(v) => set('maxConnectErrors', v)} />
            <NumField label="wait_timeout" hint="유휴 연결 끊기" value={l.waitTimeout} onChange={(v) => set('waitTimeout', v)} suffix="초" />
            <NumField label="max_allowed_packet" value={l.maxAllowedPacketMB} onChange={(v) => set('maxAllowedPacketMB', v)} suffix="MB" />
            <NumField label="innodb_buffer_pool_size" hint="RAM 의 50~70% 권장" value={l.innodbBufferPoolMB} onChange={(v) => set('innodbBufferPoolMB', v)} suffix="MB" />
            <NumField label="table_open_cache" value={l.tableOpenCache} onChange={(v) => set('tableOpenCache', v)} />
            <NumField label="thread_cache_size" value={l.threadCacheSize} onChange={(v) => set('threadCacheSize', v)} />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <NumField label="maxclients" hint="동시 클라이언트" value={l.maxClients} onChange={(v) => set('maxClients', v)} />
              <NumField label="maxmemory" hint="0 = 제한 없음" value={l.maxMemoryMB} onChange={(v) => set('maxMemoryMB', v)} suffix="MB" />
              <Field label="maxmemory-policy" hint="가득 찼을 때">
                <select className="input" value={l.maxMemoryPolicy} onChange={(e) => set('maxMemoryPolicy', e.target.value)}>
                  <option value="noeviction">noeviction (쓰기 거부)</option>
                  <option value="allkeys-lru">allkeys-lru (캐시용 추천)</option>
                  <option value="allkeys-lfu">allkeys-lfu</option>
                  <option value="volatile-lru">volatile-lru (TTL 있는 키만)</option>
                  <option value="volatile-ttl">volatile-ttl</option>
                  <option value="allkeys-random">allkeys-random</option>
                </select>
              </Field>
              <NumField label="timeout" hint="유휴 연결 끊기 (0 = 안 끊음)" value={l.timeout} onChange={(v) => set('timeout', v)} suffix="초" />
              <Field label="save (RDB 스냅샷)" hint='"초 변경수" 쌍. 비우면 끔'>
                <input className="input mono" value={l.save} onChange={(e) => set('save', e.target.value)} />
              </Field>
            </div>
            <div className="hairline-t pt-4">
              <Toggle checked={l.appendonly} onChange={(v) => set('appendonly', v)} label="AOF (appendonly)" sub="매초 디스크에 기록해 재시작해도 데이터가 남습니다" />
            </div>
          </div>
        )}
        <div className="mt-5 flex justify-end hairline-t pt-4">
          <Button
            variant="primary"
            icon={<Save size={15} />}
            disabled={!dirty}
            loading={busy === 'save'}
            onClick={() =>
              run('save', async () => {
                const r = await api.put<{ warnings: string[] }>(`/api/databases/${db.slug}/limits`, l);
                showWarnings(r.warnings, '저장했습니다.');
                reload();
              })
            }
          >
            저장
          </Button>
        </div>
      </Card>
    </div>
  );
}

function DbBackups({ db, me, reload }: { db: DbDetailData; me: Me; reload: () => void }) {
  const { data, reload: reloadList } = useApi<Backup[]>(`/api/databases/${db.slug}/backups`, { refreshOn: ['backups'] });
  const [b, setB] = useState(db.config.backup);
  useEffect(() => setB(db.config.backup), [db]);
  const [job, setJob] = useState<number | null>(null);
  const { busy, run } = useAction();
  return (
    <div className="space-y-9">
      <Card title="예약 백업">
        <div className="space-y-5">
          <Toggle checked={b.enabled} onChange={(v) => setB({ ...b, enabled: v })} label="자동 백업" sub={db.type === 'mariadb' ? 'mariadb-dump (--single-transaction, 서비스 중단 없음) + 계정/권한' : 'RDB 스냅샷 (redis-cli --rdb)'} />
          {b.enabled && (
            <div className="grid grid-cols-2 gap-4 hairline-t pt-5 sm:flex sm:flex-wrap sm:items-start">
              <Field label="주기" className="col-span-2 sm:col-span-1">
                <select className="input" value={b.mode} onChange={(e) => setB({ ...b, mode: e.target.value as 'daily' | 'interval' })}>
                  <option value="daily">매일</option>
                  <option value="interval">N시간마다</option>
                </select>
              </Field>
              {b.mode === 'daily' ? (
                <Field label="시각 (서버 시간대)">
                  <input className="input mono" type="time" value={b.time} onChange={(e) => setB({ ...b, time: e.target.value })} />
                </Field>
              ) : (
                <Field label="간격 (시간)">
                  <input className="input mono sm:w-28" inputMode="numeric" value={b.intervalHours} onChange={(e) => setB({ ...b, intervalHours: Number(e.target.value.replace(/\D/g, '')) || 6 })} />
                </Field>
              )}
              <Field label="보관 개수">
                <input className="input mono sm:w-28" inputMode="numeric" value={b.keep} onChange={(e) => setB({ ...b, keep: Number(e.target.value.replace(/\D/g, '')) || 7 })} />
              </Field>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2 hairline-t pt-4">
            <Button variant="primary" icon={<Save size={15} />} disabled={JSON.stringify(b) === JSON.stringify(db.config.backup)} loading={busy === 'save'} onClick={() => run('save', () => api.patch(`/api/databases/${db.slug}`, { backup: b }).then(reload), '저장했습니다')}>
              저장
            </Button>
            <Button icon={<Upload size={15} />} loading={busy === 'now'} onClick={() => run('now', async () => setJob((await api.post<{ jobId: number }>('/api/backups', { kind: 'database', slug: db.slug })).jobId))}>
              지금 백업
            </Button>
          </div>
        </div>
      </Card>
      <section>
        <SectionHeader title="백업 목록" />
        <BackupList list={data ?? []} me={me} reload={reloadList} />
      </section>
      <JobDialog jobId={job} onClose={() => setJob(null)} onDone={reloadList} />
    </div>
  );
}

function DbSettings({ db, reload }: { db: DbDetailData; reload: () => void }) {
  const [name, setName] = useState(db.name);
  const [port, setPort] = useState(String(db.config.port));
  const [bind, setBind] = useState(db.config.bind);
  const [res, setRes] = useState(db.config.resources);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  return (
    <Card title="기본">
      <div className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="표시 이름">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="포트" hint="바꾸면 DB 를 재시작하고 연결된 앱 환경변수도 갱신합니다">
            <input className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="접속 허용 주소">
            <select className="input" value={bind === 'local' || bind === 'all' ? bind : 'custom'} onChange={(e) => setBind(e.target.value === 'custom' ? '' : e.target.value)}>
              <option value="local">이 서버만 (127.0.0.1)</option>
              <option value="all">모든 인터페이스 (0.0.0.0)</option>
              <option value="custom">특정 IP (예: Tailscale IP)</option>
            </select>
            {bind !== 'local' && bind !== 'all' && <input className="input mono mt-2" placeholder="100.x.y.z" value={bind} onChange={(e) => setBind(e.target.value)} />}
          </Field>
        </div>
        <div className="hairline-t pt-4">
          <Disclosure label={<>리소스 제한 <span className="text-muted">{res.cpu || res.memoryMB ? [res.cpu ? `CPU ${res.cpu}코어` : '', res.memoryMB ? `메모리 ${res.memoryMB}MB` : ''].filter(Boolean).join(', ') : '제한 없음'}</span></>}>
            <div className="grid gap-5 sm:grid-cols-3">
              <Field label="CPU (코어)">
                <input className="input mono" value={res.cpu ?? ''} onChange={(e) => setRes({ ...res, cpu: num(e.target.value) })} placeholder="제한 없음" />
              </Field>
              <Field label="메모리 (MB)" hint="버퍼 풀/maxmemory 보다 넉넉하게">
                <input className="input mono" value={res.memoryMB ?? ''} onChange={(e) => setRes({ ...res, memoryMB: num(e.target.value.replace(/\D/g, '')) })} placeholder="제한 없음" />
              </Field>
              <Field label="CPU 우선순위">
                <select className="input" value={res.cpuWeight ?? ''} onChange={(e) => setRes({ ...res, cpuWeight: num(e.target.value) })}>
                  <option value="">보통 (100)</option>
                  <option value="50">낮음 (50)</option>
                  <option value="200">높음 (200)</option>
                </select>
              </Field>
            </div>
          </Disclosure>
        </div>
        <div className="flex justify-end hairline-t pt-4">
          <Button
            variant="primary"
            icon={<Save size={15} />}
            loading={busy === 'save'}
            onClick={async () => {
              const restart = Number(port) !== db.config.port || bind !== db.config.bind;
              if (restart && !(await confirm({ title: `저장하고 ${josa(db.name, '을', '를')} 재시작할까요?`, body: '연결된 앱도 재시작해야 새 주소를 씁니다.', confirm: '저장 후 재시작' }))) return;
              run('save', () => api.patch(`/api/databases/${db.slug}`, { name, port: Number(port), bind, resources: res }).then(reload), '저장했습니다');
            }}
          >
            저장
          </Button>
        </div>
      </div>
    </Card>
  );
}

function limitSummary(db: DbDetailData) {
  const l = db.config.limits;
  return 'maxConnections' in l ? `최대 연결 ${l.maxConnections.toLocaleString()}, 계정당 ${l.maxUserConnections || '무제한'}` : `최대 클라이언트 ${l.maxClients.toLocaleString()}, 메모리 ${l.maxMemoryMB ? `${l.maxMemoryMB}MB` : '제한 없음'}`;
}

function Danger({ db, me }: { db: DbDetailData; me: Me }) {
  const [open, setOpen] = useState(false);
  const [backup, setBackup] = useState(true);
  const ref = useRef(backup);
  ref.current = backup;
  return (
    <Card title="삭제">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-body font-semibold text-bad">데이터베이스 삭제</div>
          <p className="mt-1 max-w-xl text-footnote text-muted">인스턴스를 멈추고 데이터 폴더와 서비스를 지웁니다. 연결된 앱의 DB 환경변수도 빠집니다.</p>
        </div>
        <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setOpen(true)}>
          DB 삭제
        </Button>
      </div>
      <DangerDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`${josa(db.name, '을', '를')} 삭제할까요?`}
        target={db.slug}
        needTotp={me.totpEnabled}
        items={[
          <>
            데이터 폴더 <code className="mono text-footnote">{db.dataDir}</code> 의 모든 데이터
          </>,
          `systemd 서비스 hrone-db-${db.slug}`,
          ...(db.linkedApps.length ? [`연결된 앱 ${db.linkedApps.map((a) => a.name).join(', ')} 의 DB 환경변수`] : []),
        ]}
        options={<Toggle checked={backup} onChange={setBackup} label="삭제 전 최종 백업 만들기 (권장)" sub="백업은 서버 화면의 백업 목록에 남습니다" />}
        onConfirm={async (auth) => {
          await api.post(`/api/databases/${db.slug}/terminate`, { ...auth, backup: ref.current });
          toast.ok('삭제했습니다');
          navigate('/databases');
        }}
      />
    </Card>
  );
}


