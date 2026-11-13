import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Copy, Eye, EyeOff, Info, Loader2, Search, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from '../lib/router';
import type { RunState } from '../lib/store';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

// ---------- 버튼 ----------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'warn' | 'plain';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:brightness-110 active:brightness-95',
  secondary: 'bg-fill text-fg hover:bg-fill-2',
  ghost: 'bg-transparent text-fg-2 hover:bg-fill hover:text-fg',
  plain: 'bg-transparent text-accent-2 hover:bg-accent/10',
  danger: 'bg-bad/10 text-bad hover:bg-bad/15',
  success: 'bg-ok/12 text-ok hover:bg-ok/18',
  warn: 'bg-warn/12 text-warn hover:bg-warn/18',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition-[background-color,filter,opacity] duration-150 select-none whitespace-nowrap',
        'disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer',
        size === 'sm' ? 'h-8 px-3.5 text-[13px]' : size === 'lg' ? 'h-11 px-6 text-[15px]' : 'h-9 px-4 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'sm' ? 14 : 16} className="spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ title, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={cx('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-fill hover:text-fg cursor-pointer disabled:opacity-40', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------- 페이지 머리 (큰 제목 → 스크롤하면 위 막대의 작은 제목) ----------

/** Layout 이 꽂아 주는 위 막대 자리. PageHeader 가 여기에 포털로 그린다 */
export const BarSlot = createContext<HTMLElement | null>(null);
/** ⌘K 검색 열기 (Layout 이 넣어 준다) */
export const SearchOpen = createContext<() => void>(() => {});

export function PageHeader({
  title,
  sub,
  actions,
  icon,
  back,
  barTitle,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  /** 위 막대 왼쪽의 "‹ 앱" 같은 돌아가기 */
  back?: { to: string; label: string };
  /** 작은 제목을 따로 줄 때 (기본은 title) */
  barTitle?: ReactNode;
}) {
  const slot = useContext(BarSlot);
  const openSearch = useContext(SearchOpen);
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 큰 제목이 막대 밑으로 다 들어가면 막대에 작은 제목을 띄운다
    const io = new IntersectionObserver(([e]) => setCompact(!e!.isIntersecting), { rootMargin: '-56px 0px 0px 0px', threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const bar = (
    <div className={cx('transition-[background-color,box-shadow] duration-200', compact ? 'chrome hairline-b' : 'bg-transparent')}>
      <div className="relative mx-auto flex h-[52px] max-w-[1180px] items-center gap-2 px-4 sm:px-6 lg:px-10">
        <div className="flex min-w-0 flex-1 items-center">
          {back && (
            <Link to={back.to} className="-ml-2 flex min-w-0 items-center rounded-full py-1 pr-2 text-[16px] text-accent-2 transition-opacity hover:opacity-70">
              <ChevronLeft size={24} strokeWidth={2.2} className="shrink-0" />
              <span className="truncate">{back.label}</span>
            </Link>
          )}
        </div>
        <div
          aria-hidden={!compact}
          className={cx(
            'pointer-events-none absolute left-1/2 max-w-[46%] -translate-x-1/2 truncate text-[15px] font-semibold transition-all duration-200',
            compact ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
          )}
        >
          {barTitle ?? title}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          <IconButton title="검색 (⌘K)" onClick={openSearch} className="text-accent-2 hover:text-accent-2 lg:hidden">
            <Search size={19} />
          </IconButton>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {slot && createPortal(bar, slot)}
      <div ref={ref} className="mb-7 flex min-w-0 items-center gap-4 pt-1">
        {icon && <div className="shrink-0">{icon}</div>}
        <div className="min-w-0">
          <h1 className="truncate text-[30px] font-bold leading-tight tracking-[-0.025em] sm:text-[34px]">{title}</h1>
          {sub && <div className="mt-1 text-[15px] text-muted">{sub}</div>}
        </div>
      </div>
    </>
  );
}

// ---------- 그룹 목록 (iOS 설정 앱 모양) ----------

/** 제목은 칸 바깥 위에, 내용은 둥근 흰 칸 안에 */
export function Card({ children, className, title, actions, pad = true, footer }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; pad?: boolean; footer?: ReactNode }) {
  return (
    <section className={cx('min-w-0', className)}>
      {(title || actions) && <SectionHeader title={title} actions={actions} />}
      <div className={cx('card', pad ? 'p-5' : 'overflow-hidden')}>{children}</div>
      {footer && <div className="hint px-4">{footer}</div>}
    </section>
  );
}

export function SectionHeader({ title, actions }: { title?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-2 flex min-h-7 items-end justify-between gap-3 px-1">
      <h2 className="min-w-0 text-[17px] font-semibold tracking-[-0.015em]">{title}</h2>
      {actions && <div className="flex shrink-0 items-center gap-2 text-[13px]">{actions}</div>}
    </header>
  );
}

/** 구분선이 들어간 목록 칸. Row 를 넣는다 */
export function List({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('card overflow-hidden', className)}>{children}</div>;
}

/**
 * 목록의 한 줄: [아이콘] 제목/부제 ··· 값 [›]
 * to 를 주면 링크, onClick 을 주면 버튼이 된다
 */
export function Row({
  icon,
  title,
  sub,
  value,
  trailing,
  to,
  href,
  onClick,
  chevron,
  className,
  danger,
}: {
  icon?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  value?: ReactNode;
  trailing?: ReactNode;
  to?: string;
  href?: string;
  onClick?: () => void;
  chevron?: boolean;
  className?: string;
  danger?: boolean;
}) {
  const interactive = !!(to || href || onClick);
  const inner = (
    <>
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="row-body flex min-h-[48px] min-w-0 flex-1 items-center gap-3 self-stretch py-2.5 pr-4">
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate text-[15px] leading-snug', danger ? 'text-bad' : 'text-fg')}>{title}</span>
          {sub && <span className="mt-0.5 block truncate text-[13px] leading-snug text-muted">{sub}</span>}
        </span>
        {value !== undefined && <span className="max-w-[55%] shrink-0 truncate text-right text-[15px] text-muted">{value}</span>}
        {trailing}
        {(chevron ?? (interactive && !href)) && <ChevronRight size={17} strokeWidth={2.4} className="shrink-0 text-muted/50" />}
      </span>
    </>
  );
  const cls = cx(
    'row group relative flex w-full items-center gap-3 pl-4 text-left',
    interactive && 'cursor-pointer transition-colors hover:bg-fill/60 active:bg-fill',
    className,
  );
  if (to)
    return (
      <Link to={to} className={cls}>
        {inner}
      </Link>
    );
  if (href)
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {inner}
      </a>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cls}>
        {inner}
      </button>
    );
  return <div className={cls}>{inner}</div>;
}

/** 목록 왼쪽의 둥근 사각 아이콘 (설정 앱 아이콘처럼 한 가지 색) */
export function IconTile({ children, tone = 'accent', size = 30 }: { children: ReactNode; tone?: 'accent' | 'gray' | 'ok' | 'warn' | 'bad'; size?: number }) {
  const bg = { accent: 'bg-accent text-white', gray: 'bg-fill-2 text-fg-2', ok: 'bg-ok-dot text-white', warn: 'bg-warn-dot text-white', bad: 'bg-bad-dot text-white' }[tone];
  return (
    <span className={cx('flex shrink-0 items-center justify-center rounded-[8px]', bg)} style={{ width: size, height: size }}>
      {children}
    </span>
  );
}

/** 접었다 펼 수 있는 칸. 닫혀 있을 때는 제목과 한 줄 요약만 보인다 */
export function Fold({
  icon,
  title,
  summary,
  children,
  defaultOpen = false,
  danger,
}: {
  icon?: ReactNode;
  title: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-fill/60 cursor-pointer sm:px-5"
      >
        {icon && <span className={cx('flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] text-white [&_svg]:h-[17px] [&_svg]:w-[17px]', danger ? 'bg-bad-dot' : 'bg-accent')}>{icon}</span>}
        <span className="min-w-0 flex-1">
          <span className={cx('block text-[15px] font-medium', danger && 'text-bad')}>{title}</span>
          {summary && !open && <span className="mt-0.5 block truncate text-[13px] text-muted">{summary}</span>}
        </span>
        <ChevronDown size={18} className={cx('shrink-0 text-muted transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && <div className="space-y-5 px-4 pb-5 pt-1 sm:px-5">{children}</div>}
    </section>
  );
}

/** 폼 안에서 "고급 설정" 같은 부분을 접어 두는 버튼 */
export function Disclosure({ label, children, defaultOpen = false }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1 text-[15px] text-accent-2 hover:opacity-75 cursor-pointer">
        {label}
        <ChevronDown size={16} className={cx('transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && <div className="mt-4 space-y-5">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {label && <label className="label">{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, label, sub }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode; sub?: ReactNode }) {
  const sw = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors duration-200 cursor-pointer disabled:cursor-not-allowed', checked ? 'bg-ok-dot' : 'bg-fill-2')}
    >
      <span
        className={cx('absolute top-[2px] h-[22px] w-[22px] rounded-full bg-white shadow-[0_2px_6px_rgb(0_0_0/0.18),0_0_0_0.5px_rgb(0_0_0/0.04)] transition-[left] duration-200 ease-ios', checked ? 'left-[20px]' : 'left-[2px]')}
      />
    </button>
  );
  if (!label && !sub) return <span className={cx(disabled && 'opacity-50')}>{sw}</span>;
  return (
    <label className={cx('flex items-center justify-between gap-4', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <span className="min-w-0">
        {label && <span className="block text-[15px]">{label}</span>}
        {sub && <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">{sub}</span>}
      </span>
      {sw}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={cx('inline-flex max-w-full overflow-x-auto rounded-[9px] bg-fill p-[2px] no-scrollbar', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] px-3 py-[5px] text-[13px] font-medium transition-all duration-150 cursor-pointer',
            value === o.value ? 'bg-seg text-fg shadow-seg' : 'text-fg-2 hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 화면 안 탭. 세그먼트 컨트롤 모양이고, 폭이 모자라면 옆으로 밀린다 */
export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; badge?: ReactNode }[] }) {
  return (
    <div className="mb-6 -mx-4 overflow-x-auto px-4 no-scrollbar sm:mx-0 sm:px-0">
      <div className="inline-flex rounded-[10px] bg-fill p-[2px]" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={value === t.value}
            onClick={() => onChange(t.value)}
            className={cx(
              'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-4 py-1.5 text-[14px] font-medium transition-all duration-150 cursor-pointer',
              value === t.value ? 'bg-seg text-fg shadow-seg' : 'text-fg-2 hover:text-fg',
            )}
          >
            {t.label}
            {t.badge}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- 표시 ----------

type Tone = 'gray' | 'green' | 'red' | 'yellow' | 'blue' | 'purple';
const TONES: Record<Tone, string> = {
  gray: 'bg-fill text-fg-2',
  green: 'bg-ok/12 text-ok',
  red: 'bg-bad/10 text-bad',
  yellow: 'bg-warn/12 text-warn',
  blue: 'bg-info/12 text-info',
  // 예전 보라색 자리. 지금은 강조색(파랑)
  purple: 'bg-accent/12 text-accent-2',
};
const DOTS: Record<Tone, string> = {
  gray: 'bg-muted/60',
  green: 'bg-ok-dot',
  red: 'bg-bad-dot',
  yellow: 'bg-warn-dot',
  blue: 'bg-info',
  purple: 'bg-accent',
};

export function Badge({ tone = 'gray', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[12px] font-medium whitespace-nowrap', TONES[tone], className)}>{children}</span>;
}

const STATE: Record<RunState, { label: string; tone: Tone; pulse?: boolean }> = {
  running: { label: '실행 중', tone: 'green' },
  starting: { label: '시작 중', tone: 'blue', pulse: true },
  restarting: { label: '재시작 대기', tone: 'yellow', pulse: true },
  stopping: { label: '정지 중', tone: 'yellow', pulse: true },
  stopped: { label: '정지됨', tone: 'gray' },
  failed: { label: '실패', tone: 'red' },
  'not-deployed': { label: '배포 전', tone: 'gray' },
  unknown: { label: '알 수 없음', tone: 'gray' },
};

export function StatusDot({ state, className }: { state: RunState | null | undefined; className?: string }) {
  const s = STATE[state ?? 'not-deployed'];
  return <span className={cx('inline-block h-2 w-2 shrink-0 rounded-full', DOTS[s.tone], s.pulse && 'pulse', className)} />;
}

/** 상태는 테두리 없이 점 + 글자로 */
export function StatusBadge({ state }: { state: RunState | null | undefined }) {
  const s = STATE[state ?? 'not-deployed'];
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-medium', s.tone === 'red' ? 'text-bad' : s.tone === 'gray' ? 'text-muted' : 'text-fg-2')}>
      <StatusDot state={state} />
      {s.label}
    </span>
  );
}

export function stateLabel(state: RunState | null | undefined) {
  return STATE[state ?? 'not-deployed'].label;
}

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cx('spin text-muted', className)} />;
}

export function Loading({ text = '불러오는 중...' }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-[15px] text-muted fade-in">
      <Spinner />
      {text}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-3 rounded-[14px] bg-bad/10 px-4 py-3 text-[14px] text-bad">
      <span className="flex min-w-0 gap-2.5">
        <CircleAlert size={18} className="mt-px shrink-0" />
        <span className="whitespace-pre-wrap break-words">{error}</span>
      </span>
      {onRetry && (
        <Button size="sm" variant="plain" onClick={onRetry} className="-my-1">
          다시 시도
        </Button>
      )}
    </div>
  );
}

const NOTICE_ICON: Record<Tone, string> = {
  gray: 'text-muted',
  green: 'text-ok',
  red: 'text-bad',
  yellow: 'text-warn',
  blue: 'text-accent-2',
  purple: 'text-accent-2',
};

/** 안내 상자: 연한 바탕 + 색 있는 아이콘, 글자는 기본색 */
export function Notice({ tone = 'blue', title, children, icon }: { tone?: Tone; title?: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  const bg = { gray: 'bg-fill/70', green: 'bg-ok/8', red: 'bg-bad/8', yellow: 'bg-warn/10', blue: 'bg-accent/8', purple: 'bg-accent/8' }[tone];
  return (
    <div className={cx('flex gap-3 rounded-[14px] px-4 py-3 text-[14px]', bg)}>
      {icon && <div className={cx('mt-0.5 shrink-0', NOTICE_ICON[tone])}>{icon}</div>}
      <div className="min-w-0 leading-relaxed">
        {title && <div className="font-semibold text-fg">{title}</div>}
        {children && <div className={cx(title ? 'mt-0.5' : '', 'text-fg-2')}>{children}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && <div className="mb-4 text-muted/70 [&_svg]:h-11 [&_svg]:w-11 [&_svg]:stroke-[1.4]">{icon}</div>}
      <div className="text-[19px] font-semibold tracking-[-0.015em]">{title}</div>
      {children && <div className="mt-2 max-w-md text-[15px] leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function Meter({ value, tone }: { value: number; tone?: 'auto' | Tone }) {
  const v = Math.max(0, Math.min(100, value));
  const color = tone && tone !== 'auto' ? DOTS[tone] : v > 90 ? 'bg-bad-dot' : v > 75 ? 'bg-warn-dot' : 'bg-accent';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-fill">
      <div className={cx('h-full rounded-full transition-[width] duration-500 ease-ios', color)} style={{ width: `${v}%` }} />
    </div>
  );
}

/** 이름 ··· 값 (iOS 정보 화면처럼 줄마다 구분선) */
export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="-my-2 text-[15px]">
      {items.map(([k, v], i) => (
        <div key={i} className={cx('flex items-baseline justify-between gap-6 py-2.5', i > 0 && 'hairline-t')}>
          <dt className="shrink-0 text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------- 복사 / 비밀값 ----------

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }, []);
  return { copied, copy };
}

export function CopyButton({ text, title = '복사' }: { text: string; title?: string }) {
  const { copied, copy } = useCopy();
  return (
    <IconButton title={copied ? '복사됨' : title} onClick={() => copy(text)}>
      {copied ? <Check size={15} className="text-ok" /> : <Copy size={15} />}
    </IconButton>
  );
}

export function CopyField({ value, secret, mono = true, onReveal }: { value: string; secret?: boolean; mono?: boolean; onReveal?: () => Promise<string> }) {
  const [shown, setShown] = useState(!secret);
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value]);
  return (
    <div className="flex items-center gap-1 rounded-[10px] bg-fill pl-3 pr-1">
      <div className={cx('min-w-0 flex-1 truncate py-2 text-[13px]', mono && 'mono')}>{shown ? val : '•'.repeat(Math.min(24, Math.max(8, val.length)))}</div>
      {secret && (
        <IconButton
          title={shown ? '숨기기' : '보기'}
          onClick={async () => {
            if (!shown && onReveal) setVal(await onReveal());
            setShown(!shown);
          }}
        >
          {shown ? <EyeOff size={15} /> : <Eye size={15} />}
        </IconButton>
      )}
      <CopyButton text={val} />
    </div>
  );
}

// ---------- 시트 (데스크톱은 가운데, 폰은 아래에서 올라온다) ----------

function useLockScroll(open: boolean, onEsc: (() => void) | null) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onEsc?.();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onEsc]);
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  dismissable?: boolean;
}) {
  useLockScroll(open, dismissable ? onClose : null);
  if (!open) return null;
  return createPortal(
    <div
      className="fade-in fixed inset-0 z-50 flex items-end justify-center bg-backdrop sm:items-center sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dismissable && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="sheet-in flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[22px] bg-surface shadow-pop sm:rounded-[22px]"
        style={{ maxWidth: width }}
      >
        {/* 폰에서 위로 끌어 올린 시트임을 알려 주는 손잡이 */}
        <div className="flex justify-center pt-2 sm:hidden">
          <span className="h-[5px] w-9 rounded-full bg-fill-2" />
        </div>
        <header className="flex items-center justify-between gap-3 px-5 pb-2 pt-3 sm:pt-5">
          <h3 className="min-w-0 text-[19px] font-semibold tracking-[-0.015em]">{title}</h3>
          {dismissable && (
            <button type="button" title="닫기" aria-label="닫기" onClick={onClose} className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-fill text-muted transition-colors hover:bg-fill-2 hover:text-fg cursor-pointer">
              <X size={16} strokeWidth={2.6} />
            </button>
          )}
        </header>
        <div className="overflow-y-auto px-5 pb-5 pt-2">{children}</div>
        {footer && (
          <footer className="flex flex-wrap justify-end gap-2 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-1 max-sm:[&>*]:flex-1">{footer}</footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------- 확인창 (iOS 알림 모양) ----------

interface ConfirmOpts {
  title: ReactNode;
  body?: ReactNode;
  confirm?: string;
  danger?: boolean;
}

const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);

export function ConfirmHost({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const ask = useCallback((o: ConfirmOpts) => {
    setOpts(o);
    return new Promise<boolean>((r) => (resolver.current = r));
  }, []);
  const done = useCallback((v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpts(null);
  }, []);
  const cancel = useCallback(() => done(false), [done]);
  useLockScroll(!!opts, cancel);
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {opts &&
        createPortal(
          <div className="fade-in fixed inset-0 z-[55] flex items-center justify-center bg-backdrop p-6" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
            <div role="alertdialog" aria-modal="true" className="sheet-in w-full max-w-[340px] rounded-[20px] bg-surface p-5 text-center shadow-pop max-sm:[animation-name:pop-in]">
              <h3 className="text-[17px] font-semibold tracking-[-0.01em]">{opts.title}</h3>
              {opts.body && <div className="mt-2 text-[14px] leading-relaxed text-fg-2">{opts.body}</div>}
              <div className="mt-5 grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={() => done(false)}>
                  취소
                </Button>
                <Button variant={opts.danger ? 'danger' : 'primary'} className={opts.danger ? 'bg-bad-dot text-white hover:bg-bad-dot hover:brightness-110' : ''} onClick={() => done(true)} autoFocus>
                  {opts.confirm ?? '확인'}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);

// ---------- 토스트 (위 가운데의 작은 알림) ----------

interface ToastItem {
  id: number;
  tone: 'ok' | 'bad' | 'info';
  text: string;
}

let toastSeq = 0;
const toastListeners = new Set<(t: ToastItem) => void>();

export const toast = {
  ok: (text: string) => toastListeners.forEach((l) => l({ id: ++toastSeq, tone: 'ok', text })),
  error: (text: string) => toastListeners.forEach((l) => l({ id: ++toastSeq, tone: 'bad', text })),
  info: (text: string) => toastListeners.forEach((l) => l({ id: ++toastSeq, tone: 'info', text })),
};

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const l = (t: ToastItem) => {
      setItems((x) => [...x.slice(-3), t]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), t.tone === 'bad' ? 7000 : 3200);
    };
    toastListeners.add(l);
    return () => {
      toastListeners.delete(l);
    };
  }, []);
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast-in chrome pointer-events-auto flex max-w-md items-start gap-2.5 rounded-[18px] px-4 py-3 text-[14px] shadow-pop" role="status">
          {t.tone === 'ok' ? (
            <CircleCheck size={18} className="mt-px shrink-0 text-ok" />
          ) : t.tone === 'bad' ? (
            <CircleAlert size={18} className="mt-px shrink-0 text-bad" />
          ) : (
            <Info size={18} className="mt-px shrink-0 text-accent-2" />
          )}
          <span className="min-w-0 whitespace-pre-wrap break-words font-medium">{t.text}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** 비동기 작업 버튼 공통: 로딩 상태 + 실패 토스트 */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (key: string, fn: () => Promise<unknown>, okText?: string) => {
    setBusy(key);
    try {
      await fn();
      if (okText) toast.ok(okText);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, run };
}
