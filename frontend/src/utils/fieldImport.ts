/**
 * 现场回传包导入 / 合并引擎
 * 分三个阶段，每个阶段一个 Dexie 事务并推进检查点；整包写入失败后可从检查点重试。
 * 全部阶段幂等：回传包按 packageId 去重、缺口按确定性 id upsert、完工登记按作业单覆盖，
 * 重复导入 / 重试均不重复建档。
 *
 *   register   建立 / 取回回传包记录（含原始 JSON）
 *   link       按派工基线编号挂回本地作业单，登记现场完工与见证资料
 *   reconcile  生成负责人 / 人员 / 机具、病害、封锁、未挂回待处理缺口
 */
import {
  db,
  listFaults,
  listInspections,
  listSwitches,
  listYards,
  listWorkOrders,
  listRestrictions,
  getFieldReturn,
  putFieldReturn,
  putReconciles,
  putFieldCompletion,
  type FieldReturnRowRecord,
  type ReconcileItemRow,
  type FieldCompletionRowRecord,
  type SpeedRestrictionRow,
  type FaultRow,
  type WorkOrderRow,
  type InspectionRow,
  type SwitchRow,
  type YardRow,
} from './db';
import { ROW_REVISION } from '../types/persistence';
import type { FieldReturnPackage, FieldReturnEntry, FieldFaultResult, FieldCompletion } from '../types/fieldReturn';
import { FIELD_FAULT_CHECK_LABEL, FIELD_RESTRICTION_STATE_LABEL } from '../types/fieldReturn';
import type { FieldImportStage } from '../types/reconcile';
import { reconcileKey } from '../types/reconcile';
import {
  buildFaultContext,
  diffAssignment,
  evaluateFaultGap,
  evaluateRestrictionGap,
  matchEntryOrderId,
  validatePackage,
} from './fieldReturn';
import { nowIso } from './format';

export interface ImportProgress {
  packageId: string;
  stage: FieldImportStage;
  /** 挂回的作业单数量 */
  linked: number;
  /** 本次（重新）生成的待处理缺口数 */
  reconcileCount: number;
  /** 挂不回的作业单编号 */
  unmatchedCodes: string[];
}

export interface ImportResult extends ImportProgress {
  /** true=已有该包，本次为重试或重复导入 */
  resumed: boolean;
}

/**
 * 导入回传包（从检查点继续）。
 * @param input 已解析 JSON 或回传包对象；已建档重试时传 row.rawJson 对应内容
 */
export async function importFieldReturn(input: unknown): Promise<ImportResult> {
  const validation = validatePackage(input);
  if (!validation.ok) throw new Error(validation.message);
  const pkg = validation.pkg;

  const existing = await getFieldReturn(pkg.packageId);
  const resumed = Boolean(existing);

  if (!existing) await runRegister(pkg, null);

  // link / reconcile 阶段始终可重跑（幂等）：同一回传包再次导入表示现场补正后重新回传，
  // 需覆盖完工登记、重算缺口；确定性主键保证不重复建档。
  const local = await loadLocalData();
  const linkOutcome = await runLink(pkg, local.orders);
  const reconcileCount = await runReconcile(pkg, local, linkOutcome);

  await markStage(pkg, 'done', '', linkOutcome.unmatchedCodes);
  return {
    packageId: pkg.packageId,
    stage: 'done',
    linked: linkOutcome.count,
    reconcileCount,
    unmatchedCodes: linkOutcome.unmatchedCodes,
    resumed,
  };
}

/** 失败后从检查点重试（用包 id 取原始 JSON） */
export async function retryFieldReturn(packageId: string): Promise<ImportResult> {
  const row = await getFieldReturn(packageId);
  if (!row) throw new Error('没有找到该回传包的检查点记录');
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.rawJson) as unknown;
  } catch {
    throw new Error('回传包原始内容已损坏，无法从检查点重试');
  }
  return importFieldReturn(parsed);
}

/* ------------------------------ 阶段 1：register ------------------------------ */

async function runRegister(pkg: FieldReturnPackage, existing: FieldReturnRowRecord | null): Promise<void> {
  try {
    const stamp = nowIso();
    const row: FieldReturnRowRecord = existing
      ? { ...existing, stage: 'register', error: '', updatedAt: stamp }
      : {
          id: pkg.packageId,
          rawJson: JSON.stringify(pkg),
          station: pkg.station,
          exportedAt: pkg.exportedAt,
          importedAt: stamp,
          stage: 'register',
          error: '',
          entryCount: pkg.entries.length,
          unmatchedCodes: [],
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        };
    await db.transaction('rw', [db.fieldReturns], async () => {
      await putFieldReturn(row);
    });
  } catch (cause) {
    throw new Error(`检查点 register 写入失败：${cause instanceof Error ? cause.message : '未知错误'}`);
  }
}

/* ------------------------------ 阶段 2：link ------------------------------ */

interface LocalData {
  orders: WorkOrderRow[];
  faults: FaultRow[];
  inspections: InspectionRow[];
  switches: SwitchRow[];
  yards: YardRow[];
  restrictions: SpeedRestrictionRow[];
}

async function loadLocalData(): Promise<LocalData> {
  const [orders, faults, inspections, switches, yards, restrictions] = await Promise.all([
    listWorkOrders(),
    listFaults(),
    listInspections(),
    listSwitches(),
    listYards(),
    listRestrictions(),
  ]);
  return { orders, faults, inspections, switches, yards, restrictions };
}

interface LinkOutcome {
  /** entry.workOrderId → 本地作业单 id（未挂回不出现） */
  linked: Map<string, string>;
  count: number;
  unmatchedCodes: string[];
  completionRows: FieldCompletionRowRecord[];
}

async function runLink(pkg: FieldReturnPackage, orders: WorkOrderRow[]): Promise<LinkOutcome> {
  try {
    const linked = new Map<string, string>();
    const unmatchedCodes: string[] = [];
    const completionRows: FieldCompletionRowRecord[] = [];
    const stamp = nowIso();

    for (const entry of pkg.entries) {
      const localId = matchEntryOrderId(entry, orders);
      if (!localId) {
        unmatchedCodes.push(entry.workOrderCode || entry.baseline.workOrderCode);
        continue;
      }
      linked.set(entry.workOrderId, localId);
      if (entry.completion) {
        completionRows.push(toCompletionRow(localId, pkg.packageId, entry.completion, stamp));
      }
    }

    await db.transaction('rw', [db.fieldReturns, db.fieldCompletions], async () => {
      await markStage(pkg, 'link', '', unmatchedCodes);
      for (const row of completionRows) await putFieldCompletion(row);
    });
    return { linked, count: linked.size, unmatchedCodes, completionRows };
  } catch (cause) {
    await saveCheckpointError(pkg, 'link', cause);
    throw new Error(
      `检查点 link（挂回作业单 / 登记完工）失败：${cause instanceof Error ? cause.message : '未知错误'}`,
    );
  }
}

function toCompletionRow(
  workOrderId: string,
  packageId: string,
  completion: FieldCompletion,
  stamp: string,
): FieldCompletionRowRecord {
  return {
    workOrderId,
    packageId,
    registeredAt: completion.registeredAt,
    registrar: completion.registrar,
    leaderActual: completion.leaderActual,
    membersActual: [...completion.membersActual],
    machinesActual: [...completion.machinesActual],
    finishNote: completion.finishNote,
    evidencesJson: JSON.stringify(completion.evidences ?? []),
    faultResultsJson: JSON.stringify(completion.faultResults ?? []),
    restrictionResultsJson: JSON.stringify(completion.restrictionResults ?? []),
    importedAt: stamp,
    revision: ROW_REVISION,
  };
}

/* ------------------------------ 阶段 3：reconcile ------------------------------ */

async function runReconcile(
  pkg: FieldReturnPackage,
  local: LocalData,
  link: LinkOutcome,
): Promise<number> {
  try {
    const stamp = nowIso();
    const context = buildFaultContext(local.faults, local.inspections, local.switches, local.yards);
    const items: ReconcileItemRow[] = [];

    for (const entry of pkg.entries) {
      const localOrderId = link.linked.get(entry.workOrderId);
      if (!localOrderId) {
        items.push(buildUnmatchedItem(pkg.packageId, entry, stamp));
        continue;
      }
      const order = local.orders.find((item) => item.id === localOrderId);
      if (!order) continue;
      if (!entry.completion) continue;
      items.push(...buildAssignmentItems(pkg.packageId, localOrderId, order, entry, stamp));
      items.push(...buildFaultItems(pkg.packageId, localOrderId, order, entry, context, stamp));
      items.push(...buildRestrictionItems(pkg.packageId, localOrderId, order, entry, local.restrictions, stamp));
    }

    await db.transaction('rw', [db.fieldReturns, db.reconciles], async () => {
      // 幂等合并：已人工处理（resolved）的结论保留；新缺口按确定性 id upsert，
      // 此前待处理但本次已不再构成缺口的旧项删除——重复导入不重复建档。
      const previous = await db.reconciles.where('packageId').equals(pkg.packageId).toArray();
      const previousResolved = new Map(
        previous.filter((row) => row.status === 'resolved').map((row) => [row.id, row]),
      );
      const incomingKeys = new Set(items.map((item) => item.id));
      const merged = items.map((item) => previousResolved.get(item.id) ?? item);
      await putReconciles(merged);
      const staleIds = previous
        .filter((row) => row.status === 'pending' && !incomingKeys.has(row.id))
        .map((row) => row.id);
      if (staleIds.length) await db.reconciles.bulkDelete(staleIds);
      await markStage(pkg, 'reconcile', '', link.unmatchedCodes);
    });
    return items.length;
  } catch (cause) {
    await saveCheckpointError(pkg, 'reconcile', cause);
    throw new Error(
      `检查点 reconcile（生成待处理缺口）失败：${cause instanceof Error ? cause.message : '未知错误'}`,
    );
  }
}

function baseItem(
  packageId: string,
  workOrderId: string,
  workOrderCode: string,
  stamp: string,
): Omit<ReconcileItemRow, 'id' | 'kind' | 'localValue' | 'fieldValue' | 'detail'> {
  return {
    packageId,
    workOrderId,
    workOrderCode,
    status: 'pending',
    faultId: '',
    restrictionId: '',
    faultCheck: '',
    restrictionState: '',
    resolution: '',
    resolvedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
}

function buildUnmatchedItem(packageId: string, entry: FieldReturnEntry, stamp: string): ReconcileItemRow {
  const code = entry.workOrderCode || entry.baseline.workOrderCode;
  return {
    ...baseItem(packageId, '', code, stamp),
    id: reconcileKey(packageId, '', 'unmatched', entry.workOrderId),
    kind: 'unmatched',
    localValue: '本地未找到该作业单（派工基线编号与作业单号均未命中）',
    fieldValue: `回传包内作业单 ${code}`,
    detail: '作业单挂不回本地记录，完工内容暂存，待人工确认后处理',
  };
}

function buildAssignmentItems(
  packageId: string,
  localOrderId: string,
  order: WorkOrderRow,
  entry: FieldReturnEntry,
  stamp: string,
): ReconcileItemRow[] {
  const completion = entry.completion;
  if (!completion) return [];
  return diffAssignment(
    { leader: order.leader, members: order.members, machines: order.machines },
    completion,
    entry.baseline,
  ).map((diff) => ({
    ...baseItem(packageId, localOrderId, order.code, stamp),
    id: reconcileKey(packageId, localOrderId, diff.kind, 'assignment'),
    kind: diff.kind,
    localValue: diff.localValue,
    fieldValue: diff.fieldValue,
    detail: diff.detail,
  }));
}

function resultOf(completion: FieldCompletion, faultId: string): FieldFaultResult | undefined {
  return completion.faultResults.find((item) => item.faultId === faultId);
}

function buildFaultItems(
  packageId: string,
  localOrderId: string,
  order: WorkOrderRow,
  entry: FieldReturnEntry,
  context: Map<string, { fault: FaultRow }>,
  stamp: string,
): ReconcileItemRow[] {
  const completion = entry.completion;
  if (!completion) return [];
  const baselineIds = new Set(entry.baseline.faultIds);
  const localIds = new Set(order.faultIds);
  // 以派工基线 + 本地安排的并集核对，保证基线病害被摘除也能发现缺口
  const faultIds = [...new Set([...entry.baseline.faultIds, ...order.faultIds])];
  const items: ReconcileItemRow[] = [];
  for (const faultId of faultIds) {
    const localFault = context.get(faultId)?.fault;
    const localState: 'pending' | 'solved' | 'missing' = !localFault
      ? 'missing'
      : localFault.state === 'solved'
        ? 'solved'
        : 'pending';
    const result = resultOf(completion, faultId);
    const evaluation = evaluateFaultGap({ localState, result });
    // 现场确认已修复、待核对销号的项不在此建缺口（由“核对销号”动作统一处理）
    if (!evaluation.blocking) continue;
    items.push({
      ...baseItem(packageId, localOrderId, order.code, stamp),
      id: reconcileKey(packageId, localOrderId, 'fault', faultId),
      kind: 'fault',
      faultId,
      faultCheck: result?.check ?? '',
      localValue: `本地${localState === 'missing' ? '病害已缺失' : localState === 'solved' ? '已销号' : '待修'}${
        baselineIds.has(faultId) ? '；在派工基线内' : ''
      }${localIds.has(faultId) ? '；在本地作业单内' : '；本地作业单已摘除'}`,
      fieldValue: result
        ? `现场：${FIELD_FAULT_CHECK_LABEL[result.check]}${result.note ? `（${result.note}）` : ''}`
        : '现场：未逐条核对',
      detail: evaluation.detail,
    });
  }
  return items;
}

function buildRestrictionItems(
  packageId: string,
  localOrderId: string,
  order: WorkOrderRow,
  entry: FieldReturnEntry,
  restrictions: SpeedRestrictionRow[],
  stamp: string,
): ReconcileItemRow[] {
  const completion = entry.completion;
  if (!completion) return [];
  // 以导出时携带的封锁条件清单为准逐条核对（本地是否仍登记 / 期限是否结束）
  return entry.restrictions
    .map((ref): ReconcileItemRow | null => {
      const local = restrictions.find((item) => item.id === ref.restrictionId);
      const fieldState = completion.restrictionResults.find(
        (item) => item.restrictionId === ref.restrictionId,
      )?.state;
      const periodActive = local ? periodStillOpen(local.period) : false;
      const evaluation = evaluateRestrictionGap({
        localExists: Boolean(local),
        localActive: periodActive,
        fieldState,
      });
      if (!evaluation.blocking) return null;
      return {
        ...baseItem(packageId, localOrderId, order.code, stamp),
        id: reconcileKey(packageId, localOrderId, 'restriction', ref.restrictionId),
        kind: 'restriction',
        restrictionId: ref.restrictionId,
        restrictionState: fieldState ?? '',
        localValue: local
          ? `本地登记：${local.switchCode || '站场级'} 限速 ${local.limitKmh}km/h，${local.period}（${
              periodActive ? '期限内' : '期限已结束'
            }）`
          : '本地已无该封锁条件登记',
        fieldValue: fieldState ? `现场：${FIELD_RESTRICTION_STATE_LABEL[fieldState]}` : '现场：未逐条核对',
        detail: evaluation.detail,
      };
    })
    .filter((item): item is ReconcileItemRow => Boolean(item));
}

/** 封锁期限是否覆盖今天（与 fieldReturn.isRestrictionActiveAt 同口径，引擎内独立实现避免循环） */
function periodStillOpen(period: string): boolean {
  const parts = period.split('~').map((item) => item.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return true;
  const today = nowIso().slice(0, 10);
  return today >= parts[0].slice(0, 10) && today <= parts[1].slice(0, 10);
}

/* ------------------------------ 检查点写回 ------------------------------ */

async function markStage(
  pkg: FieldReturnPackage,
  stage: FieldImportStage,
  error: string,
  unmatchedCodes: string[],
): Promise<void> {
  const existing = await getFieldReturn(pkg.packageId);
  const stamp = nowIso();
  const row: FieldReturnRowRecord = existing
    ? { ...existing, stage, error, unmatchedCodes: [...unmatchedCodes], updatedAt: stamp }
    : {
        id: pkg.packageId,
        rawJson: JSON.stringify(pkg),
        station: pkg.station,
        exportedAt: pkg.exportedAt,
        importedAt: stamp,
        stage,
        error,
        entryCount: pkg.entries.length,
        unmatchedCodes: [...unmatchedCodes],
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
  await putFieldReturn(row);
}

async function saveCheckpointError(pkg: FieldReturnPackage, stage: FieldImportStage, cause: unknown): Promise<void> {
  try {
    const existing = await getFieldReturn(pkg.packageId);
    if (!existing) return; // register 阶段失败时无记录可挂
    await putFieldReturn({
      ...existing,
      stage,
      error: cause instanceof Error ? cause.message : '未知错误',
      updatedAt: nowIso(),
    });
  } catch {
    // 检查点错误写回失败不再覆盖原始异常
  }
}
