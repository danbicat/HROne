import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  History,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Skull,
  Trash2,
  Undo2,
  Wand2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { AreaChart } from '../components/Charts';
import { EnvEditor } from '../components/EnvEditor';
import { FileBrowser } from '../components/FileBrowser';
import { DeployLog, LogViewer } from '../components/LogViewer';
import { AppPower, DeployBadge, PendingDeploy, TRIGGER, hostOf, modeText, normalizeUrl, type Deploy } from '../components/shared';
import {
  Badge,
  Button,
  Card,
  CopyField,
  Empty,
  ErrorBox,
  Field,
  IconButton,
  KV,
  Loading,
  Modal,
  Notice,
  PageHeader,
  Row,
  SectionHeader,
  Stats,
  StatusBadge,
  Tabs,
  Toggle,
  cx,
  toast,
  useAction,
  useConfirm,
} from '../components/ui';
import type { Me } from '../components/Layout';
import { api, errorText } from '../lib/api';
import { ago, bytes, dateTime, duration, josa, sha } from '../lib/format';
import { Link, navigate, setQuery, useLocation, useTitle } from '../lib/router';
import { useApi, useUnit, type UnitStatus } from '../lib/store';
import { AppSettings } from './AppSettings';
import { DbIcon, RuntimeIcon, type AppSummary, type DbSummary } from './Dashboard';

export interface AppConfig {
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

export interface AppDetailData extends AppSummary {
  config: AppConfig;
  createdAt: number;
  deployKey: string | null;
  webhookPath: string;
  links: { slug: string; name: string; type: 'mariadb' | 'redis'; prefix: string; port: number; keys: string[] }[];
  envCount: number;
  history: { t: number; cpu: number; mem: number }[];
  dir: string;
  dataDir: string;
  rejectedSha: string | null;
  lastSeenSha: string | null;
}

type Tab = 'overview' | 'console' | 'files' | 'deploys' | 'env' | 'settings';

// 예전 탭 주소(?tab=links 등)로 들어와도 맞는 곳을 보여 준다
const OLD_TABS: Record<string, Tab> = { links: 'env', backups: 'settings', danger: 'settings' };

export function AppDetail({ slug, me }: { slug: string; me: Me }) {
  const { query } = useLocation();
  const raw = query.get('tab') ?? 'overview';
  const tab = (OLD_TABS[raw] ?? raw) as Tab;
  const { data: app, error, loading, reload } = useApi<AppDetailData>(`/api/apps/${slug}`, { refreshOn: ['apps', 'deploys'] });
  const unit = useUnit(`hrone-app-${slug}.service`);
  const st = unit ?? app?.status ?? null;
  useTitle(app?.name ?? slug);

  if (loading && !app) return <Loading />;
  if (error && !app) return <ErrorBox error={error} onRetry={reload} />;
  if (!app) return null;

  const state = app.deployedSha ? st?.state : 'not-deployed';
  const setTab = (t: Tab) => {
    // 파일 탭의 위치(?dir, ?file)는 다른 탭으로 넘어가면 지운다
    setQuery('dir', null);
    setQuery('file', null);
    setQuery('tab', t === 'overview' ? null : t);
  };

  return (
    <div>
      <PageHeader
        back={{ to: '/apps', label: '앱' }}
        icon={<RuntimeIcon runtime={app.runtime} size={56} />}
        title={app.name}
        sub={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge state={state} />
            {app.busy && <Badge tone="purple">배포 중</Badge>}
            <a href={app.repoWeb} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:text-fg">
              <span className="truncate">{app.repoUrl.replace(/^https?:\/\/(github\.com\/)?|\.git$/g, '')}</span>
              <GitBranch size={14} className="ml-1.5 shrink-0" />
              <span className="shrink-0">{app.branch}</span>
            </a>
            {app.publicUrl ? (
              <a href={app.publicUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-accent-2 hover:opacity-75">
                <span className="truncate">{app.publicUrl.replace(/^https?:\/\//, '')}</span>
                <ExternalLink size={13} className="shrink-0" />
              </a>
            ) : (
              app.port && <span>127.0.0.1:{app.port}</span>
            )}
          </span>
        }
        actions={<AppPower slug={slug} name={app.name} state={st?.state} deployed={!!app.deployedSha} size="sm" />}
      />

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: '개요' },
          { value: 'console', label: '로그' },
          { value: 'files', label: '파일' },
          { value: 'deploys', label: '배포', badge: app.openDeploy?.status === 'pending' ? <span className="h-1.5 w-1.5 rounded-full bg-warn-dot" /> : undefined },
          { value: 'env', label: '환경변수', badge: app.envCount + app.links.length ? <span className="text-caption text-muted">{app.envCount + app.links.length}</span> : undefined },
          { value: 'settings', label: '설정' },
        ]}
      />

      {tab === 'overview' && <Overview app={app} st={st} reload={reload} />}
      {tab === 'console' && <LogViewer kind="app" slug={slug} />}
      {tab === 'files' && <FileBrowser slug={slug} canRestart={!!app.deployedSha} deployLabel={modeText(app.deployMode, app.deployDelaySec)} />}
      {tab === 'deploys' && <Deploys app={app} />}
      {tab === 'env' && (
        <div className="space-y-9">
          <EnvEditor slug={slug} running={st?.state === 'running'} />
          <Links app={app} reload={reload} running={st?.state === 'running'} />
        </div>
      )}
      {tab === 'settings' && <AppSettings app={app} me={me} reload={reload} />}
    </div>
  );
}

// ---------- 개요 ----------

/** 공개 주소(배포 도메인)를 개요에서 바로 고친다. 설정 → 기본의 공개 주소와 같은 값 */
function PublicUrlEditor({ app, reload }: { app: AppDetailData; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(app.publicUrl);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!editing) setValue(app.publicUrl);
  }, [app.publicUrl, editing]);

  const save = async () => {
    const next = normalizeUrl(value);
    if (next === app.publicUrl) return setEditing(false);
    setSaving(true);
    try {
      await api.patch(`/api/apps/${app.slug}`, { config: { publicUrl: next } });
      toast.ok(next ? '공개 주소를 저장했습니다' : '공개 주소를 지웠습니다');
      setEditing(false);
      reload();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  if (editing)
    return (
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="label" htmlFor="public-url">
          공개 주소
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="public-url"
            className="input min-w-0 flex-1 basis-56"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
            placeholder="https://app.example.com"
            inputMode="url"
            autoCapitalize="none"
            autoFocus
          />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={saving}>
              저장
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)} disabled={saving}>
              취소
            </Button>
          </div>
        </div>
        <div className="hint !mt-1">cloudflared 등으로 연결한 도메인. https:// 는 빼고 써도 됩니다. 비우면 링크가 사라집니다.</div>
      </form>
    );

  return app.publicUrl ? (
    <div className="flex items-center justify-between gap-3">
      <a href={app.publicUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1.5 text-headline font-medium text-accent-2 hover:opacity-75">
        <span className="truncate">{hostOf(app.publicUrl)}</span>
        <ExternalLink size={15} className="shrink-0" />
      </a>
      <Button size="sm" variant="plain" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>
        수정
      </Button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 flex-1 text-footnote text-muted">
        {app.port ? 'cloudflared 터널의 서비스 주소를 아래 주소로 지정하고, 연결한 도메인을 적어 두면 여기와 앱 목록에 링크로 나옵니다.' : '연결한 도메인을 적어 두면 여기와 앱 목록에 링크로 나옵니다.'}
      </p>
      <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setEditing(true)}>
        공개 주소 추가
      </Button>
    </div>
  );
}

function Overview({ app, st, reload }: { app: AppDetailData; st: UnitStatus | null; reload: () => void }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [hist, setHist] = useState(app.history);
  useEffect(() => setHist(app.history), [app.history]);
  useEffect(() => {
    if (!st || st.state !== 'running') return;
    setHist((h) => [...h.slice(-299), { t: Date.now(), cpu: st.cpu ?? 0, mem: st.memory ?? 0 }]);
  }, [st]);
  const wrongPort = st?.state === 'running' && (st.listen ?? []).length > 0 && app.port && !(st.listen ?? []).some((l) => l.port === app.port);
  // 앱이 실제로 열어 둔 포트들 (HROne 이 쓸 수 있는 1024~65535 만)
  const listenPorts = [...new Set((st?.listen ?? []).map((l) => l.port))].filter((p) => p >= 1024 && p <= 65535).slice(0, 3);
  /** 설정 포트를 앱이 실제로 쓰는 포트로 맞춘다. 앱은 다시 시작하지 않는다 */
  const fixPort = async (p: number) => {
    const at = (st?.listen ?? []).filter((l) => l.port === p);
    const loopbackOk = at.some((l) => ['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::', '*', '[::]'].includes(l.addr));
    const ok = await confirm({
      title: `설정 포트를 ${p}번으로 맞출까요?`,
      body: (
        <>
          HROne 설정만 {app.port}번에서 {p}번으로 바꾸고, 앱은 다시 시작하지 않습니다.
          {!loopbackOk && at[0] && <span className="mt-2 block text-warn">앱이 {at[0].addr} 에서만 열려 있어 127.0.0.1:{p} 로는 접속되지 않을 수 있습니다.</span>}
        </>
      ),
      confirm: '맞추기',
    });
    if (!ok) return;
    if (await run(`port-${p}`, () => api.patch(`/api/apps/${app.slug}`, { config: { port: p } }), `포트를 ${p}번으로 맞췄습니다`)) reload();
  };
  const memLimit = app.config.resources.memoryMB ? app.config.resources.memoryMB * 1024 * 1024 : null;

  const on = st?.state === 'running';
  const mem = on ? bytes(st!.memory).split(' ') : null;

  return (
    <div className="space-y-9">
      {(!app.deployedSha && !app.busy) || wrongPort || app.lastPollError ? (
        <div className="space-y-3">
          {!app.deployedSha && !app.busy && (
            <Notice tone="yellow" title="아직 배포되지 않았습니다" icon={<AlertTriangle size={17} />}>
              첫 배포가 실패했다면{' '}
              <button type="button" className="text-accent-2 hover:opacity-75 cursor-pointer" onClick={() => setQuery('tab', 'deploys')}>
                배포 기록
              </button>
              에서 로그를 확인하고, 설정을 고친 뒤 다시 배포하세요.
            </Notice>
          )}
          {wrongPort && (
            <Notice tone="yellow" title={`앱이 설정된 포트(${app.port})가 아닌 곳에서 열려 있습니다`} icon={<AlertTriangle size={17} />}>
              <span>
                앱이 연 주소는 <span className="mono text-footnote">{(st?.listen ?? []).map((l) => `${l.addr}:${l.port}`).join(', ')}</span>입니다. 앱 코드에 포트가 정해져 있다면 HROne 설정을 그 포트로 맞추세요.
              </span>
              <span className="mt-3 flex flex-wrap items-center gap-2">
                {listenPorts.map((p) => (
                  <Button key={p} size="sm" variant="primary" icon={<Wand2 size={14} />} loading={busy === `port-${p}`} onClick={() => fixPort(p)}>
                    {p}번 포트로 맞추기
                  </Button>
                ))}
                <span className="text-footnote text-muted">
                  코드를 고치려면 <code className="mono">process.env.PORT</code>나 <code className="mono">os.environ["PORT"]</code>를 쓰세요.
                </span>
              </span>
            </Notice>
          )}
          {app.lastPollError && (
            <Notice tone="red" title="저장소에서 새 커밋을 확인하지 못했습니다" icon={<AlertTriangle size={17} />}>
              {app.lastPollError}
            </Notice>
          )}
        </div>
      ) : null}
      {app.openDeploy && (app.openDeploy.status === 'pending' || app.openDeploy.status === 'scheduled') && <OpenDeployCard id={app.openDeploy.id} name={app.name} />}

      <Stats
        items={[
          { label: 'CPU', value: on && st!.cpu != null ? st!.cpu.toFixed(1) : '-', unit: on && st!.cpu != null ? '%' : undefined, sub: app.config.resources.cpu ? `상한 ${app.config.resources.cpu}코어` : '제한 없음' },
          { label: '메모리', value: mem ? mem[0] : '-', unit: mem?.[1], sub: memLimit ? `상한 ${bytes(memLimit, 0)}` : '제한 없음' },
          { label: '가동 시간', value: on && st!.since ? duration((Date.now() - st!.since) / 1000) : '-', sub: `재시작 ${st?.restarts ?? 0}회` },
        ]}
      />

      <div className="grid gap-9 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
        <div className="min-w-0 space-y-9">
          <Card title="사용량" actions={<span className="text-muted">최근 10분</span>}>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="min-w-0">
                <div className="mb-2 text-footnote text-muted">CPU (코어 1개 = 100%)</div>
                <AreaChart times={hist.map((h) => h.t)} series={[{ label: 'CPU', color: 'var(--color-accent)', values: hist.map((h) => h.cpu) }]} format={(v) => `${v.toFixed(0)}%`} height={150} />
              </div>
              <div className="min-w-0">
                <div className="mb-2 text-footnote text-muted">메모리</div>
                <AreaChart times={hist.map((h) => h.t)} max={memLimit ?? undefined} series={[{ label: '메모리', color: 'var(--color-info)', values: hist.map((h) => h.mem) }]} format={(v) => bytes(v, 0)} height={150} />
              </div>
            </div>
          </Card>

          <Card title="접속">
            <div className="space-y-4 text-body">
              <PublicUrlEditor app={app} reload={reload} />
              {app.port ? <CopyField value={`http://127.0.0.1:${app.port}`} /> : <p className="text-muted">포트 없이 실행되는 앱입니다 (봇 등).</p>}
              {(st?.listen ?? []).length > 0 && (
                <div className="text-footnote text-muted">
                  실제로 열린 주소: <span className="mono">{st!.listen.map((l) => `${l.addr}:${l.port}`).join(', ')}</span>
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="min-w-0 space-y-9">
          <Card title="배포">
            <KV
              items={[
                ['현재 커밋', <span className="mono">{sha(app.deployedSha)}</span>],
                ['배포 시각', app.deployedAt ? (
                    <span>
                      {ago(app.deployedAt)}
                      <span className="block text-footnote text-muted">{dateTime(app.deployedAt)}</span>
                    </span>
                  ) : (
                    '-'
                  )],
                ['푸시하면', modeText(app.deployMode, app.deployDelaySec)],
                ['새 커밋 확인', app.config.pollEnabled ? `${app.config.pollIntervalSec}초마다, 마지막 ${ago(app.lastPollAt)}` : '꺼짐 (웹후크만)'],
                ...(app.rejectedSha && app.lastSeenSha === app.rejectedSha
                  ? ([['건너뛴 커밋', <span className="text-warn"><span className="mono">{sha(app.rejectedSha)}</span> (거절/실패/롤백)</span>]] as [string, React.ReactNode][])
                  : []),
              ]}
            />
            <div className="hairline-t -mx-5 mt-2 flex flex-wrap gap-2 px-5 pt-4">
              <Button
                variant="primary"
                size="sm"
                icon={<Rocket size={14} />}
                loading={busy === 'deploy'}
                onClick={async () => {
                  if (!(await confirm({ title: `${josa(app.name, '을', '를')} 지금 배포할까요?`, body: '적용 방식과 상관없이 원격 브랜치의 최신 커밋을 바로 배포합니다.', confirm: '배포' }))) return;
                  run('deploy', async () => {
                    const r = await api.post<{ id: number }>(`/api/apps/${app.slug}/deploy`, {});
                    navigate(`/apps/${app.slug}?tab=deploys&deploy=${r.id}`);
                  }, '배포를 시작했습니다');
                }}
              >
                지금 배포
              </Button>
              <Button
                size="sm"
                icon={<RefreshCw size={14} />}
                loading={busy === 'check'}
                disabled={!app.deployedSha}
                onClick={() =>
                  run('check', async () => {
                    const r = await api.post<{ sha: string; upToDate: boolean }>(`/api/apps/${app.slug}/check`);
                    toast.info(r.upToDate ? '이미 최신 커밋입니다' : `새 커밋 ${sha(r.sha)}을 찾았습니다. ${modeText(app.deployMode, app.deployDelaySec)}합니다`);
                    reload();
                  })
                }
              >
                새 커밋 확인
              </Button>
            </div>
          </Card>

          <Card title="실행">
            <KV
              items={[
                ['런타임', `${app.runtime === 'node' ? 'Node.js' : 'Python'} ${app.runtimeVersion}`],
                ['식별자', <span className="mono">{app.slug}</span>],
                ['시작 명령', <code className="mono text-footnote">{app.config.startCmd || '-'}</code>],
                ['폴더', <span className="mono text-footnote break-all">{app.dir}</span>],
                ['PID', on && st!.pid ? <span className="mono">{st!.pid}</span> : '-'],
                ...(on && st?.tasks ? ([['스레드/작업', `${st.tasks}개`]] as [string, React.ReactNode][]) : []),
              ]}
            />
            <div className="hairline-t -mx-5 mt-2 px-5 pt-3.5">
              <Toggle
                checked={app.autostart}
                onChange={(v) => run('auto', () => api.post(`/api/apps/${app.slug}/autostart`, { enabled: v }), v ? '재부팅 시 자동 시작합니다' : '자동 시작을 껐습니다').then(reload)}
                label="재부팅 시 자동 시작"
              />
            </div>
            {app.deployedSha && (st?.state === 'running' || st?.state === 'restarting' || st?.state === 'starting') && (
              <div className="hairline-t -mx-5 mt-3.5 px-5 pt-4">
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Skull size={14} />}
                  loading={busy === 'kill'}
                  onClick={async () => {
                    if (!(await confirm({ title: `${josa(app.name, '을', '를')} 강제 종료할까요?`, body: '정상 종료를 기다리지 않고 프로세스를 바로 끝내므로(SIGKILL) 저장 중이던 데이터가 손상될 수 있습니다.', confirm: '강제 종료', danger: true }))) return;
                    run('kill', () => api.post(`/api/apps/${app.slug}/action`, { action: 'kill' }), '강제 종료했습니다');
                  }}
                >
                  강제 종료
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function OpenDeployCard({ id, name }: { id: number; name: string }) {
  const { data } = useApi<Deploy>(`/api/deploys/${id}`, { refreshOn: ['deploys'] });
  if (!data) return null;
  return (
    <Card title="적용 대기 중인 배포">
      <PendingDeploy d={{ ...data, appName: name }} />
    </Card>
  );
}

// ---------- 배포 ----------

function Deploys({ app }: { app: AppDetailData }) {
  const { query } = useLocation();
  const { data, loading, reload } = useApi<Deploy[]>(`/api/apps/${app.slug}/deploys`, { refreshOn: ['deploys'] });
  const [openId, setOpenId] = useState<number | null>(Number(query.get('deploy')) || null);
  const [diffFor, setDiffFor] = useState<Deploy | null>(null);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  useEffect(() => {
    if (!openId && data?.length) setOpenId(data[0]!.id);
  }, [data, openId]);

  if (loading && !data) return <Loading />;
  if (!data?.length)
    return (
      <div className="card">
        <Empty icon={<History />} title="아직 배포 기록이 없습니다">
          저장소에 푸시하거나 개요에서 지금 배포를 누르면 여기에 기록이 남습니다.
        </Empty>
      </div>
    );

  return (
    <section>
      <SectionHeader title="배포 기록" actions={<span className="text-muted">{data.length}개</span>} />
      <div className="card overflow-hidden">
        {data.map((d, i) => {
          const open = openId === d.id;
          const head = d.commits[0];
          const dur = d.started_at && d.finished_at ? Math.round((d.finished_at - d.started_at) / 1000) : null;
          return (
            <div key={d.id} className={cx(i > 0 && 'hairline-t')}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : d.id)}
                className={cx('flex w-full items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer hover:bg-fill/60 sm:px-5', open && 'bg-fill/40')}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    {d.status !== 'success' && <DeployBadge status={d.status} />}
                    <span className="mono shrink-0 text-footnote text-fg-2">{sha(d.to_sha)}</span>
                    <span className="min-w-0 truncate text-body">{head?.message ?? TRIGGER[d.trigger]}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-footnote text-muted">
                    <span>#{d.id}</span>
                    <span>{TRIGGER[d.trigger]}</span>
                    {d.triggered_by && <span>{d.triggered_by}</span>}
                    <span>{ago(d.created_at)}</span>
                    {dur !== null && <span>{dur}초 걸림</span>}
                  </span>
                </span>
                <ChevronDown size={17} className={cx('shrink-0 text-muted transition-transform duration-200', open && 'rotate-180')} />
              </button>
              {open && (
                <div className="hairline-t space-y-4 px-4 pb-5 pt-4 sm:px-5">
                  {(d.status === 'pending' || d.status === 'scheduled' || d.status === 'queued') && <PendingDeploy d={d} compact />}
                  {d.error && (
                    <Notice tone="red" icon={<AlertTriangle size={17} />}>
                      <span className="whitespace-pre-wrap break-words">{d.error}</span>
                    </Notice>
                  )}
                  {d.commits.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-footnote font-semibold text-muted">커밋 {d.commits.length}개</div>
                      <div className="overflow-hidden rounded-control bg-fill/50">
                        {d.commits.slice(0, 15).map((c, ci) => (
                          <div key={c.sha} className={cx('flex items-center gap-2.5 px-3 py-2 text-body', ci > 0 && 'hairline-t')}>
                            <GitCommitHorizontal size={15} className="shrink-0 text-muted" />
                            <a href={app.repoWeb ? `${app.repoWeb}/commit/${c.sha}` : undefined} target="_blank" rel="noreferrer" className="mono shrink-0 text-footnote text-accent-2 hover:opacity-75">
                              {sha(c.sha)}
                            </a>
                            <span className="min-w-0 flex-1 truncate">{c.message}</span>
                            <span className="hidden shrink-0 gap-x-3 text-footnote text-muted sm:flex">
                              <span>{c.author}</span>
                              <span>{ago(c.date)}</span>
                            </span>
                          </div>
                        ))}
                        {d.commits.length > 15 && <div className="hairline-t px-3 py-2 text-footnote text-muted">외 {d.commits.length - 15}개</div>}
                      </div>
                    </div>
                  )}
                  {((d.to_sha && d.from_sha && d.to_sha !== d.from_sha) || (d.status === 'success' && d.to_sha !== app.deployedSha) || d.status === 'failed' || d.status === 'rolled_back') && (
                    <div className="flex flex-wrap gap-2">
                      {d.to_sha && d.from_sha && d.to_sha !== d.from_sha && (
                        <Button size="sm" icon={<FileDiff size={14} />} onClick={() => setDiffFor(d)}>
                          변경 내용 보기
                        </Button>
                      )}
                      {d.status === 'success' && d.to_sha !== app.deployedSha && (
                        <Button
                          size="sm"
                          variant="warn"
                          icon={<Undo2 size={14} />}
                          loading={busy === `rb${d.id}`}
                          onClick={async () => {
                            if (!(await confirm({ title: `${sha(d.to_sha)} 버전으로 롤백할까요?`, body: '원격의 최신 커밋은 새 푸시가 올 때까지 자동 배포하지 않습니다.', confirm: '롤백' }))) return;
                            run(`rb${d.id}`, async () => {
                              const r = await api.post<{ id: number }>(`/api/apps/${app.slug}/rollback`, { deployId: d.id });
                              setOpenId(r.id);
                              reload();
                            }, '롤백을 시작했습니다');
                          }}
                        >
                          이 버전으로 롤백
                        </Button>
                      )}
                      {(d.status === 'failed' || d.status === 'rolled_back') && (
                        <Button
                          size="sm"
                          icon={<RotateCcw size={14} />}
                          loading={busy === `re${d.id}`}
                          onClick={() =>
                            run(`re${d.id}`, async () => {
                              const r = await api.post<{ id: number }>(`/api/apps/${app.slug}/deploy`, { sha: d.to_sha });
                              setOpenId(r.id);
                              reload();
                            }, '배포를 다시 시작했습니다')
                          }
                        >
                          다시 시도
                        </Button>
                      )}
                    </div>
                  )}
                  {d.status !== 'pending' && d.status !== 'scheduled' && d.status !== 'superseded' && d.status !== 'rejected' && d.status !== 'cancelled' && (
                    <DeployLog id={d.id} running={d.status === 'running' || d.status === 'queued'} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <DiffModal deploy={diffFor} onClose={() => setDiffFor(null)} />
    </section>
  );
}

function DiffModal({ deploy, onClose }: { deploy: Deploy | null; onClose: () => void }) {
  const [stat, setStat] = useState<{ file: string; add: number; del: number }[] | null>(null);
  const [web, setWeb] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const [patch, setPatch] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!deploy) return;
    setStat(null);
    setFile(null);
    setPatch('');
    api
      .get<{ stat: { file: string; add: number; del: number }[]; web: string }>(`/api/deploys/${deploy.id}/diff`)
      .then((r) => {
        setStat(r.stat);
        setWeb(r.web);
      })
      .catch((e) => toast.error(errorText(e)));
  }, [deploy]);
  useEffect(() => {
    if (!deploy || file === null) return;
    setLoading(true);
    const f = file.includes(' → ') ? file.split(' → ')[1]! : file;
    api
      .get<{ patch: string }>(`/api/deploys/${deploy.id}/diff?file=${encodeURIComponent(f)}`)
      .then((r) => setPatch(r.patch))
      .catch((e) => toast.error(errorText(e)))
      .finally(() => setLoading(false));
  }, [deploy, file]);
  return (
    <Modal open={!!deploy} onClose={onClose} title={deploy ? `변경 내용 ${sha(deploy.from_sha)} → ${sha(deploy.to_sha)}` : ''} width={980}>
      {!stat ? (
        <Loading />
      ) : (
        <div className="grid gap-4 md:grid-cols-[280px_minmax(0,1fr)]">
          <div className="min-w-0">
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <span className="text-footnote font-semibold text-muted">파일 {stat.length}개</span>
              {web.startsWith('https://github.com/') && deploy?.from_sha && (
                <a href={`${web}/compare/${deploy.from_sha}...${deploy.to_sha}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-footnote text-accent-2 hover:opacity-75">
                  GitHub 에서 비교 <ExternalLink size={12} />
                </a>
              )}
            </div>
            <div className="max-h-[60vh] overflow-auto rounded-control bg-fill/50 max-md:max-h-[30vh]">
              {stat.map((s, i) => (
                <button
                  key={s.file}
                  type="button"
                  onClick={() => setFile(s.file)}
                  className={cx('flex w-full items-center gap-2 px-3 py-2 text-left text-footnote transition-colors cursor-pointer', i > 0 && 'hairline-t', file === s.file ? 'bg-accent/12' : 'hover:bg-fill')}
                >
                  <span className={cx('mono min-w-0 flex-1 truncate', file === s.file && 'text-accent-2')}>{s.file}</span>
                  {s.add >= 0 ? (
                    <span className="shrink-0 text-caption">
                      <span className="text-ok">+{s.add}</span> <span className="text-bad">-{s.del}</span>
                    </span>
                  ) : (
                    <span className="shrink-0 text-caption text-muted">바이너리</span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="console mono max-h-[60vh] min-h-[200px] min-w-0 overflow-auto rounded-card p-3 text-caption leading-[1.55] whitespace-pre">
            {file === null ? (
              <span className="text-muted">왼쪽에서 파일을 고르세요</span>
            ) : loading ? (
              <span className="text-muted">불러오는 중...</span>
            ) : (
              patch.split('\n').map((l, i) => (
                <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'bg-ok/15 text-ok' : l.startsWith('-') && !l.startsWith('---') ? 'bg-bad/15 text-bad' : l.startsWith('@@') ? 'text-info' : 'text-fg-2'}>
                  {l || ' '}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------- DB 연결 ----------

function Links({ app, reload, running }: { app: AppDetailData; reload: () => void; running: boolean }) {
  const { data: dbs } = useApi<DbSummary[]>('/api/databases');
  const [db, setDb] = useState('');
  const [prefix, setPrefix] = useState('');
  const { busy, run } = useAction();
  const available = (dbs ?? []).filter((d) => !app.links.some((l) => l.slug === d.slug));
  const afterChange = async (restartNeeded: boolean) => {
    reload();
    if (restartNeeded && running) {
      toast.info('연결 정보가 바뀌었습니다. 앱을 재시작해야 반영됩니다.');
    }
  };
  return (
    <Card title="데이터베이스 연결" pad={false} footer={app.links.length === 0 ? 'MariaDB나 Redis를 연결하면 접속 정보(DATABASE_URL, REDIS_URL 등)가 환경변수로 들어갑니다.' : undefined}>
      {app.links.map((l) => (
        <Row
          key={l.slug}
          icon={<DbIcon type={l.type} size={30} />}
          title={
            <span className="flex items-center gap-2">
              <Link to={`/databases/${l.slug}`} className="truncate font-medium hover:text-accent-2">
                {l.name}
              </Link>
              {l.prefix && (
                <span className="shrink-0 text-footnote text-muted">
                  접두사 <span className="mono">{l.prefix}</span>
                </span>
              )}
            </span>
          }
          sub={
            <span className="mono flex flex-wrap gap-x-3 text-caption">
              {l.keys.map((k) => (
                <span key={k}>{k}</span>
              ))}
            </span>
          }
          trailing={
            <IconButton
              title="연결 해제"
              className="hover:text-bad"
              onClick={() =>
                run(`rm${l.slug}`, async () => {
                  const r = await api.del<{ restartNeeded: boolean }>(`/api/apps/${app.slug}/links/${l.slug}`);
                  await afterChange(r.restartNeeded);
                }, '연결을 해제했습니다')
              }
            >
              <Trash2 size={16} />
            </IconButton>
          }
        />
      ))}
      <div className={cx('px-4 py-4 sm:px-5', app.links.length > 0 && 'hairline-t')}>
        {available.length === 0 ? (
          <div className="text-body text-muted">
            {app.links.length ? '더 연결할 DB 가 없습니다.' : '아직 DB 가 없습니다.'}{' '}
            <Link to="/databases?new=1" className="text-accent-2 hover:opacity-75">
              새 DB 만들기
            </Link>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="연결할 DB" className="min-w-[200px] flex-1">
              <select className="input" value={db} onChange={(e) => setDb(e.target.value)}>
                <option value="">선택...</option>
                {available.map((d) => (
                  <option key={d.slug} value={d.slug}>
                    {d.name} ({d.type === 'mariadb' ? 'MariaDB' : 'Redis'} :{d.port})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="변수 접두사 (선택)" className="w-full sm:w-48">
              <input className="input mono" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} placeholder="없음" />
            </Field>
            <Button
              variant="primary"
              icon={<Link2 size={15} />}
              disabled={!db}
              loading={busy === 'add'}
              onClick={() =>
                run('add', async () => {
                  const r = await api.post<{ restartNeeded: boolean }>(`/api/apps/${app.slug}/links`, { database: db, prefix });
                  setDb('');
                  setPrefix('');
                  await afterChange(r.restartNeeded);
                }, '연결했습니다')
              }
            >
              연결
            </Button>
          </div>
        )}
        {available.length > 0 && <div className="hint">변수 접두사 예: CACHE_ → CACHE_REDIS_URL</div>}
      </div>
    </Card>
  );
}
