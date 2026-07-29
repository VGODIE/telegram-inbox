// Helpers for "iframe auto-login" mode used by Gradly embed.
// When the app is loaded as an iframe with ?accountId=xxx, instead of
// showing QR/phone auth screen we hand the freshly-generated login token
// over to the parent window via postMessage. The parent calls our backend,
// which calls auth.acceptLoginToken from an already-authorized session.

const ALLOWED_PARENT_ORIGINS: ReadonlyArray<string> = [
  'http://localhost:3000',
  'https://gradly.ru',
  'https://app.gradly.ru',
  'https://www.gradly.ru',
];

export type IframeBootstrap = {
  accountId: string;
};

export function getIframeBootstrap(): IframeBootstrap | null {
  if (typeof window === 'undefined') return null;
  if (window.self === window.top) return null;
  const accountId = new URLSearchParams(window.location.search).get('accountId');
  if (!accountId) return null;
  return { accountId };
}

/**
 * Running embedded in Gradly (as opposed to standalone web).
 *
 * Multi-account UI must stay hidden in this mode. The native switcher lists
 * every slot found in localStorage (see getAccountsInfo), which is "every
 * Telegram session ever authorized in this browser on our origin" — not
 * "accounts of the currently signed-in Gradly user". Two more reasons:
 * the parent renders its own account switcher and tracks the selected account,
 * so in-iframe switching silently desyncs it; and "Add account" would start a
 * raw Telegram login bypassing Gradly's connect flow (plan limit,
 * telegram_accounts row, iframe_slot assignment).
 *
 * Evaluated once at import time — the embed never changes mode at runtime.
 */
export const IS_GRADLY_IFRAME = Boolean(getIframeBootstrap());

/**
 * Slots of the Telegram accounts owned by the Gradly user currently signed in,
 * passed by the parent as `?slots=1,7,12`.
 *
 * localStorage is per-browser, not per-Gradly-user: slots pile up from every
 * account ever authorized on this origin, including ones belonging to a Gradly
 * user who signed in earlier on the same machine. Sessions are deliberately
 * left in place (switching Gradly accounts back must not require a re-login),
 * so instead we narrow what the app can see and act on — see getAccountsInfo.
 *
 * `undefined` means "do not filter": either we are not embedded, or the parent
 * is an older build that does not send the parameter yet. Failing open keeps the
 * two deploys independent — a mismatched pair degrades to today's behaviour
 * rather than to an empty account list.
 */
function parseAllowedSlots(): Set<number> | undefined {
  if (!IS_GRADLY_IFRAME) return undefined;
  const raw = new URLSearchParams(window.location.search).get('slots');
  if (!raw) return undefined;

  const slots = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  return slots.length ? new Set(slots) : undefined;
}

export const ALLOWED_ACCOUNT_SLOTS = parseAllowedSlots();

export function isParentOriginAllowed(origin: string): boolean {
  return ALLOWED_PARENT_ORIGINS.includes(origin);
}

type AcceptTokenResult = { ok: true } | { ok: false; error?: string };

let cachedParentOrigin: string | null = null;

/**
 * Listens for the first allowed message from parent and records its origin.
 * Subsequent outgoing postMessage targets this exact origin (lockdown after handshake).
 */
export function listenForParentOrigin(): void {
  if (cachedParentOrigin) return;
  const handler = (event: MessageEvent) => {
    if (!isParentOriginAllowed(event.origin)) return;
    cachedParentOrigin = event.origin;
    window.removeEventListener('message', handler);
  };
  window.addEventListener('message', handler);
}

export function getParentOrigin(): string {
  return cachedParentOrigin || '*';
}

export function notifyParentReady(accountId: string): void {
  window.parent.postMessage(
    { type: 'gradly:tg:iframe-ready', accountId },
    getParentOrigin(),
  );
}

export function notifyParentAuthReady(accountId: string): void {
  window.parent.postMessage(
    { type: 'gradly:tg:auth-ready', accountId },
    getParentOrigin(),
  );
}

export function requestAcceptToken(
  accountId: string,
  tokenBase64: string,
  signal?: AbortSignal,
): Promise<AcceptTokenResult> {
  return new Promise((resolve) => {
    const requestId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;

    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', handler);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (result: AcceptTokenResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const handler = (event: MessageEvent) => {
      if (!isParentOriginAllowed(event.origin)) return;
      // Lock parent origin once we receive any allowed message
      if (!cachedParentOrigin) cachedParentOrigin = event.origin;
      const data = event.data;
      if (!data || data.type !== 'gradly:tg:accept-token:result') return;
      if (data.requestId !== requestId) return;
      settle(data.result || { ok: false, error: 'malformed_response' });
    };

    const onAbort = () => settle({ ok: false, error: 'aborted' });

    window.addEventListener('message', handler);
    signal?.addEventListener('abort', onAbort);

    window.parent.postMessage(
      { type: 'gradly:tg:accept-token', requestId, accountId, tokenBase64 },
      getParentOrigin(),
    );
  });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
