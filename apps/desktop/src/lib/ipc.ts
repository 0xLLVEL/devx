import { commands, events } from "@/bindings";
import type {
  Config,
  ConnectionParams,
  DevxError,
  ErrorCode,
} from "@/bindings";

export type {
  AppInfo,
  AppPaths,
  Artifact,
  CaStatus,
  DnsStatus,
  Check,
  CheckStatus,
  Checksum,
  ComponentKind,
  ComponentSummary,
  ComponentVersion,
  Config,
  ConnectionParams,
  DbResult,
  DbServer,
  DbValue,
  DevxError,
  DnsMode,
  DoctorReport,
  ErrorCode,
  General,
  InstalledVersion,
  InstallPhase,
  InstallProgress,
  LogEntry,
  LogStream,
  MailStatus,
  Message,
  MessageSummary,
  Network,
  PhpPoolStatus,
  PhpPools,
  PrivilegedStatus,
  Provisioning,
  ReleaseChannel,
  ServiceState,
  ServiceStatus,
  SiteStatus,
  TunnelStatus,
  Theme,
  UpdateStatus,
  VersionListing,
} from "@/bindings";

/** A `Result` as produced by the generated `tauri-specta` client. */
type IpcResult<T> =
  | { status: "ok"; data: T }
  | { status: "error"; error: DevxError };

/**
 * A failed command, carrying the structured domain error.
 *
 * Thrown (rather than returned) so TanStack Query's error channel and React
 * error boundaries work without every caller unwrapping by hand.
 */
export class IpcError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | null;

  constructor(detail: DevxError) {
    super(detail.message);
    this.name = "IpcError";
    this.code = detail.code;
    this.hint = detail.hint;
  }
}

/** Converts an IPC result into a resolved value or a thrown [`IpcError`]. */
export async function unwrap<T>(result: Promise<IpcResult<T>>): Promise<T> {
  const value = await result;
  if (value.status === "error") {
    throw new IpcError(value.error);
  }
  return value.data;
}

/**
 * Typed facade over the generated command client.
 *
 * The UI always goes through this module: it keeps error handling uniform and
 * gives tests a single seam to mock.
 */
export const ipc = {
  appInfo: () => unwrap(commands.appInfo()),
  pathsGet: () => unwrap(commands.pathsGet()),
  configGet: () => unwrap(commands.configGet()),
  configSet: (config: Config) => unwrap(commands.configSet(config)),
  configReset: () => unwrap(commands.configReset()),
  doctorRun: () => unwrap(commands.doctorRun()),
  catalogList: () => unwrap(commands.catalogList()),
  componentVersions: (componentId: string) =>
    unwrap(commands.componentVersions(componentId)),
  componentInstall: (componentId: string, version: string) =>
    unwrap(commands.componentInstall(componentId, version)),
  componentUninstall: (componentId: string, version: string) =>
    unwrap(commands.componentUninstall(componentId, version)),
  installedVersions: () => unwrap(commands.installedVersions()),
  serviceComponentIds: () => unwrap(commands.serviceComponentIds()),
  serviceStart: (componentId: string, version: string) =>
    unwrap(commands.serviceStart(componentId, version)),
  serviceStop: (id: string) => unwrap(commands.serviceStop(id)),
  serviceStatus: (id: string) => unwrap(commands.serviceStatus(id)),
  serviceLogs: (id: string, after: number) =>
    unwrap(commands.serviceLogs(id, after)),
  phpPoolList: () => unwrap(commands.phpPoolList()),
  phpPoolStart: (version: string, workers: number) =>
    unwrap(commands.phpPoolStart(version, workers)),
  phpPoolStop: (version: string) => unwrap(commands.phpPoolStop(version)),
  phpPoolStatus: (version: string) => unwrap(commands.phpPoolStatus(version)),
  phpPoolLogs: (version: string, after: number) =>
    unwrap(commands.phpPoolLogs(version, after)),
  siteList: () => unwrap(commands.siteList()),
  siteAdd: (hostname: string, docroot: string, phpVersion: string, https: boolean) =>
    unwrap(commands.siteAdd(hostname, docroot, phpVersion, https)),
  siteRemove: (hostname: string) => unwrap(commands.siteRemove(hostname)),
  caStatus: () => unwrap(commands.caStatus()),
  caInstall: () => unwrap(commands.caInstall()),
  caRemove: () => unwrap(commands.caRemove()),
  dnsStatus: () => unwrap(commands.dnsStatus()),
  dnsStart: () => unwrap(commands.dnsStart()),
  dnsStop: () => unwrap(commands.dnsStop()),
  dbListServers: () => unwrap(commands.dbListServers()),
  dbQuery: (params: ConnectionParams, statement: string) =>
    unwrap(commands.dbQuery(params, statement)),
  dbListDatabases: (params: ConnectionParams) =>
    unwrap(commands.dbListDatabases(params)),
  dbListTables: (params: ConnectionParams) =>
    unwrap(commands.dbListTables(params)),
  mailStatus: () => unwrap(commands.mailStatus()),
  mailList: (limit: number) => unwrap(commands.mailList(limit)),
  mailMessage: (id: string) => unwrap(commands.mailMessage(id)),
  mailDelete: (ids: string[]) => unwrap(commands.mailDelete(ids)),
  tunnelStart: (hostname: string) => unwrap(commands.tunnelStart(hostname)),
  tunnelStop: (hostname: string) => unwrap(commands.tunnelStop(hostname)),
  tunnelStatus: (hostname: string) => unwrap(commands.tunnelStatus(hostname)),
  privilegedStatus: () => unwrap(commands.privilegedStatus()),
  revealManagedDir: (path: string) => unwrap(commands.revealManagedDir(path)),
  settingsSyncAutostart: () => unwrap(commands.settingsSyncAutostart()),
  updateCheck: () => unwrap(commands.updateCheck()),
};

/** Backend-to-frontend events, typed by the generated client. */
export const ipcEvents = events;
