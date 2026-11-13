import { ArrowDownUp, Boxes, Check, ChevronRight, CircleAlert, CircleCheck, Clock, Cpu, Database, ExternalLink, HardDrive, MemoryStick, Plus, Zap } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Sparkline } from '../components/Charts';
import type { Me } from '../components/Layout';
import { AppMenu, AppPower, DeployBadge, PendingDeploy, TRIGGER, type Deploy } from '../components/shared';
import { Badge, Button, Card, Empty, IconButton, List, Loading, Meter, PageHeader, Row, SectionHeader, StatusBadge, StatusDot, cx } from '../components/ui';
import { ago, bytes, rate, sha } from '../lib/format';
import { Link, navigate, useTitle } from '../lib/router';
import { useApi, useLive, type SystemNow, type UnitStatus } from '../lib/store';

export interface AppSummary {
  id: number;
  slug: string;
  name: string;
  runtime: 'node' | 'python';
  runtimeVersion: string;
  repoUrl: string;
  repoWeb: string;
  branch: string;
  port: number | null;
  publicUrl: string;
  deployMode: 'auto' | 'delay' | 'manual';
  deployDelaySec: number;
  autostart: boolean;
  desiredState: 'running' | 'stopped';
  deployedSha: string | null;
  deployedAt: number | null;
  lastPollAt: number | null;
  lastPollError: string | null;
  status: UnitStatus | null;
  openDeploy: { id: number; status: string; to_sha: string | null; scheduled_at: number | null } | null;
  lastDeploy: { id: number; status: string; finished_at: number | null } | null;
  busy: boolean;
}

export interface DbSummary {
  id: number;
  slug: string;
  name: string;
  type: 'mariadb' | 'redis';
  port: number;
  bind: string;
  autostart: boolean;
  initialized: boolean;
  desiredState: string;
  status: UnitStatus | null;
  job: { id: number; kind: string; title: string } | null;
  linkedApps: { slug: string; name: string; prefix: string }[];
}

interface Sample {
  t: number;
  cpu: number;
  mem: number;
  rx: number;
  tx: number;
}

/** 앱 목록 왼쪽 아이콘: 한 가지 색의 둥근 사각형 + 런타임 글자 */
export function RuntimeIcon({ runtime, size = 34 }: { runtime: 'node' | 'python'; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[22%] bg-fill-2 font-semibold tracking-[-0.02em] text-fg-2"
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.34)) }}
      title={runtime === 'node' ? 'Node.js' : 'Python'}
    >
      {runtime === 'node' ? 'JS' : 'PY'}
    </div>
  );
}

export function DbIcon({ type, size = 34 }: { type: 'mariadb' | 'redis'; size?: number }) {
  return (
    <div className="flex shrink-0 items-center justify-center rounded-[22%] bg-fill-2 text-fg-2" style={{ width: size, height: size }} title={type === 'mariadb' ? 'MariaDB' : 'Redis'}>
      {type === 'mariadb' ? <Database size={size * 0.5} /> : <Zap size={size * 0.5} />}
    </div>
  );
}

function useHistory() {
  const live = useLive();
  const { data } = useApi<{ history: Sample[] }>('/api/system/metrics?range=1h');
  const [hist, setHist] = useState<Sample[]>([]);
  useEffect(() => {
    if (data) setHist(data.history.slice(-90));
  }, [data]);
  useEffect(() => {
    const s = live.system;
    if (!s) return;
    setHist((h) => (h.length && h[h.length - 1]!.t >= s.t ? h : [...h.slice(-89), { t: s.t, cpu: s.cpu, mem: s.mem, rx: s.rx, tx: s.tx }]));
  }, [live.system]);
  return hist;
}

/** 서버 사용량: 큰 숫자 + 얇은 그래프 (건강 앱의 요약 칸처럼) */
function ServerTiles({ sys, hist }: { sys: SystemNow | null; hist: Sample[] }) {
  if (!sys) return null;
  const disk = sys.disk[0];
  const diskPct = disk ? (disk.used / disk.total) * 100 : 0;
  const tiles: { label: string; icon: ReactNode; value: string; unit?: string; sub: string; spark?: number[]; max?: number; meter?: number }[] = [
    { label: 'CPU', icon: <Cpu size={14} />, value: sys.cpu.toFixed(0), unit: '%', sub: `${sys.cores.length}코어 · 부하 ${sys.load.toFixed(2)}`, spark: hist.map((s) => s.cpu), max: 100 },
    { label: '메모리', icon: <MemoryStick size={14} />, value: sys.mem.toFixed(0), unit: '%', sub: `${bytes(sys.memUsed)} / ${bytes(sys.memTotal)}`, spark: hist.map((s) => s.mem), max: 100 },
    { label: '디스크', icon: <HardDrive size={14} />, value: disk ? diskPct.toFixed(0) : '-', unit: disk ? '%' : '', sub: disk ? `${bytes(disk.total - disk.used)} 남음` : '', meter: diskPct },
    { label: '네트워크', icon: <ArrowDownUp size={14} />, value: rate(sys.rx + sys.tx), sub: `↓ ${rate(sys.rx)}  ↑ ${rate(sys.tx)}`, spark: hist.map((s) => s.rx + s.tx) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
      {tiles.map((t) => (
        <Link key={t.label} to="/system" className="card group flex min-w-0 flex-col p-4 transition-transform duration-200 active:scale-[0.98] sm:p-5">
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-muted">
            {t.icon}
            {t.label}
            <ChevronRight size={14} className="ml-auto text-muted/50 transition-transform group-hover:translate-x-0.5" />
          </div>
          <div className="mt-2 flex items-baseline gap-0.5 whitespace-nowrap">
            <span className={cx('font-semibold tracking-[-0.03em]', t.unit !== undefined ? 'text-[34px] leading-none' : 'text-[22px] leading-[34px]')}>{t.value}</span>
            {t.unit && <span className="text-[17px] font-semibold text-muted">{t.unit}</span>}
          </div>
          <div className="mt-1 truncate text-[12.5px] text-muted">{t.sub}</div>
          <div className="mt-auto pt-3">
            {t.spark && t.spark.length > 1 ? (
              <Sparkline values={t.spark} max={t.max} height={28} />
            ) : t.meter !== undefined ? (
              <div className="flex h-7 items-end pb-1">
                <Meter value={t.meter} />
              </div>
            ) : (
              <div className="h-7" />
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}

/** 맨 위 한 줄 요약: 지금 손볼 게 있는지 */
function StatusLine({ apps, dbs, waiting, units }: { apps: AppSummary[]; dbs: DbSummary[]; waiting: number; units: Record<string, UnitStatus> }) {
  const appState = (a: AppSummary) => (a.deployedSha ? (units[`hrone-app-${a.slug}.service`] ?? a.status)?.state : 'not-deployed');
  const dbState = (d: DbSummary) => (d.initialized ? (units[`hrone-db-${d.slug}.service`] ?? d.status)?.state : 'not-deployed');
  const appRun = apps.filter((a) => appState(a) === 'running').length;
  const appBad = apps.filter((a) => appState(a) === 'failed').length;
  const dbRun = dbs.filter((d) => dbState(d) === 'running').length;
  const dbBad = dbs.filter((d) => dbState(d) === 'failed').length;
  const bad = appBad + dbBad;
  const headline = bad
    ? `${bad}개 서비스에 문제가 있습니다`
    : waiting
      ? `승인을 기다리는 배포가 ${waiting}개 있습니다`
      : apps.length + dbs.length === 0
        ? '아직 실행 중인 서비스가 없습니다'
        : '모든 서비스가 정상입니다';
  const Icon = bad ? CircleAlert : waiting ? Clock : CircleCheck;
  const parts = [
    apps.length ? `앱 ${apps.length}개 중 ${appRun}개 실행 중` : null,
    dbs.length ? `데이터베이스 ${dbs.length}개 중 ${dbRun}개 실행 중` : null,
  ].filter(Boolean);
  return (
    <div className="flex items-center gap-3.5">
      <Icon size={30} strokeWidth={1.8} className={cx('shrink-0', bad ? 'text-bad' : waiting ? 'text-warn' : 'text-ok')} />
      <div className="min-w-0">
        <div className="text-[17px] font-semibold tracking-[-0.015em]">{headline}</div>
        {parts.length > 0 && <div className="mt-0.5 text-[14px] text-muted">{parts.join(' · ')}</div>}
      </div>
    </div>
  );
}

const HIDE_GUIDE = 'hrone:guide-hidden';

/** 처음 쓰는 사람을 위한 순서 안내. 다 끝내거나 숨기면 사라진다 */
function GettingStarted({ me, appCount }: { me: Me; appCount: number }) {
  const { data: s } = useApi<{ githubTokenSet: boolean; discordSet: boolean }>('/api/settings');
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDE_GUIDE) === '1';
    } catch {
      return false;
    }
  });
  if (!s || hidden) return null;
  const steps = [
    { done: me.totpEnabled, title: '계정 지키기', body: '설치할 때 받은 비밀번호를 바꾸고 OTP(2단계 인증)를 켜세요.', to: '/settings', cta: '내 계정' },
    { done: s.githubTokenSet, optional: true, title: 'GitHub 연결', body: '비공개 저장소를 쓸 때만 필요합니다. 연결하면 앱 추가 화면에서 내 저장소를 골라 쓸 수 있습니다.', to: '/settings?tab=connect', cta: '토큰 넣기' },
    { done: appCount > 0, title: '첫 앱 배포', body: '저장소 주소만 넣으면 실행 방법을 알아서 찾고 바로 배포합니다.', to: '/apps/new', cta: '앱 추가', primary: true },
    { done: s.discordSet, optional: true, title: '디스코드 알림', body: '배포 성공·실패, 크래시를 디스코드로 받습니다.', to: '/settings?tab=connect', cta: '웹후크 넣기' },
  ];
  if (steps.every((x) => x.done)) return null;
  const left = steps.filter((x) => !x.done && !x.optional).length;
  return (
    <Card
      title="시작하기"
      actions={
        <>
          <span className="text-muted">{left ? `필수 ${left}개 남음` : '필수 단계를 마쳤습니다'}</span>
          <Button
            size="sm"
            variant="plain"
            className="-mr-2"
            onClick={() => {
              try {
                localStorage.setItem(HIDE_GUIDE, '1');
              } catch {
                // 저장이 막힌 브라우저면 이번 화면에서만 숨긴다
              }
              setHidden(true);
            }}
          >
            숨기기
          </Button>
        </>
      }
      pad={false}
    >
      <ol>
        {steps.map((x, i) => (
          <li key={x.title} className={cx('flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5', i > 0 && 'hairline-t')}>
            <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold', x.done ? 'bg-ok-dot text-white' : 'bg-fill text-fg-2')}>
              {x.done ? <Check size={15} strokeWidth={3} /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cx('text-[15px] font-medium', x.done && 'text-muted')}>
                {x.title}
                {x.optional && <span className="ml-1.5 text-[13px] font-normal text-muted">선택</span>}
              </div>
              {!x.done && <div className="mt-0.5 text-[13px] leading-relaxed text-muted">{x.body}</div>}
            </div>
            {!x.done && (
              <Button size="sm" variant={x.primary ? 'primary' : 'secondary'} onClick={() => navigate(x.to)}>
                {x.cta}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

const seeAll = (to: string) => (
  <Link to={to} className="text-[15px] text-accent-2 hover:opacity-75">
    전체 보기
  </Link>
);

export function Dashboard({ me }: { me: Me }) {
  useTitle('홈');
  const live = useLive();
  const hist = useHistory();
  const { data, loading } = useApi<{ apps: AppSummary[]; databases: DbSummary[]; open: Deploy[]; recent: Deploy[]; system: SystemNow | null }>('/api/dashboard', {
    refreshOn: ['apps', 'deploys', 'databases'],
  });
  const { data: info } = useApi<{ hostname: string }>('/api/system/info');
  const appsById = useMemo(() => new Map((data?.apps ?? []).map((a) => [a.id, a])), [data]);
  const waiting = (data?.open ?? []).filter((d) => d.status === 'pending' || d.status === 'scheduled');

  return (
    <div>
      <PageHeader
        title="홈"
        sub={info?.hostname}
        actions={
          <>
            <Button size="sm" icon={<Database size={15} />} onClick={() => navigate('/databases?new=1')} title="DB 추가" aria-label="DB 추가">
              <span className="max-sm:hidden">DB 추가</span>
            </Button>
            <Button size="sm" variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/apps/new')}>
              앱 추가
            </Button>
          </>
        }
      />

      {loading && !data ? (
        <Loading />
      ) : (
        <div className="space-y-9">
          <section className="space-y-4">
            <StatusLine apps={data!.apps} dbs={data!.databases} waiting={waiting.length} units={live.units} />
            <ServerTiles sys={live.system ?? data?.system ?? null} hist={hist} />
          </section>

          <GettingStarted me={me} appCount={data!.apps.length} />

          {waiting.length > 0 && (
            <Card title="적용 대기 중인 배포" pad={false}>
              {waiting.map((d, i) => (
                <div key={d.id} className={cx('px-4 py-3.5 sm:px-5', i > 0 && 'hairline-t')}>
                  <PendingDeploy d={{ ...d, appName: appsById.get(d.app_id)?.name }} />
                </div>
              ))}
            </Card>
          )}

          <div className="grid gap-9 xl:grid-cols-[minmax(0,1fr)_380px] xl:gap-8">
            <section className="min-w-0">
              <SectionHeader title="앱" actions={data!.apps.length > 0 && seeAll('/apps')} />
              {data!.apps.length === 0 ? (
                <div className="card">
                  <Empty icon={<Boxes />} title="아직 앱이 없습니다" action={<Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/apps/new')}>첫 앱 추가</Button>}>
                    GitHub 저장소를 연결하면 푸시할 때마다 자동으로 배포됩니다.
                  </Empty>
                </div>
              ) : (
                <List>
                  {data!.apps.map((a) => {
                    const st = live.units[`hrone-app-${a.slug}.service`] ?? a.status;
                    const state = a.deployedSha ? st?.state : 'not-deployed';
                    const addr = a.publicUrl ? a.publicUrl.replace(/^https?:\/\//, '') : a.port ? `127.0.0.1:${a.port}` : '포트 없음';
                    return (
                      <Row
                        key={a.slug}
                        to={`/apps/${a.slug}`}
                        icon={<RuntimeIcon runtime={a.runtime} size={36} />}
                        title={
                          <span className="flex items-center gap-2">
                            <span className="truncate font-medium">{a.name}</span>
                            {a.busy && <Badge tone="purple">배포 중</Badge>}
                          </span>
                        }
                        sub={
                          <span className="flex items-center gap-2">
                            <StatusBadge state={state} />
                            <span className="truncate">
                              {addr}
                              {st?.state === 'running' && ` · ${bytes(st.memory)}`}
                            </span>
                          </span>
                        }
                        trailing={
                          <span className="flex items-center gap-1" onClick={(e) => e.preventDefault()}>
                            <span className="md:hidden">
                              <AppMenu slug={a.slug} name={a.name} state={st?.state} deployed={!!a.deployedSha} publicUrl={a.publicUrl || undefined} />
                            </span>
                            <span className="hidden items-center gap-1 md:flex">
                              {a.publicUrl && (
                                <IconButton title={a.publicUrl} onClick={() => window.open(a.publicUrl, '_blank', 'noopener')}>
                                  <ExternalLink size={15} />
                                </IconButton>
                              )}
                              <AppPower slug={a.slug} state={st?.state} deployed={!!a.deployedSha} />
                            </span>
                          </span>
                        }
                      />
                    );
                  })}
                </List>
              )}
            </section>

            <div className="min-w-0 space-y-9">
              <section>
                <SectionHeader title="데이터베이스" actions={data!.databases.length > 0 && seeAll('/databases')} />
                {data!.databases.length === 0 ? (
                  <div className="card px-5 py-8 text-center text-[15px] text-muted">
                    MariaDB · Redis 가 필요하면{' '}
                    <Link to="/databases?new=1" className="text-accent-2 hover:underline">
                      추가하세요
                    </Link>
                  </div>
                ) : (
                  <List>
                    {data!.databases.map((d) => {
                      const st = live.units[`hrone-db-${d.slug}.service`] ?? d.status;
                      return (
                        <Row
                          key={d.slug}
                          to={`/databases/${d.slug}`}
                          icon={<DbIcon type={d.type} size={32} />}
                          title={d.name}
                          sub={`${d.type === 'mariadb' ? 'MariaDB' : 'Redis'} · :${d.port}${st?.state === 'running' ? ` · ${bytes(st.memory)}` : ''}`}
                          trailing={d.job ? <span className="text-[13px] text-info">준비 중</span> : <StatusDot state={d.initialized ? st?.state : 'not-deployed'} />}
                        />
                      );
                    })}
                  </List>
                )}
              </section>

              {data!.recent.length > 0 && (
                <section>
                  <SectionHeader title="최근 배포" />
                  <List>
                    {data!.recent.slice(0, 6).map((d) => (
                      <Row
                        key={d.id}
                        to={`/apps/${d.appSlug}?tab=deploys&deploy=${d.id}`}
                        title={
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium">{d.appName}</span>
                            <span className="shrink-0 text-[13px] text-muted">{ago(d.finished_at ?? d.created_at)}</span>
                          </span>
                        }
                        sub={
                          <span className="flex items-center gap-2">
                            <DeployBadge status={d.status} />
                            <span className="truncate">
                              <span className="mono text-[12px]">{sha(d.to_sha)}</span> {d.commits[0]?.message ?? TRIGGER[d.trigger]}
                            </span>
                          </span>
                        }
                        chevron={false}
                      />
                    ))}
                  </List>
                </section>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
