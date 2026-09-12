import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  FileText,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ipc,
  type MailStatus,
  type Message,
  type MessageSummary,
} from "@/lib/ipc";

/** Mail page: every message your apps sent, captured locally by Mailpit. */
export function MailPage() {
  const queryClient = useQueryClient();
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
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["mail-list"] });
      queryClient.invalidateQueries({ queryKey: ["mail-status"] });
    },
  });

  const busy = remove.isPending;
  const error =
    remove.error instanceof Error
      ? remove.error
      : messages.error instanceof Error
        ? messages.error
        : viewer.error instanceof Error
          ? viewer.error
          : null;

  const select = (id: string) => {
    setSelectedId(id);
    // Opening a message marks it read server-side; refresh the counters.
    void queryClient.invalidateQueries({ queryKey: ["mail-list"] });
    void queryClient.invalidateQueries({ queryKey: ["mail-status"] });
  };

  return (
    <>
      <PageHeader
        title="Mail"
        description="Every message your apps send is captured locally — nothing leaves your machine."
      />

      <div className="mx-auto w-full max-w-4xl space-y-4 p-6">
        <StatusCard status={status.data} />

        {error ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {error.message}
          </p>
        ) : null}

        {status.data?.running ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
            <MessageList
              messages={messages.data}
              pending={messages.isPending}
              selectedId={selectedId}
              onSelect={select}
              onDelete={(id) => remove.mutate([id])}
              deleting={busy && remove.variables?.length === 1}
            />
            <MessageViewer
              messageId={selectedId}
              message={viewer.data}
              pending={viewer.isPending}
            />
          </div>
        ) : null}

        {status.data?.running && (messages.data ?? []).length > 0 ? (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => remove.mutate([])}
            >
              <Trash2 />
              Clear inbox
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** SMTP target + inbox counters. */
function StatusCard({ status }: { status?: MailStatus }) {
  if (!status) {
    return null;
  }
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Inbox className="size-4 text-muted-foreground" aria-hidden />
          Mail catcher
          {status.running ? (
            <Badge variant="secondary">
              {status.unread ?? "?"} unread of {status.total ?? "?"}
            </Badge>
          ) : (
            <Badge variant="outline">stopped</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {status.running
            ? `Point your app's SMTP client at 127.0.0.1:${status.smtp_port}; read mail here or in Mailpit's own UI on port ${status.port}.`
            : "Start the mailpit service from the Services page to begin capturing mail."}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

/** The list of captured messages, newest first. */
function MessageList({
  messages,
  pending,
  selectedId,
  onSelect,
  onDelete,
  deleting,
}: {
  messages?: MessageSummary[];
  pending: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  return (
    <Card className="self-start">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Inbox</CardTitle>
      </CardHeader>
      <CardContent className="p-2">
        {pending ? (
          <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading messages…
          </p>
        ) : (messages ?? []).length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No messages yet. Send one from your app to see it here.
          </p>
        ) : (
          <ul className="space-y-1">
            {(messages ?? []).map((message) => (
              <li key={message.id}>
                <MessageRow
                  message={message}
                  selected={message.id === selectedId}
                  deleting={deleting}
                  onSelect={() => onSelect(message.id)}
                  onDelete={() => onDelete(message.id)}
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
  return (
    <div
      className={`group flex items-center gap-2 rounded-md p-2 text-sm ${
        selected ? "bg-accent" : "hover:bg-accent/50"
      }`}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onSelect}
      >
        {message.read ? (
          <MailOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <Mail className="size-4 shrink-0 text-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${message.read ? "" : "font-medium"}`}>
            {message.subject === "" ? "(no subject)" : message.subject}
          </span>
          <span className="block truncate text-xs text-muted-foreground" data-selectable>
            {message.from.name || message.from.address} →{" "}
            {message.to.map((to) => to.address).join(", ")}
          </span>
        </span>
        {!message.read ? (
          <span aria-label="unread" className="size-2 shrink-0 rounded-full bg-primary" />
        ) : null}
      </button>
      <Button
        variant="ghost"
        size="sm"
        className="opacity-0 transition-opacity group-hover:opacity-100"
        disabled={deleting}
        onClick={onDelete}
        aria-label={`Delete message ${message.subject === "" ? "(no subject)" : message.subject}`}
      >
        {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
      </Button>
    </div>
  );
}

/** The selected message: headers, attachment names, text or HTML body. */
function MessageViewer({
  messageId,
  message,
  pending,
}: {
  messageId: string | null;
  message?: Message;
  pending: boolean;
}) {
  if (messageId === null) {
    return (
      <Card className="self-start">
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          Select a message to read it. Viewing marks it read.
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
        <CardTitle className="text-base" data-selectable>
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
            <Badge key={attachment.part_id} variant="outline" className="font-mono">
              <FileText className="size-3" aria-hidden />
              {attachment.file_name}
            </Badge>
          ))}
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs" data-selectable>
          {message.text ?? "(no plain-text body)"}
        </pre>
      </CardContent>
    </Card>
  );
}
