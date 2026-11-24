import '@mantine/core/styles.css';
import './app.css';
import { Alert, Center, MantineProvider } from '@mantine/core';
import type { UserManagerSettings } from 'oidc-client-ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from 'react-oidc-context';
import { fetchConfig, type PublicConfig } from './api';
import { App, Splash } from './App';
import { locale, t } from './messages';
import { cssVariablesResolver, theme } from './theme';

function oidcSettings(config: PublicConfig): UserManagerSettings {
  const appUrl = `${window.location.origin}/`;
  return {
    authority: `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`,
    client_id: config.clientId,
    redirect_uri: appUrl,
    response_type: 'code',
    scope: 'openid',
    // Cognito's discovery document lists no revocation_endpoint, so without this revokeTokens() throws.
    // https://docs.aws.amazon.com/cognito/latest/developerguide/revocation-endpoint.html
    metadataSeed: { revocation_endpoint: new URL('/oauth2/revoke', config.domain).toString() },
    // The managed login page's language: https://docs.aws.amazon.com/cognito/latest/developerguide/managed-login-brandingeditor.html
    extraQueryParams: { lang: locale },
  };
}

const onSigninCallback = () => window.history.replaceState({}, document.title, window.location.pathname);

document.documentElement.lang = locale;
document.title = t.title;

const root = createRoot(document.getElementById('root') as HTMLElement);
const render = (node: React.ReactNode) =>
  root.render(
    <StrictMode>
      <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme="auto">
        {node}
      </MantineProvider>
    </StrictMode>,
  );

render(<Splash />);

fetchConfig().then(
  (config) =>
    render(
      <AuthProvider {...oidcSettings(config)} onSigninCallback={onSigninCallback}>
        <App config={config} />
      </AuthProvider>,
    ),
  () =>
    render(
      <Center h="100vh">
        <Alert color="gray" variant="default">{t.configFailed}</Alert>
      </Center>,
    ),
);
