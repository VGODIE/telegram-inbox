import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import {
  getIframeBootstrap,
  listenForParentOrigin,
  notifyParentAuthReady,
  notifyParentReady,
  requestAcceptToken,
} from '../../util/iframeAutoLogin';

import './AuthIframeLogin.scss';

type StateProps = {
  auth: GlobalState['auth'];
  connectionState: GlobalState['connectionState'];
};

type Status = 'connecting' | 'awaiting-token' | 'submitting' | 'success' | 'error';

const AuthIframeLogin = ({ auth, connectionState }: StateProps) => {
  const { goToAuthQrCode } = getActions();

  const bootstrap = getIframeBootstrap();
  const accountId = bootstrap?.accountId;
  const { state, qrCode } = auth;

  const [status, setStatus] = useState<Status>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submittedTokenRef = useRef<string | null>(null);
  const acceptedRef = useRef(false);
  const authReadySentRef = useRef(false);

  // На монтировании начинаем слушать parent origin для последующих postMessage.
  useEffect(() => {
    if (!accountId) return;
    listenForParentOrigin();
    notifyParentReady(accountId);
  }, [accountId]);

  // Переводим gramjs на QR-флоу (он сам циклит exportLoginToken) по СОСТОЯНИЮ,
  // а не один раз на монтировании. Причина — гонка на iOS/Android: там gramjs
  // стартует с ввода номера (client.ts, initialMethod по платформе), а App
  // монтирует auth-экран ещё до первого auth-состояния. Вызов goToAuthQrCode
  // в этот момент молча теряется: в воркере ещё нет ожидающего промиса, и
  // restartAuthWithQr выходит по `if (!authController.reject) return`. Дальше
  // приходит authorizationStateWaitPhoneNumber, повторного вызова не было —
  // и экран висел на «Авторизуем аккаунт через Gradly» навсегда. На десктопе
  // не воспроизводилось: там initialMethod = qrCode и токен приходит сам.
  //
  // Только WaitPhoneNumber: RESTART_AUTH_WITH_QR ловится в signInUser именно на
  // ожидании номера; на этапе кода тот же reject не переводит на QR.
  useEffect(() => {
    if (!accountId) return;
    if (state === 'authorizationStateWaitPhoneNumber') {
      goToAuthQrCode();
    }
  }, [accountId, state]);

  // Когда gramjs обновил qrCode (новый login token) — отправляем родителю.
  // После первого успешного accept бэкендом — игнорим последующие токены: gramjs
  // внутри signInUserWithQrCode крутит exportLoginToken-loop пока не придёт
  // UpdateLoginToken, и успевает сгенерить ещё один токен. Если его отправить —
  // бэкенд получит AUTH_TOKEN_ALREADY_ACCEPTED от Telegram и зарепортит ошибку
  // в UI, хотя Session B уже создана.
  useEffect(() => {
    if (!accountId || !qrCode?.token) return;
    if (acceptedRef.current) return;
    if (submittedTokenRef.current === qrCode.token) return;
    submittedTokenRef.current = qrCode.token;

    setStatus('submitting');
    setErrorMessage(null);

    let cancelled = false;
    const ac = new AbortController();
    (async () => {
      const result = await requestAcceptToken(accountId, qrCode.token, ac.signal);
      if (cancelled) return;
      if (result.ok) {
        acceptedRef.current = true;
        // Не флипаем сразу в success — ждём, пока authState станет ready
        // (UpdateLoginToken прилетит и gramjs завершит signInUserWithQrCode).
        setStatus('awaiting-token');
      } else {
        setStatus('error');
        setErrorMessage(result.error || 'unknown_error');
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [accountId, qrCode?.token]);

  // Когда auth стал ready — уведомляем родителя.
  useEffect(() => {
    if (state === 'authorizationStateReady' && accountId && !authReadySentRef.current) {
      authReadySentRef.current = true;
      setStatus('success');
      notifyParentAuthReady(accountId);
    }
  }, [state, accountId]);

  if (!accountId) {
    return (
      <div id="auth-iframe-login" className="custom-scroll">
        <div className="auth-form">
          <p>Iframe bootstrap missing accountId</p>
        </div>
      </div>
    );
  }

  const isConnecting = connectionState !== 'connectionStateReady';

  let title = 'Подключаем Telegram…';
  let subtitle = 'Авторизуем аккаунт через Gradly';
  if (isConnecting) {
    subtitle = 'Устанавливаем соединение с Telegram…';
  } else if (status === 'submitting') {
    subtitle = 'Подтверждаем сессию на сервере…';
  } else if (status === 'awaiting-token') {
    subtitle = 'Финализируем авторизацию…';
  } else if (status === 'success') {
    title = 'Готово';
    subtitle = 'Открываем Telegram…';
  } else if (status === 'error') {
    title = 'Не удалось подключить';
    subtitle = errorMessage === 'session_revoked'
      ? 'Сессия Gradly отозвана. Переподключите аккаунт в настройках Gradly.'
      : 'Попробуйте обновить страницу. Если не помогает — переподключите аккаунт в Gradly.';
  }

  return (
    <div id="auth-iframe-login" className="custom-scroll">
      <div className="auth-form">
        {status !== 'error' && status !== 'success' && <div className="auth-iframe-spinner" />}
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => ({
    auth: global.auth,
    connectionState: global.connectionState,
  }),
)(AuthIframeLogin));
