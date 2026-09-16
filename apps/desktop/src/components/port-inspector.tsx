import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Plug, RefreshCw, Square } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { IpcError, ipc, type PortOwner } from "@/lib/ipc";

/** The listener table. Read on open, refreshed on request, never polled: a row
 * that disappears while the user reads it is worse than a stale one. */
const LISTENING_PORTS_KEY = ["listening-ports"] as const;

/** Shared with the dashboard and the services page, so opening the inspector
 * shows the port map they already polled instead of asking again. */
const PORT_MAP_KEY = ["port-map"] as const;

/**
 * §110's entry point: the inspector, behind a button.
 *
 * The listener table is the one view that is about the machine rather than
 * about DevX, so the dialog says so before the first row: `port_map` lists the
 * ports DevX reserves, this lists everything Windows is accepting connections
 * on, and the "Claimed by" column marks which rows are DevX's. A user who
 * reads "port 5432" here must not conclude DevX owns it.
 *
 * Reading is unprivileged. Stopping is not always: the backend ends the
 * process only if Windows lets this user end it, and says so when it does not
 * (§131 Rule 18). Nothing on this screen raises the window's privilege.
 *
 * Self-contained on purpose — it opens from the resource panel and from a
 * server's Ports tab, and neither of those should have to own its state.
 */
export function PortInspectorButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
      >
        <Plug aria-hidden />
        Inspect ports
      </Button>
      <PortInspector open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function PortInspector({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  /** The row awaiting confirmation. Nothing is stopped while this is null. */
  const [stopping, setStopping] = useState<PortOwner | null>(null);

  // Both reads start when the dialog opens and stop mattering when it closes:
  // a dialog nobody opened must not cost a system call.
  const ports = useQuery({
    queryKey: LISTENING_PORTS_KEY,
    queryFn: ipc.listeningPorts,
    enabled: open,
  });
  const claimed = useQuery({
    queryKey: PORT_MAP_KEY,
    queryFn: ipc.portMap,
    enabled: open,
  });

  const stop = useMutation({
    mutationFn: (owner: PortOwner) => ipc.stopProcessOnPort(owner.pid, owner.port),
    onSuccess: (_result, owner) => {
      toast.success(`${processName(owner)} was stopped`, {
        description: `PID ${owner.pid} no longer holds port ${owner.port}.`,
      });
      // The list is the only thing on screen that changed.
      void queryClient.invalidateQueries({ queryKey: LISTENING_PORTS_KEY });
    },
    onError: (error, owner) => {
      // §54: a refusal is feedback too. The reason is the visible line — a
      // refusal behind "View Details" is a refusal the user never reads.
      toast.error(`${processName(owner)} was not stopped`, {
        description: reasonOf(error),
        details: hintOf(error),
      });
    },
    // Either way the confirmation is done with: on success the row must not be
    // clickable again, on failure the message says to reload the list.
    onSettled: () => setStopping(null),
  });

  // What DevX claims, by port, so a row can say whose it is. The port map is
  // DevX's own answer, not a guess made from the process name.
  const devxPorts = new Map(
    (claimed.data ?? []).map((entry) => [entry.port, entry.owner]),
  );
  const rows = ports.data ?? [];
  const claimsKnown = claimed.isSuccess;

  /**
   * What one row's "Claimed by" cell says. Three answers rather than two,
   * because a port map that has not answered is not a port map that says
   * "no" — and a row labelled "another process" that turns out to be DevX's
   * own MariaDB is exactly the confusion this dialog exists to prevent.
   */
  const claimLabel = (port: number): string => {
    if (claimed.isError) {
      return "Unknown";
    }
    if (claimed.isPending) {
      return "Checking…";
    }
    const owner = devxPorts.get(port);
    return owner ? `DevX · ${owner}` : "Another process";
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        size="lg"
        title="Port inspector"
        description="Every IPv4 TCP port in the LISTEN state on this machine, with the process holding it. Some of these are DevX's; the rest belong to other software."
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              disabled={ports.isFetching}
              onClick={() => void ports.refetch()}
            >
              {ports.isFetching ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <RefreshCw aria-hidden />
              )}
              Refresh
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        }
      >
        {ports.isPending ? (
          <p className="flex items-center gap-2 text-ink-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Reading the port list…
          </p>
        ) : ports.isError ? (
          // §131 Rule 18: "nothing is listening" and "the table could not be
          // read" are different answers, and this is the second one.
          <Callout variant="destructive" title="Could not read the port list.">
            <p>{reasonOf(ports.error)}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void ports.refetch()}
            >
              Try again
            </Button>
          </Callout>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Plug />}
            title="No IPv4 port is in the LISTEN state."
            description="Nothing is accepting IPv4 TCP connections right now."
          />
        ) : (
          <div className="space-y-3">
            {claimsKnown ? null : (
              // §131 Rule 17: an unread port map is not an empty one, and a
              // column that answered "another process" here would be lying
              // about DevX's own services.
              <Callout variant="warning" title="The port map could not be read.">
                <p>
                  So this table cannot say which of these ports DevX claims.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => void claimed.refetch()}
                >
                  Try again
                </Button>
              </Callout>
            )}
            <div className="max-h-[55vh] overflow-y-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">
                  TCP ports in the LISTEN state, with the process holding each one
                </caption>
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="sticky top-0 bg-elevated py-2 pr-3 font-medium">
                      Port
                    </th>
                    <th scope="col" className="sticky top-0 bg-elevated py-2 pr-3 font-medium">
                      Process
                    </th>
                    <th scope="col" className="sticky top-0 bg-elevated py-2 pr-3 font-medium">
                      PID
                    </th>
                    <th scope="col" className="sticky top-0 bg-elevated py-2 pr-3 font-medium">
                      Claimed by
                    </th>
                  <th scope="col" className="sticky top-0 bg-elevated py-2 text-right font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((owner, index) => {
                  return (
                    <tr
                      // A process can hold the same port on two addresses, so
                      // port and PID alone would not be unique.
                      key={`${owner.port}-${owner.pid}-${index}`}
                      className="border-t border-border hover:bg-hover"
                    >
                      <td className="py-1.5 pr-3">
                        <span className="data-value text-foreground" data-selectable>
                          {owner.port}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3">
                        <span className="data-value text-ink-secondary">
                          {owner.process_name ?? "unknown"}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3">
                        <span className="data-value text-ink-secondary" data-selectable>
                          {owner.pid}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-xs text-ink-muted">
                        {claimLabel(owner.port)}
                      </td>
                      <td className="py-1.5">
                        <div className="flex items-center justify-end gap-1">
                          <Tooltip label="Copy PID">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Copy PID ${owner.pid}`}
                              onClick={() => void copyPid(toast, owner)}
                            >
                              <Copy />
                            </Button>
                          </Tooltip>
                          {/* §123: the row action only opens the confirmation;
                              the destructive weight lives on its confirm
                              button, so no row reads as a trap. */}
                          <Tooltip label="Stop process">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Stop ${processName(owner)} on port ${owner.port}`}
                              onClick={() => setStopping(owner)}
                            >
                              <Square />
                            </Button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </div>
          </div>
        )}
      </Dialog>

      {/* §110: stopping a process the user did not start needs confirmation,
          and the confirmation names what it will end. */}
      <ConfirmDialog
        open={stopping !== null}
        onClose={() => setStopping(null)}
        onConfirm={() => {
          if (stopping) {
            stop.mutate(stopping);
          }
        }}
        destructive
        pending={stop.isPending}
        title={stopping ? `Stop ${processName(stopping)}?` : "Stop process?"}
        description={
          stopping
            ? stopDescription(stopping, devxPorts.get(stopping.port), claimsKnown)
            : ""
        }
        confirmLabel="Stop process"
      />
    </>
  );
}

/** The image name, or the PID when Windows would not give us one. */
function processName(owner: PortOwner): string {
  return owner.process_name ?? `PID ${owner.pid}`;
}

/** What the confirmation promises, including what happens afterwards. */
function stopDescription(
  owner: PortOwner,
  devxOwner: string | undefined,
  claimsKnown: boolean,
): string {
  const target = `PID ${owner.pid}${
    owner.process_name ? ` (${owner.process_name})` : ""
  } on port ${owner.port}`;

  if (!claimsKnown) {
    return `Ends ${target}. DevX could not read its port map, so it cannot say whether it restarts this.`;
  }
  return devxOwner
    ? `Ends ${target}. DevX claims that port for ${devxOwner}, so it reads as stopped until the service is started again.`
    : `Ends ${target}. Nothing restarts it afterwards.`;
}

/** Writes the PID to the clipboard and says what happened either way. */
async function copyPid(
  toast: ReturnType<typeof useToast>,
  owner: PortOwner,
): Promise<void> {
  const text = String(owner.pid);
  if (!navigator.clipboard) {
    toast.error("Could not copy the PID", {
      description: "The clipboard is not available in this window.",
      details: text,
    });
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast.success("PID copied", { description: text });
  } catch (error) {
    toast.error("Could not copy the PID", { details: reasonOf(error) });
  }
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
