import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  Copy,
  ExternalLink,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  Globe,
  Loader2,
  Settings2,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OverflowMenu, type MenuItem } from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { openFolder } from "@/lib/open-folder";
import { openInBrowser } from "@/lib/open-url";
import { pickDirectory } from "@/lib/pick-directory";
import { ipc, type ProjectSummary } from "@/lib/ipc";
import { queryKeys, useInstalledVersions, useProjects } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * Projects — the folder-shaped view of the workspace.
 *
 * Registered projects (added by the user) always appear here even before
 * anything points into them; folders referenced by sites, workers or cron
 * tasks are detected automatically. The selected project's detail panel
 * carries per-project runtime defaults and quick actions.
 */
export function ProjectsPage() {
  const projects = useProjects();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const list = useMemo(() => projects.data ?? [], [projects.data]);
  const selected = list.find((project) => project.path === selectedPath) ?? null;

  const runningWorkers = list.reduce((sum, p) => sum + p.running_workers, 0);

  return (
    <div className="space-y-4 p-5">
      <PageHeader
        title={
          projects.isPending
            ? "Projects"
            : list.length === 0
              ? "Projects"
              : `${list.length} project${list.length === 1 ? "" : "s"}`
        }
        description="Folders that hold your sites, workers and scheduled tasks — registered explicitly or detected from where things point on disk."
        right={
          <div className="flex items-center gap-3">
            {!projects.isPending && list.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                {runningWorkers > 0
                  ? `${runningWorkers} worker instance${runningWorkers === 1 ? "" : "s"} running`
                  : "no workers running"}
              </span>
            ) : null}
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <FolderPlus />
              Add project
            </Button>
          </div>
        }
      />

      <AddProjectDialog open={addOpen} onClose={() => setAddOpen(false)} />

      {projects.isPending ? (
        <ProjectSkeleton />
      ) : projects.isError ? (
        <Callout variant="destructive" title="Could not read the projects.">
          <p>{projects.error.message}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void projects.refetch()}
          >
            Try again
          </Button>
        </Callout>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<FolderKanban />}
          title="No projects yet."
          description="Add a project folder to pin it here, or point a site or worker at a folder and it shows up automatically."
          action={
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <FolderPlus />
              Add project
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            {list.map((project) => (
              <ProjectCard
                key={project.path}
                project={project}
                active={selected?.path === project.path}
                onSelect={() => setSelectedPath(project.path)}
              />
            ))}
          </div>

          {/* The detail column always reserves its width so cards keep the
              same size before and after a selection. */}
          <div className="min-w-0" aria-live="polite">
            {selected ? (
              <ProjectDetail project={selected} />
            ) : (
              <div
                className="h-full rounded-lg border border-dashed border-border"
                aria-label="Project details"
                aria-hidden
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Native folder picker + register mutation. */
function AddProjectDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");

  const add = useMutation({
    mutationFn: ({ path, label }: { path: string; label: string | null }) =>
      ipc.projectAdd(path, label),
    onSuccess: (projects) => {
      queryClient.setQueryData(queryKeys.projects, projects);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      toast.success("Project added", {
        description: "Pin runtime defaults for it from its detail panel.",
      });
      setLabel("");
      onClose();
    },
    onError: (error) => {
      toast.error("Could not add the project", { details: error.message });
    },
  });

  const pick = async () => {
    const directory = await pickDirectory("");
    if (directory === null) {
      return;
    }
    add.mutate({ path: directory, label: label.trim() || null });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a project"
      description="Choose a folder on disk. It stays on the Projects page even before anything points into it."
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void pick()} disabled={add.isPending}>
            {add.isPending ? <Loader2 className="animate-spin" /> : <FolderPlus />}
            Choose folder…
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="project-label">Display name (optional)</Label>
          <Input
            id="project-label"
            value={label}
            placeholder="Defaults to the folder name"
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          The folder picker opens after you confirm. Nothing is moved or copied —
          DevX only remembers where the project lives.
        </p>
      </div>
    </Dialog>
  );
}

/** One project card: name, path, runtime badges, aggregate status. */
function ProjectCard({
  project,
  active,
  onSelect,
}: {
  project: ProjectSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: () => ipc.projectRemove(project.path),
    onSuccess: (projects) => {
      queryClient.setQueryData(queryKeys.projects, projects);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      toast.success("Project removed from the list", {
        description: "The folder on disk was not touched.",
      });
    },
    onError: (error) => {
      toast.error("Could not remove the project", { details: error.message });
    },
  });

  const confirmRemove = () => {
    if (
      window.confirm(
        `Remove "${project.name}" from the Projects list? The folder on disk is not touched.`,
      )
    ) {
      remove.mutate();
    }
  };

  const menu: MenuItem[] = [];
  if (project.managed) {
    menu.push({
      id: "remove-project",
      label: "Remove project",
      icon: Trash2,
      onSelect: confirmRemove,
    });
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "cursor-pointer rounded-lg border p-3 text-left transition-colors duration-150",
        active
          ? "border-primary bg-primary-soft"
          : "border-border bg-card hover:bg-hover",
      )}
    >
      <div className="flex items-center gap-2">
        <FolderKanban
          className={cn("size-4 shrink-0", active ? "text-primary" : "text-ink-secondary")}
          aria-hidden
        />
        <span className="min-w-0 truncate text-sm font-semibold text-foreground">
          {project.name}
        </span>
        {project.managed ? (
          <Tooltip label="Registered project">
            <Badge variant="secondary">managed</Badge>
          </Tooltip>
        ) : null}
        {project.running_workers > 0 ? (
          <Badge variant="success">
            {project.running_workers} running
          </Badge>
        ) : project.sites.length + project.workers.length + project.cron.length === 0 ? (
          <span className="text-caption text-ink-muted">empty</span>
        ) : (
          <span className="ml-auto text-caption text-ink-muted">idle</span>
        )}
        {menu.length > 0 ? (
          <OverflowMenu label={`Actions for ${project.name}`} items={menu} />
        ) : null}
      </div>
      <p
        className="data-value mt-1 truncate text-ink-muted"
        title={project.path}
        data-selectable
      >
        {project.path}
      </p>

      <RuntimeBadges project={project} />

      <ul className="mt-2 space-y-1">
        {project.sites.slice(0, 3).map((site) => (
          <li key={site.hostname} className="flex items-center gap-1.5 text-xs">
            <Globe className="size-3 shrink-0 text-ink-muted" aria-hidden />
            <span className="data-value min-w-0 truncate text-foreground" data-selectable>
              {site.hostname}
            </span>
            {site.php_version ? (
              <Badge variant="outline">PHP {site.php_version}</Badge>
            ) : (
              <Badge variant="outline">static</Badge>
            )}
          </li>
        ))}
        {project.workers.slice(0, 2).map((worker) => (
          <li key={worker.name} className="flex items-center gap-1.5 text-xs">
            <Loader2
              className={cn(
                "size-3 shrink-0",
                worker.live.some((i) => i.state === "running")
                  ? "animate-spin text-success"
                  : "text-ink-muted",
              )}
              aria-hidden
            />
            <span className="min-w-0 truncate text-foreground">{worker.name}</span>
          </li>
        ))}
        {project.cron.slice(0, 2).map((job) => (
          <li key={job.name} className="flex items-center gap-1.5 text-xs">
            <CalendarClock className="size-3 shrink-0 text-ink-muted" aria-hidden />
            <span className="min-w-0 truncate text-foreground">{job.name}</span>
            <span className="text-caption text-ink-muted">every {job.every_minutes}m</span>
          </li>
        ))}
        {project.sites.length + project.workers.length + project.cron.length === 0 ? (
          <li className="text-xs text-muted-foreground">
            No sites, workers or tasks point here yet.
          </li>
        ) : null}
      </ul>
    </button>
  );
}

/** "PHP 8.4 · Node 22" style badges for the project's pinned runtimes. */
function RuntimeBadges({ project }: { project: ProjectSummary }) {
  const pinned = [
    project.default_php && `PHP ${shortVersion(project.default_php)}`,
    project.default_node && `Node ${shortVersion(project.default_node)}`,
    project.default_python && `Python ${shortVersion(project.default_python)}`,
  ].filter(Boolean) as string[];

  if (pinned.length === 0) {
    return null;
  }
  return (
    <p className="mt-2 flex flex-wrap gap-1">
      {pinned.map((badge) => (
        <Badge key={badge} variant="secondary">
          {badge}
        </Badge>
      ))}
    </p>
  );
}

/** Major.minor for display; a bare "8" stays "8". */
function shortVersion(version: string): string {
  const parts = version.split(".");
  return parts.slice(0, 2).join(".");
}

/** The selected project's full contents, settings, and actions. */
function ProjectDetail({ project }: { project: ProjectSummary }) {
  const toast = useToast();
  const installed = useInstalledVersions();
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(project.path);
      toast.success("Path copied");
    } catch {
      toast.error("The clipboard is not available in this window.");
    }
  };

  return (
    <aside className="min-w-0" aria-label={`${project.name} details`}>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-medium">
              <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{project.name}</span>
            </CardTitle>
            <div className="ml-auto flex items-center gap-1">
              <Tooltip label="Copy path">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Copy project path"
                  onClick={() => void copyPath()}
                >
                  <Copy />
                </Button>
              </Tooltip>
              <Tooltip label="Runtime settings">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Runtime settings for ${project.name}`}
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings2 />
                </Button>
              </Tooltip>
            </div>
          </div>
          <p className="data-value truncate text-ink-muted" data-selectable>
            {project.path}
          </p>
          <RuntimeBadges project={project} />
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailSection label="Sites" empty="No sites in this project.">
            {project.sites.map((site) => (
              <div key={site.hostname} className="flex items-center gap-2 text-sm">
                <span className="data-value min-w-0 flex-1 truncate text-foreground" data-selectable>
                  {site.hostname}
                </span>
                <Tooltip label="Open in browser">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Open ${site.hostname} in browser`}
                    onClick={() =>
                      void openInBrowser(
                        `${site.https ? "https" : "http"}://${site.hostname}`,
                      )
                    }
                  >
                    <ExternalLink />
                  </Button>
                </Tooltip>
                {site.https ? <Badge variant="success">HTTPS</Badge> : null}
              </div>
            ))}
          </DetailSection>

          <DetailSection label="Workers" empty="No workers in this project.">
            {project.workers.map((worker) => (
              <div key={worker.name} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">{worker.name}</span>
                {worker.live.length > 0 ? (
                  <StatusBadge
                    state={
                      worker.live.every((i) => i.state === "running")
                        ? "running"
                        : worker.live.some((i) => i.state === "running")
                          ? "starting"
                          : "stopped"
                    }
                  />
                ) : (
                  <Badge variant="outline">{worker.instances} configured</Badge>
                )}
              </div>
            ))}
          </DetailSection>

          <DetailSection label="Scheduled tasks" empty="No scheduled tasks in this project.">
            {project.cron.map((job) => (
              <div key={job.name} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">{job.name}</span>
                <span className="text-caption text-ink-muted">
                  every {job.every_minutes} min
                </span>
                <Badge variant={job.registered ? "secondary" : "warning"}>
                  {job.registered ? "registered" : "unregistered"}
                </Badge>
              </div>
            ))}
          </DetailSection>

          <div className="flex gap-2 border-t border-border pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void openFolder(project.path)}
            >
              <FolderOpen />
              Open folder
            </Button>
            <Link
              to="/terminal"
              className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-hover"
            >
              <TerminalSquare className="size-4" />
              Terminal
            </Link>
          </div>
        </CardContent>
      </Card>

      <ProjectSettingsDialog
        project={project}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        installed={installed.data ?? []}
        onSaved={(projects) => {
          queryClient.setQueryData(queryKeys.projects, projects);
          void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
        }}
      />
    </aside>
  );
}

/** Per-project pinned runtime versions, saved with project_update. */
function ProjectSettingsDialog({
  project,
  open,
  onClose,
  installed,
  onSaved,
}: {
  project: ProjectSummary;
  open: boolean;
  onClose: () => void;
  installed: { component_id: string; version: string }[];
  onSaved: (projects: ProjectSummary[]) => void;
}) {
  const toast = useToast();
  const [php, setPhp] = useState<string>(project.default_php ?? "");
  const [node, setNode] = useState<string>(project.default_node ?? "");
  const [python, setPython] = useState<string>(project.default_python ?? "");

  const save = useMutation({
    mutationFn: () =>
      ipc.projectUpdate(
        project.path,
        project.label,
        php || null,
        node || null,
        python || null,
      ),
    onSuccess: (projects) => {
      onSaved(projects);
      toast.success("Project settings saved");
      onClose();
    },
    onError: (error) => {
      toast.error("Could not save the project settings", {
        details: error.message,
      });
    },
  });

  const versions = (componentId: string) =>
    installed
      .filter((component) => component.component_id === componentId)
      .map((component) => component.version);

  const runtimeRow = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
  ) => {
    const options = versions(id);
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`runtime-${id}`}>{label}</Label>
        <Select
          id={`runtime-${id}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={options.length === 0}
        >
          <option value="">(use global default)</option>
          {options.map((version) => (
            <option key={version} value={version}>
              {version}
            </option>
          ))}
        </Select>
        {options.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No {label} version installed —{" "}
            <Link to="/components" className="underline">
              install one from Components
            </Link>
            .
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${project.name} settings`}
      description="Pin the runtime versions this project uses. New processes for the project will prefer these."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {runtimeRow("php", "PHP version", php, setPhp)}
        {runtimeRow("node", "Node.js version", node, setNode)}
        {runtimeRow("python", "Python version", python, setPython)}
      </div>
    </Dialog>
  );
}

/** A labelled group of rows, with a quiet line when there is nothing. */
function DetailSection({
  label,
  empty,
  children,
}: {
  label: string;
  empty: string;
  children: React.ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  const isEmpty =
    items.filter(Boolean).length === 0 ||
    (Array.isArray(children) && children.length === 0);

  return (
    <section>
      <h3 className="pb-1 text-caption font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </h3>
      {isEmpty ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-1">{children}</div>
      )}
    </section>
  );
}

/** Page-shaped skeleton while the projects read is in flight. */
function ProjectSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-2" role="status">
      <span className="sr-only">Loading projects…</span>
      {[0, 1, 2, 3].map((row) => (
        <span
          key={row}
          aria-hidden
          className="block h-28 animate-pulse rounded-lg bg-secondary"
        />
      ))}
    </div>
  );
}
