import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Network, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { IpcError, ipc, type HostsEntry, type HostsSkipped } from "@/lib/ipc";

/** The marked entries, read when the dialog opens and rewritten by every
 * mutation — all four commands return the list they produced, so the table
 * never shows a state the helper did not just report. */
const HOSTS_KEY = ["hosts-entries"] as const;

/** One row being edited. `original` is the host name the row is filed under
 * now; when it differs from `hostname` the save has to move the entry. */
type Draft = {
  original: string | null;
  hostname: string;
  ip: string;
};

/**
 * §111's entry point: the manager, behind a button in the network strip.
 *
 * §111 calls this an optional utility, and the strip is a status line rather
 * than a row of cards — so the list lives in a dialog reached from the strip,
 * the same way §110's port inspector is reached from the resource panel.
 */
export function HostsButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
      >
        <Network aria-hidden />
        Hosts entries
      </Button>
      <HostsManager open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function HostsManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  /** The form's contents, or null when no add/edit is in progress. */
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The row awaiting confirmation. Nothing is removed while this is null. */
  const [removing, setRemoving] = useState<HostsEntry | null>(null);
  /** Site names the last re-sync could not write, with reasons. Cleared by
   * the next re-sync; entries are never removed from under this list. */
  const [skipped, setSkipped] = useState<HostsSkipped[]>([]);

  // Read on open, never polled: `hosts_list` does not elevate, but it is still
  // a helper round trip, and the file only changes when this dialog changes it.
  const entries = useQuery({
    queryKey: HOSTS_KEY,
    queryFn: ipc.hostsList,
    enabled: open,
  });

  const save = useMutation({
    mutationFn: (draft: Draft) => saveEntry(draft),
    onSuccess: (result, draft) => {
      queryClient.setQueryData(HOSTS_KEY, result);
      setDraft(null);
      toast.success(
        draft.original
          ? `${draft.hostname} was updated`
          : `${draft.hostname} now resolves to ${draft.ip}`,
        { description: "DevX manages this line in the Windows hosts file." },
      );
    },
    onError: (error, draft) => {
      // §54: the reason is the visible line. A refusal the user has to expand
      // "View Details" to read is a refusal they will miss.
      toast.error(
        draft.original ? `${draft.hostname} was not updated` : `${draft.hostname} was not added`,
        { description: reasonOf(error), details: hintOf(error) },
      );
      // A two-step save can land one of its halves, so the table is re-read
      // rather than trusted: showing the old rows here would be a guess.
      void queryClient.invalidateQueries({ queryKey: HOSTS_KEY });
    },
    // The form stays open on failure with the typed values intact, so a
    // rejected host name can be corrected instead of retyped.
  });

  const remove = useMutation({
    mutationFn: (entry: HostsEntry) => ipc.hostsRemove(entry.hostname),
    onSuccess: (result, entry) => {
      queryClient.setQueryData(HOSTS_KEY, result);
      toast.success(`${entry.hostname} was removed`, {
        description: `It no longer resolves to ${entry.ip} from the hosts file.`,
      });
    },
    onError: (error, entry) => {
      toast.error(`${entry.hostname} was not removed`, {
        description: reasonOf(error),
        details: hintOf(error),
      });
      void queryClient.invalidateQueries({ queryKey: HOSTS_KEY });
    },
    onSettled: () => setRemoving(null),
  });

  const flush = useMutation({
    mutationFn: ipc.hostsFlushDns,
    onSuccess: () => {
      toast.success("DNS cache flushed", {
        description:
          "Cached answers are gone, so the next lookup of every name is fresh.",
      });
    },
    onError: (error) => {
      toast.error("The DNS cache was not flushed", {
        description: reasonOf(error),
        details: hintOf(error),
      });
    },
  });

  const resync = useMutation({
    mutationFn: ipc.hostsResync,
    onSuccess: (result) => {
      queryClient.setQueryData<HostsEntry[]>(HOSTS_KEY, result.entries);
      setSkipped(result.skipped);
      if (result.skipped.length === 0) {
        toast.success("Hosts entries re-synced with your sites", {
          description:
            "Every site hostname and alias now points at its owning server. Hand-added lines were left alone.",
        });
      } else {
        toast.warning("Some names could not be written", {
          description: `${result.skipped.length} site name${result.skipped.length === 1 ? "" : "s"} still need${result.skipped.length === 1 ? "s" : ""} attention — see the list.`,
        });
      }
    },
    onError: (error) => {
      toast.error("Hosts entries were not re-synced", {
        description: reasonOf(error),
        details: hintOf(error),
      });
      void queryClient.invalidateQueries({ queryKey: HOSTS_KEY });
    },
  });

  const rows = entries.data ?? [];
  const busy = save.isPending || remove.isPending;

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        size="lg"
        title="Hosts entries"
        description="The lines DevX manages in the Windows hosts file. Entries you or other software added are not listed here and are never touched."
        footer={
          <>
            <Tooltip label="Rewrite every site hostname and alias with its owning server's address">
              <Button
                type="button"
                variant="outline"
                disabled={resync.isPending}
                onClick={() => resync.mutate()}
              >
                {resync.isPending ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <RefreshCw aria-hidden />
                )}
                Re-sync with sites
              </Button>
            </Tooltip>
            <Tooltip label="Drops the whole machine's DNS cache, not just these names">
              <Button
                type="button"
                variant="outline"
                disabled={flush.isPending}
                onClick={() => flush.mutate()}
              >
                {flush.isPending ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <RefreshCw aria-hidden />
                )}
                Flush DNS
              </Button>
            </Tooltip>
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        }
      >
        {entries.isPending ? (
          <p className="flex items-center gap-2 text-ink-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Reading the DevX hosts entries…
          </p>
        ) : entries.isError ? (
          /* §131 Rule 18: an unreadable list is not an empty list. The backend
             says why (usually: the privileged helper is not running), and
             nothing here offers a form that could not be applied. */
          <Callout variant="destructive" title="Could not read the hosts entries.">
            <p>{reasonOf(entries.error)}</p>
            {hintOf(entries.error) ? (
              <p className="mt-1">{hintOf(entries.error)}</p>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void entries.refetch()}
            >
              Try again
            </Button>
          </Callout>
        ) : (
          <div className="space-y-3">
            {/* §111: privileged operations are clearly communicated. Every
                button below can bring the helper up, and that is the one thing
                Windows shows a prompt for — so it is said before the buttons,
                not discovered by clicking one. */}
            <Callout variant="info" title="Windows may ask for administrator permission.">
              <p>
                Adding, changing, removing and flushing are applied by DevX's
                privileged helper, because Windows only lets an elevated
                process write the hosts file or drop the DNS cache. If the
                helper is not already running, Windows shows one permission
                prompt to start it. Declining that prompt applies nothing and
                changes nothing.
              </p>
            </Callout>

            {skipped.length > 0 ? (
              <Callout
                variant="destructive"
                title="Some site names need your hands."
              >
                <p>
                  DevX will not overwrite lines it did not write. Remove the
                  hand-written line for each name below (open the hosts file
                  as administrator), then Re-sync with sites.
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {skipped.map((s) => (
                    <li key={s.hostname}>
                      <span className="data-value" data-selectable>
                        {s.hostname}
                      </span>
                      {" — "}
                      {s.reason}
                    </li>
                  ))}
                </ul>
              </Callout>
            ) : null}

            {/* §38: the empty state says what it means — DevX manages nothing
                — rather than describing the hosts file as empty, which would
                be a claim about lines this panel cannot see. */}
            {rows.length === 0 ? (
              <EmptyState
                icon={<Network />}
                title="DevX does not manage any hosts entries."
                description="Sites are given a line here when the resolution strategy is the hosts file. Your own entries are not shown and are not affected."
              />
            ) : (
              <table className="w-full text-left text-sm">
                <caption className="sr-only">
                  Hosts entries managed by DevX, with the address each name
                  resolves to
                </caption>
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Host name
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Resolves to
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <tr key={entry.hostname} className="border-t border-border hover:bg-hover">
                      <td className="py-1.5 pr-3">
                        <span className="data-value text-foreground" data-selectable>
                          {entry.hostname}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3">
                        <span className="data-value text-ink-secondary" data-selectable>
                          {entry.ip}
                        </span>
                      </td>
                      <td className="py-1.5">
                        <div className="flex items-center justify-end gap-1">
                          <Tooltip label="Edit">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Edit ${entry.hostname}`}
                              onClick={() => setDraft({ ...entry, original: entry.hostname })}
                            >
                              <Pencil />
                            </Button>
                          </Tooltip>
                          {/* §123: the row action only opens the confirmation;
                              the destructive weight lives on its confirm
                              button, so no row reads as a trap. */}
                          <Tooltip label="Remove">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Remove ${entry.hostname}`}
                              onClick={() => setRemoving(entry)}
                            >
                              <Trash2 />
                            </Button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {draft ? (
              <form
                className="space-y-3 rounded-md border border-border p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  save.mutate(draft);
                }}
              >
                <p className="font-medium">
                  {draft.original ? `Edit ${draft.original}` : "Add an entry"}
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[12rem] flex-1 space-y-1">
                    <Label htmlFor="hosts-hostname">Host name</Label>
                    <Input
                      id="hosts-hostname"
                      required
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="myapp.test"
                      value={draft.hostname}
                      onChange={(event) =>
                        setDraft({ ...draft, hostname: event.target.value })
                      }
                    />
                  </div>
                  <div className="min-w-[10rem] flex-1 space-y-1">
                    <Label htmlFor="hosts-ip">IP address</Label>
                    <Input
                      id="hosts-ip"
                      required
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="127.0.0.1"
                      value={draft.ip}
                      onChange={(event) => setDraft({ ...draft, ip: event.target.value })}
                    />
                  </div>
                </div>
                <p className="text-xs text-ink-muted">
                  {draft.original
                    ? "Changing the host name removes the old line and adds the new one."
                    : "A host name DevX does not already manage must be free: a line added by hand for the same name is left alone and the entry is refused."}
                </p>
                <div className="flex items-center gap-2">
                  <Button type="submit" size="sm" disabled={busy}>
                    {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                    {draft.original ? "Save changes" : "Add entry"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setDraft(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setDraft({ original: null, hostname: "", ip: "127.0.0.1" })}
              >
                <Plus aria-hidden />
                Add entry
              </Button>
            )}
          </div>
        )}
      </Dialog>

      {/* §111: removing an entry changes how a name resolves, so it is
          confirmed — and the confirmation says what Windows will ask for. */}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) {
            remove.mutate(removing);
          }
        }}
        destructive
        pending={remove.isPending}
        title={removing ? `Remove ${removing.hostname}?` : "Remove entry?"}
        description={
          removing
            ? `Deletes DevX's hosts line for ${removing.hostname}, so it stops resolving to ${removing.ip} and goes back to whatever DNS answers. Windows may ask for administrator permission first: without elevation the hosts file cannot be written.`
            : ""
        }
        confirmLabel="Remove entry"
      />
    </>
  );
}

/**
 * Applies one draft: a create, an in-place update, or a rename.
 *
 * The helper keys entries by host name, so a renamed entry is an add of the
 * new name plus a remove of the old one. The order matters — the add goes
 * first. A new name that a hand-written line already maps is refused, and if
 * that refusal came after the removal, the user would have lost an entry to a
 * failure that changed nothing else.
 */
async function saveEntry(draft: Draft): Promise<HostsEntry[]> {
  const hostname = draft.hostname.trim().toLowerCase();
  const ip = draft.ip.trim();

  if (draft.original && draft.original.toLowerCase() !== hostname) {
    await ipc.hostsAdd(hostname, ip);
    return ipc.hostsRemove(draft.original);
  }
  return ipc.hostsAdd(hostname, ip);
}

/** The failure as the backend phrased it. */
function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** The backend's suggested next step, when it gave one. */
function hintOf(error: unknown): string | undefined {
  return error instanceof IpcError && error.hint ? error.hint : undefined;
}
