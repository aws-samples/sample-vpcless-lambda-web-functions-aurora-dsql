import { Alert, Button, Center, Container, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from 'react-oidc-context';
import { createApi, type ListSummary, type PublicConfig } from './api';
import { Lists } from './Lists';
import { t } from './messages';
import { BUTTON_PADDING } from './theme';
import { TodoList } from './TodoList';

export const Splash = () => (
  <Center h="100vh">
    <Loader aria-label={t.loading} />
  </Center>
);

export function App({ config }: { config: PublicConfig }) {
  const auth = useAuth();
  // Read the token through a ref so a token refresh does not rebuild the Api and reload the screen. A layout
  // effect, not useEffect: it runs before the children's effects, so their first request carries the token.
  const authRef = useRef(auth);
  useLayoutEffect(() => {
    authRef.current = auth;
  });
  const api = useMemo(() => createApi(() => authRef.current.user?.access_token), []);
  const signIn = useCallback(() => void authRef.current.signinRedirect(), []);
  // null: the lists screen.
  const [open, setOpen] = useState<ListSummary | null>(null);
  const [listsMessage, setListsMessage] = useState<string | null>(null);
  const showLists = useCallback((message: string | null) => {
    setListsMessage(message);
    setOpen(null);
  }, []);
  const onListGone = useCallback(() => showLists(t.listGone), [showLists]);

  if (auth.isLoading || auth.activeNavigator) return <Splash />;

  if (!auth.isAuthenticated) {
    return (
      <Container size="xs" py="xl">
        <Stack>
          <Title order={1} size="h2">
            {t.title}
          </Title>
          <Text>{t.signInPrompt}</Text>
          {auth.error && <Alert color="gray" variant="default">{t.signInFailed}</Alert>}
          <Button onClick={signIn}>{t.signIn}</Button>
        </Stack>
      </Container>
    );
  }

  // Cognito's discovery document has no end_session_endpoint, so the /logout URL is built here.
  const signOut = async () => {
    try {
      await auth.revokeTokens(['refresh_token']);
    } catch (error) {
      console.warn('Could not revoke the refresh token on sign-out; it may stay valid until it expires.', error);
    }
    await auth.removeUser();
    const url = new URL('/logout', config.domain);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('logout_uri', `${window.location.origin}/`);
    window.location.assign(url.toString());
  };

  return (
    <Container size="sm" py="xl" px={24}>
      <Stack gap="lg">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Title order={1} size="h2">
            {t.title}
          </Title>
          <Group gap="sm" wrap="nowrap" align="center" mr={-BUTTON_PADDING}>
            <Text size="xs" c="dimmed" visibleFrom="xs">
              {auth.user?.profile['cognito:username'] as string | undefined}
            </Text>
            <Button variant="subtle" color="gray" size="sm" c="dimmed" onClick={() => void signOut()}>
              {t.signOut}
            </Button>
          </Group>
        </Group>
        {open ? (
          <TodoList api={api} list={open} onUnauthorized={signIn} onBack={() => showLists(null)} onListGone={onListGone} />
        ) : (
          <Lists api={api} onOpen={setOpen} onUnauthorized={signIn} initialMessage={listsMessage} />
        )}
      </Stack>
    </Container>
  );
}
