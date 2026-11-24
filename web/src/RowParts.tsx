import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { type FormEvent, useCallback, useState } from 'react';
import { failureKind, type VersionConflictError } from './api';
import { t } from './messages';
import { BUTTON_PADDING } from './theme';

interface RowChangeOptions<T> {
  initialMessage?: string | null;
  /** The row's notice after a 409 that carries the latest version (TODOs only; lists have no version). */
  conflictText?: string;
  goneText: string;
  replaceItem?: (item: T) => void;
  removeItem: (id: string) => void;
  onUnauthorized: () => void;
  /** A 404 on a screen-level call (load, add). Without it, the fallback text is shown. */
  onGone?: () => void;
}

export function useRowChange<T extends { id: string }>(options: RowChangeOptions<T>) {
  const { conflictText, goneText, replaceItem, removeItem, onUnauthorized, onGone } = options;
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(options.initialMessage ?? null);
  const setNotice = (id: string, text: string | undefined) =>
    setNotices(({ [id]: _old, ...rest }) => (text ? { ...rest, [id]: text } : rest));

  /** For a screen-level call (load, load more, add). */
  const reportFailure = useCallback(
    (error: unknown, fallback: string) => {
      const kind = failureKind(error);
      if (kind === 'unauthorized') onUnauthorized();
      else if (kind === 'gone' && onGone) onGone();
      else setMessage(kind === 'outcome-unknown' ? t.outcomeUnknown : fallback);
    },
    [onUnauthorized, onGone],
  );

  /**
   * Runs a change on one row and updates the screen. Returns true when an open
   * editor should close: the change was saved, or the row changed under it.
   */
  const run = async (id: string, change: () => Promise<T | void>): Promise<boolean> => {
    setNotice(id, undefined);
    try {
      const updated = await change();
      if (updated) replaceItem?.(updated);
      else removeItem(id);
      setMessage(null);
      return true;
    } catch (error) {
      switch (failureKind(error)) {
        case 'version-conflict': {
          // Optimistic locking: do not retry; show the latest version and let the person decide again.
          const current = (error as VersionConflictError).current as T;
          replaceItem?.(current);
          setNotice(current.id, conflictText);
          return true;
        }
        case 'gone':
          removeItem(id);
          setMessage(goneText);
          return true;
        case 'unauthorized':
          onUnauthorized();
          return false;
        case 'outcome-unknown':
          setMessage(t.outcomeUnknown);
          return false;
        case 'contended':
          setNotice(id, t.contended);
          return false;
        default:
          setNotice(id, t.failed);
          return false;
      }
    }
  };

  return { notices, setNotices, message, setMessage, reportFailure, run };
}

interface AddFormProps {
  label: string;
  maxLength: number;
  /** While the screen loads: the load replaces the rows, so a row added now would drop off the screen. */
  disabled: boolean;
  /** Resolves true when the input should be cleared. */
  onAdd: (value: string) => Promise<boolean>;
}

export function AddForm({ label, maxLength, disabled, onAdd }: AddFormProps) {
  const [value, setValue] = useState('');
  const [adding, setAdding] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || adding || disabled) return;
    setAdding(true);
    try {
      if (await onAdd(trimmed)) setValue('');
    } finally {
      setAdding(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)}>
      <Group align="flex-end" gap="sm" wrap="nowrap">
        <TextInput
          aria-label={label}
          placeholder={label}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          maxLength={maxLength}
          size="md"
          className="app-grow"
        />
        <Button
          type="submit"
          size="md"
          variant={value.trim() ? 'filled' : 'default'}
          loading={adding}
          disabled={!value.trim() || disabled}
        >
          {t.add}
        </Button>
      </Group>
    </form>
  );
}

export function ScreenMessage({ message, closable, onClose }: { message: string | null; closable: boolean; onClose: () => void }) {
  if (!message) return null;
  return (
    <Alert
      color="gray"
      variant="default"
      withCloseButton={closable}
      closeButtonLabel={t.close}
      onClose={onClose}
      classNames={{ root: 'app-notice' }}
    >
      <Text fw={600} className="app-wrap app-pretty">
        {message}
      </Text>
    </Alert>
  );
}

export function useBusy() {
  const [busy, setBusy] = useState(false);
  const act = async <T,>(action: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      return await action();
    } finally {
      setBusy(false);
    }
  };
  return { busy, act };
}

interface EditFormProps {
  label: string;
  initial: string;
  maxLength: number;
  busy: boolean;
  /** Resolves true when the editor should close. */
  onSave: (value: string) => Promise<boolean>;
  onCancel: () => void;
}

export function EditForm({ label, initial, maxLength, busy, onSave, onCancel }: EditFormProps) {
  const [draft, setDraft] = useState(initial);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    // A transient failure keeps the editor open so the draft is not lost.
    if (await onSave(draft.trim())) onCancel();
  };
  return (
    <form onSubmit={(event) => void save(event)}>
      <Group align="flex-end" gap="sm" wrap="wrap">
        <TextInput
          aria-label={label}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          maxLength={maxLength}
          size="md"
          className="app-edit-input"
          autoFocus
        />
        <Group gap="sm" wrap="nowrap" ml="auto">
          <Button type="submit" loading={busy} disabled={!draft.trim()}>
            {t.save}
          </Button>
          <Button variant="subtle" color="gray" c="dimmed" onClick={onCancel}>
            {t.cancel}
          </Button>
        </Group>
      </Group>
    </form>
  );
}

interface RowButtonsProps {
  /** Without onEdit there is no edit button (a list cannot be renamed). */
  editText?: string;
  /** Accessible names that say which row each button acts on, for example `Delete "Buy milk"`. */
  editLabel?: string;
  deleteLabel: string;
  /** While the row's change is in flight, so an editor cannot open on a row about to be replaced. */
  disabled: boolean;
  onEdit?: () => void;
  onDelete: () => void;
}

export function RowButtons({ editText, editLabel, deleteLabel, disabled, onEdit, onDelete }: RowButtonsProps) {
  return (
    <Group gap={4} wrap="nowrap" mr={-BUTTON_PADDING}>
      {onEdit && (
        <Button variant="subtle" color="gray" size="sm" c="dimmed" aria-label={editLabel} disabled={disabled} onClick={onEdit}>
          {editText}
        </Button>
      )}
      <Button
        variant="subtle"
        color="gray"
        size="sm"
        c="dimmed"
        className="app-delete"
        aria-label={deleteLabel}
        disabled={disabled}
        onClick={onDelete}
      >
        {t.delete}
      </Button>
    </Group>
  );
}

interface DeleteDialogProps {
  opened: boolean;
  title: string;
  body: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeleteDialog({ opened, title, body, busy, onConfirm, onClose }: DeleteDialogProps) {
  return (
    <Modal
      opened={opened}
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnEscape={!busy}
      closeOnClickOutside={!busy}
      withCloseButton={false}
      title={title}
      centered
    >
      <Stack gap="lg">
        <Text className="app-wrap">
          {body}
        </Text>
        <Group justify="flex-end" gap="sm" wrap="nowrap">
          {/* Cancel is the default focus and the safe choice. */}
          <Button variant="subtle" color="gray" c="dimmed" disabled={busy} onClick={onClose} data-autofocus>
            {t.cancel}
          </Button>
          <Button className="app-danger" loading={busy} onClick={onConfirm}>
            {t.delete}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
