import { Archive, Download, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { JobDialog, ReauthDialog } from '../components/Dialogs';
import type { Me } from '../components/Layout';
import { Badge, Empty, IconButton, Loading, Segmented, cx, toast, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { bytes, dateTime, josa } from '../lib/format';
import { Link } from '../lib/router';
import { useApi } from '../lib/store';

export interface Backup {
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

const TRIG: Record<Backup['trigger'], string> = { manual: '수동', schedule: '예약', predeploy: '배포 전', terminate: '삭제 전 최종' };

export function BackupList({ list, me, reload, showTarget }: { list: Backup[]; me: Me; reload: () => void; showTarget?: boolean }) {
  const confirm = useConfirm();
  const [restore, setRestore] = useState<Backup | null>(null);
  const [job, setJob] = useState<number | null>(null);
  if (!list.length)
    return (
      <div className="card">
        <Empty icon={<Archive size={22} />} title="백업이 없습니다">
          자동 백업이나 지금 백업으로 만든 백업이 여기에 나옵니다.
        </Empty>
      </div>
    );
  return (
    <>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[680px] text-body">
          <thead>
            <tr className="text-left text-caption font-semibold text-muted">
              <th className="py-2.5 pl-5 pr-3 font-semibold">시각</th>
              {showTarget && <th className="px-3 py-2.5 font-semibold">대상</th>}
              <th className="px-3 py-2.5 font-semibold">종류</th>
              <th className="px-3 py-2.5 font-semibold">크기</th>
              <th className="px-3 py-2.5 font-semibold">상태</th>
              <th className="py-2.5 pl-3 pr-4" />
            </tr>
          </thead>
          <tbody>
            {list.map((b) => (
              <tr key={b.id} className="hairline-t transition-colors hover:bg-fill/50">
                <td className="whitespace-nowrap py-3 pl-5 pr-3 text-footnote tabular-nums text-fg-2">{dateTime(b.created_at)}</td>
                {showTarget && (
                  <td className="whitespace-nowrap px-3 py-3">
                    <Link to={b.kind === 'app' ? `/apps/${b.target_slug}?tab=settings` : `/databases/${b.target_slug}?tab=backups`} className="font-medium text-fg hover:text-accent-2">
                      {b.target_slug}
                    </Link>{' '}
                    <span className="text-footnote text-muted">{b.kind === 'app' ? '앱' : 'DB'}</span>
                  </td>
                )}
                <td className="px-3 py-3">
                  {b.trigger === 'terminate' ? <Badge tone="yellow">{TRIG[b.trigger]}</Badge> : <span className="text-fg-2">{TRIG[b.trigger]}</span>}
                  {b.note && b.status !== 'failed' && <span className="ml-2 text-footnote text-muted">{b.note}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-fg-2">{b.status === 'done' ? bytes(b.size) : '-'}</td>
                <td className="px-3 py-3">
                  <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap text-footnote font-medium', b.status === 'failed' ? 'text-bad' : 'text-fg-2')}>
                    <span className={cx('h-2 w-2 rounded-full', b.status === 'done' ? 'bg-ok-dot' : b.status === 'running' ? 'bg-accent pulse' : 'bg-bad-dot')} />
                    {b.status === 'done' ? '완료' : b.status === 'running' ? '진행 중' : '실패'}
                  </span>
                  {b.status === 'failed' && b.note && <div className="mt-1 max-w-xs truncate text-caption text-bad" title={b.note}>{b.note}</div>}
                </td>
                <td className="py-2 pl-3 pr-4">
                  <div className="flex items-center justify-end gap-0.5">
                    {b.status === 'done' && (
                      <>
                        <a href={`/api/backups/${b.id}/download`} className="mr-1 inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full bg-fill px-3 text-footnote font-medium text-fg transition-colors hover:bg-fill-2">
                          <Download size={14} />
                          내려받기
                        </a>
                        <IconButton title="복원" onClick={() => setRestore(b)}>
                          <RotateCcw size={15} />
                        </IconButton>
                      </>
                    )}
                    <IconButton
                      title="삭제"
                      onClick={async () => {
                        if (!(await confirm({ title: `${dateTime(b.created_at)} 백업을 삭제할까요?`, body: '백업 파일이 지워지며 되돌릴 수 없습니다.', confirm: '삭제', danger: true }))) return;
                        try {
                          await api.del(`/api/backups/${b.id}`);
                          toast.ok('삭제했습니다');
                          reload();
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ReauthDialog
        open={!!restore}
        onClose={() => setRestore(null)}
        title={restore ? `${josa(restore.target_slug, '을', '를')} 복원할까요?` : '백업 복원'}
        danger
        confirmLabel="복원"
        needTotp={me.totpEnabled}
        body={
          restore && (
            <>
              <b className="text-fg">{dateTime(restore.created_at)}</b> 백업 시점으로 되돌립니다.{' '}
              {restore.kind === 'database' ? 'DB는 복원하는 동안 잠깐 멈추거나 느려질 수 있습니다.' : '백업에 들어 있는 파일을 덮어씁니다.'} 복원 직전 상태는 자동으로 한 번 더 백업됩니다.
            </>
          )
        }
        onConfirm={async (auth) => {
          const r = await api.post<{ jobId: number }>(`/api/backups/${restore!.id}/restore`, auth);
          setJob(r.jobId);
        }}
      />
      <JobDialog jobId={job} onClose={() => setJob(null)} onDone={reload} />
    </>
  );
}

/** 서버 → 백업 탭: 모든 앱/DB 의 백업 */
export function BackupsPanel({ me }: { me: Me }) {
  const [kind, setKind] = useState<'all' | 'database' | 'app'>('all');
  const { data, loading, reload } = useApi<Backup[]>('/api/backups', { refreshOn: ['backups'] });
  const list = (data ?? []).filter((b) => kind === 'all' || b.kind === kind);
  const total = list.filter((b) => b.status === 'done').reduce((a, b) => a + b.size, 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="max-w-2xl text-body text-muted">
          <p>DB는 매일 04:00에 자동으로 백업하고 7개를 보관합니다. 앱 데이터(SQLite 등)의 백업은 각 앱의 설정 탭에서 켤 수 있습니다.</p>
          <p className="mt-1 text-footnote">합계 {bytes(total)}</p>
        </div>
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: '전체' },
            { value: 'database', label: 'DB' },
            { value: 'app', label: '앱' },
          ]}
        />
      </div>
      {loading && !data ? <Loading /> : <BackupList list={list} me={me} reload={reload} showTarget />}
    </div>
  );
}
