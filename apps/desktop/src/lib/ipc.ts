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
  BackupEntry,
  CaStatus,
  DnsStatus,
  Check,
  CheckStatus,
  Checksum,
  CronJob,
  CronStatus,
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
  LogFileContent,
  LogFileInfo,
  LogStream,
  MailStatus,
  Message,
  MessageSummary,
  Network,
  PhpExtensions,
  PhpExtensionInfo,
  PhpPoolStatus,
  PhpPools,
  PrivilegedStatus,
  Provisioning,
  ReleaseChannel,
  ServiceEvent,
  ServiceEventUpdate,
  ServiceMetrics,
  ServiceState,
  ServiceStatus,
  SiteStatus,
  TemplateCreateResult,
  TemplateInfo,
  TerminalExit,
  TerminalOutput,
  TunnelStatus,
  Theme,
  UpdateStatus,
  VersionListing,
  Worker,
  WorkerInstanceStatus,
  WorkerStatus,
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
  configExport: () => unwrap(commands.configExport()),
  configImport: (body: string) => unwrap(commands.configImport(body)),
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
  serviceMetrics: () => unwrap(commands.serviceMetrics()),
  logsList: () => unwrap(commands.logsList()),
  logsRead: (fileName: string, tail: number) =>
    unwrap(commands.logsRead(fileName, tail)),
  phpPoolList: () => unwrap(commands.phpPoolList()),
  phpPoolStart: (version: string, workers: number) =>
    unwrap(commands.phpPoolStart(version, workers)),
  phpPoolStop: (version: string) => unwrap(commands.phpPoolStop(version)),
  phpPoolStatus: (version: string) => unwrap(commands.phpPoolStatus(version)),
  phpPoolLogs: (version: string, after: number) =>
    unwrap(commands.phpPoolLogs(version, after)),
  phpExtList: (version: string) => unwrap(commands.phpExtList(version)),
  phpExtSet: (version: string, extension: string, enabled: boolean) =>
    unwrap(commands.phpExtSet(version, extension, enabled)),
  siteList: () => unwrap(commands.siteList()),
  siteAdd: (hostname: string, docroot: string, phpVersion: string, https: boolean) =>
    unwrap(commands.siteAdd(hostname, docroot, phpVersion, https)),
  siteRemove: (hostname: string) => unwrap(commands.siteRemove(hostname)),
  siteEnvSet: (hostname: string, key: string, value: string) =>
    unwrap(commands.siteEnvSet(hostname, key, value)),
  siteEnvDelete: (hostname: string, key: string) =>
    unwrap(commands.siteEnvDelete(hostname, key)),
  siteAliasAdd: (hostname: string, alias: string) =>
    unwrap(commands.siteAliasAdd(hostname, alias)),
  siteAliasDelete: (hostname: string, alias: string) =>
    unwrap(commands.siteAliasDelete(hostname, alias)),
  backupList: (serviceId: string) => unwrap(commands.backupList(serviceId)),
  backupCreate: (serviceId: string) => unwrap(commands.backupCreate(serviceId)),
  backupRestore: (serviceId: string, fileName: string) =>
    unwrap(commands.backupRestore(serviceId, fileName)),
  backupDelete: (serviceId: string, fileName: string) =>
    unwrap(commands.backupDelete(serviceId, fileName)),
  terminalPath: () => unwrap(commands.terminalPath()),
  terminalRun: (cwd: string, command: string) =>
    unwrap(commands.terminalRun(cwd, command)),
  templateList: () => unwrap(commands.templateList()),
  templateCreate: (
    templateId: string,
    hostname: string,
    docroot: string,
    phpVersion: string,
    https: boolean,
  ) => unwrap(commands.templateCreate(templateId, hostname, docroot, phpVersion, https)),
  cronList: () => unwrap(commands.cronList()),
  cronSet: (
    name: string,
    program: string | null,
    phpVersion: string | null,
    args: string[],
    workingDir: string,
    everyMinutes: number,
  ) => unwrap(commands.cronSet(name, program, phpVersion, args, workingDir, everyMinutes)),
  cronDelete: (name: string) => unwrap(commands.cronDelete(name)),
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
  workerList: () => unwrap(commands.workerList()),
  workerAdd: (
    name: string,
    program: string | null,
    phpVersion: string | null,
    args: string[],
    workingDir: string,
    instances: number,
  ) => unwrap(commands.workerAdd(name, program, phpVersion, args, workingDir, instances)),
  workerRemove: (name: string) => unwrap(commands.workerRemove(name)),
  workerStart: (name: string) => unwrap(commands.workerStart(name)),
  workerStop: (name: string) => unwrap(commands.workerStop(name)),
  privilegedStatus: () => unwrap(commands.privilegedStatus()),
  revealManagedDir: (path: string) => unwrap(commands.revealManagedDir(path)),
  settingsSyncAutostart: () => unwrap(commands.settingsSyncAutostart()),
  updateCheck: () => unwrap(commands.updateCheck()),
};

/** Backend-to-frontend events, typed by the generated client. */
export const ipcEvents = events;
