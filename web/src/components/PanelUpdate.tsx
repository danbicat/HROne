import { Download, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { ago, dateTime } from '../lib/format';
import { Link } from '../lib/router';
import { useApi } from '../lib/store';
import { Badge, Button, Card, KV, Notice, Segmented, Toggle, cx, toast, useAction, useConfirm } from './ui';

interface Status {
  version: string;
  current: { sha: string; message: string; date: number | null };
  settings: { enabled: boolean; intervalHours: number };
  state: {
    lastCheckAt: number | null;
    lastResult: 'latest' | 'updating' | 'busy' | 'error' | null;
    message: string;
    pending: { from: string; to: string; at: number; by: string } | null;
    lastUpdate: { from: string; to: string; at: number; by: string } | null;
  };
  busy: string | null;
}

interface Check {
  available: boolean;
  local?: string;
  remote?: string;
  branch?: string;
  commits?: { sha: string; message: string; when: string }[];
  error?: string;
}

/** 설정 → 업데이트: 지금 버전, 수동 업데이트, 자동 업데이트 */
export function PanelUpdate() {
  const { data: st, reload } = useApi<Status>('/api/system/update/status');
  const [check, setCheck] = useState<Check | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const startSha = useRef<string | null>(null);
  const { busy, run } = useAction();
  const confirm = useConfirm();

  // 업데이트를 시작했으면 로그를 따라가다가, 새 버전으로 다시 켜지면 화면을 새로 불러온다
  const updating = log !== null || !!st?.state.pending;
  useEffect(() => {
    if (!updating) return;
    if (!startSha.current && st) startSha.current = st.current.sha;
    const t = setInterval(async () => {
      try {
        setLog((await api.get<{ log: string }>('/api/system/update/log')).log);
        const s = await api.get<Status>('/api/system/update/status');
        if (startSha.current && s.current.sha && s.current.sha !== startSha.current) {
          clearInterval(t);
          toast.ok(`업데이트했습니다 (${s.current.sha}). 새 화면을 불러옵니다`);
          setTimeout(() => location.reload(), 1200);
        }
      } catch {
        /* 패널 재시작 중 */
      }
    }, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updating]);

  if (!st) return null;
  const s = st.settings;
  const save = (v: Partial<Status['settings']>) =>
    run('save', async () => {
      await api.put('/api/system/update/settings', v);
      reload();
    }, v.enabled === false ? '자동 업데이트를 껐습니다' : '저장했습니다');

  const result = st.state.lastResult;
  return (
    <div className="space-y-9">
      <Card
        title="HROne 버전"
        footer={<>서버 터미널에서 <code className="mono">sudo hrone update</code>를 실행해도 업데이트할 수 있습니다.</>}
        actions={check?.available ? <Badge tone="blue">새 버전 있음</Badge> : null}
      >
        <div className="space-y-5 text-body">
          <KV
            items={[
              [
                '지금 버전',
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <span>v{st.version}</span>
                  <span className="mono">{st.current.sha}</span>
                  <span>{st.current.message}</span>
                  {st.current.date && <span className="text-muted">{dateTime(st.current.date)}</span>}
                </span>,
              ],
              ...(st.state.lastUpdate
                ? ([['마지막 업데이트', `${ago(st.state.lastUpdate.at)}, ${st.state.lastUpdate.from} → ${st.state.lastUpdate.to}, ${st.state.lastUpdate.by}`]] as [string, string][])
                : []),
            ]}
          />
          {st.busy && (
            <Notice tone="yellow" title="지금은 업데이트를 미룹니다">
              {st.busy}입니다. 업데이트하면 패널이 재시작되며 이 작업이 끊기므로, 끝난 뒤에 진행합니다.
            </Notice>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              icon={<RefreshCw size={15} />}
              loading={busy === 'c'}
              onClick={() =>
                run('c', async () => {
                  const r = await api.get<Check>('/api/system/update/check');
                  setCheck(r);
                  if (!r.available && !r.error) toast.ok('최신 버전입니다');
                })
              }
            >
              업데이트 확인
            </Button>
            {check?.available && (
              <Button
                variant="primary"
                icon={<Download size={15} />}
                loading={busy === 'u'}
                disabled={!!st.busy || updating}
                onClick={async () => {
                  if (!(await confirm({ title: 'HROne을 업데이트할까요?', body: '패널만 1~3분 동안 재시작되고, 앱과 DB 는 계속 실행됩니다.', confirm: '업데이트' }))) return;
                  run('u', async () => {
                    startSha.current = st.current.sha;
                    await api.post('/api/system/update');
                    setLog('');
                  }, '업데이트를 시작했습니다');
                }}
              >
                지금 업데이트 ({check.commits?.length}개)
              </Button>
            )}
          </div>
          {check?.error && <div className="text-body text-bad">{check.error}</div>}
          {check?.commits && check.commits.length > 0 && (
            <div className="rounded-control bg-fill/60 px-4">
              {check.commits.map((c, i) => (
                <div key={c.sha} className={cx('flex items-baseline gap-3 py-2.5 text-body', i > 0 && 'hairline-t')}>
                  <span className="mono shrink-0 text-footnote text-accent-2">{c.sha}</span>
                  <span className="min-w-0 flex-1 truncate">{c.message}</span>
                  <span className="shrink-0 text-footnote text-muted">{c.when}</span>
                </div>
              ))}
            </div>
          )}
          {log !== null && <pre className="console mono max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-control p-4 text-caption leading-[1.6]">{log || '시작하는 중...'}</pre>}
        </div>
      </Card>

      <Card title="자동 업데이트">
        <div className="space-y-5 text-body">
          <Toggle checked={s.enabled} onChange={(v) => save({ enabled: v })} label="GitHub 에 새 버전이 올라오면 자동으로 업데이트" sub="dariring/HROne 저장소를 정해진 주기마다 확인합니다" />
          {s.enabled && (
            <div className="hairline-t flex flex-wrap items-center justify-between gap-3 pt-4">
              <span>확인 주기</span>
              <Segmented
                value={String(s.intervalHours)}
                onChange={(v) => save({ intervalHours: Number(v) })}
                options={[
                  { value: '1', label: '1시간' },
                  { value: '6', label: '6시간' },
                  { value: '24', label: '하루' },
                ]}
              />
            </div>
          )}
          <ul className="hairline-t list-disc space-y-1.5 pl-5 pt-4 text-footnote text-fg-2">
            <li>업데이트해도 앱과 DB 는 꺼지지 않습니다. 각자 별도 서비스라 패널만 재시작됩니다.</li>
            <li>배포나 백업이 진행 중이면 끊기지 않도록 끝난 뒤에 업데이트합니다.</li>
            <li>
              <Link to="/settings?tab=connect" className="text-accent-2 hover:underline">
                연결 설정
              </Link>
              에 디스코드 웹후크를 넣어 두면 업데이트의 시작, 완료, 실패를 알려 줍니다.
            </li>
          </ul>
          {s.enabled && (
            <div className="flex flex-wrap gap-x-3 text-footnote text-muted">
              <span>{st.state.lastCheckAt ? `마지막 확인 ${ago(st.state.lastCheckAt)}` : '아직 확인하지 않았습니다. 패널이 켜지고 몇 분 뒤 처음 확인합니다'}</span>
              <span className={result === 'error' ? 'text-bad' : result === 'busy' ? 'text-warn' : ''}>{st.state.message || '-'}</span>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
