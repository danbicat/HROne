import {
  Archive,
  Bell,
  Boxes,
  CornerDownLeft,
  Database,
  FileClock,
  Globe,
  House,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCw,
  Search,
  Server,
  SlidersHorizontal,
  Square,
  SquareTerminal,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AppSummary, DbSummary } from '../pages/Dashboard';
import { api, errorText } from '../lib/api';
import { josa } from '../lib/format';
import { navigate } from '../lib/router';
import { useLive } from '../lib/store';
import { cx, toast, useConfirm } from './ui';

interface Item {
  id: string;
  group: '이동' | '앱' | '데이터베이스' | '동작';
  label: string;
  sub?: string;
  icon: ReactNode;
  /** 검색에 같이 쓰는 말 */
  keys?: string;
  /** 검색어가 있을 때만 보인다 */
  onlyOnSearch?: boolean;
  run: () => void | Promise<void>;
}

const PAGES: { label: string; to: string; icon: ReactNode; keys: string }[] = [
  { label: '홈', to: '/', icon: <House size={15} />, keys: 'home dashboard 대시보드' },
  { label: '앱', to: '/apps', icon: <Boxes size={15} />, keys: 'apps 앱 목록' },
  { label: '앱 추가', to: '/apps/new', icon: <Plus size={15} />, keys: 'new app deploy 새 앱 만들기' },
  { label: '데이터베이스', to: '/databases', icon: <Database size={15} />, keys: 'db database mariadb redis' },
  { label: 'DB 추가', to: '/databases?new=1', icon: <Plus size={15} />, keys: 'new database mariadb redis 새 데이터베이스' },
  { label: '서버 상태', to: '/system', icon: <Server size={15} />, keys: 'system cpu memory disk 서버 메모리 디스크' },
  { label: '백업', to: '/system?tab=backups', icon: <Archive size={15} />, keys: 'backup restore 복원' },
  { label: '서버 고급 설정', to: '/system?tab=advanced', icon: <SlidersHorizontal size={15} />, keys: 'swap timezone tailscale cloudflared 스왑 시간대' },
  { label: '내 계정', to: '/settings', icon: <KeyRound size={15} />, keys: 'account password otp 2fa 비밀번호 계정 설정' },
  { label: '연결', to: '/settings?tab=connect', icon: <Bell size={15} />, keys: 'github token discord webhook 토큰 디스코드 알림 github discord' },
  { label: '패널 접속', to: '/settings?tab=access', icon: <Globe size={15} />, keys: 'access ip users 사용자 접속' },
  { label: '업데이트', to: '/settings?tab=update', icon: <RefreshCw size={15} />, keys: 'update version 버전' },
  { label: '활동 기록', to: '/settings?tab=audit', icon: <FileClock size={15} />, keys: 'audit log history 기록' },
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [dbs, setDbs] = useState<DbSummary[]>([]);
  const live = useLive();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    api.get<AppSummary[]>('/api/apps').then(setApps).catch(() => {});
    api.get<DbSummary[]>('/api/databases').then(setDbs).catch(() => {});
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => input.current?.focus());
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => {
      onClose();
      navigate(to);
    };
    const out: Item[] = PAGES.map((p) => ({ id: `p:${p.to}`, group: '이동', label: p.label, icon: p.icon, keys: p.keys, run: go(p.to) }));
    for (const a of apps) {
      const st = live.units[`hrone-app-${a.slug}.service`] ?? a.status;
      const on = st?.state === 'running' || st?.state === 'starting' || st?.state === 'restarting';
      out.push({ id: `a:${a.slug}`, group: '앱', label: a.name, sub: a.slug, icon: <Boxes size={15} />, keys: `${a.slug} ${a.repoUrl}`, run: go(`/apps/${a.slug}`) });
      out.push({ id: `a:${a.slug}:log`, group: '앱', label: `${a.name} 로그`, icon: <SquareTerminal size={15} />, keys: `${a.slug} log console 콘솔`, onlyOnSearch: true, run: go(`/apps/${a.slug}?tab=console`) });
      if (!a.deployedSha) continue;
      const act = (action: string, done: string) => async () => {
        onClose();
        try {
          await api.post(`/api/apps/${a.slug}/action`, { action });
          toast.ok(`${a.name}: ${done}`);
        } catch (e) {
          toast.error(errorText(e));
        }
      };
      out.push({ id: `x:${a.slug}:restart`, group: '동작', label: `${a.name} 재시작`, icon: <RotateCw size={15} />, keys: `${a.slug} restart`, onlyOnSearch: true, run: act('restart', '재시작했습니다') });
      if (on)
        out.push({
          id: `x:${a.slug}:stop`,
          group: '동작',
          label: `${a.name} 정지`,
          icon: <Square size={14} />,
          keys: `${a.slug} stop`,
          onlyOnSearch: true,
          run: async () => {
            onClose();
            if (await confirm({ title: `${josa(a.name, '을', '를')} 정지할까요?`, body: '자동 배포는 새 코드를 받아 두기만 하고 앱을 시작하지 않습니다.', confirm: '정지' })) await act('stop', '정지했습니다')();
          },
        });
      else out.push({ id: `x:${a.slug}:start`, group: '동작', label: `${a.name} 시작`, icon: <Play size={15} />, keys: `${a.slug} start`, onlyOnSearch: true, run: act('start', '시작했습니다') });
      out.push({
        id: `x:${a.slug}:deploy`,
        group: '동작',
        label: `${a.name} 지금 배포`,
        sub: '최신 커밋을 받아 다시 배포합니다',
        icon: <Rocket size={15} />,
        keys: `${a.slug} deploy redeploy 재배포`,
        onlyOnSearch: true,
        run: async () => {
          onClose();
          try {
            const r = await api.post<{ id: number }>(`/api/apps/${a.slug}/deploy`, {});
            toast.ok(`${a.name}: 배포를 시작했습니다`);
            navigate(`/apps/${a.slug}?tab=deploys&deploy=${r.id}`);
          } catch (e) {
            toast.error(errorText(e));
          }
        },
      });
    }
    for (const d of dbs) {
      out.push({
        id: `d:${d.slug}`,
        group: '데이터베이스',
        label: d.name,
        sub: `${d.type === 'mariadb' ? 'MariaDB' : 'Redis'}, 포트 ${d.port}`,
        icon: <Database size={15} />,
        keys: `${d.slug} ${d.type}`,
        run: go(`/databases/${d.slug}`),
      });
    }
    return out;
  }, [apps, dbs, live.units, onClose, confirm]);

  const shown = useMemo(() => {
    const n = norm(q);
    if (!n) return items.filter((i) => !i.onlyOnSearch);
    const scored = items
      .map((i) => {
        const label = norm(i.label);
        const all = label + norm(i.sub ?? '') + norm(i.keys ?? '');
        const score = label.startsWith(n) ? 3 : label.includes(n) ? 2 : all.includes(n) ? 1 : 0;
        return { i, score };
      })
      .filter((x) => x.score > 0);
    // 같은 묶음끼리 모아 두되, 묶음 안에서는 잘 맞는 것부터
    const order = ['앱', '데이터베이스', '동작', '이동'];
    scored.sort((a, b) => order.indexOf(a.i.group) - order.indexOf(b.i.group) || b.score - a.score);
    return scored.map((x) => x.i);
  }, [items, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(shown.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      // 한글 조합을 끝내는 Enter 는 넘긴다 (Safari 는 isComposing 대신 keyCode 229 로 온다)
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      void shown[sel]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = '';
  return createPortal(
    <div className="fade-in fixed inset-0 z-[58] flex items-start justify-center bg-backdrop px-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="검색" className="toast-in flex max-h-[min(560px,80dvh)] w-full max-w-[620px] flex-col overflow-hidden rounded-sheet bg-surface shadow-pop" onKeyDown={onKey}>
        <div className="hairline-b flex items-center gap-3 px-4">
          <Search size={20} className="shrink-0 text-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="앱, 데이터베이스, 메뉴 또는 동작 검색"
            className="h-14 min-w-0 flex-1 bg-transparent text-headline font-normal outline-none placeholder:text-muted/70"
            aria-label="검색어"
          />
          <kbd className="hidden rounded-tile bg-fill px-1.5 py-0.5 font-sans text-caption text-muted sm:block">esc</kbd>
        </div>
        <div ref={listRef} className="overflow-y-auto overscroll-contain px-2 pb-2">
          {shown.length === 0 && <div className="px-3 py-10 text-center text-body text-muted">"{q}"에 맞는 항목이 없습니다. 앱 이름, 메뉴 이름 또는 동작으로 검색하세요</div>}
          {shown.map((it, idx) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            const active = idx === sel;
            return (
              <div key={it.id}>
                {head && <div className="px-3 pb-1 pt-3 text-caption font-semibold text-muted">{head}</div>}
                <button
                  type="button"
                  data-idx={idx}
                  onMouseMove={() => setSel(idx)}
                  onClick={() => void it.run()}
                  className={cx('flex w-full items-center gap-3 rounded-control px-3 py-2 text-left cursor-pointer', active ? 'bg-accent text-white' : 'text-fg')}
                >
                  <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-tile', active ? 'bg-white/20 text-white' : 'bg-fill text-fg-2')}>{it.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-body">{it.label}</span>
                  {it.sub && <span className={cx('hidden shrink-0 truncate text-footnote sm:block', active ? 'text-white/75' : 'text-muted')}>{it.sub}</span>}
                  {active && <CornerDownLeft size={14} className="shrink-0 text-white/80" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
