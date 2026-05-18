import '../../global/actions/initial';

import { memo } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { IS_TAURI } from '../../util/browser/globalEnvironment';
import { IS_MAC_OS, PLATFORM_ENV } from '../../util/browser/windowEnvironment';

import useCurrentOrPrev from '../../hooks/useCurrentOrPrev';
import useHistoryBack from '../../hooks/useHistoryBack';

import { getIframeBootstrap } from '../../util/iframeAutoLogin';

import Transition from '../ui/Transition';
import AuthCode from './AuthCode.async';
import AuthIframeLogin from './AuthIframeLogin';
import AuthPassword from './AuthPassword.async';
import AuthPhoneNumber from './AuthPhoneNumber';
import AuthQrCode from './AuthQrCode';
import AuthRegister from './AuthRegister.async';

import './Auth.scss';

type StateProps = {
  authState: GlobalState['auth']['state'];
};

const Auth = ({
  authState,
}: StateProps) => {
  const {
    returnToAuthPhoneNumber, goToAuthQrCode,
  } = getActions();

  const isMobile = PLATFORM_ENV === 'iOS' || PLATFORM_ENV === 'Android';
  // Iframe-mode короткозамыкает обычный выбор экранов и сразу рендерит auto-login.
  // Это даёт корректное поведение даже если authState ещё в Initial — компонент сам
  // дёрнет goToAuthQrCode() для запуска QR-флоу gramjs.
  const iframeBootstrap = getIframeBootstrap();

  const handleChangeAuthorizationMethod = () => {
    if (!isMobile) {
      goToAuthQrCode();
    } else {
      returnToAuthPhoneNumber();
    }
  };

  useHistoryBack({
    isActive: (!isMobile && authState === 'authorizationStateWaitPhoneNumber')
      || (isMobile && authState === 'authorizationStateWaitQrCode'),
    onBack: handleChangeAuthorizationMethod,
  });

  // For animation purposes
  const renderingAuthState = useCurrentOrPrev(
    authState !== 'authorizationStateReady' ? authState : undefined,
    true,
  );

  function getScreen() {
    if (iframeBootstrap) {
      // Iframe-mode перехватывает только QR-token flow (наш auto-login).
      // Для 2FA пароля / регистрации — отдаём нормальные Web A экраны, иначе
      // юзер не сможет завершить логин (Telegram пришлёт «incomplete login attempt»).
      switch (renderingAuthState) {
        case 'authorizationStateWaitPassword':
          return <AuthPassword />;
        case 'authorizationStateWaitRegistration':
          return <AuthRegister />;
        default:
          return <AuthIframeLogin />;
      }
    }
    switch (renderingAuthState) {
      case 'authorizationStateWaitCode':
        return <AuthCode />;
      case 'authorizationStateWaitPassword':
        return <AuthPassword />;
      case 'authorizationStateWaitRegistration':
        return <AuthRegister />;
      case 'authorizationStateWaitPhoneNumber':
        return <AuthPhoneNumber />;
      case 'authorizationStateWaitQrCode':
        return <AuthQrCode />;
      default:
        return isMobile ? <AuthPhoneNumber /> : <AuthQrCode />;
    }
  }

  function getActiveKey() {
    switch (renderingAuthState) {
      case 'authorizationStateWaitCode':
        return 0;
      case 'authorizationStateWaitPassword':
        return 1;
      case 'authorizationStateWaitRegistration':
        return 2;
      case 'authorizationStateWaitPhoneNumber':
        return 3;
      case 'authorizationStateWaitQrCode':
        return 4;
      default:
        return isMobile ? 3 : 4;
    }
  }

  return (
    <Transition
      activeKey={getActiveKey()}
      name="fade"
      className="Auth"
      data-tauri-drag-region={IS_TAURI && IS_MAC_OS ? true : undefined}
    >
      {getScreen()}
    </Transition>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    return {
      authState: global.auth.state,
    };
  },
)(Auth));
