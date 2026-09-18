// ponytail: shallow facade — 25× unwrap forward, depth near zero.
// New code use `service-queries.ts` deep module (1 seam, 5 hooks) instead.
// This file stays for incremental migration (32 tests mock here) — delete per-route, not big-bang.
import { commands, events } from "@/bindings";
import type {
  Config,
  ConnectionParams,
  DevxError,
  ErrorCode,
  LimitConfig,
  WebServer,
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
  DirUsage,
  DnsMode,
  DoctorReport,
  ErrorCode,
  EventEntry,
  General,
  HostsEntry,
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
  NotificationEntry,
  NotificationList,
  PhpExtensionInfo,
  PhpPoolStatus,
  PhpXdebugInfo,
  ProfileEntry,
  ProjectSummary,
  PortEntry,
  PortOwner,
  PrivilegedStatus,
  Provisioning,
  ReleaseChannel,
  ServiceEvent,
  ServiceEventUpdate,
  ServiceMetrics,
  ServiceState,
  LimitConfig,
  SiteAuth,
  SiteRequestEntry,
  ServiceStatus,
  BatchStartOutcome,
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
  profileList: () => unwrap(commands.profileList()),
  projectsList: () => unwrap(commands.projectsList()),
  projectAdd: (path: string, label: string | null) =>
    unwrap(commands.projectAdd(path, label)),
  projectRemove: (path: string) => unwrap(commands.projectRemove(path)),
  projectUpdate: (
    path: string,
    label: string | null,
    defaultPhp: string | null,
    defaultNode: string | null,
    defaultPython: string | null,
  ) => unwrap(commands.projectUpdate(path, label, defaultPhp, defaultNode, defaultPython)),
  profileSave: (name: string) => unwrap(commands.profileSave(name)),
  profileApply: (name: string) => unwrap(commands.profileApply(name)),
  profileDelete: (name: string) => unwrap(commands.profileDelete(name)),
  doctorRun: () => unwrap(commands.doctorRun()),
  doctorFix: (checkId: string) => unwrap(commands.doctorFix(checkId)),
  eventsRecent: (limit: number | null) => unwrap(commands.eventsRecent(limit)),
  notificationsList: (limit: number | null) => unwrap(commands.notificationsList(limit)),
  notificationsMarkAllRead: (limit: number | null) =>
    unwrap(commands.notificationsMarkAllRead(limit)),
  notificationsClear: (limit: number | null) => unwrap(commands.notificationsClear(limit)),
  diskUsage: () => unwrap(commands.diskUsage()),
  portMap: () => unwrap(commands.portMap()),
  listeningPorts: () => unwrap(commands.listeningPorts()),
  stopProcessOnPort: (pid: number, port: number) =>
    unwrap(commands.stopProcessOnPort(pid, port)),
  catalogList: () => unwrap(commands.catalogList()),
  componentVersions: (componentId: string) =>
    unwrap(commands.componentVersions(componentId)),
  componentInstall: (componentId: string, version: string) =>
    unwrap(commands.componentInstall(componentId, version)),
  componentInstallCancel: (componentId: string, version: string) =>
    unwrap(commands.componentInstallCancel(componentId, version)),
  componentUninstall: (componentId: string, version: string) =>
    unwrap(commands.componentUninstall(componentId, version)),
  installedVersions: () => unwrap(commands.installedVersions()),
  serviceComponentIds: () => unwrap(commands.serviceComponentIds()),
  servicesStartAll: () => unwrap(commands.servicesStartAll()),
  mailMarkAllRead: () => unwrap(commands.mailMarkAllRead()),
  mailSendTest: () => unwrap(commands.mailSendTest()),
  servicesStopAll: () => unwrap(commands.servicesStopAll()),
  serviceStart: (componentId: string, version: string) =>
    unwrap(commands.serviceStart(componentId, version)),
  serviceStop: (id: string) => unwrap(commands.serviceStop(id)),
  serviceStatus: (id: string) => unwrap(commands.serviceStatus(id)),
  serviceLogs: (id: string, after: number) =>
    unwrap(commands.serviceLogs(id, after)),
  serviceMetrics: () => unwrap(commands.serviceMetrics()),
  serviceSetPort: (componentId: string, port: number | null) =>
    unwrap(commands.serviceSetPort(componentId, port)),
  serviceGetPorts: () => unwrap(commands.serviceGetPorts()),
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
  phpXdebugGet: (version: string) => unwrap(commands.phpXdebugGet(version)),
  phpLimitsGet: (version: string) => unwrap(commands.phpLimitsGet(version)),
  phpLimitsSet: (version: string, limits: LimitConfig) =>
    unwrap(commands.phpLimitsSet(version, limits)),
  phpXdebugSet: (version: string, enabled: boolean, mode: string, clientPort: number) =>
    unwrap(commands.phpXdebugSet(version, enabled, mode, clientPort)),
  siteList: () => unwrap(commands.siteList()),
  sitePing: (hostname: string) => unwrap(commands.sitePing(hostname)),
  siteRequests: (hostname: string, limit: number) =>
    unwrap(commands.siteRequests(hostname, limit)),
  siteAdd: (hostname: string, docroot: string, phpVersion: string, https: boolean, webServer: WebServer | null) =>
    unwrap(commands.siteAdd(hostname, docroot, phpVersion, https, webServer)),
  siteRemove: (hostname: string) => unwrap(commands.siteRemove(hostname)),
  siteEnvSet: (hostname: string, key: string, value: string) =>
    unwrap(commands.siteEnvSet(hostname, key, value)),
  siteEnvDelete: (hostname: string, key: string) =>
    unwrap(commands.siteEnvDelete(hostname, key)),
  siteAliasAdd: (hostname: string, alias: string) =>
    unwrap(commands.siteAliasAdd(hostname, alias)),
  siteAuthSet: (hostname: string, username: string | null, password: string | null) =>
    unwrap(commands.siteAuthSet(hostname, username, password)),
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
  terminalUseVersion: (componentId: string, version: string) =>
    unwrap(commands.terminalUseVersion(componentId, version)),
  terminalUnsetVersion: (componentId: string) =>
    unwrap(commands.terminalUnsetVersion(componentId)),
  templateList: () => unwrap(commands.templateList()),
  templateCreate: (
    templateId: string,
    hostname: string,
    docroot: string,
    phpVersion: string,
    https: boolean,
    gitUrl: string | null,
  ) => unwrap(commands.templateCreate(templateId, hostname, docroot, phpVersion, https, gitUrl)),
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
  hostsList: () => unwrap(commands.hostsList()),
  hostsAdd: (hostname: string, ip: string) =>
    unwrap(commands.hostsAdd(hostname, ip)),
  hostsRemove: (hostname: string) => unwrap(commands.hostsRemove(hostname)),
  hostsFlushDns: () => unwrap(commands.hostsFlushDns()),
  caStatus: () => unwrap(commands.caStatus()),
  caInstall: () => unwrap(commands.caInstall()),
  caRemove: () => unwrap(commands.caRemove()),
  dnsStatus: () => unwrap(commands.dnsStatus()),
  dnsStart: () => unwrap(commands.dnsStart()),
  dnsRepair: () => unwrap(commands.dnsRepair()),
  dnsStop: () => unwrap(commands.dnsStop()),
  dbListServers: () => unwrap(commands.dbListServers()),
  dbQuery: (params: ConnectionParams, statement: string) =>
    unwrap(commands.dbQuery(params, statement)),
  dbListDatabases: (params: ConnectionParams) =>
    unwrap(commands.dbListDatabases(params)),
  dbListTables: (params: ConnectionParams) =>
    unwrap(commands.dbListTables(params)),
  dbImportSql: (serviceId: string, filePath: string) =>
    unwrap(commands.dbImportSql(serviceId, filePath)),
  dbExportCsv: (params: ConnectionParams, statement: string, filePath: string) =>
    unwrap(commands.dbExportCsv(params, statement, filePath)),
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
