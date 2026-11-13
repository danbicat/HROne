import { Database, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { JobDialog } from '../components/Dialogs';
import { Badge, Button, Disclosure, Empty, Field, List, Loading, Modal, Notice, PageHeader, Row, Segmented, StatusBadge, toast } from '../components/ui';
import { api, errorText } from '../lib/api';
import { bytes, pct } from '../lib/format';
import { navigate, setQuery, useLocation, useTitle } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import { DbIcon, type DbSummary } from './Dashboard';

/** 영문/숫자만 남겨 DB ID 후보를 만든다 */
function slugFrom(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, 'db-$1')
    .slice(0, 24)
    .replace(/-+$/, '');
}

export function CreateDbModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [type, setType] = useState<'mariadb' | 'redis'>('mariadb');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [port, setPort] = useState('');
  const [bind, setBind] = useState('local');
  const [mem, setMem] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<{ id: number; slug: string } | null>(null);
  const { data: engines } = useApi<{ mariadb: string | null; redis: string | null }>(open ? '/api/databases/engines' : null);
  const { data: existing } = useApi<DbSummary[]>(open ? '/api/databases' : null);
  useEffect(() => {
    if (open) {
      setName('');
      setSlug('');
      setSlugTouched(false);
      setPort('');
      setMem('');
      setBind('local');
    }
  }, [open]);
  // ID 는 이름(영문이면) 또는 종류로 정하고, 이미 있으면 숫자를 붙인다
  useEffect(() => {
    if (slugTouched) return;
    const taken = new Set((existing ?? []).map((d) => d.slug));
    let base = slugFrom(name);
    if (base.length < 2) base = type;
    let s = base;
    for (let i = 2; taken.has(s); i++) s = `${base.slice(0, 21)}-${i}`;
    setSlug(s);
  }, [name, type, existing, slugTouched]);
  const installed = type === 'mariadb' ? engines?.mariadb : engines?.redis;
  const valid = /^[a-z][a-z0-9-]{1,23}$/.test(slug);
  return (
    <>
      <Modal
        open={open && !job}
        onClose={onClose}
        title="데이터베이스 추가"
        footer={
          <>
            <Button size="lg" onClick={onClose}>
              취소
            </Button>
            <Button
              size="lg"
              variant="primary"
              loading={busy}
              disabled={!valid}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.post<{ jobId: number; db: { slug: string } }>('/api/databases', {
                    type,
                    slug,
                    name: name || slug,
                    port: port ? Number(port) : undefined,
                    bind,
                    resources: mem ? { memoryMB: Number(mem) } : undefined,
                  });
                  setJob({ id: r.jobId, slug: r.db.slug });
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
          <div className="flex flex-col items-center gap-3 pt-1 text-center">
            <DbIcon type={type} size={56} />
            <Segmented
              value={type}
              onChange={setType}
              className="w-full [&>button]:flex-1"
              options={[
                { value: 'mariadb', label: 'MariaDB' },
                { value: 'redis', label: 'Redis' },
              ]}
            />
            <div className="text-[13px] text-muted">{type === 'mariadb' ? 'MySQL 과 같은 SQL DB' : '캐시 · 큐 · 세션'}</div>
          </div>
          <Field label="이름">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={type === 'mariadb' ? '메인 DB' : '캐시'} autoFocus />
          </Field>
          {engines && !installed && (
            <Notice tone="blue">{type === 'mariadb' ? 'MariaDB' : 'Redis'} 가 아직 설치되지 않았습니다. 만들 때 자동으로 설치합니다 (1~2분).</Notice>
          )}
          <p className="text-[13px] leading-relaxed text-muted">이 서버 안에서만 접속할 수 있게 만들어집니다. 앱 → 환경변수 탭에서 연결하면 접속 정보가 자동으로 들어갑니다.</p>
          <Disclosure label="고급 설정">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="ID" hint="영문 소문자/숫자/-. DB 이름과 계정 이름에도 쓰이며 나중에 못 바꿉니다">
                <input
                  className="input mono"
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value.toLowerCase());
                    setSlugTouched(true);
                  }}
                />
              </Field>
              <Field label="포트" hint={`비우면 ${type === 'mariadb' ? '3306' : '6379'} 부터 빈 포트`}>
                <input className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="자동" />
              </Field>
              <Field label="메모리 상한 (MB)" hint={type === 'mariadb' ? '버퍼 풀을 이 값의 절반으로 잡습니다' : 'maxmemory 를 이 값의 80% 로 잡습니다'}>
                <input className="input mono" inputMode="numeric" value={mem} onChange={(e) => setMem(e.target.value.replace(/\D/g, ''))} placeholder="제한 없음" />
              </Field>
            </div>
            <Field label="접속 허용" hint="외부 허용은 Tailscale 등으로 PC 의 DB 툴에서 접속할 때만 켜세요 (방화벽은 직접 관리)">
              <Segmented
                value={bind === 'local' ? 'local' : 'all'}
                onChange={setBind}
                className="w-full [&>button]:flex-1"
                options={[
                  { value: 'local', label: '이 서버만 (127.0.0.1)' },
                  { value: 'all', label: '모든 인터페이스 (0.0.0.0)' },
                ]}
              />
            </Field>
            {!valid && <div className="text-[13px] text-bad">ID 는 영문 소문자로 시작하는 2~24자여야 합니다.</div>}
          </Disclosure>
        </div>
      </Modal>
      <JobDialog
        jobId={job?.id ?? null}
        onClose={() => {
          const s = job?.slug;
          setJob(null);
          onClose();
          if (s) navigate(`/databases/${s}`);
        }}
      />
    </>
  );
}

export function Databases() {
  useTitle('데이터베이스');
  const { query } = useLocation();
  const live = useLive();
  const { data, loading } = useApi<DbSummary[]>('/api/databases', { refreshOn: ['databases', 'jobs'] });
  const creating = query.get('new') === '1';
  return (
    <div>
      <PageHeader
        title="데이터베이스"
        sub={data?.length ? `${data.length}개 · 실행 중 ${data.filter((d) => (live.units[`hrone-db-${d.slug}.service`] ?? d.status)?.state === 'running').length}개 · 백업은 매일 자동` : 'MariaDB · Redis. DB 마다 따로 실행되고 백업은 매일 자동으로 됩니다'}
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={16} />} onClick={() => setQuery('new', '1')}>
            DB 추가
          </Button>
        }
      />
      {loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <div className="card">
          <Empty icon={<Database />} title="데이터베이스가 없습니다" action={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setQuery('new', '1')}>DB 추가</Button>}>
            MariaDB 또는 Redis 를 만들고 앱에 연결하면 접속 정보가 환경변수로 자동으로 들어갑니다. 데이터는 앱을 배포해도 그대로 유지됩니다.
          </Empty>
        </div>
      ) : (
        <List>
          {data.map((d) => {
            const st = live.units[`hrone-db-${d.slug}.service`] ?? d.status;
            const status = d.job ? <Badge tone="blue">준비 중</Badge> : !d.initialized ? <Badge tone="red">초기화 실패</Badge> : <StatusBadge state={st?.state} />;
            const address = `${d.bind === 'local' ? '127.0.0.1' : d.bind === 'all' ? '0.0.0.0' : d.bind}:${d.port}`;
            const usage = st?.state === 'running' ? `CPU ${pct(st.cpu, 1)} · ${bytes(st.memory)}` : null;
            const apps = d.linkedApps.length ? d.linkedApps.map((a) => a.name).join(', ') : null;
            return (
              <Row
                key={d.slug}
                to={`/databases/${d.slug}`}
                icon={<DbIcon type={d.type} size={40} />}
                title={<span className="font-medium">{d.name}</span>}
                sub={
                  <span className="flex items-center gap-2">
                    {status}
                    <span className="truncate">
                      {d.type === 'mariadb' ? 'MariaDB' : 'Redis'} · {apps ? `앱: ${apps}` : '연결된 앱 없음'}
                    </span>
                  </span>
                }
                trailing={
                  <span className="hidden w-44 min-w-0 shrink-0 text-right md:block">
                    <span className="mono block truncate text-[13px] text-fg-2">{address}</span>
                    <span className="block truncate text-[12.5px] text-muted">{usage ?? ''}</span>
                  </span>
                }
              />
            );
          })}
        </List>
      )}
      <CreateDbModal open={creating} onClose={() => setQuery('new', null)} />
    </div>
  );
}
