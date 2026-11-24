import { Box, Button, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import type { Api, List, ListSummary } from './api';
import { t } from './messages';
import { AddForm, DeleteDialog, RowButtons, ScreenMessage, useBusy, useRowChange } from './RowParts';
import { BUTTON_PADDING } from './theme';

interface Props {
  api: Api;
  onOpen: (list: ListSummary) => void;
  onUnauthorized: () => void;
  /** A message to show first, for example that the list just left was deleted. */
  initialMessage: string | null;
}

export function Lists({ api, onOpen, onUnauthorized, initialMessage }: Props) {
  const [items, setItems] = useState<ListSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const { notices, setNotices, message, setMessage, reportFailure, run } = useRowChange<List>({
    initialMessage,
    goneText: t.listGone,
    removeItem: (id) => setItems((all) => all.filter((item) => item.id !== id)),
    onUnauthorized,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems((await api.lists()).items);
      setNotices({});
      setLoadFailed(false);
      // Clear an earlier load failure, but keep the message the screen opened with.
      setMessage((shown) => (shown === t.loadListsFailed ? null : shown));
    } catch (error) {
      setLoadFailed(true);
      reportFailure(error, t.loadListsFailed);
    } finally {
      setLoading(false);
    }
  }, [api, reportFailure, setNotices, setMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (name: string) => {
    try {
      const list = await api.createList(name);
      setItems((all) => [...all, list]);
      setMessage(null);
      return true;
    } catch (error) {
      reportFailure(error, t.failed);
      return false;
    }
  };

  return (
    <Stack gap="lg">
      <AddForm label={t.newList} maxLength={100} disabled={loading} onAdd={add} />

      <ScreenMessage message={message} closable={!loadFailed} onClose={() => setMessage(null)} />

      {loading ? (
        <Text c="dimmed" py="md" role="status">
          {t.loading}
        </Text>
      ) : loadFailed ? (
        <Group ml={-BUTTON_PADDING}>
          <Button variant="subtle" onClick={() => void load()}>
            {t.refresh}
          </Button>
        </Group>
      ) : items.length === 0 ? (
        <Text c="dimmed" py="md">
          {t.noLists}
        </Text>
      ) : (
        <>
          <Stack gap={0}>
            {items.map((list) => (
              <ListItem
                key={list.id}
                list={list}
                notice={notices[list.id]}
                onOpen={() => onOpen(list)}
                onDelete={() => run(list.id, () => api.removeList(list))}
              />
            ))}
          </Stack>
          <Group ml={-BUTTON_PADDING}>
            <Button variant="subtle" color="gray" c="dimmed" onClick={() => void load()}>
              {t.refresh}
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}

interface ItemProps {
  list: ListSummary;
  notice: string | undefined;
  onOpen: () => void;
  onDelete: () => Promise<unknown>;
}

function ListItem({ list, notice, onOpen, onDelete }: ItemProps) {
  const [confirming, setConfirming] = useState(false);
  const { busy, act } = useBusy();

  const confirmDelete = async () => {
    await act(onDelete);
    setConfirming(false);
  };

  return (
    <Box className="app-row" py="sm">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" gap="md" align="flex-start">
          <UnstyledButton onClick={onOpen} aria-label={t.openList(list.name)} className="app-row-main">
            <Text fw={600} className="app-list-name app-wrap">
              {list.name}
            </Text>
            <Text size="sm" c="dimmed">
              <span className="app-nowrap">{t.listCounts(list.openCount, list.totalCount)}</span> ·{' '}
              <span className="app-nowrap">{t.createdBy(list.createdBy)}</span>
            </Text>
          </UnstyledButton>
          <RowButtons deleteLabel={t.deleteItem(list.name)} disabled={busy} onDelete={() => setConfirming(true)} />
        </Group>
        {notice && (
          <Text size="sm" fw={600} role="status" className="app-notice app-wrap">
            {notice}
          </Text>
        )}
      </Stack>

      <DeleteDialog
        opened={confirming}
        title={t.deleteListTitle}
        body={t.deleteListConfirm(list.name)}
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onClose={() => setConfirming(false)}
      />
    </Box>
  );
}
