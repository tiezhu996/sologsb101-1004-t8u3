/**
 * 现场回传包导入合并：
 * - 先按作业单 / 病害 / 封锁条件编号挂回本地记录，不覆盖本地安排
 * - 负责人、人员或机具与本地（派工基线）不同时两方来源都保留，生成待处理分歧，处理前不能推进作业状态
 * - 完工与见证资料先登记；封锁条件未解除、关联病害对不上时缺口留在待处理处并说明
 * - 整包写入分阶段落检查点，失败后从检查点重试；重复导入同一包不重复建档
 */
import {
  db,
  getImportBatch,
  putCompletion,
  putImportBatch,
  putPendingItems,
  putRestriction,
  putWorkOrder,
  type FaultRow,
  type ImportBatchRow,
  type InspectionRow,
  type PendingItemRow,
  type SpeedRestrictionRow,
  type SwitchRow,
  type WorkOrderRow,
} from './db';
import {
  FIELD_RETURN_PACKAGE_KIND,
  FIELD_RETURN_PACKAGE_VERSION,
  type FieldFaultResult,
  type FieldReturnPackage,
} from '../types/fieldReturn';
import {
  PENDING_GATE_LABEL,
  PENDING_KIND_LABEL,
  pendingGateOf,
  type PendingItem,
  type PendingKind,
} from '../types/pending';
import { IMPORT_STAGE_ORDER, type ImportStage } from '../types/importBatch';
import { isRestrictionActive } from '../types/restriction';
import { restrictionsForOrder } from './export';
import { nowDateTime } from './window';
import { ROW_REVISION } from '../types/persistence';

/** 确定性待处理项 id：同一缺口重复导入不重复建档 */
export function pendingId(workOrderId: string, kind: PendingKind, refId?: string | null): string {
  return refId ? `pend-${workOrderId}-${kind}-${refId}` : `pend-${workOrderId}-${kind}`;
}

/** 回传包结构校验 */
export function validateFieldReturnPackage(raw: unknown): { ok: true; pkg: FieldReturnPackage } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, message: '文件不是有效的 JSON 对象' };
  const pkg = raw as Partial<FieldReturnPackage>;
  if (pkg.kind !== FIELD_RETURN_PACKAGE_KIND) {
    return { ok: false, message: '不是 gbrailswitch 现场回传包（缺少 kind 标识）' };
  }
  if (pkg.packageVersion !== FIELD_RETURN_PACKAGE_VERSION) {
    return { ok: false, message: `回传包版本 ${String(pkg.packageVersion)} 与本机支持版本 ${FIELD_RETURN_PACKAGE_VERSION} 不一致` };
  }
  if (!pkg.packageId || !pkg.workOrderId) return { ok: false, message: '回传包缺少 packageId / workOrderId' };
  if (!pkg.baseline) return { ok: false, message: '回传包缺少派工基线，无法按编号挂回本地记录' };
  if (!pkg.workOrder || !Array.isArray(pkg.workOrder.faultIds)) {
    return { ok: false, message: '回传包缺少作业单快照' };
  }
  return { ok: true, pkg: pkg as FieldReturnPackage };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

function openPending(input: {
  workOrderId: string;
  workOrderCode: string;
  kind: PendingKind;
  detail: string;
  fieldValue: string;
  localValue: string;
  packageId: string | null;
  faultId?: string | null;
  restrictionId?: string | null;
  createdAt: string;
}): PendingItemRow {
  const gate = pendingGateOf(input.kind);
  return {
    id: pendingId(input.workOrderId, input.kind, input.faultId ?? input.restrictionId),
    workOrderId: input.workOrderId,
    workOrderCode: input.workOrderCode,
    faultId: input.faultId ?? null,
    restrictionId: input.restrictionId ?? null,
    kind: input.kind,
    gate,
    detail: input.detail,
    fieldValue: input.fieldValue,
    localValue: input.localValue,
    status: 'open',
    resolutionNote: '',
    resolvedAt: null,
    packageId: input.packageId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    revision: ROW_REVISION,
  };
}

interface LocalContext {
  order: WorkOrderRow | undefined;
  faults: FaultRow[];
  inspections: InspectionRow[];
  switches: SwitchRow[];
  restrictions: SpeedRestrictionRow[];
  existingPending: PendingItemRow[];
}

/** 病害 → 道岔编号（经巡检挂接） */
function switchCodeOfFault(fault: FaultRow, inspections: InspectionRow[], switches: SwitchRow[]): string {
  const inspection = inspections.find((item) => item.id === fault.inspectionId);
  return switches.find((item) => item.id === inspection?.switchId)?.code ?? '';
}

/**
 * 比对生成待处理缺口（纯函数）：封锁未解除、病害缺失/未处治、人员机具分歧、见证缺失。
 * 只产出仍成立的 open 缺口；已处理项不在导入路径上改动。
 * @param completionSource 现场完工登记来源：回传包（packageId 用包号）/ 本机离线登记（null）
 */
export function buildGaps(
  pkg: FieldReturnPackage,
  ctx: LocalContext,
  stamp: string,
  completionOverride?: { completion: NonNullable<FieldReturnPackage['completion']>; source: 'fieldPackage' | 'local' },
): PendingItemRow[] {
  const { order, faults, inspections, switches, restrictions } = ctx;
  const localOrder = order ?? pkg.workOrder;
  const localFaults = new Map(faults.map((item) => [item.id, item]));
  const completion = completionOverride?.completion ?? pkg.completion;
  const packageId = completionOverride && completionOverride.source === 'local' ? null : pkg.packageId;
  const items: PendingItemRow[] = [];
  const push = (item: PendingItemRow): void => {
    if (!items.some((row) => row.id === item.id)) items.push(item);
  };

  // 1) 封锁条件：导出时登记中的封锁/慢行，导入时仍未解除则阻断销号
  const faultSwitchCodes = new Set(
    pkg.workOrder.faultIds
      .map((faultId) => localFaults.get(faultId))
      .filter((item): item is FaultRow => Boolean(item))
      .map((item) => switchCodeOfFault(item, inspections, switches)),
  );
  for (const restriction of pkg.restrictions ?? []) {
    if (!isRestrictionActive(restriction)) continue;
    const local = restrictions.find((item) => item.id === restriction.id);
    // 本地已解除以本地为准；站场级或关联道岔命中本作业单病害的封锁条件才挂缺口
    if (local && !isRestrictionActive(local)) continue;
    if (restriction.switchCode && !faultSwitchCodes.has(restriction.switchCode)) continue;
    push(
      openPending({
        workOrderId: pkg.workOrderId,
        workOrderCode: pkg.workOrderCode,
        kind: 'restrictionActive',
        detail: `${restriction.switchCode ? `${restriction.switchCode} ` : ''}${restriction.reason}（${restriction.period}）尚未解除`,
        fieldValue: restriction.limitKmh > 0 ? `慢行 ${restriction.limitKmh}km/h` : '封锁停车',
        localValue: local && !isRestrictionActive(local) ? `已于 ${local.liftedAt ?? ''} 解除` : '登记中',
        packageId,
        restrictionId: restriction.id,
        createdAt: stamp,
      }),
    );
  }

  // 2) 关联病害：本地缺失 / 现场未处治
  for (const faultId of localOrder.faultIds) {
    const localFault = localFaults.get(faultId);
    if (!localFault) {
      push(
        openPending({
          workOrderId: pkg.workOrderId,
          workOrderCode: pkg.workOrderCode,
          kind: 'faultMissing',
          detail: `关联病害 ${faultId} 在本地记录中缺失，无法核对销号`,
          fieldValue: '回传包已关联',
          localValue: '本地缺失',
          packageId,
          faultId,
          createdAt: stamp,
        }),
      );
      continue;
    }
    if (localFault.state === 'solved') continue;
    const result: FieldFaultResult | undefined = completion?.faultResults.find((item) => item.faultId === faultId);
    if (!result || result.result === 'untreated') {
      push(
        openPending({
          workOrderId: pkg.workOrderId,
          workOrderCode: pkg.workOrderCode,
          kind: 'faultUntreated',
          detail: `${switchCodeOfFault(localFault, inspections, switches) || '关联病害'} 现场${
            result ? `未处治（${result.note || '无备注'}）` : '未回报处置结果'
          }，暂不销号`,
          fieldValue: result ? result.note || '未处治' : '未回报',
          localValue: '待修',
          packageId,
          faultId,
          createdAt: stamp,
        }),
      );
    }
  }

  // 3) 负责人 / 人员 / 机具：现场登记与派工基线不一致（两方来源都保留，处理前不能推进状态）
  if (completion) {
    const baseline = localOrder.dispatchBaseline ?? pkg.baseline;
    if (completion.leader.trim() && completion.leader.trim() !== baseline.leader.trim()) {
      push(
        openPending({
          workOrderId: pkg.workOrderId,
          workOrderCode: pkg.workOrderCode,
          kind: 'leaderMismatch',
          detail: `现场负责人「${completion.leader}」与派工基线负责人「${baseline.leader}」不一致`,
          fieldValue: completion.leader,
          localValue: baseline.leader,
          packageId,
          createdAt: stamp,
        }),
      );
    }
    if (!sameSet(completion.members, baseline.members)) {
      push(
        openPending({
          workOrderId: pkg.workOrderId,
          workOrderCode: pkg.workOrderCode,
          kind: 'memberMismatch',
          detail: `现场作业人员（${completion.members.join('、') || '空'}）与派工基线（${baseline.members.join('、') || '空'}）不一致`,
          fieldValue: completion.members.join('、'),
          localValue: baseline.members.join('、'),
          packageId,
          createdAt: stamp,
        }),
      );
    }
    if (!sameSet(completion.machines, baseline.machines)) {
      push(
        openPending({
          workOrderId: pkg.workOrderId,
          workOrderCode: pkg.workOrderCode,
          kind: 'machineMismatch',
          detail: `现场机具（${completion.machines.join('、') || '空'}）与派工基线（${baseline.machines.join('、') || '空'}）不一致`,
          fieldValue: completion.machines.join('、'),
          localValue: baseline.machines.join('、'),
          packageId,
          createdAt: stamp,
        }),
      );
    }
    // 4) 见证资料缺失
    if (!completion.witnesses.some((item) => item.ref.trim())) {
      push(
        openPending({
          workOrderId: pkg.workOrderId,
          workOrderCode: pkg.workOrderCode,
          kind: 'witnessMissing',
          detail: '完工登记缺少见证资料（照片 / 视频 / 签字单编号），补齐后才能核对销号',
          fieldValue: '无',
          localValue: '要求至少 1 份',
          packageId,
          createdAt: stamp,
        }),
      );
    }
  }

  return items;
}

export interface FieldImportResult {
  /** completed=本次（或此前）已完成整包写入；retried=本次从检查点重试后完成 */
  outcome: 'completed' | 'duplicate';
  orderId: string;
  orderCode: string;
  gapCount: number;
  checkpoint: ImportStage;
  attempts: number;
  /** 本次新登记 / 重新打开的缺口说明 */
  gaps: PendingItemRow[];
}

/**
 * 导入一个现场回传包。
 * 已完成的同包重复导入直接判重返回；失败批次从检查点继续。
 */
export async function importFieldReturnPackage(pkgInput: FieldReturnPackage): Promise<FieldImportResult> {
  const stamp = nowDateTime();
  const existing = await getImportBatch(pkgInput.packageId);
  if (existing?.status === 'completed') {
    return {
      outcome: 'duplicate',
      orderId: existing.workOrderId,
      orderCode: existing.workOrderCode,
      gapCount: await db.pendingItems.where('workOrderId').equals(existing.workOrderId).count(),
      checkpoint: 'completed',
      attempts: existing.attempts,
      gaps: [],
    };
  }

  const batch: ImportBatchRow =
    existing && existing.status === 'failed'
      ? { ...existing, payload: pkgInput, attempts: existing.attempts + 1, lastError: '', updatedAt: stamp }
      : {
          id: pkgInput.packageId,
          workOrderId: pkgInput.workOrderId,
          workOrderCode: pkgInput.workOrderCode,
          checkpoint: 'order',
          status: 'failed',
          lastError: '',
          attempts: 1,
          importedAt: stamp,
          updatedAt: stamp,
          payload: pkgInput,
          revision: ROW_REVISION,
        };

  let gaps: PendingItemRow[] = [];
  try {
    // 阶段顺序执行；已通过检查点的阶段在重试时跳过
    for (const stage of IMPORT_STAGE_ORDER) {
      if (stageIndex(batch.checkpoint) > stageIndex(stage)) continue;
      if (stage === 'completed') {
        batch.checkpoint = 'completed';
        batch.status = 'completed';
        batch.updatedAt = stamp;
        await putImportBatch({ ...batch });
        break;
      }
      await runStage(stage, batch, (produced) => {
        gaps = produced;
      });
      batch.checkpoint = stage;
      batch.updatedAt = stamp;
      await putImportBatch({ ...batch });
    }
  } catch (cause) {
    batch.lastError = cause instanceof Error ? cause.message : '整包写入失败';
    batch.updatedAt = stamp;
    await putImportBatch({ ...batch });
    throw new Error(`${PENDING_KINDS_STAGE_LABEL[batch.checkpoint]}写入失败：${batch.lastError}（已保存检查点，可重试）`);
  }

  return {
    outcome: 'completed',
    orderId: pkgInput.workOrderId,
    orderCode: pkgInput.workOrderCode,
    gapCount: gaps.length,
    checkpoint: 'completed',
    attempts: batch.attempts,
    gaps,
  };
}

const PENDING_KINDS_STAGE_LABEL: Record<ImportStage, string> = {
  order: '挂回作业单',
  completion: '完工与见证资料',
  restriction: '封锁条件核对',
  gaps: '待处理缺口登记',
  completed: '整包写入',
};

function stageIndex(stage: ImportStage): number {
  return IMPORT_STAGE_ORDER.indexOf(stage);
}

/** 单阶段写入（每阶段独立事务，失败不影响已落检查点的前序阶段） */
async function runStage(
  stage: Exclude<ImportStage, 'completed'>,
  batch: ImportBatchRow,
  setGaps: (items: PendingItemRow[]) => void,
): Promise<void> {
  const pkg = batch.payload;
  const stamp = nowDateTime();

  if (stage === 'order') {
    const local = await db.workOrders.get(pkg.workOrderId);
    if (local) {
      // 按编号挂回本地记录：本地安排不动；旧数据缺少派工基线时用包内基线兼容回填
      if (!local.dispatchBaseline) {
        await putWorkOrder({ ...local, dispatchBaseline: pkg.baseline, completionId: local.completionId ?? null });
      }
    } else {
      // 本地缺少该作业单：按包内快照建档，现场作业状态不替本地推进
      await putWorkOrder({
        ...pkg.workOrder,
        dispatchBaseline: pkg.workOrder.dispatchBaseline ?? pkg.baseline,
        completionId: null,
      });
    }
    return;
  }

  if (stage === 'completion') {
    if (!pkg.completion) return;
    const local = await db.completions.get(pkg.completion.id);
    if (local) return; // 重复导入不重复建档
    const completion: typeof pkg.completion =
      pkg.completion.workOrderId === pkg.workOrderId
        ? pkg.completion
        : { ...pkg.completion, workOrderId: pkg.workOrderId };
    await putCompletion(completion);
    const order = await db.workOrders.get(pkg.workOrderId);
    if (order && !order.completionId) {
      await putWorkOrder({ ...order, completionId: completion.id });
    }
    return;
  }

  if (stage === 'restriction') {
    for (const incoming of pkg.restrictions ?? []) {
      const local = await db.restrictions.get(incoming.id);
      if (!local) {
        // 登记中的封锁条件随包补登（liftedAt 为空）；已解除条件不回退本地解除状态
        await putRestriction({ ...incoming, liftedAt: incoming.liftedAt ?? null });
      } else if (!local.liftedAt && incoming.liftedAt) {
        // 现场回传带回了解除登记，且本地仍登记中 → 同步解除
        await putRestriction({ ...local, liftedAt: incoming.liftedAt });
      }
    }
    return;
  }

  // gaps：比对登记待处理缺口（确定性 id，重复导入不重复建档；已处理项不动）
  const [order, faults, inspections, switches, restrictions, existingPending] = await Promise.all([
    db.workOrders.get(pkg.workOrderId),
    db.faults.toArray(),
    db.inspections.toArray(),
    db.switches.toArray(),
    db.restrictions.toArray(),
    db.pendingItems.where('workOrderId').equals(pkg.workOrderId).toArray(),
  ]);
  const produced = buildGaps(pkg, { order, faults, inspections, switches, restrictions, existingPending }, stamp);
  const producedIds = new Set(produced.map((item) => item.id));
  const stale = existingPending.filter(
    // 此前 open、本次比对已不成立（封锁已解除 / 病害已处治 / 分歧已消除）的缺口自动关闭；
    // 人工 resolved / ignored 记录保留不动
    (item) => item.status === 'open' && !producedIds.has(item.id),
  );
  await putPendingItems(
    stale.map((item) => ({
      ...item,
      status: 'resolved',
      resolutionNote: '重新导入时条件已满足，自动关闭',
      resolvedAt: stamp,
      updatedAt: stamp,
    })),
  );
  const handled = new Set(existingPending.filter((item) => item.status !== 'open').map((item) => item.id));
  const fresh = produced.filter((item) => !handled.has(item.id));
  await putPendingItems(fresh);
  setGaps(fresh);
}

/**
 * 本机离线登记完工后按同一口径刷新待处理缺口（封锁未解除 / 病害未处治 / 人员分歧 / 见证缺失）。
 * 与导入共用 buildGaps；包壳仅承载作业单编号与基线，completion 用本机登记覆盖。
 */
export async function syncLocalCompletionGaps(workOrderId: string): Promise<PendingItemRow[]> {
  const stamp = nowDateTime();
  const [order, completion, faults, inspections, switches, restrictions, existingPending] = await Promise.all([
    db.workOrders.get(workOrderId),
    db.completions.where('workOrderId').equals(workOrderId).first(),
    db.faults.toArray(),
    db.inspections.toArray(),
    db.switches.toArray(),
    db.restrictions.toArray(),
    db.pendingItems.where('workOrderId').equals(workOrderId).toArray(),
  ]);
  if (!order || !completion) return [];
  const shell: FieldReturnPackage = {
    kind: FIELD_RETURN_PACKAGE_KIND,
    packageVersion: FIELD_RETURN_PACKAGE_VERSION,
    packageId: completion.packageId ?? `local-${workOrderId}`,
    workOrderId: order.id,
    workOrderCode: order.code,
    exportedAt: stamp,
    baseline: order.dispatchBaseline ?? {
      code: order.code,
      leader: order.leader,
      members: order.members,
      machines: order.machines,
      windowStart: order.windowStart,
      windowEnd: order.windowEnd,
      faultIds: order.faultIds,
      frozenAt: order.updatedAt,
      source: 'legacyBackfill',
    },
    workOrder: order,
    faults: faults.filter((item) => order.faultIds.includes(item.id)),
    restrictions: [],
    completion: null,
  };
  // 封锁条件按「同站场且道岔号命中 / 站场级」关联到作业单（与导出同口径）
  const relatedRestrictions = restrictionsForOrder(order, faults, inspections, switches, restrictions);
  shell.restrictions = relatedRestrictions;
  const produced = buildGaps(
    { ...shell, restrictions: relatedRestrictions },
    { order, faults, inspections, switches, restrictions, existingPending },
    stamp,
    { completion, source: 'local' },
  );
  const producedIds = new Set(produced.map((item) => item.id));
  const stale = existingPending.filter(
    (item) => item.status === 'open' && item.packageId === null && !producedIds.has(item.id),
  );
  await putPendingItems(
    stale.map((item) => ({
      ...item,
      status: 'resolved',
      resolutionNote: '补录完工时条件已满足，自动关闭',
      resolvedAt: stamp,
      updatedAt: stamp,
    })),
  );
  const handled = new Set(existingPending.filter((item) => item.status !== 'open').map((item) => item.id));
  const fresh = produced.filter((item) => !handled.has(item.id));
  await putPendingItems(fresh);
  return fresh;
}

/** 从检查点重试失败批次（用已保存的原始回传包） */
export async function retryFailedImport(packageId: string): Promise<FieldImportResult> {
  const batch = await getImportBatch(packageId);
  if (!batch) throw new Error('未找到该导入批次的检查点');
  if (batch.status === 'completed') {
    return {
      outcome: 'duplicate',
      orderId: batch.workOrderId,
      orderCode: batch.workOrderCode,
      gapCount: await db.pendingItems.where('workOrderId').equals(batch.workOrderId).count(),
      checkpoint: 'completed',
      attempts: batch.attempts,
      gaps: [],
    };
  }
  return importFieldReturnPackage(batch.payload);
}

/** 待处理缺口文案汇总（供页面提示） */
export function pendingHint(item: Pick<PendingItem, 'kind' | 'detail'>): string {
  return `${PENDING_KIND_LABEL[item.kind]}：${item.detail}（${PENDING_GATE_LABEL[pendingGateOf(item.kind)]}）`;
}
