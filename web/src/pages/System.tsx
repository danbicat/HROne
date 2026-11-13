import { Download, Save, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { AreaChart } from '../components/Charts';
import { JobDialog } from '../components/Dialogs';
import type { Me } from '../components/Layout';
import { Badge, Button, Card, CopyField, KV, Loading, Meter, Notice, PageHeader, SectionHeader, Segmented, Tabs, cx, toast, useAction, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { bytes, duration, pct, rate } from '../lib/format';
import { Link, setQuery, useLocation, useTitle } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import { BackupsPanel } from './Backups';

interface Info {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cores: number;
  memTotal: number;
  virtualization: string;
  container: boolean;
  timezone: string;
  networks: { name: string; address: string }[];
  panelNode: string;
  panelVersion: string;
  tailscale: { installed: false } | { installed: true; ip: string | null; dnsName: string | null; state: string | null; service: string };
  cloudflared: { installed: false } | { installed: true; version: string; service: string; ingress: { hostname: string; service: string }[] };
  cgroupControllers: string[];
}

interface Res {
  cpu: number | null;
  memoryMB: number | null;
  swapMB: number | null;
  tasks: number | null;
  cpuWeight: number | null;
}

type SysTab = 'status' | 'backups' | 'advanced';

export function System({ me }: { me: Me }) {
  useTitle('서버');
  const { query } = useLocation();
  const tab = (query.get('tab') as SysTab) || 'status';
  const { data: info } = useApi<Info>('/api/system/info');

  return (
    <div>
      <PageHeader title="서버" sub={info ? `${info.hostname} · ${info.os} · ${info.arch} · ${info.virtualization === 'none' ? '물리/베어메탈' : info.virtualization.toUpperCase()}` : ''} />
      <Tabs
        value={tab}
        onChange={(t) => setQuery('tab', t === 'status' ? null : t)}
        tabs={[
          { value: 'status', label: '상태' },
          { value: 'backups', label: '백업' },
          { value: 'advanced', label: '고급' },
        ]}
      />
      {tab === 'status' && <StatusTab info={info ?? undefined} />}
      {tab === 'backups' && <BackupsPanel me={me} />}
      {tab === 'advanced' && (
        <div className="space-y-9">
          <p className="px-1 text-[15px] text-muted">처음에는 건드리지 않아도 됩니다. 서버를 직접 조정하고 싶을 때만 쓰세요.</p>
          <SliceLimits info={info ?? undefined} />
          <div className="grid gap-9 xl:grid-cols-2 xl:gap-8">
            <div className="min-w-0 space-y-9">
              <NetworkServices info={info ?? undefined} />
              <Components />
            </div>
            <div className="min-w-0 space-y-9">
              <Tuning container={!!info?.container} />
              <Swap />
              <Timezone current={info?.timezone} />
              <JournalCard />
              <PanelVersion version={info?.panelVersion} node={info?.panelNode} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 큰 숫자 칸: 이름 / 큰 값 / 보조 설명 / 아래에 그래프 */
function StatCard({ label, value, unit, sub, children }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <section className="card flex min-w-0 flex-col p-5">
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-0.5 whitespace-nowrap">
        <span className="text-[34px] font-semibold leading-none tracking-[-0.03em]">{value}</span>
        {unit && <span className="text-[17px] font-semibold text-muted">{unit}</span>}
      </div>
      {sub && <div className="mt-1.5 truncate text-[13px] text-muted">{sub}</div>}
      {children && <div className="mt-5">{children}</div>}
    </section>
  );
}

function StatusTab({ info }: { info: Info | undefined }) {
  const live = useLive();
  const sys = live.system;
  const [range, setRange] = useState<'1h' | '24h'>('1h');
  const { data: metrics } = useApi<{ history: { t: number; cpu: number; mem: number; rx: number; tx: number; load: number }[] }>(`/api/system/metrics?range=${range}`, { interval: range === '1h' ? 10_000 : 60_000 });
  const h = metrics?.history ?? [];
  const times = h.map((x) => x.t);

  if (!sys) return <Loading />;
  const disk = sys.disk[0];
  return (
    <section className="min-w-0">
      <SectionHeader
        title="사용량"
        actions={
          <Segmented
            value={range}
            onChange={setRange}
            options={[
              { value: '1h', label: '1시간' },
              { value: '24h', label: '24시간' },
            ]}
          />
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <StatCard label="CPU" value={sys.cpu.toFixed(0)} unit="%" sub={`부하 ${sys.load.toFixed(2)} · ${sys.cores.length}코어${info?.cpuModel ? ` · ${info.cpuModel}` : ''}`}>
          {/* 코어별 사용률: 활성 상태 보기처럼 가는 막대 */}
          <div className="mb-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {sys.cores.map((c, i) => (
              <div key={i} className="flex items-center gap-3 text-[12.5px]">
                <span className="w-11 shrink-0 text-muted">코어 {i}</span>
                <Meter value={c} />
                <span className="w-9 shrink-0 text-right tabular-nums text-fg-2">{c.toFixed(0)}%</span>
              </div>
            ))}
          </div>
          <AreaChart times={times} max={100} height={120} format={(v) => `${v.toFixed(0)}%`} series={[{ label: 'CPU', color: 'var(--color-accent)', values: h.map((x) => x.cpu) }]} />
        </StatCard>
        <StatCard
          label="메모리"
          value={sys.mem.toFixed(0)}
          unit="%"
          sub={
            <>
              {bytes(sys.memUsed)} / {bytes(sys.memTotal)} · 스왑 {sys.swapTotal ? `${bytes(sys.swapUsed)} / ${bytes(sys.swapTotal)}` : '없음'}
            </>
          }
        >
          {sys.swapTotal > 0 && (
            <div className="mb-4 flex items-center gap-3 text-[13px] text-muted">
              <span className="shrink-0">스왑</span>
              <Meter value={(sys.swapUsed / sys.swapTotal) * 100} tone="gray" />
            </div>
          )}
          <AreaChart times={times} max={100} height={120} format={(v) => `${v.toFixed(0)}%`} series={[{ label: '메모리', color: 'var(--color-accent)', values: h.map((x) => x.mem) }]} />
        </StatCard>
        <StatCard label="디스크" value={disk ? ((disk.used / disk.total) * 100).toFixed(0) : '-'} unit={disk ? '%' : undefined} sub={disk ? `${bytes(disk.total - disk.used)} 남음` : undefined}>
          <div className="space-y-4">
            {sys.disk.map((d) => (
              <div key={d.mount}>
                <div className="mb-1.5 flex justify-between gap-3 text-[13px]">
                  <span className="mono text-fg-2">{d.mount}</span>
                  <span className="text-muted">
                    {bytes(d.used)} / {bytes(d.total)}
                  </span>
                </div>
                <Meter value={(d.used / d.total) * 100} />
              </div>
            ))}
            <div className="hairline-t flex justify-between pt-3 text-[13px]">
              <span className="text-muted">가동 시간</span>
              <span>{duration(sys.uptime)}</span>
            </div>
          </div>
        </StatCard>
        <StatCard label="네트워크" value={rate(sys.rx + sys.tx)} sub={`수신 ↓ ${rate(sys.rx)} · 송신 ↑ ${rate(sys.tx)}`}>
          <AreaChart
            times={times}
            height={120}
            format={(v) => rate(v)}
            series={[
              { label: '수신', color: 'var(--color-accent)', values: h.map((x) => x.rx) },
              { label: '송신', color: 'var(--color-muted)', values: h.map((x) => x.tx) },
            ]}
          />
        </StatCard>
      </div>
      {range === '24h' && <div className="hint px-4">24시간 기록은 패널이 켜진 뒤부터 1분 단위로 모읍니다 (패널 재시작 시 초기화).</div>}
    </section>
  );
}

function SliceLimits({ info }: { info: Info | undefined }) {
  const { data, reload } = useApi<{ total: Res; apps: Res; dbs: Res }>('/api/system/limits');
  const live = useLive();
  const [v, setV] = useState<{ total: Res; apps: Res; dbs: Res } | null>(null);
  useEffect(() => setV(data), [data]);
  const { busy, run } = useAction();
  if (!v) return null;
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const rows: [keyof typeof v, string, string, string][] = [
    ['total', '전체 (앱 + DB)', 'hrone.slice', 'HROne 이 돌리는 모든 것의 합계 상한'],
    ['apps', '앱 전체', 'hrone-apps.slice', '모든 앱 합계'],
    ['dbs', 'DB 전체', 'hrone-dbs.slice', '모든 MariaDB/Redis 합계'],
  ];
  const noCpu = info && !info.cgroupControllers.includes('cpu');
  return (
    <Card
      title="전체 사용량 상한"
      pad={false}
    >
      <p className="px-5 pt-4 text-[13px] leading-relaxed text-muted">
        앱별 제한은 각 앱 설정에서, 여기서는 묶음 전체의 상한을 정합니다 (systemd slice). 패널 자신과 시스템 서비스(SSH, Tailscale, cloudflared)는 제외되므로 앱이 폭주해도 서버에 접속할 수 있습니다.
      </p>
      {noCpu && (
        <div className="px-5 pt-3">
          <Notice tone="yellow">이 환경은 cgroup cpu 컨트롤러가 없어 CPU 제한이 동작하지 않을 수 있습니다.</Notice>
        </div>
      )}
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[680px] text-[14px]">
          <thead>
            <tr className="text-left text-[12.5px] font-semibold text-muted">
              <th className="py-2.5 pl-5 pr-3 font-semibold">범위</th>
              <th className="px-3 py-2.5 font-semibold">현재</th>
              <th className="px-3 py-2.5 font-semibold">CPU 상한 (코어)</th>
              <th className="px-3 py-2.5 font-semibold">메모리 상한 (MB)</th>
              <th className="py-2.5 pl-3 pr-5 font-semibold">스왑 (MB)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, label, unit, hint]) => {
              const st = live.units[unit];
              return (
                <tr key={k} className="hairline-t transition-colors hover:bg-fill/50">
                  <td className="py-3 pl-5 pr-3">
                    <div className="font-medium">{label}</div>
                    <div className="mt-0.5 text-[13px] text-muted">{hint}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-[13px] text-fg-2">{st ? `CPU ${pct(st.cpu, 1)} · ${bytes(st.memory)}` : '-'}</td>
                  {(['cpu', 'memoryMB', 'swapMB'] as const).map((f, i) => (
                    <td key={f} className={cx('py-3', i === 2 ? 'pl-3 pr-5' : 'px-3')}>
                      <input className="input mono w-28" inputMode="decimal" value={v[k][f] ?? ''} placeholder="없음" onChange={(e) => setV({ ...v, [k]: { ...v[k], [f]: num(e.target.value) } })} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="hairline-t flex justify-end px-5 py-4">
        <Button variant="primary" icon={<Save size={15} />} disabled={JSON.stringify(v) === JSON.stringify(data)} loading={busy === 's'} onClick={() => run('s', () => api.put('/api/system/limits', v).then(reload), '바로 적용했습니다')}>
          저장 + 적용
        </Button>
      </div>
    </Card>
  );
}

function NetworkServices({ info }: { info: Info | undefined }) {
  if (!info) return null;
  const ts = info.tailscale;
  const cf = info.cloudflared;
  return (
    <div className="space-y-9">
      <Card title="Tailscale" actions={ts.installed ? <Badge tone={ts.state === 'Running' ? 'green' : 'yellow'}>{ts.state ?? ts.service}</Badge> : <Badge>미설치</Badge>}>
        {ts.installed ? (
          <KV
            items={[
              ['IP', ts.ip ? <span className="mono text-[14px]">{ts.ip}</span> : '-'],
              ['이름', ts.dnsName ?? '-'],
              ['패널 주소', ts.ip ? <span className="mono text-[14px]">http://{ts.ip}:{location.port || 80}</span> : '-'],
            ]}
          />
        ) : (
          <div className="space-y-3 text-[14px] leading-relaxed text-muted">
            <p>설치하면 Tailscale 네트워크에서 이 패널과 DB 에 안전하게 접속할 수 있습니다.</p>
            <CopyField value="curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up" />
            {info.container && <p className="text-[13px]">LXC 라면 호스트에서 /dev/net/tun 을 컨테이너에 넘겨 줘야 합니다 (Proxmox: 컨테이너 설정에 lxc.cgroup2.devices.allow / mount entry 추가).</p>}
          </div>
        )}
      </Card>
      <Card title="cloudflared" actions={cf.installed ? <Badge tone={cf.service === 'active' ? 'green' : 'yellow'}>{cf.service === 'active' ? '실행 중' : cf.service}</Badge> : <Badge>미설치</Badge>}>
        {cf.installed ? (
          <div className="space-y-3 text-[14px]">
            {cf.ingress.length ? (
              <KV items={[['버전', <span className="mono text-[13px]">{cf.version}</span>], ...cf.ingress.map((r) => [<span className="mono break-all text-[13px] text-fg">{r.hostname}</span>, <span className="mono break-all text-[13px] text-muted">{r.service}</span>] as [ReactNode, ReactNode])]} />
            ) : (
              <>
                <KV items={[['버전', <span className="mono text-[13px]">{cf.version}</span>]]} />
                <p className="hairline-t pt-3 leading-relaxed text-muted">토큰 방식(대시보드 관리) 터널입니다. Cloudflare Zero Trust → Tunnels → Public Hostname 에서 서비스를 http://127.0.0.1:앱포트 로 지정하세요.</p>
              </>
            )}
          </div>
        ) : (
          <p className="text-[14px] leading-relaxed text-muted">앱을 도메인으로 공개하려면 cloudflared 를 설치하고, 터널 Public Hostname 의 서비스를 http://127.0.0.1:앱포트 로 지정하세요. Nginx 는 필요 없습니다.</p>
        )}
      </Card>
    </div>
  );
}

function Components() {
  const { data, reload } = useApi<{ node: string[]; python: { version: string; path: string; managed: boolean }[]; uv: string | null; mariadb: string | null; redis: string | null; git: string | null; buildEssential: boolean }>('/api/system/components');
  const { data: nodeVersions } = useApi<{ version: string; lts: string | false }[]>('/api/system/node-versions');
  const [job, setJob] = useState<number | null>(null);
  const [py, setPy] = useState('3.12');
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const install = (component: string, version?: string) => run(`i${component}${version ?? ''}`, async () => setJob((await api.post<{ jobId: number }>('/api/system/components/install', { component, version })).jobId));
  if (!data)
    return (
      <Card title="구성 요소 · 런타임">
        <Loading />
      </Card>
    );
  return (
    <Card title="구성 요소 · 런타임" pad={false}>
      <div className="text-[15px]">
        <div className="p-5">
          <div className="mb-3 font-semibold">Node.js</div>
          <div className="flex flex-wrap gap-2">
            {data.node.map((v) => (
              <span key={v} className="inline-flex h-8 items-center gap-0.5 rounded-full bg-fill pl-3 pr-1 text-[13px]">
                <span className="mono">{v}</span>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-bad/10 hover:text-bad cursor-pointer"
                  title="삭제"
                  onClick={async () => {
                    if (!(await confirm({ title: `Node ${v} 삭제`, confirm: '삭제', danger: true }))) return;
                    run(`rm${v}`, () => api.post('/api/system/components/remove', { component: 'node', version: v }).then(reload), '삭제했습니다');
                  }}
                >
                  <X size={13} strokeWidth={2.4} />
                </button>
              </span>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(nodeVersions ?? [])
              .filter((n) => !data.node.includes(n.version))
              .map((n) => (
                <Button key={n.version} size="sm" variant="plain" icon={<Download size={13} />} loading={busy === `inode${n.version}`} onClick={() => install('node', n.version)}>
                  {n.version}
                  {n.lts ? ` LTS` : ''}
                </Button>
              ))}
          </div>
          <div className="hint">앱이 요구하는 버전은 배포할 때 자동으로 설치됩니다.</div>
        </div>
        <div className="hairline-t p-5">
          <div className="mb-2 font-semibold">Python</div>
          <div>
            {data.python.map((p, i) => (
              <div key={p.path} className={cx('flex items-center gap-2 py-2 text-[14px]', i > 0 && 'hairline-t')}>
                <span className="mono">{p.version}</span>
                <Badge>{p.managed ? 'uv' : '시스템'}</Badge>
                <span className="mono min-w-0 truncate text-[12.5px] text-muted">{p.path}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select className="input h-8 w-28 py-0 text-[13px]" value={py} onChange={(e) => setPy(e.target.value)}>
              {['3.14', '3.13', '3.12', '3.11', '3.10', '3.9'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <Button size="sm" icon={<Download size={13} />} loading={busy === `ipython${py}`} onClick={() => install('python', py)}>
              설치
            </Button>
            <span className="ml-auto text-[13px] text-muted">uv {data.uv ? data.uv.replace(/^uv /, '') : '미설치'}</span>
          </div>
        </div>
        <div className="hairline-t">
          {(
            [
              ['MariaDB', data.mariadb, 'mariadb'],
              ['Redis', data.redis, 'redis'],
            ] as const
          ).map(([label, v, c]) => (
            <div key={c} className={cx('flex min-h-[48px] items-center justify-between gap-3 px-5 py-2', c === 'redis' && 'hairline-t')}>
              <span>{label}</span>
              {v ? (
                <span className="mono min-w-0 truncate text-[13px] text-muted">{v}</span>
              ) : (
                <Button size="sm" variant="plain" icon={<Download size={13} />} loading={busy === `i${c}`} onClick={() => install(c)}>
                  설치
                </Button>
              )}
            </div>
          ))}
          <div className="hairline-t flex min-h-[48px] items-center justify-between gap-3 px-5 py-2">
            <span>git</span>
            <span className="mono min-w-0 truncate text-[13px] text-muted">{data.git ?? '-'}</span>
          </div>
          <div className="hairline-t flex min-h-[48px] items-center justify-between gap-3 px-5 py-2">
            <span>빌드 도구 (gcc)</span>
            <span className="text-[15px] text-muted">{data.buildEssential ? '있음' : '없음'}</span>
          </div>
        </div>
      </div>
      <JobDialog jobId={job} onClose={() => setJob(null)} onDone={reload} />
    </Card>
  );
}

function Tuning({ container }: { container: boolean }) {
  const { data, reload } = useApi<{ key: string; value: string; why: string; current: string | null }[]>('/api/system/tuning');
  const { busy, run } = useAction();
  if (!data) return null;
  const ok = (t: { key: string; value: string; current: string | null }) => t.current === t.value || (t.key.endsWith('somaxconn') && Number(t.current) >= Number(t.value)) || (t.key === 'fs.file-max' && Number(t.current) >= Number(t.value));
  return (
    <Card
      title="커널 튜닝 (동시 접속 / Redis)"
      actions={
        <Button
          size="sm"
          variant="plain"
          loading={busy === 't'}
          onClick={() =>
            run('t', async () => {
              const r = await api.post<{ key: string; ok: boolean; error?: string }[]>('/api/system/tuning', {});
              const failed = r.filter((x) => !x.ok);
              if (failed.length) toast.info(`${r.length - failed.length}개 적용, ${failed.length}개는 이 환경에서 바꿀 수 없음${container ? ' (LXC 는 호스트에서 설정)' : ''}`);
              else toast.ok('모두 적용했습니다 (/etc/sysctl.d/90-hrone.conf)');
              reload();
            })
          }
        >
          권장값 적용
        </Button>
      }
    >
      <div className="-my-2 text-[13px]">
        {data.map((t, i) => (
          <div key={t.key} className={cx('flex items-center gap-2.5 py-2.5', i > 0 && 'hairline-t')}>
            <span className={cx('h-2 w-2 shrink-0 rounded-full', ok(t) ? 'bg-ok-dot' : 'bg-warn-dot')} />
            <span className="mono min-w-0 flex-1 truncate" title={t.why}>
              {t.key}
            </span>
            <span className="mono text-muted">{t.current ?? '읽기 불가'}</span>
            {!ok(t) && <span className="mono text-warn">→ {t.value}</span>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Swap() {
  const { data, reload } = useApi<{ list: { name: string; size: number; used: number }[]; managed: boolean; container: boolean }>('/api/system/swap');
  const [size, setSize] = useState('2048');
  const { busy, run } = useAction();
  const confirm = useConfirm();
  if (!data) return null;
  return (
    <Card title="스왑">
      {data.list.length ? (
        <div className="-mt-2 mb-4 text-[14px]">
          {data.list.map((s, i) => (
            <div key={s.name} className={cx('flex justify-between gap-3 py-2.5', i > 0 && 'hairline-t')}>
              <span className="mono">{s.name}</span>
              <span className="text-muted">
                {bytes(s.used)} / {bytes(s.size)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-4 text-[14px] leading-relaxed text-muted">스왑이 없습니다. 메모리가 작은 VM 이라면 만들어 두면 OOM 을 줄일 수 있습니다.</div>
      )}
      {data.container ? (
        <div className="text-[13px] leading-relaxed text-muted">LXC 에서는 컨테이너 안에서 스왑을 만들 수 없습니다. Proxmox 컨테이너 설정의 Swap 값을 올리세요.</div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input className="input mono w-28" inputMode="numeric" value={size} onChange={(e) => setSize(e.target.value.replace(/\D/g, ''))} />
          <span className="text-[15px] text-muted">MB</span>
          <Button size="sm" loading={busy === 'c'} onClick={() => run('c', () => api.post('/api/system/swap', { sizeMB: Number(size) }).then(reload), '스왑을 만들었습니다')}>
            {data.managed ? '크기 변경' : '스왑 파일 만들기'}
          </Button>
          {data.managed && (
            <Button
              size="sm"
              variant="danger"
              loading={busy === 'r'}
              onClick={async () => {
                if (await confirm({ title: '스왑 제거', confirm: '제거' })) run('r', () => api.del('/api/system/swap').then(reload), '제거했습니다');
              }}
            >
              제거
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function Timezone({ current }: { current?: string }) {
  const { data: list } = useApi<string[]>('/api/system/timezones');
  const [tz, setTz] = useState(current ?? '');
  useEffect(() => setTz(current ?? ''), [current]);
  const { busy, run } = useAction();
  return (
    <Card title="시간대">
      <div className="flex items-center gap-2">
        <select className="input" value={tz} onChange={(e) => setTz(e.target.value)}>
          {(list ?? [current ?? '']).map((z) => (
            <option key={z}>{z}</option>
          ))}
        </select>
        <Button size="sm" disabled={tz === current} loading={busy === 'tz'} onClick={() => run('tz', () => api.put('/api/system/timezone', { timezone: tz }), '바꿨습니다. 예약 백업 시각이 이 시간대를 따릅니다.')}>
          적용
        </Button>
        {current !== 'Asia/Seoul' && (
          <Button size="sm" variant="plain" onClick={() => setTz('Asia/Seoul')}>
            서울
          </Button>
        )}
      </div>
    </Card>
  );
}

function JournalCard() {
  const { data, reload } = useApi<{ usage: string }>('/api/system/journal');
  const { busy, run } = useAction();
  return (
    <Card
      title="로그 저장소 (journald)"
      footer="앱 콘솔 로그는 journald 에 저장되며 최대 2GB 를 넘으면 오래된 것부터 지워집니다 (/etc/systemd/journald.conf.d/hrone.conf)."
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[15px]">
        <span className="text-fg-2">{data?.usage ?? '-'}</span>
        <Button size="sm" loading={busy === 'v'} onClick={() => run('v', () => api.post('/api/system/journal/vacuum', { size: '500M' }).then(reload), '오래된 로그를 정리했습니다')}>
          500MB 까지 정리
        </Button>
      </div>
    </Card>
  );
}

function PanelVersion({ version, node }: { version?: string; node?: string }) {
  const { data } = useApi<{ settings: { enabled: boolean; intervalHours: number }; current: { sha: string } }>('/api/system/update/status');
  return (
    <Card title="HROne" footer="업데이트해도 앱과 DB 는 계속 실행됩니다">
      <KV
        items={[
          ['버전', <span className="mono break-all text-[14px]">v{version} · {data?.current.sha}</span>],
          ['Node', <span className="mono text-[14px]">{node}</span>],
          ['자동 업데이트', data ? (data.settings.enabled ? `켜짐 (${data.settings.intervalHours === 24 ? '하루' : `${data.settings.intervalHours}시간`}마다 확인)` : '꺼짐') : ''],
        ]}
      />
      <div className="hairline-t mt-2 pt-3">
        <Link to="/settings?tab=update" className="text-[15px] text-accent-2 hover:opacity-75">
          업데이트 설정
        </Link>
      </div>
    </Card>
  );
}
