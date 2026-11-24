import { Box, Button, Checkbox, Group, Stack, Text, Title } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import type { Api, ListSummary, Todo } from './api';
import { t } from './messages';
import { AddForm, DeleteDialog, EditForm, RowButtons, ScreenMessage, useBusy, useRowChange } from './RowParts';
import { BUTTON_PADDING } from './theme';

interface Props {
  api: Api;
  list: ListSummary;
  onUnauthorized: () => void;
  onBack: () => void;
  /** The list was deleted by someone else (a 404 on load or add). */
  onListGone: () => void;
}

export function TodoList({ api, list, onUnauthorized, onBack, onListGone }: Props) {
  const [items, setItems] = useState<Todo[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const { notices, setNotices, message, setMessage, reportFailure, run } = useRowChange<Todo>({
    conflictText: t.conflict,
    goneText: t.goneByOthers,
    replaceItem: (todo) => setItems((all) => all.map((item) => (item.id === todo.id ? todo : item))),
    removeItem: (id) => setItems((all) => all.filter((item) => item.id !== id)),
    onUnauthorized,
    onGone: onListGone,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const page = await api.list(list.id);
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setNotices({});
      setLoadFailed(false);
    } catch (error) {
      setLoadFailed(true);
      reportFailure(error, t.loadListFailed);
    } finally {
      setLoading(false);
    }
  }, [api, list.id, reportFailure, setNotices, setMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.list(list.id, nextCursor);
      setItems((all) => [...all, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      reportFailure(error, t.failed);
    } finally {
      setLoadingMore(false);
    }
  };

  const add = async (title: string) => {
    try {
      const todo = await api.create(list.id, title);
      // New items sort to the end (oldest first).
      if (nextCursor) setMessage(t.addedAtEnd);
      else {
        setItems((all) => [...all, todo]);
        setMessage(null);
      }
      return true;
    } catch (error) {
      reportFailure(error, t.failed);
      return false;
    }
  };

  return (
    <Stack gap="lg">
      <Stack gap={4} align="flex-start">
        <Button variant="subtle" color="gray" c="dimmed" size="sm" ml={-BUTTON_PADDING} onClick={onBack}>
          ← {t.backToLists}
        </Button>
        <Title order={2} size="h3" className="app-wrap">
          {list.name}
        </Title>
      </Stack>

      <AddForm label={t.newTodo} maxLength={200} disabled={loading} onAdd={add} />

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
          {t.empty}
        </Text>
      ) : (
        <>
          <Stack gap={0}>
            {items.map((todo) => (
              <TodoItem
                key={todo.id}
                todo={todo}
                notice={notices[todo.id]}
                onToggle={(completed) => run(todo.id, () => api.update(todo, { completed }))}
                onSave={(title) => run(todo.id, () => api.update(todo, { title }))}
                onDelete={() => run(todo.id, () => api.remove(todo))}
              />
            ))}
          </Stack>

          <Group gap="md" ml={-BUTTON_PADDING}>
            {nextCursor && (
              <Button variant="subtle" loading={loadingMore} onClick={() => void loadMore()}>
                {t.loadMore}
              </Button>
            )}
            <Button variant="subtle" color="gray" c="dimmed" disabled={loadingMore} onClick={() => void load()}>
              {t.refresh}
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}

interface ItemProps {
  todo: Todo;
  notice: string | undefined;
  onToggle: (completed: boolean) => Promise<boolean>;
  onSave: (title: string) => Promise<boolean>;
  onDelete: () => Promise<unknown>;
}

function TodoItem({ todo, notice, onToggle, onSave, onDelete }: ItemProps) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, act } = useBusy();

  const confirmDelete = async () => {
    await act(onDelete);
    setConfirming(false);
  };

  return (
    <Box className="app-row" py="sm">
      <Stack gap="xs">
        {editing ? (
          <EditForm
            label={t.editTitle}
            initial={todo.title}
            maxLength={200}
            busy={busy}
            onSave={(title) => act(() => onSave(title))}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <Group justify="space-between" wrap="nowrap" gap="md" align="flex-start">
            <Checkbox
              checked={todo.completed}
              size="md"
              disabled={busy}
              onChange={(event) => void act(() => onToggle(event.currentTarget.checked))}
              label={
                <Text td={todo.completed ? 'line-through' : undefined} c={todo.completed ? 'dimmed' : undefined} className="app-wrap">
                  {todo.title}
                </Text>
              }
              description={t.updatedBy(todo.updatedBy)}
              aria-label={t.toggleDone(todo.title, todo.completed)}
              classNames={{ root: 'app-row-main' }}
              styles={{
                body: { minWidth: 0, alignItems: 'flex-start' },
                labelWrapper: { minWidth: 0 },
              }}
            />
            <RowButtons
              editText={t.edit}
              editLabel={t.editItem(todo.title)}
              deleteLabel={t.deleteItem(todo.title)}
              disabled={busy}
              onEdit={() => setEditing(true)}
              onDelete={() => setConfirming(true)}
            />
          </Group>
        )}
        {notice && (
          <Text size="sm" fw={600} role="status" className="app-notice app-wrap">
            {notice}
          </Text>
        )}
      </Stack>

      <DeleteDialog
        opened={confirming}
        title={t.deleteTitle}
        body={t.deleteConfirm(todo.title)}
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onClose={() => setConfirming(false)}
      />
    </Box>
  );
}
