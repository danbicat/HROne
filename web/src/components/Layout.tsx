import { Boxes, Database, House, LogOut, Search, Server, Settings, ShieldCheck, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { Link, useLocation } from '../lib/router';
import { useApi, useSocketUp } from '../lib/store';
import { CommandPalette } from './CommandPalette';
import { BarSlot, SearchOpen, cx } from './ui';

// 자주 쓰는 메뉴만 위에 두고, 서버 관리는 아래로 뺀다.
// 예전 메뉴(백업, 활동 기록)는 서버 / 설정 안의 탭이 됐다.
type NavItem = { to: string; label: string; short?: string; icon: typeof House; exact?: boolean; also?: string[] };
const NAV: NavItem[] = [
  { to: '/', label: '홈', icon: House, exact: true },
  { to: '/apps', label: '앱', icon: Boxes },
  { to: '/databases', label: '데이터베이스', short: 'DB', icon: Database },
];
const NAV_MANAGE: NavItem[] = [
  { to: '/system', label: '서버', icon: Server, also: ['/backups'] },
  { to: '/settings', label: '설정', icon: Settings, also: ['/audit'] },
];

export interface Me {
  username: string;
  totpEnabled: boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function Layout({ me, children }: { me: Me; children: ReactNode }) {
  const { path } = useLocation();
  const up = useSocketUp();
  const { data: open_ } = useApi<{ status: string }[]>('/api/deploys/open', { refreshOn: ['deploys'] });
  const pending = (open_ ?? []).filter((d) => d.status === 'pending').length;
  const { data: info } = useApi<{ hostname: string; virtualization: string }>('/api/system/info');
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [search, setSearch] = useState(false);
  const openSearch = useCallback(() => setSearch(true), []);

  // ⌘K / Ctrl+K 로 어디서든 검색
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch((s) => !s);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isActive = (n: NavItem) => (n.exact ? path === n.to : [n.to, ...(n.also ?? [])].some((p) => path === p || path.startsWith(p + '/')));

  const sideItem = (n: NavItem) => {
    const active = isActive(n);
    const Icon = n.icon;
    return (
      <Link
        key={n.to}
        to={n.to}
        aria-current={active ? 'page' : undefined}
        className={cx(
          'flex items-center gap-2.5 rounded-tile px-2.5 py-[7px] text-body transition-colors',
          active ? 'bg-accent font-medium text-white' : 'text-fg hover:bg-fill',
        )}
      >
        <Icon size={17} strokeWidth={2} className={active ? 'text-white' : 'text-accent-2'} />
        {n.label}
        {n.to === '/apps' && pending > 0 && (
          <span
            className={cx('ml-auto min-w-5 rounded-full px-1.5 text-center text-caption font-semibold leading-5', active ? 'bg-white/25 text-white' : 'bg-warn-dot text-white')}
            title="승인을 기다리는 배포"
          >
            {pending}
          </span>
        )}
      </Link>
    );
  };

  const tabItem = (n: NavItem) => {
    const active = isActive(n);
    const Icon = n.icon;
    return (
      <Link
        key={n.to}
        to={n.to}
        aria-current={active ? 'page' : undefined}
        className={cx('relative flex flex-1 flex-col items-center gap-[3px] pb-1 pt-[7px] text-caption font-medium transition-colors', active ? 'text-accent' : 'text-muted')}
      >
        <span className="relative">
          <Icon size={23} strokeWidth={active ? 2.2 : 1.8} />
          {n.to === '/apps' && pending > 0 && (
            <span className="absolute -right-2.5 -top-1 min-w-[17px] rounded-full bg-bad-dot px-1 text-center text-caption font-semibold leading-[17px] text-white">{pending}</span>
          )}
        </span>
        {n.short ?? n.label}
      </Link>
    );
  };

  return (
    <SearchOpen.Provider value={openSearch}>
      <BarSlot.Provider value={bar}>
        <div className="min-h-dvh">
          {/* 데스크톱: macOS 설정 앱 같은 반투명 사이드바 */}
          <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col border-r border-line bg-sidebar backdrop-blur-2xl backdrop-saturate-150 lg:flex">
            <Link to="/" className="flex items-center gap-2.5 px-5 pb-3 pt-5">
              <img src="/favicon.svg" className="h-8 w-8" alt="" />
              <div className="min-w-0">
                <div className="text-body font-semibold leading-tight">HROne</div>
                <div className="truncate text-caption text-muted">{info?.hostname ?? ''}</div>
              </div>
            </Link>
            <div className="px-3 pb-3">
              <button
                type="button"
                onClick={openSearch}
                className="flex h-8 w-full items-center gap-2 rounded-control bg-fill px-2.5 text-footnote text-muted transition-colors hover:bg-fill-2 cursor-pointer"
              >
                <Search size={14} />
                검색
                <kbd className="ml-auto font-sans text-caption text-muted/80">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
              </button>
            </div>
            <nav className="flex flex-col gap-0.5 px-3">
              {NAV.map(sideItem)}
              <div className="px-2.5 pb-1 pt-5 text-caption font-semibold text-muted">관리</div>
              {NAV_MANAGE.map(sideItem)}
            </nav>
            <div className="mt-auto flex items-center gap-2.5 px-4 py-4">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fill-2 text-footnote font-semibold text-fg-2">{me.username.slice(0, 1).toUpperCase()}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 truncate text-footnote font-medium">
                  {me.username}
                  {me.totpEnabled && <ShieldCheck size={12} className="shrink-0 text-ok" aria-label="2단계 인증 켜짐" />}
                </div>
                <div className="flex items-center gap-1.5 text-caption text-muted">
                  <span className={cx('h-1.5 w-1.5 rounded-full', up ? 'bg-ok-dot' : 'bg-bad-dot pulse')} />
                  {up ? '연결됨' : '재연결 중'}
                </div>
              </div>
              <button
                type="button"
                title="로그아웃"
                aria-label="로그아웃"
                className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-fill hover:text-fg cursor-pointer"
                onClick={async () => {
                  await api.post('/api/auth/logout');
                  location.href = '/';
                }}
              >
                <LogOut size={16} />
              </button>
            </div>
          </aside>

          <main className="lg:pl-[248px]">
            {/* 각 화면의 PageHeader 가 여기에 위 막대를 그린다 */}
            <div ref={setBar} className="sticky top-0 z-30 pt-[env(safe-area-inset-top)]" />
            {!up && (
              <div className="fade-in mx-auto mt-2 flex max-w-[1180px] px-4 sm:px-6 lg:px-10">
                <div className="flex items-center gap-2 rounded-full bg-warn/12 px-3 py-1.5 text-footnote font-medium text-warn">
                  <WifiOff size={14} />
                  서버와 다시 연결하는 중입니다
                </div>
              </div>
            )}
            <div className="pb-tabbar mx-auto max-w-[1180px] px-4 sm:px-6 lg:px-10">{children}</div>
          </main>

          {/* 폰 · 태블릿: iOS 탭바 */}
          <nav className="chrome hairline-t fixed inset-x-0 bottom-0 z-40 flex pb-[env(safe-area-inset-bottom)] lg:hidden">
            {[...NAV, ...NAV_MANAGE].map(tabItem)}
          </nav>

          <CommandPalette open={search} onClose={() => setSearch(false)} />
        </div>
      </BarSlot.Provider>
    </SearchOpen.Provider>
  );
}
