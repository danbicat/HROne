import QRCode from 'qrcode';
import { LogOut, Save, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ReauthDialog } from '../components/Dialogs';
import { PanelUpdate } from '../components/PanelUpdate';
import type { Me } from '../components/Layout';
import { Badge, Button, Card, CopyField, Field, IconButton, IconTile, List, Modal, Notice, PageHeader, Row, SectionHeader, Segmented, Tabs, Toggle, cx, toast, useAction } from '../components/ui';
import { api, errorText } from '../lib/api';
import { ago } from '../lib/format';
import { setTheme, useTheme, type ThemePref } from '../lib/theme';
import { setQuery, useLocation, useTitle } from '../lib/router';
import { useApi } from '../lib/store';
import { AuditPanel } from './Audit';

interface SettingsData {
  panel: { port: number; access: 'private' | 'all' | 'custom'; allowedCidrs: string[]; baseUrl: string };
  defaults: { pollIntervalSec: number; notify: Record<string, boolean> };
  alerts: { enabled: boolean; diskPercent: number; memPercent: number };
  githubTokenSet: boolean;
  discordWebhook: string;
  discordSet: boolean;
}

/** 설정 칸: 제목은 칸 위에, 내용은 흰 칸 안에 (iOS 설정처럼). 제목에 아이콘은 넣지 않는다 */
function Section({ title, children, actions, footer }: { title: ReactNode; children: ReactNode; actions?: ReactNode; footer?: ReactNode }) {
  return (
    <Card title={title} actions={actions} footer={footer}>
      <div className="space-y-5">{children}</div>
    </Card>
  );
}

/** 칸 안에서 스위치를 한 줄씩 (구분선은 두 번째 줄부터) */
function ToggleRows({ children }: { children: ReactNode[] }) {
  return (
    <div className="-my-2">
      {children.map((c, i) => (
        <div key={i} className={cx('py-3', i > 0 && 'hairline-t')}>
          {c}
        </div>
      ))}
    </div>
  );
}

type SettingsTab = 'account' | 'connect' | 'access' | 'update' | 'audit';

export function Settings({ me }: { me: Me }) {
  useTitle('설정');
  const { query } = useLocation();
  const tab = (query.get('tab') as SettingsTab) || 'account';
  const { data, reload } = useApi<SettingsData>('/api/settings');
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="설정" />
      <Tabs
        value={tab}
        onChange={(t) => setQuery('tab', t === 'account' ? null : t)}
        tabs={[
          { value: 'account', label: '내 계정' },
          { value: 'connect', label: 'GitHub · 알림' },
          { value: 'access', label: '패널 접속' },
          { value: 'update', label: '업데이트' },
          { value: 'audit', label: '활동 기록' },
        ]}
      />
      {tab === 'account' && (
        <div className="space-y-9">
          <Account me={me} />
          <Appearance />
          <UsersCard me={me} />
          <LogoutRow />
        </div>
      )}
      {tab === 'connect' && data && (
        <div className="space-y-9">
          <GitHub s={data} reload={reload} />
          <Notifications s={data} reload={reload} />
        </div>
      )}
      {tab === 'access' && data && <PanelAccess s={data} reload={reload} />}
      {tab === 'update' && <PanelUpdate />}
      {tab === 'audit' && <AuditPanel />}
    </div>
  );
}

function PanelAccess({ s, reload }: { s: SettingsData; reload: () => void }) {
  const [p, setP] = useState(s.panel);
  const [cidrs, setCidrs] = useState(s.panel.allowedCidrs.join('\n'));
  useEffect(() => {
    setP(s.panel);
    setCidrs(s.panel.allowedCidrs.join('\n'));
  }, [s]);
  const { busy, run } = useAction();
  return (
    <Section title="패널 접속">
      <Field label="접속 허용" hint="GitHub 웹후크 주소(/api/hooks/...)는 이 제한과 상관없이 서명으로만 확인합니다">
        <Segmented
          value={p.access}
          onChange={(v) => setP({ ...p, access: v })}
          options={[
            { value: 'private', label: 'Tailscale · 사설망만' },
            { value: 'custom', label: '지정한 IP 만' },
            { value: 'all', label: '모든 IP' },
          ]}
        />
      </Field>
      {p.access === 'private' && (
        <div className="text-[14px] leading-relaxed text-muted">허용: 127.0.0.1, Tailscale (100.64.0.0/10, fd7a::/48), 10/8, 172.16/12, 192.168/16. cloudflared 를 거쳐 들어온 외부 요청은 실제 IP 로 판단해서 막습니다.</div>
      )}
      {p.access === 'all' && <Notice tone="red">공인 IP 에서도 로그인 화면이 열립니다. OTP 를 꼭 켜고, 가능하면 Cloudflare Access 등으로 한 겹 더 막으세요.</Notice>}
      {p.access === 'custom' && (
        <Field label="허용할 IP / CIDR (한 줄에 하나)" hint="127.0.0.1 은 항상 허용됩니다">
          <textarea className="input mono min-h-[90px]" value={cidrs} onChange={(e) => setCidrs(e.target.value)} placeholder={'100.64.0.0/10\n203.0.113.7'} />
        </Field>
      )}
      <div className="hairline-t grid gap-5 pt-5 sm:grid-cols-2">
        <Field label="패널 포트" hint="바꾸면 패널이 재시작됩니다">
          <input className="input mono" inputMode="numeric" value={p.port} onChange={(e) => setP({ ...p, port: Number(e.target.value.replace(/\D/g, '')) || 7700 })} />
        </Field>
        <Field label="패널 공개 주소 (선택)" hint="디스코드 알림 링크와 웹후크 URL 에 쓰입니다. 예: http://100.x.y.z:7700">
          <input className="input" value={p.baseUrl} onChange={(e) => setP({ ...p, baseUrl: e.target.value })} placeholder={location.origin} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button
          variant="primary"
          icon={<Save size={15} />}
          loading={busy === 's'}
          onClick={() =>
            run('s', async () => {
              const r = await api.put<{ restartNeeded: boolean }>('/api/settings', { panel: { ...p, allowedCidrs: cidrs.split('\n').map((x) => x.trim()).filter(Boolean) } });
              if (r.restartNeeded) {
                await api.post('/api/system/restart-panel');
                toast.info(`포트를 바꿔 패널을 재시작합니다. 새 주소: ${location.protocol}//${location.hostname}:${p.port}`);
                setTimeout(() => (location.href = `${location.protocol}//${location.hostname}:${p.port}${location.pathname}`), 3500);
              } else toast.ok('저장했습니다');
              reload();
            })
          }
        >
          저장
        </Button>
      </div>
    </Section>
  );
}

function GitHub({ s, reload }: { s: SettingsData; reload: () => void }) {
  const [token, setToken] = useState('');
  const { busy, run } = useAction();
  return (
    <Section title="GitHub" actions={s.githubTokenSet ? <Badge tone="green">토큰 설정됨</Badge> : <Badge>토큰 없음</Badge>}>
      <p className="text-[14px] leading-relaxed text-muted">
        비공개 저장소를 받거나 앱 추가 화면에서 내 저장소 목록을 보려면 토큰을 넣으세요. Fine-grained token 이라면 Repository access 에서 저장소를 고르고 Contents: Read-only, Metadata: Read-only 면 충분합니다.
      </p>
      <div className="flex flex-wrap gap-2 sm:flex-nowrap">
        <input className="input mono min-w-0 flex-1" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.githubTokenSet ? '새 토큰으로 바꾸기' : 'github_pat_... 또는 ghp_...'} autoComplete="off" />
        <Button
          variant="primary"
          disabled={!token}
          loading={busy === 's'}
          onClick={() =>
            run('s', async () => {
              await api.put('/api/settings', { githubToken: token });
              const r = await api.get<{ repos: unknown[] }>('/api/github/repos').catch((e) => {
                throw new Error(`저장했지만 확인에 실패했습니다: ${errorText(e)}`);
              });
              toast.ok(`저장했습니다 · 저장소 ${r.repos.length}개 보임`);
              setToken('');
              reload();
            })
          }
        >
          저장
        </Button>
        {s.githubTokenSet && (
          <Button variant="danger" loading={busy === 'd'} onClick={() => run('d', () => api.put('/api/settings', { githubToken: '' }).then(reload), '토큰을 지웠습니다')}>
            지우기
          </Button>
        )}
      </div>
    </Section>
  );
}

function Notifications({ s, reload }: { s: SettingsData; reload: () => void }) {
  const [url, setUrl] = useState('');
  const [d, setD] = useState(s.defaults);
  const [a, setA] = useState(s.alerts);
  useEffect(() => {
    setD(s.defaults);
    setA(s.alerts);
  }, [s]);
  const { busy, run } = useAction();
  return (
    <>
    <Section title="알림 (디스코드)" actions={s.discordSet ? <Badge tone="green">연결됨</Badge> : undefined}>
      <Field label="전역 웹후크" hint={s.discordSet ? `현재: ${s.discordWebhook}` : '디스코드 채널 → 설정 → 연동 → 웹후크 → URL 복사'}>
        <div className="flex flex-wrap gap-2 sm:flex-nowrap">
          <input className="input mono min-w-0 flex-1" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/..." />
          <Button variant="primary" disabled={!url} loading={busy === 'u'} onClick={() => run('u', () => api.put('/api/settings', { discordWebhook: url }).then(() => (setUrl(''), reload())), '저장했습니다')}>
            저장
          </Button>
          {s.discordSet && (
            <>
              <Button loading={busy === 't'} onClick={() => run('t', () => api.post('/api/settings/test-discord'), '테스트 알림을 보냈습니다')}>
                테스트
              </Button>
              <Button variant="danger" loading={busy === 'x'} onClick={() => run('x', () => api.put('/api/settings', { discordWebhook: '' }).then(reload), '지웠습니다')}>
                지우기
              </Button>
            </>
          )}
        </div>
      </Field>
    </Section>
    <Section title="새 앱의 기본 알림 항목">
        <ToggleRows>
          {(
            [
              ['push', '새 푸시 감지'],
              ['pending', '승인 대기'],
              ['start', '배포 시작'],
              ['success', '배포 성공'],
              ['failure', '배포 실패'],
              ['crash', '크래시'],
            ] as const
          ).map(([k, label]) => (
            <Toggle key={k} checked={!!d.notify[k]} onChange={(v) => setD({ ...d, notify: { ...d.notify, [k]: v } })} label={label} />
          ))}
        </ToggleRows>
        <Field label="새 앱 기본 폴링 주기 (초)" className="hairline-t pt-5">
          <input className="input mono sm:w-40" inputMode="numeric" value={d.pollIntervalSec} onChange={(e) => setD({ ...d, pollIntervalSec: Number(e.target.value.replace(/\D/g, '')) || 60 })} />
        </Field>
    </Section>
    <Section title="서버 경고">
      <Toggle checked={a.enabled} onChange={(v) => setA({ ...a, enabled: v })} label="서버 경고 알림 (디스크/메모리/DB 다운)" />
      <div className="hairline-t grid gap-5 pt-5 sm:grid-cols-2">
        <Field label="디스크 경고 (%)">
          <input className="input mono" inputMode="numeric" value={a.diskPercent} onChange={(e) => setA({ ...a, diskPercent: Number(e.target.value.replace(/\D/g, '')) || 90 })} />
        </Field>
        <Field label="메모리 경고 (%, 3분 지속)">
          <input className="input mono" inputMode="numeric" value={a.memPercent} onChange={(e) => setA({ ...a, memPercent: Number(e.target.value.replace(/\D/g, '')) || 95 })} />
        </Field>
      </div>
    </Section>
    <div className="-mt-5 flex items-center justify-end gap-3">
      <span className="text-[13px] text-muted">기본 알림 항목과 서버 경고를 함께 저장합니다</span>
      <Button variant="primary" icon={<Save size={15} />} loading={busy === 's'} onClick={() => run('s', () => api.put('/api/settings', { defaults: d, alerts: a }).then(reload), '저장했습니다')}>
        저장
      </Button>
    </div>
    </>
  );
}

function Account({ me }: { me: Me }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [totpOtp, setTotpOtp] = useState('');
  const { busy, run } = useAction();
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const { data: sessions, reload } = useApi<{ id: string; created_at: number; last_seen_at: number; ip: string; user_agent: string; current: boolean }[]>('/api/auth/sessions');
  return (
    <>
      <Section title={`내 계정 (${me.username})`}>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="현재 비밀번호">
            <input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="새 비밀번호" hint="8자 이상">
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="새 비밀번호 확인">
            <input className="input" type="password" value={next2} onChange={(e) => setNext2(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
        {me.totpEnabled && (
          <Field label="OTP 코드">
            <input className="input mono w-40" inputMode="numeric" maxLength={6} value={totpOtp} onChange={(e) => setTotpOtp(e.target.value.replace(/\D/g, ''))} />
          </Field>
        )}
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={!cur || next.length < 8 || next !== next2}
            loading={busy === 'pw'}
            onClick={() => run('pw', () => api.post('/api/auth/password', { current: cur, next, totp: totpOtp }).then(() => (setCur(''), setNext(''), setNext2(''))), '비밀번호를 바꿨습니다. 다른 기기의 로그인은 끊겼습니다.')}
          >
            비밀번호 변경
          </Button>
        </div>
      </Section>

      <Card title="2단계 인증" pad={false} footer="로그인과 삭제·복원 같은 위험한 작업에 인증 앱 코드를 요구합니다.">
        <Row
          icon={
            <IconTile tone={me.totpEnabled ? 'ok' : 'gray'}>
              <ShieldCheck size={17} />
            </IconTile>
          }
          title="2단계 인증 (OTP)"
          trailing={
            <span className="flex shrink-0 items-center gap-2">
              {me.totpEnabled ? <Badge tone="green">켜짐</Badge> : <Badge>꺼짐</Badge>}
              {me.totpEnabled ? (
                <Button size="sm" variant="danger" onClick={() => setDisableOpen(true)}>
                  끄기
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy === 'otp'}
                  onClick={() =>
                    run('otp', async () => {
                      const r = await api.post<{ secret: string; uri: string }>('/api/auth/totp/begin');
                      // QR 은 테마와 상관없이 흰 바탕에 검은 점이어야 잘 읽힌다
                      const qr = await QRCode.toDataURL(r.uri, { margin: 1, width: 220, color: { dark: '#000000', light: '#ffffff' } });
                      setSetup({ ...r, qr });
                      setCode('');
                    })
                  }
                >
                  OTP 켜기
                </Button>
              )}
            </span>
          }
        />
      </Card>

      <section className="min-w-0">
        <SectionHeader title="로그인된 기기" />
        <List>
          {(sessions ?? []).map((s) => (
            <Row
              key={s.id}
              title={s.user_agent.replace(/\(.*?\)/g, '').slice(0, 80) || '알 수 없는 브라우저'}
              sub={`${s.ip} · 마지막 ${ago(s.last_seen_at)}`}
              trailing={
                s.current ? (
                  <Badge tone="green">지금 이 기기</Badge>
                ) : (
                  <IconButton title="로그아웃시키기" onClick={() => run(`s${s.id}`, () => api.del(`/api/auth/sessions/${s.id}`).then(reload), '로그아웃시켰습니다')}>
                    <Trash2 size={15} />
                  </IconButton>
                )
              }
            />
          ))}
        </List>
      </section>

      <Modal
        open={!!setup}
        onClose={() => setSetup(null)}
        title="OTP 설정"
        width={440}
        footer={
          <>
            <Button onClick={() => setSetup(null)}>
              취소
            </Button>
            <Button
              variant="primary"
              disabled={code.length !== 6}
              loading={busy === 'en'}
              onClick={() =>
                run('en', async () => {
                  await api.post('/api/auth/totp/enable', { secret: setup!.secret, code });
                  setSetup(null);
                  location.reload();
                }, 'OTP 를 켰습니다')
              }
            >
              확인하고 켜기
            </Button>
          </>
        }
      >
        {setup && (
          <div className="space-y-5 text-[15px]">
            <p className="leading-relaxed text-fg-2">Google Authenticator, 1Password, Authy 등으로 QR 을 찍은 뒤 나오는 6자리 코드를 입력하세요.</p>
            <div className="mx-auto w-fit rounded-[14px] bg-white p-2">
              <img src={setup.qr} alt="OTP QR" className="block" width={220} height={220} />
            </div>
            <Field label="직접 입력용 키">
              <CopyField value={setup.secret} />
            </Field>
            <Field label="6자리 코드">
              <input className="input mono text-center text-lg tracking-[0.4em]" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            </Field>
            <p className="text-[13px] leading-relaxed text-muted">휴대폰을 잃어버리면 서버에서 sudo hrone disable-2fa {me.username} 로 끌 수 있습니다.</p>
          </div>
        )}
      </Modal>
      <ReauthDialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title="OTP 끄기"
        needTotp
        danger
        confirmLabel="끄기"
        onConfirm={async (auth) => {
          await api.post('/api/auth/totp/disable', auth);
          location.reload();
        }}
      />
    </>
  );
}

function UsersCard({ me }: { me: Me }) {
  const { data, reload } = useApi<{ id: number; username: string; totpEnabled: boolean; lastLoginAt: number | null }[]>('/api/users');
  const [open, setOpen] = useState(false);
  const [u, setU] = useState('');
  const [pw, setPw] = useState('');
  const [del, setDel] = useState<{ id: number; username: string } | null>(null);
  const { busy, run } = useAction();
  return (
    <Card
      title="관리자 계정"
      pad={false}
      actions={
        <Button size="sm" variant="plain" icon={<UserPlus size={14} />} onClick={() => setOpen(true)}>
          추가
        </Button>
      }
      footer="모든 계정은 같은 전체 권한을 가집니다. 변경 내용은 활동 기록에 계정별로 남습니다."
    >
      {(data ?? []).map((x) => (
        <Row
          key={x.id}
          title={<span className="font-medium">{x.username}</span>}
          sub={x.lastLoginAt ? `${ago(x.lastLoginAt)} 로그인` : '로그인 기록 없음'}
          trailing={
            <span className="flex shrink-0 items-center gap-1.5">
              {x.totpEnabled && <Badge tone="green">OTP</Badge>}
              {x.username !== me.username && (
                <IconButton title="삭제" onClick={() => setDel(x)}>
                  <Trash2 size={15} />
                </IconButton>
              )}
            </span>
          }
        />
      ))}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="관리자 추가"
        width={420}
        footer={
          <Button
            variant="primary"
            disabled={!u || pw.length < 8}
            loading={busy === 'add'}
            onClick={() => run('add', () => api.post('/api/users', { username: u, password: pw }).then(() => (setOpen(false), setU(''), setPw(''), reload())), '추가했습니다')}
          >
            추가
          </Button>
        }
      >
        <div className="space-y-5">
          <Field label="아이디">
            <input className="input" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
          </Field>
          <Field label="비밀번호" hint="8자 이상. 로그인 후 본인이 바꾸게 하세요">
            <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
      </Modal>
      <ReauthDialog
        open={!!del}
        onClose={() => setDel(null)}
        title={`${del?.username} 삭제`}
        danger
        confirmLabel="삭제"
        needTotp={me.totpEnabled}
        onConfirm={async (auth) => {
          await api.post(`/api/users/${del!.id}/delete`, auth);
          toast.ok('삭제했습니다');
          reload();
        }}
      />
    </Card>
  );
}

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'system', label: '시스템' },
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' },
];

/** 내 계정 → 화면: 테마 (이 브라우저에만 저장) */
function Appearance() {
  const theme = useTheme();
  return (
    <Card title="화면" footer="이 브라우저에만 저장됩니다. 시스템을 고르면 기기의 라이트/다크 설정을 따릅니다.">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[15px]">테마</span>
        <Segmented value={theme} onChange={setTheme} options={THEMES} />
      </div>
    </Card>
  );
}

/** 폰에서는 사이드바가 없으므로 여기서 로그아웃한다 */
function LogoutRow() {
  return (
    <List>
      <Row
        icon={
          <IconTile tone="bad">
            <LogOut size={16} />
          </IconTile>
        }
        title="로그아웃"
        danger
        chevron={false}
        onClick={async () => {
          await api.post('/api/auth/logout');
          location.href = '/';
        }}
      />
    </List>
  );
}
