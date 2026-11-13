import { useSyncExternalStore } from 'react';

/** 화면 테마: 시스템 설정을 따르거나 라이트/다크로 고정. 브라우저마다 따로 저장된다 */
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'hrone:theme';
const listeners = new Set<() => void>();

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let current: ThemePref = read();

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
  // 폰 브라우저 주소창 색도 맞춘다
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    if (pref === 'system') m.content = m.media.includes('dark') ? '#000000' : '#f5f5f7';
    else m.content = dark ? '#000000' : '#f5f5f7';
  });
}

export function setTheme(pref: ThemePref) {
  current = pref;
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // 저장이 막힌 브라우저면 이번 화면에서만 바꾼다
  }
  apply(pref);
  listeners.forEach((l) => l());
}

export function useTheme(): ThemePref {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

apply(current);
