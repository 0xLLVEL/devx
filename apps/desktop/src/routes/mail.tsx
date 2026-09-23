import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  Inbox,
  Loader2,
  Mail,
  MailCheck,
  MailOpen,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ipc,
  type MailStatus,
  type Message,
  type MessageSummary,
} from "@/lib/ipc";

/** A rejection that is not an `Error` still has to say something (§131 Rule 18). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A captured message with no subject still needs a name in copy. */
function subjectOf(message: MessageSummary): string {
  return message.subject === "" ? "(no subject)" : message.subject;
}

/** Mail page: every message your apps sent, captured locally by Mailpit. */
export function MailPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmClear, setConfirmClear] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MessageSummary | null>(null);
  const status = useQuery({
    queryKey: ["mail-status"],
    queryFn: ipc.mailStatus,
    refetchInterval: 4000,
  });
  const messages = useQuery({
    queryKey: ["mail-list"],
    queryFn: () => ipc.mailList(50),
    enabled: status.data?.running === true,
    refetchInterval: 4000,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const viewer = useQuery({
    queryKey: ["mail-message", selectedId],
    queryFn: () => ipc.mailMessage(selectedId!),
    enabled: selectedId !== null,
  });

  const remove = useMutation({
    mutationFn: (ids: string[]) => ipc.mailDelete(ids),
    onSuccess: (_result, ids) => {
      // The confirmation owns the pending state, so it closes when the delete
      // has actually landed rather than the moment the click happens.
      setConfirmClear(false);
      setDeleteTarget(null);
      if (ids.length === 0) {
        toast.success("Inbox cleared");
      } else {
        toast.success(ids.length === 1 ? "Message deleted" : `${ids.length} messages deleted`);
      }
    },
    onError: (error: Error) => {
      toast.error("Could not delete the messages", { details: error.message });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["mail-list"] });
      queryClient.invalidateQueries({ queryKey: ["mail-status"] });
    },
  });

  const markAllRead = useMutation({
    mutationFn: ipc.mailMarkAllRead,
    onSuccess: () => toast.success("Inbox marked read"),
    onError: (error: Error) => {
      toast.error("Could not mark the inbox read", { details: error.message });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["mail-list"] });
      queryClient.invalidateQueries({ queryKey: ["mail-status"] });
    },
  });
  const sendTest = useMutation({
    mutationFn: ipc.mailSendTest,
    onSuccess: () => toast.success("Test message sent"),
    onError: (error: Error) => {
      toast.error("Could not send the test message", { details: error.message });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["mail-list"] });
      queryClient.invalidateQueries({ queryKey: ["mail-status"] });
    },
  });

  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visibleMessages = (messages.data ?? []).filter((message) => {
    if (needle === "") return true;
    return (
      message.subject.toLowerCase().includes(needle) ||
      message.from.address.toLowerCase().includes(needle) ||
      message.from.name.toLowerCase().includes(needle)
    );
  });

  const busy = remove.isPending;
  // Only the row that is actually being deleted reports it (§121).
  const deletingId =
    remove.isPending && remove.variables?.length === 1 ? (remove.variables[0] ?? null) : null;
  // Query failures are rendered by the panel they emptied, so the banner is
  // left with the inbox actions, which have no refetch of their own.
  const actionError =
    remove.error !== null
      ? { title: "Could not delete the messages.", error: remove.error }
      : markAllRead.error !== null
        ? { title: "Could not mark the inbox read.", error: markAllRead.error }
        : sendTest.error !== null
          ? { title: "Could not send the test message.", error: sendTest.error }
          : null;
  const statusFailed = status.isError && status.data === undefined;
  const listError = messages.isError && messages.data === undefined ? messages.error : null;
  const viewerError = viewer.isError && viewer.data === undefined ? viewer.error : null;

  const select = (id: string) => {
    setSelectedId(id);
    // Opening a message marks it read server-side; refresh the counters.
    void queryClient.invalidateQueries({ queryKey: ["mail-list"] });
    void queryClient.invalidateQueries({ queryKey: ["mail-status"] });
  };

  const unreadCount = (messages.data ?? []).filter((m) => !m.read).length;

  return (
    <>
      <div className="mx-auto w-full max-w-5xl space-y-6 p-8">
        {statusFailed ? (
          <Callout variant="destructive" title="Could not read the mail catcher status.">
            <p>{errorText(status.error)}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void status.refetch()}
            >
              Try again
            </Button>
          </Callout>
        ) : (
          <StatusCard
            status={status.data}
            busy={sendTest.isPending || markAllRead.isPending}
            unreadCount={unreadCount}
            onSendTest={() => sendTest.mutate()}
            onMarkAllRead={() => markAllRead.mutate()}
          />
        )}

        {actionError ? (
          <Callout variant="destructive" title={actionError.title}>
            <p>{errorText(actionError.error)}</p>
          </Callout>
        ) : null}

        {status.data?.running ? (
          <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
            <MessageList
              messages={visibleMessages}
              pending={messages.isPending}
              error={listError}
              onRetry={() => void messages.refetch()}
              filter={filter}
              onFilter={setFilter}
              selectedId={selectedId}
              onSelect={select}
              onDelete={(message) => setDeleteTarget(message)}
              deletingId={deletingId}
            />
            <MessageViewer
              messageId={selectedId}
              message={viewer.data}
              pending={viewer.isPending}
              error={viewerError}
              onRetry={() => void viewer.refetch()}
            />
          </div>
        ) : status.data && !status.data.running ? (
          // §38: the status card only says the catcher is off; the page still
          // owes the user the action that turns it on.
          <Card>
            <CardContent className="p-6">
              <EmptyState
                icon={<Inbox />}
                title="Nothing is being captured yet."
                description="With the catcher running, every message your app sends is held here instead of being delivered."
                action={
                  <Link
                    to="/services"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Open Services
                  </Link>
                }
              />
            </CardContent>
          </Card>
        ) : null}

        {status.data?.running && (messages.data ?? []).length > 0 ? (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 />
              Clear inbox
            </Button>
          </div>
        ) : null}
      </div>

      {/* §35: name the loss and its scope instead of asking "are you sure?". */}
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => remove.mutate([])}
        title="Delete every captured message?"
        description={`All ${(messages.data ?? []).length} messages in the Mailpit inbox are deleted, including the read ones. Nothing is sent or forwarded anywhere — the inbox simply starts empty.`}
        confirmLabel="Delete all messages"
        destructive
        pending={remove.isPending}
      />

      {/* §35: one message is lost for good, so the loss is named before it happens. */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            remove.mutate([deleteTarget.id]);
          }
        }}
        title={deleteTarget ? `Delete "${subjectOf(deleteTarget)}"?` : "Delete this message?"}
        description="The message is removed from the Mailpit inbox and cannot be recovered. Nothing is sent or forwarded anywhere."
        confirmLabel="Delete message"
        destructive
        pending={remove.isPending}
      />
    </>
  );
}

/**
 * SMTP target + inbox counters as a status strip, with the inbox actions:
 * send a test email, mark everything read, and filter the list.
 */
function StatusCard({
  status,
  busy,
  unreadCount,
  onSendTest,
  onMarkAllRead,
}: {
  status?: MailStatus;
  busy: boolean;
  unreadCount: number;
  onSendTest: () => void;
  onMarkAllRead: () => void;
}) {
  if (!status) {
    // §37/§121: the first read gets a skeleton, so the page is never blank.
    return (
      <div className="space-y-2" role="status">
        <span className="sr-only">Loading the mail catcher status…</span>
        <span aria-hidden className="block h-7 w-64 shimmer-skeleton rounded-sm" />
        <span aria-hidden className="block h-4 w-full max-w-2xl shimmer-skeleton rounded-sm" />
      </div>
    );
  }
  return (
    <>
      <PageHeader
        title={status.running ? "Mail catcher is capturing." : "Mail catcher is off."}
        description={
          status.running
            ? "Mail your sites send lands here — nothing leaves the machine."
            : "Start the mailpit service from the Services page to begin capturing mail."
        }
        right={
          <div className="flex flex-col items-end gap-2">
            {status.running ? (
              <Badge variant="default" className="data-value">
                {status.unread ?? "?"} unread · {status.total ?? "?"} captured
              </Badge>
            ) : (
              <Badge variant="outline">stopped</Badge>
            )}
            {status.running ? (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={onSendTest}>
                  {busy ? <Loader2 className="animate-spin" /> : <Send />}
                  Send test email
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || unreadCount === 0}
                  onClick={onMarkAllRead}
                >
                  <MailCheck />
                  Mark all read
                </Button>
              </div>
            ) : null}
          </div>
        }
      />
      {status.running ? (
        <Card>
          <CardContent className="grid gap-6 sm:grid-cols-2 p-4">
            <div className="space-y-1.5">
              <p className="text-caption text-ink-muted">SMTP — point your app here</p>
              <div className="flex items-center gap-2">
                <span
                  className="border border-line-strong bg-surface px-3.5 py-2 font-mono text-[13px]"
                  data-selectable
                >
                  127.0.0.1:{status.smtp_port}
                </span>
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-caption text-ink-muted">Mailpit&apos;s own UI</p>
              <div className="flex items-center gap-2">
                <span
                  className="border border-line-strong bg-surface px-3.5 py-2 font-mono text-[13px]"
                  data-selectable
                >
                  127.0.0.1:{status.port}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => window.open(`http://127.0.0.1:${status.port}`, "_blank")}
                >
                  Open
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

/** The list of captured messages, newest first, with a text filter. */
function MessageList({
  messages,
  pending,
  error,
  onRetry,
  filter,
  onFilter,
  selectedId,
  onSelect,
  onDelete,
  deletingId,
}: {
  messages?: MessageSummary[];
  pending: boolean;
  error?: unknown;
  onRetry: () => void;
  filter: string;
  onFilter: (value: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (message: MessageSummary) => void;
  deletingId: string | null;
}) {
  return (
    <Card className="self-start">
      <CardHeader className="pb-3">
        <CardTitle data-selectable>Inbox</CardTitle>
        <div className="relative mt-2">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
            placeholder="Filter by sender or subject…"
            className="pl-8"
            aria-label="Filter messages"
          />
        </div>
      </CardHeader>
      <CardContent className="p-2">
        {error != null ? (
          <Callout variant="destructive" title="Could not read the inbox.">
            <p>{errorText(error)}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
              Try again
            </Button>
          </Callout>
        ) : pending ? (
          <div className="space-y-2 p-4" role="status">
            <span className="sr-only">Loading messages…</span>
            {[0, 1, 2].map((row) => (
              <span
                key={row}
                aria-hidden
                className="block h-9 shimmer-skeleton rounded-sm"
              />
            ))}
          </div>
        ) : (messages ?? []).length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Inbox />}
              title={filter ? "No messages match the filter." : "No messages yet."}
              description={
                filter
                  ? "Clear the filter to see every captured message."
                  : "Send one from your app — or use Send test email — to see it here."
              }
              action={
                filter ? (
                  <Button size="sm" variant="outline" onClick={() => onFilter("")}>
                    Clear filter
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ul className="space-y-1">
            {(messages ?? []).map((message) => (
              <li key={message.id}>
                <MessageRow
                  message={message}
                  selected={message.id === selectedId}
                  deleting={message.id === deletingId}
                  onSelect={() => onSelect(message.id)}
                  onDelete={() => onDelete(message)}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** One message row: unread dot, sender, subject, delete control. */
function MessageRow({
  message,
  selected,
  deleting,
  onSelect,
  onDelete,
}: {
  message: MessageSummary;
  selected: boolean;
  deleting: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const subject = subjectOf(message);
  const participants = `${message.from.name || message.from.address} → ${message.to
    .map((to) => to.address)
    .join(", ")}`;
  return (
    <div
      className={`group flex items-center gap-2 rounded-sm text-sm transition-colors duration-150 ${
        selected ? "bg-accent" : ""
      }`}
    >
      {/* The row's padding lives on the button, so cursor, hover and hit area agree. */}
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm p-2 text-left transition-colors duration-150 hover:bg-accent/50"
        onClick={onSelect}
      >
        {message.read ? (
          <MailOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <Mail className="size-4 shrink-0 text-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate ${message.read ? "" : "font-medium"}`}
            title={subject}
          >
            {subject}
          </span>
          <span
            className="block truncate text-xs text-muted-foreground"
            title={participants}
            data-selectable
          >
            {participants}
          </span>
        </span>
        {!message.read ? (
          <>
            {/* §55: the dot is decoration; the state is the text. */}
            <span className="sr-only">Unread</span>
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
          </>
        ) : null}
      </button>
      <Tooltip label="Delete message">
        <Button
          variant="ghost"
          size="sm"
          className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          disabled={deleting}
          onClick={onDelete}
          aria-label={`Delete message ${subject}`}
        >
          {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </Button>
      </Tooltip>
    </div>
  );
}

/** The selected message: headers, attachment names, text or HTML body. */
function MessageViewer({
  messageId,
  message,
  pending,
  error,
  onRetry,
}: {
  messageId: string | null;
  message?: Message;
  pending: boolean;
  error?: unknown;
  onRetry: () => void;
}) {
  if (messageId === null) {
    return (
      <Card className="self-start">
        <CardContent className="p-4">
          <EmptyState
            icon={<MailOpen />}
            title="Select a message to read it."
            description="Viewing marks it read."
          />
        </CardContent>
      </Card>
    );
  }
  if (error != null) {
    return (
      <Card className="self-start">
        <CardContent className="p-4">
          <Callout variant="destructive" title="Could not read the message.">
            <p>{errorText(error)}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
              Try again
            </Button>
          </Callout>
        </CardContent>
      </Card>
    );
  }
  if (pending) {
    return (
      <Card className="self-start">
        <CardContent className="p-8">
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading message…
          </p>
        </CardContent>
      </Card>
    );
  }
  if (!message) {
    return null;
  }
  return (
    <Card className="self-start">
      <CardHeader className="pb-3">
        <CardTitle data-selectable>
          {message.subject === "" ? "(no subject)" : message.subject}
        </CardTitle>
        <CardDescription data-selectable>
          {message.from.name
            ? `${message.from.name} <${message.from.address}>`
            : message.from.address}{" "}
          → {message.to.map((to) => to.address).join(", ")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {message.attachments.map((attachment) => (
            <Badge
              key={attachment.part_id}
              variant="outline"
              className="max-w-full font-mono"
              title={attachment.file_name}
            >
              <FileText className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{attachment.file_name}</span>
            </Badge>
          ))}
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-muted/30 p-3 font-mono text-xs" data-selectable>
          {message.text ?? "(no plain-text body)"}
        </pre>
      </CardContent>
    </Card>
  );
}
