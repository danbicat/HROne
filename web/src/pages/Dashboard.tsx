import { Boxes, Check, Clock, Database, Plus, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Sparkline } from '../components/Charts';
import type { Me } from '../components/Layout';
import { AppMenu, AppPower, DeployBadge, DomainLink, PendingDeploy, TRIGGER, type Deploy } from '../components/shared';
import { Badge, Button, Card, Empty, List, Loading, Meter, PageHeader, Row, SectionHeader, Stats, StatusBadge, StatusDot, cx } from '../components/ui';
import { ago, bytes, josa, rate, sha } from '../lib/format';
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

/** 서버 사용량: 칸 하나를 넷으로 나눈 요약. 누르면 서버 화면으로 */
function ServerStats({ sys, hist }: { sys: SystemNow | null; hist: Sample[] }) {
  if (!sys) return null;
  const disk = sys.disk[0];
  const diskPct = disk ? (disk.used / disk.total) * 100 : 0;
  // 그래프가 없는 칸도 높이를 맞춘다
  const spark = (values: number[], max?: number) => (values.length > 1 ? <Sparkline values={values} max={max} height={28} /> : <span className="block h-7" />);
  return (
    <Stats
      items={[
        { label: 'CPU', value: sys.cpu.toFixed(0), unit: '%', sub: `${sys.cores.length}코어, 부하 ${sys.load.toFixed(2)}`, to: '/system', chart: spark(hist.map((s) => s.cpu), 100) },
        { label: '메모리', value: sys.mem.toFixed(0), unit: '%', sub: `${bytes(sys.memUsed)} / ${bytes(sys.memTotal)}`, to: '/system', chart: spark(hist.map((s) => s.mem), 100) },
        {
          label: '디스크',
          value: disk ? diskPct.toFixed(0) : '-',
          unit: disk ? '%' : undefined,
          sub: disk ? `${bytes(disk.total - disk.used)} 남음` : undefined,
          to: '/system',
          tone: diskPct > 90 ? 'bad' : undefined,
          chart: (
            <span className="flex h-7 items-end pb-1">
              <Meter value={diskPct} />
            </span>
          ),
        },
        {
          label: '네트워크',
          value: rate(sys.rx + sys.tx),
          sub: (
            <span className="flex gap-2.5">
              <span>↓ {rate(sys.rx)}</span>
              <span>↑ {rate(sys.tx)}</span>
            </span>
          ),
          to: '/system',
          chart: spark(hist.map((s) => s.rx + s.tx)),
        },
      ]}
    />
  );
}

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

/**
 * 홈 제목: 지금 상태를 한 문장으로. 문제가 있으면 그것부터, 없으면 실행 중인 개수.
 * 아래 한 줄은 앱 · DB 를 나눠 센 사실.
 */
function useHeadline(apps: AppSummary[], dbs: DbSummary[], waiting: number, units: Record<string, UnitStatus>) {
  const appState = (a: AppSummary) => (a.deployedSha ? (units[`hrone-app-${a.slug}.service`] ?? a.status)?.state : 'not-deployed');
  const dbState = (d: DbSummary) => (d.initialized ? (units[`hrone-db-${d.slug}.service`] ?? d.status)?.state : 'not-deployed');
  const failed = [...apps.filter((a) => appState(a) === 'failed').map((a) => a.name), ...dbs.filter((d) => dbState(d) === 'failed').map((d) => d.name)];
  const appRun = apps.filter((a) => appState(a) === 'running').length;
  const dbRun = dbs.filter((d) => dbState(d) === 'running').length;
  const total = apps.length + dbs.length;
  const running = appRun + dbRun;

  let title: string;
  let tone: Tone;
  if (failed.length === 1) [title, tone] = [`${failed[0]}에 문제가 생겼습니다`, 'bad'];
  else if (failed.length > 1) [title, tone] = [`서비스 ${failed.length}개에 문제가 생겼습니다`, 'bad'];
  else if (waiting) [title, tone] = [`승인을 기다리는 배포가 ${waiting}개 있습니다`, 'warn'];
  else if (total === 0) [title, tone] = ['첫 앱을 배포해 보세요', 'idle'];
  else if (running === total) [title, tone] = ['모든 서비스가 실행 중입니다', 'ok'];
  else [title, tone] = [`서비스 ${total}개 중 ${running}개가 실행 중입니다`, 'idle'];

  const count = (label: string, n: number, run: number) => (n === 0 ? null : run === n ? `${label} ${n}개 모두` : `${label} ${n}개 중 ${run}개`);
  const facts = [count('앱', apps.length, appRun), count('데이터베이스', dbs.length, dbRun)].filter(Boolean).join(', ');
  const sub =
    total === 0
      ? 'GitHub 저장소를 연결하면 푸시할 때마다 이 서버에 자동으로 배포합니다.'
      : [failed.length > 1 ? `${josa(failed.join(', '), '을', '를')} 확인하세요.` : null, facts ? `${facts} 실행 중입니다.` : null].filter(Boolean).join(' ');
  return { title, tone, sub };
}

/** 제목 왼쪽의 상태 표시: 색 있는 원 + 흰 기호 */
function HeadlineMark({ tone }: { tone: Tone }) {
  if (tone === 'idle') return null;
  const [bg, icon] =
    tone === 'bad'
      ? ['bg-bad-dot', <span key="b" className="text-title font-bold leading-none">!</span>]
      : tone === 'warn'
        ? ['bg-warn-dot', <Clock key="w" size={20} strokeWidth={2.6} />]
        : ['bg-ok-dot', <Check key="o" size={21} strokeWidth={3.2} />];
  return <span className={cx('flex h-9 w-9 items-center justify-center rounded-full text-white', bg)}>{icon}</span>;
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
    { done: s.discordSet, optional: true, title: '디스코드 알림', body: '배포가 끝나거나 실패할 때, 앱이 멈췄을 때 디스코드로 알려 줍니다.', to: '/settings?tab=connect', cta: '웹후크 넣기' },
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
            <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-footnote font-semibold', x.done ? 'bg-ok-dot text-white' : 'bg-fill text-fg-2')}>
              {x.done ? <Check size={15} strokeWidth={3} /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cx('text-body font-medium', x.done && 'text-muted')}>
                {x.title}
                {x.optional && <span className="ml-1.5 text-footnote font-normal text-muted">선택</span>}
              </div>
              {!x.done && <div className="mt-0.5 text-footnote text-muted">{x.body}</div>}
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
  <Link to={to} className="text-body text-accent-2 hover:opacity-75">
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
  const appsById = useMemo(() => new Map((data?.apps ?? []).map((a) => [a.id, a])), [data]);
  const waiting = (data?.open ?? []).filter((d) => d.status === 'pending' || d.status === 'scheduled');
  const head = useHeadline(data?.apps ?? [], data?.databases ?? [], waiting.length, live.units);

  return (
    <div>
      <PageHeader
        title={data ? head.title : '홈'}
        barTitle="홈"
        wrap
        icon={data && <HeadlineMark tone={head.tone} />}
        sub={data && head.sub}
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
          <section>
            <SectionHeader title="서버" />
            <ServerStats sys={live.system ?? data?.system ?? null} hist={hist} />
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
                    const local = a.port ? `127.0.0.1:${a.port}` : '포트 없음';
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
                          <span className="flex min-w-0 items-center gap-3">
                            <StatusBadge state={state} />
                            {a.publicUrl ? <DomainLink url={a.publicUrl} className="md:max-w-[60%] md:shrink-0" /> : <span className="shrink-0">{local}</span>}
                            {st?.state === 'running' && <span className="truncate max-md:hidden">{bytes(st.memory)}</span>}
                          </span>
                        }
                        trailing={
                          <span className="flex items-center gap-1" onClick={(e) => e.preventDefault()}>
                            <span className="md:hidden">
                              <AppMenu slug={a.slug} name={a.name} state={st?.state} deployed={!!a.deployedSha} publicUrl={a.publicUrl || undefined} />
                            </span>
                            <span className="hidden items-center gap-1 md:flex">
                              <AppPower slug={a.slug} name={a.name} state={st?.state} deployed={!!a.deployedSha} />
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
                  <div className="card px-5 py-8 text-center text-body text-muted">
                    앱에 MariaDB나 Redis가 필요하면{' '}
                    <Link to="/databases?new=1" className="text-accent-2 hover:underline">
                      여기서 만드세요
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
                          sub={
                            <span className="flex gap-3">
                              <span>{d.type === 'mariadb' ? 'MariaDB' : 'Redis'}</span>
                              <span>포트 {d.port}</span>
                              {st?.state === 'running' && <span>{bytes(st.memory)}</span>}
                            </span>
                          }
                          trailing={d.job ? <span className="text-footnote text-info">준비 중</span> : <StatusDot state={d.initialized ? st?.state : 'not-deployed'} />}
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
                            <span className="shrink-0 text-footnote text-muted">{ago(d.finished_at ?? d.created_at)}</span>
                          </span>
                        }
                        sub={
                          <span className="flex items-center gap-2">
                            {/* 성공은 보통의 일이라 표시하지 않는다. 눈여겨볼 상태만 배지로 */}
                            {d.status !== 'success' && <DeployBadge status={d.status} />}
                            <span className="mono shrink-0 text-caption">{sha(d.to_sha)}</span>
                            <span className="truncate">{d.commits[0]?.message ?? TRIGGER[d.trigger]}</span>
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
