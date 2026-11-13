import { Boxes, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { AppMenu, AppPower, DomainLink, modeText } from '../components/shared';
import { Badge, Button, Empty, ErrorBox, List, Loading, PageHeader, Row, StatusBadge, cx } from '../components/ui';
import { ago, bytes, pct, sha } from '../lib/format';
import { navigate, useTitle } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import { RuntimeIcon, type AppSummary } from './Dashboard';

export function Apps() {
  useTitle('앱');
  const live = useLive();
  const { data, error, loading, reload } = useApi<AppSummary[]>('/api/apps', { refreshOn: ['apps', 'deploys'] });
  const [q, setQ] = useState('');
  const list = (data ?? []).filter((a) => !q || `${a.name} ${a.slug} ${a.repoUrl}`.toLowerCase().includes(q.toLowerCase()));
  const stateOf = (a: AppSummary) => (a.deployedSha ? (live.units[`hrone-app-${a.slug}.service`] ?? a.status)?.state : 'not-deployed');
  const running = (data ?? []).filter((a) => stateOf(a) === 'running').length;

  return (
    <div>
      <PageHeader
        title="앱"
        sub={data?.length ? `${data.length}개 중 ${running}개 실행 중` : 'GitHub에 푸시하면 자동으로 배포되는 Node.js, Python 앱'}
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/apps/new')}>
            앱 추가
          </Button>
        }
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <div className="card">
          <Empty icon={<Boxes />} title="아직 앱이 없습니다" action={<Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/apps/new')}>앱 추가</Button>}>
            GitHub 저장소 주소만 넣으면 실행 방법을 알아서 찾고, 이후 푸시할 때마다 자동으로 배포합니다.
          </Empty>
        </div>
      ) : (
        <>
          {data.length > 4 && (
            <div className="relative mb-5 max-w-md">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input className="input pl-9" placeholder="검색" aria-label="앱 검색" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          {list.length === 0 ? (
            <div className="card px-5 py-10 text-center text-body text-muted">"{q}"에 맞는 앱이 없습니다. 검색어를 바꿔 보세요.</div>
          ) : (
            <List>
              {list.map((a) => (
                <AppRow key={a.slug} a={a} st={live.units[`hrone-app-${a.slug}.service`] ?? a.status} />
              ))}
            </List>
          )}
        </>
      )}
    </div>
  );
}

function AppRow({ a, st }: { a: AppSummary; st: AppSummary['status'] }) {
  const state = a.deployedSha ? st?.state : 'not-deployed';
  const usage =
    st?.state === 'running' ? (
      <span className="flex justify-end gap-x-3">
        <span>CPU {pct(st.cpu, 1)}</span>
        <span>{bytes(st.memory)}</span>
      </span>
    ) : null;
  const local = a.port ? `127.0.0.1:${a.port}` : '포트 없음';
  // 지금 눈여겨볼 배포 상태가 있으면 그것을, 없으면 마지막 배포 시각
  const deploy =
    a.openDeploy?.status === 'pending' ? (
      <Badge tone="yellow">승인 대기</Badge>
    ) : a.openDeploy?.status === 'scheduled' ? (
      <Badge tone="blue">배포 예약됨</Badge>
    ) : a.busy ? (
      <Badge tone="purple">배포 중</Badge>
    ) : a.lastPollError ? (
      <Badge tone="red">저장소 확인 실패</Badge>
    ) : null;
  const repo = a.repoUrl.replace(/^https?:\/\/(github\.com\/)?|^git@github\.com:|\.git$/g, '');

  return (
    <Row
      to={`/apps/${a.slug}`}
      icon={<RuntimeIcon runtime={a.runtime} size={40} />}
      title={
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{a.name}</span>
          {deploy}
        </span>
      }
      sub={
        <span className="flex min-w-0 items-center gap-2">
          <StatusBadge state={state} />
          {/* 공개 주소는 누르면 바로 그 사이트로 */}
          {a.publicUrl && <DomainLink url={a.publicUrl} className="md:max-w-[60%] md:shrink-0" />}
          {/* 폰에서는 도메인이 다 보이게 저장소 이름을 숨긴다 */}
          <span className={cx('flex min-w-0 gap-x-3', a.publicUrl && 'max-md:hidden')}>
            <span className="truncate">{repo}</span>
            <span className="shrink-0">{a.branch}</span>
          </span>
        </span>
      }
      trailing={
        <span className="flex shrink-0 items-center" onClick={(e) => e.preventDefault()}>
          <span className="md:hidden">
            <AppMenu slug={a.slug} name={a.name} state={st?.state} deployed={!!a.deployedSha} publicUrl={a.publicUrl || undefined} />
          </span>
          <span className="hidden shrink-0 items-center gap-6 md:flex">
            <span className="hidden w-44 min-w-0 text-right lg:block">
              <span className="block truncate text-footnote text-fg-2">{local}</span>
              <span className="block truncate text-caption text-muted">{usage ?? (a.autostart ? '' : '자동 시작 꺼짐')}</span>
            </span>
            <span className="hidden w-36 min-w-0 text-right xl:block">
              <span className="flex justify-end gap-x-3 truncate text-footnote text-fg-2">
                {a.deployedAt ? (
                  <>
                    <span>{ago(a.deployedAt)}</span>
                    <span className="mono">{sha(a.deployedSha)}</span>
                  </>
                ) : (
                  '배포 전'
                )}
              </span>
              <span className="block truncate text-caption text-muted">{modeText(a.deployMode, a.deployDelaySec)}</span>
            </span>
            <span className="flex items-center gap-1">
              <AppPower slug={a.slug} name={a.name} state={st?.state} deployed={!!a.deployedSha} />
            </span>
          </span>
        </span>
      }
    />
  );
}
