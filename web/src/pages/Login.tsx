import { useState } from 'react';
import { Button } from '../components/ui';
import { api, errorText } from '../lib/api';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ needTotp?: boolean }>('/api/auth/login', { username, password, totp: needTotp ? totp : undefined });
      if (r.needTotp) {
        setNeedTotp(true);
        return;
      }
      onLogin();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-5 py-10">
      <form onSubmit={submit} className="w-full max-w-[360px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/favicon.svg" className="h-16 w-16 rounded-card shadow-pop" alt="" />
          <h1 className="mt-5 text-display">{needTotp ? '2단계 인증' : 'HROne에 로그인'}</h1>
          <p className="mt-1.5 text-body text-muted">{needTotp ? '인증 앱(Google Authenticator 등)의 6자리 코드를 넣으세요' : '서버 패널을 관리하려면 로그인하세요'}</p>
        </div>
        {!needTotp ? (
          // 아이디와 비밀번호를 한 칸으로 묶는다 (Apple 로그인 화면처럼)
          <div className="overflow-hidden rounded-card bg-surface shadow-card ring-1 ring-line focus-within:ring-2 focus-within:ring-accent">
            <input
              className="block h-[52px] w-full bg-transparent px-4 text-headline font-normal outline-none placeholder:text-muted/70"
              placeholder="아이디"
              aria-label="아이디"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoFocus
            />
            <div className="mx-4 h-px bg-line" />
            <input
              className="block h-[52px] w-full bg-transparent px-4 text-headline font-normal outline-none placeholder:text-muted/70"
              type="password"
              placeholder="비밀번호"
              aria-label="비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
        ) : (
          <input
            className="mono block h-[56px] w-full rounded-card bg-surface text-center text-title font-normal tracking-[0.5em] shadow-card outline-none ring-1 ring-line focus:ring-2 focus:ring-accent"
            inputMode="numeric"
            maxLength={6}
            aria-label="OTP 코드"
            value={totp}
            onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
            autoFocus
            autoComplete="one-time-code"
          />
        )}
        {error && <div className="mt-3 text-center text-body text-bad">{error}</div>}
        <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" loading={busy}>
          {needTotp ? '확인' : '로그인'}
        </Button>
        <p className="mt-8 text-center text-footnote text-muted">
          비밀번호를 잊었다면 서버에서 <code className="rounded-tile bg-fill px-1.5 py-0.5 text-caption text-fg-2">sudo hrone reset-password</code>를 실행하세요
        </p>
      </form>
    </div>
  );
}
