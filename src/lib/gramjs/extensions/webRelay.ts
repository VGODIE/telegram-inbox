// Gradly: подключение к Telegram через релей прокси аккаунта.
//
// Браузер не умеет ходить через SOCKS, поэтому для аккаунта с назначенным прокси
// WebSocket открывается не к `zwsN.web.telegram.org`, а к релею Gradly
// (`wss://www.gradly.ru/tg-relay/apiws?host=zwsN&t=…`), и тот выходит в Telegram
// через SOCKS5 аккаунта — с того же IP, что и бэкенд-сессия.
//
// Модуль живёт в worker'е gramjs (один worker на слот аккаунта). Конфиг берём
// с `/api/telegram/relay-config`: форк раздаётся с origin Gradly (/tg-app/), так
// что cookie-сессия Gradly уезжает вместе с запросом.
//
// Адрес подменяется только в момент открытия сокета — в сессию и хранилище
// ничего не пишется, поэтому выключение релея возвращает прямое подключение
// без перелогина.

type RelayConfig = {
  url: string;
  token: string;
  exp: number;
};

type RelayConfigResponse =
  | ({ mode: 'relay' } & RelayConfig)
  | { mode: 'direct' };

const CONFIG_ENDPOINT = '/api/telegram/relay-config';
// Обновляем токен заранее: релей проверяет его только при открытии соединения
const REFRESH_BEFORE_EXP_SEC = 5 * 60;
const FETCH_TIMEOUT_MS = 5000;
// Только хосты Telegram Web — тот же белый список, что на стороне релея
const HOST_RE = /^(zws[1-5](?:-1)?)\.web\.telegram\.org$/;

let accountId: string | undefined;
let config: RelayConfig | undefined;
let refreshing: Promise<RelayConfig | undefined> | undefined;

async function fetchConfig(id: string): Promise<RelayConfigResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${CONFIG_ENDPOINT}?accountId=${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`relay-config ${res.status}`);
    return await res.json() as RelayConfigResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Включает релей для worker'а, если Gradly подтвердил его для аккаунта.
 * Любая ошибка — остаёмся на прямом подключении: на этапе раскатки клиент без
 * Telegram из-за нашего сбоя хуже, чем одна сессия с домашнего IP.
 */
export async function configureWebRelay(id: string): Promise<boolean> {
  accountId = id;
  try {
    const res = await fetchConfig(id);
    if (res.mode !== 'relay') return false;
    config = { url: res.url, token: res.token, exp: res.exp };
    // eslint-disable-next-line no-console
    console.log('[Gradly] Telegram connection goes through account proxy relay');
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Gradly] relay-config unavailable, connecting directly', err);
    return false;
  }
}

export function isWebRelayActive() {
  return Boolean(config);
}

/** Релей закрыл сокет с 4401 — токен не принят, при следующем подключении берём новый. */
export function invalidateWebRelayToken() {
  if (config) config = { ...config, exp: 0 };
}

async function freshConfig(): Promise<RelayConfig | undefined> {
  if (!config || !accountId) return config;
  if (config.exp - Date.now() / 1000 > REFRESH_BEFORE_EXP_SEC) return config;

  refreshing ??= fetchConfig(accountId)
    .then((res) => {
      // Релей для аккаунта выключили (kill switch, сняли прокси). Прямое
      // подключение включится только с перезагрузкой форка — посреди жизни
      // worker'а IP не меняем.
      if (res.mode === 'relay') config = { url: res.url, token: res.token, exp: res.exp };
      return config;
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[Gradly] relay token refresh failed', err);
      return config;
    })
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}

/**
 * Адрес релея для хоста Telegram (`zws2-1.web.telegram.org` и т. п.).
 * Хост вне белого списка — ошибка, а не прямое подключение: смешивать IP одной
 * сессии ровно то, от чего релей защищает.
 */
export async function getWebRelayLink(ip: string, isPremium?: boolean): Promise<string> {
  const match = HOST_RE.exec(ip);
  if (!match) throw new Error(`[Gradly] relay: unsupported Telegram host ${ip}`);

  const current = await freshConfig();
  if (!current) throw new Error('[Gradly] relay: not configured');

  const params = new URLSearchParams({
    host: match[1],
    path: isPremium ? 'apiws_premium' : 'apiws',
    t: current.token,
  });
  return `${current.url}?${params.toString()}`;
}
