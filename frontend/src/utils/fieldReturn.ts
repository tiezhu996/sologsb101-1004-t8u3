/**
 * 现场回传包：导出拼装与纯规则（不触碰 Dexie，便于导入引擎与页面共用）
 * - 导出：带上作业单派工基线、关联病害摘要、登记中的封锁条件
 * - 导入：按派工基线编号（workOrderId，兜底 code）挂回本地记录
 * - 现场负责人 / 人员 / 机具与本地不同：判定为不一致项，两方来源都保留（在 reconcile 阶段建档）
 * - 病害核对缺口、封锁条件未解除的判定口径
 */
import type { FaultRow, SwitchRow, InspectionRow, YardRow } from './db';
import type {
  DispatchBaseline,
  FieldCompletion,
  FieldFaultResult,
  FieldReturnEntry,
  FieldReturnPackage,
  RestrictionRef,
} from '../types/fieldReturn';
import {
  FIELD_RETURN_PACKAGE_TYPE,
  FIELD_RETURN_PACKAGE_VERSION,
} from '../types/fieldReturn';
import type { SpeedRestriction } from './db';
import type { ReconcileKind } from '../types/reconcile';
import { isOverlap, nowDateTime, todayDate } from './window';
import { uuid } from './format';

/* ============================== 派工基线 ============================== */

/** 冻结派工基线：作业单编排 / 更新时调用，缺基线才生成，已有基线不覆盖 */
export function freezeBaseline(order: {
  id: string;
  code: string;
  windowStart: string;
  windowEnd: string;
  leader: string;
  members: string[];
  machines: string[];
  faultIds: string[];
  dispatchBaseline?: DispatchBaseline;
}): DispatchBaseline | undefined {
  if (order.dispatchBaseline) return order.dispatchBaseline;
  return {
    workOrderId: order.id,
    workOrderCode: order.code,
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    leader: order.leader.trim(),
    members: [...order.members],
    machines: [...order.machines],
    faultIds: [...order.faultIds],
    frozenAt: nowDateTime(),
  };
}

/* ============================== 关联病害 / 封锁上下文 ============================== */

export interface FaultContext {
  fault: FaultRow;
  switch: SwitchRow | undefined;
  yard: YardRow | undefined;
}

/** 组装病害 → 巡检 → 道岔 → 站场上下文表 */
export function buildFaultContext(
  faults: FaultRow[],
  inspections: InspectionRow[],
  switches: SwitchRow[],
  yards: YardRow[],
): Map<string, FaultContext> {
  const result = new Map<string, FaultContext>();
  for (const fault of faults) {
    const inspection = inspections.find((item) => item.id === fault.inspectionId);
    const switchRow = inspection ? switches.find((item) => item.id === inspection.switchId) : undefined;
    const yard = switchRow ? yards.find((item) => item.id === switchRow.yardId) : undefined;
    result.set(fault.id, { fault, switch: switchRow, yard });
  }
  return result;
}

/** 作业单关联病害涉及的站场 id */
export function orderYardIds(order: { faultIds: string[] }, context: Map<string, FaultContext>): string[] {
  const ids = new Set<string>();
  for (const faultId of order.faultIds) {
    const yardId = context.get(faultId)?.yard?.id;
    if (yardId) ids.add(yardId);
  }
  return [...ids];
}

/** 作业单的时间窗 */
function orderWindow(order: { windowStart: string; windowEnd: string }) {
  return { windowStart: order.windowStart, windowEnd: order.windowEnd };
}

/** 封锁条件是否与作业单相关：同站场（站场级条件全单适用），且时间窗重叠 */
export function restrictionRelates(
  restriction: Pick<SpeedRestriction, 'yardId' | 'switchCode'> & { period: string },
  yardIds: string[],
  switchCodes: string[],
  window: { windowStart: string; windowEnd: string },
): boolean {
  if (!yardIds.includes(restriction.yardId)) return false;
  if (restriction.switchCode && !switchCodes.includes(restriction.switchCode)) return false;
  const period = parseRestrictionPeriod(restriction.period);
  if (!period) return true; // 起止无法解析时不轻易漏掉，导出时一并带上
  return isOverlap(window, period);
}

/** 收集与作业单相关、仍登记在案的封锁条件（导出时携带） */
export function collectEntryRestrictions(
  order: { faultIds: string[]; windowStart: string; windowEnd: string },
  context: Map<string, FaultContext>,
  restrictions: SpeedRestriction[],
): RestrictionRef[] {
  const yardIds = orderYardIds(order, context);
  const switchCodes = order.faultIds
    .map((faultId) => context.get(faultId)?.switch?.code)
    .filter((code): code is string => Boolean(code));
  return restrictions
    .filter((item) =>
      restrictionRelates(item, yardIds, switchCodes, orderWindow(order)),
    )
    .map((item) => ({
      restrictionId: item.id,
      yardId: item.yardId,
      switchCode: item.switchCode,
      limitKmh: item.limitKmh,
      period: item.period,
      reason: item.reason,
    }));
}

/** 解析 "yyyy-MM-dd ~ yyyy-MM-dd"（端点允许带时分）为整日级时间窗 */
export function parseRestrictionPeriod(period: string): { windowStart: string; windowEnd: string } | null {
  const parts = period.split('~').map((item) => item.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const windowStart = parts[0].length <= 10 ? `${parts[0]} 00:00` : parts[0];
  const windowEnd = parts[1].length <= 10 ? `${parts[1]} 23:59` : parts[1];
  return { windowStart, windowEnd };
}

/** 某时刻封锁条件是否仍生效；起止无法解析时按“在生效”处理（安全侧） */
export function isRestrictionActiveAt(restriction: { period: string }, at: string = todayDate()): boolean {
  const period = parseRestrictionPeriod(restriction.period);
  if (!period) return true;
  const moment = at.length <= 10 ? `${at} 12:00` : at;
  return moment >= period.windowStart && moment <= period.windowEnd;
}

/** 作业单当前仍生效的本地封锁条件（核对销号前必须全部解除） */
export function orderActiveRestrictions(
  order: { faultIds: string[]; windowStart: string; windowEnd: string },
  context: Map<string, FaultContext>,
  restrictions: SpeedRestriction[],
  at: string = todayDate(),
): SpeedRestriction[] {
  const yardIds = orderYardIds(order, context);
  const switchCodes = order.faultIds
    .map((faultId) => context.get(faultId)?.switch?.code)
    .filter((code): code is string => Boolean(code));
  return restrictions.filter(
    (item) =>
      restrictionRelates(item, yardIds, switchCodes, orderWindow(order)) && isRestrictionActiveAt(item, at),
  );
}

/* ============================== 导出拼装 ============================== */

/** 组装一张作业单的回传包条目（现场完成登记留空，作离线模板） */
export function buildEntry(
  order: {
    id: string;
    code: string;
    windowStart: string;
    windowEnd: string;
    leader: string;
    members: string[];
    machines: string[];
    faultIds: string[];
    dispatchBaseline?: DispatchBaseline;
  },
  context: Map<string, FaultContext>,
  restrictions: SpeedRestriction[],
  exportedAt: string,
): FieldReturnEntry {
  const baseline: DispatchBaseline = order.dispatchBaseline ?? {
    workOrderId: order.id,
    workOrderCode: order.code,
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    leader: order.leader,
    members: [...order.members],
    machines: [...order.machines],
    faultIds: [...order.faultIds],
    frozenAt: exportedAt,
    backfilled: true,
  };
  const faultRefs = order.faultIds
    .map((faultId) => {
      const ctx = context.get(faultId);
      const fault = ctx?.fault;
      if (!fault || !ctx?.switch) return undefined;
      return {
        faultId: fault.id,
        switchCode: ctx.switch.code,
        part: fault.part,
        type: fault.type,
        severity: fault.severity,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return {
    workOrderId: order.id,
    workOrderCode: order.code,
    baseline,
    completion: null,
    faultRefs,
    restrictions: collectEntryRestrictions(order, context, restrictions),
  };
}

/** 组装整包（可只包含勾选的作业单） */
export function buildPackage(
  entries: FieldReturnEntry[],
  station: string,
  schemaVersion: number,
  exportedAt: string = nowDateTime(),
): FieldReturnPackage {
  return {
    packageType: FIELD_RETURN_PACKAGE_TYPE,
    packageVersion: FIELD_RETURN_PACKAGE_VERSION,
    packageId: `pkg-${exportedAt.replace(/[-: ]/g, '')}-${uuid().slice(-6)}`,
    exportedAt,
    station: station.trim() || '现场回传',
    schemaVersion,
    entries,
  };
}

/* ============================== 导入校验与挂回 ============================== */

/** 回传包结构校验（宽容读取，返回可读错误） */
export function validatePackage(data: unknown): { ok: true; pkg: FieldReturnPackage } | { ok: false; message: string } {
  if (!data || typeof data !== 'object') return { ok: false, message: '回传包不是合法 JSON 对象' };
  const pkg = data as Partial<FieldReturnPackage>;
  if (pkg.packageType !== FIELD_RETURN_PACKAGE_TYPE) {
    return { ok: false, message: `文件类型标识不正确（应为 ${FIELD_RETURN_PACKAGE_TYPE}）` };
  }
  if (pkg.packageVersion !== FIELD_RETURN_PACKAGE_VERSION) {
    return { ok: false, message: `回传包版本 ${String(pkg.packageVersion)} 不受支持（当前 v${FIELD_RETURN_PACKAGE_VERSION}）` };
  }
  if (typeof pkg.packageId !== 'string' || !pkg.packageId) {
    return { ok: false, message: '回传包缺少 packageId，无法去重' };
  }
  if (!Array.isArray(pkg.entries)) return { ok: false, message: '回传包缺少 entries 数组' };
  for (const [index, entry] of pkg.entries.entries()) {
    if (!entry || typeof entry !== 'object' || !entry.workOrderId || !entry.baseline) {
      return { ok: false, message: `第 ${index + 1} 条作业单缺少派工基线，无法挂回` };
    }
  }
  return { ok: true, pkg: data as FieldReturnPackage };
}

/** 按派工基线编号挂回本地作业单：先 id，再 code 兜底 */
export function matchEntryOrderId(
  entry: Pick<FieldReturnEntry, 'workOrderId' | 'workOrderCode' | 'baseline'>,
  localOrders: Array<{ id: string; code: string }>,
): string | undefined {
  const byId = localOrders.find((item) => item.id === entry.workOrderId || item.id === entry.baseline.workOrderId);
  if (byId) return byId.id;
  const byCode = localOrders.find(
    (item) => item.code === entry.workOrderCode || item.code === entry.baseline.workOrderCode,
  );
  return byCode?.id;
}

/* ====================== 现场安排与本地安排不一致判定 ====================== */

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function diffList(local: string[], field: string[]): { differ: boolean; local: string; fieldValue: string } {
  const a = sortedUnique(local);
  const b = sortedUnique(field);
  return {
    differ: a.join('、') !== b.join('、'),
    local: a.join('、') || '（空）',
    fieldValue: b.join('、') || '（空）',
  };
}

/** 现场完工安排与本地 / 派工基线安排的差异（两方来源都保留） */
export function diffAssignment(
  local: { leader: string; members: string[]; machines: string[] },
  completion: Pick<FieldCompletion, 'leaderActual' | 'membersActual' | 'machinesActual'>,
  baseline: DispatchBaseline,
): Array<{
  kind: Extract<ReconcileKind, 'leader' | 'members' | 'machines'>;
  localValue: string;
  fieldValue: string;
  detail: string;
}> {
  const result: ReturnType<typeof diffAssignment> = [];
  const localLeader = local.leader.trim() || '（空）';
  const fieldLeader = completion.leaderActual.trim() || '（空）';
  if (localLeader !== fieldLeader) {
    result.push({
      kind: 'leader',
      localValue: `本地：${localLeader}；派工基线：${baseline.leader || '（空）'}`,
      fieldValue: `现场：${fieldLeader}`,
      detail: '现场实际负责人与本地安排不一致，处理前不能推进作业状态',
    });
  }
  for (const diff of [
    { kind: 'members' as const, d: diffList(local.members, completion.membersActual), base: baseline.members },
    { kind: 'machines' as const, d: diffList(local.machines, completion.machinesActual), base: baseline.machines },
  ]) {
    if (diff.d.differ) {
      const label = diff.kind === 'members' ? '作业人员' : '机具';
      result.push({
        kind: diff.kind,
        localValue: `本地：${diff.d.local}；派工基线：${sortedUnique(diff.base).join('、') || '（空）'}`,
        fieldValue: `现场：${diff.d.fieldValue}`,
        detail: `现场实际${label}与本地安排不一致，处理前不能推进作业状态`,
      });
    }
  }
  return result;
}

/* ============================== 病害 / 封锁缺口判定 ============================== */

/**
 * 单条关联病害的现场核对缺口。
 * 本地仍待修且现场未明确修复（确认存在 / 未找到 / 存疑 / 未核对）→ 阻塞销号。
 */
export function evaluateFaultGap(args: {
  localState: 'pending' | 'solved' | 'missing';
  result: FieldFaultResult | undefined;
}): { blocking: boolean; detail: string } {
  const { localState, result } = args;
  if (!result) {
    return localState === 'pending'
      ? { blocking: true, detail: '现场未逐条核对该病害，不能销号' }
      : { blocking: false, detail: '本地已销号，现场未单独核对' };
  }
  if (localState === 'missing') {
    return { blocking: true, detail: `现场核对记录存在，但本地病害已删除或未挂回（现场结论：${result.check}）` };
  }
  switch (result.check) {
    case 'repaired':
      // 现场确认已修复：不是缺口，待修状态由「核对销号」动作统一回写销号
      return { blocking: false, detail: '现场确认已修复，待核对销号' };
    case 'confirmed':
      return { blocking: true, detail: '现场确认病害仍存在，暂不能销号' };
    case 'notFound':
      return { blocking: true, detail: '现场未找到该病害，需复核位置与编号后再销号' };
    case 'gap':
      return { blocking: true, detail: '现场标记存疑缺口，需复核后再销号' };
    default:
      return { blocking: true, detail: '现场核对结论未识别' };
  }
}

/** 单条封锁条件的现场 / 本地核对缺口：仍在封锁或未能确认 → 阻塞销号 */
export function evaluateRestrictionGap(args: {
  localExists: boolean;
  localActive: boolean;
  fieldState: FieldCompletion['restrictionResults'][number]['state'] | undefined;
}): { blocking: boolean; detail: string } {
  const { localExists, localActive, fieldState } = args;
  if (!localExists) {
    return { blocking: true, detail: '导出时登记的封锁条件在本地已不存在，需重新核实' };
  }
  if (fieldState === 'lifted' && !localActive) {
    return { blocking: false, detail: '现场确认已解除，本地封锁期限也已结束' };
  }
  if (fieldState === 'lifted' && localActive) {
    return { blocking: true, detail: '现场称已解除，但本地登记封锁期限尚未结束，需先销记封锁条件' };
  }
  if (fieldState === 'active') {
    return { blocking: true, detail: '现场反馈仍在封锁，条件解除前不能销号' };
  }
  if (fieldState === 'unknown') {
    return { blocking: true, detail: '现场未能确认封锁是否解除，不能销号' };
  }
  // 现场未核对该条：以本地登记为准
  return { blocking: localActive, detail: localActive ? '封锁条件仍在登记期限内，现场未核对解除，不能销号' : '本地封锁期限已结束' };
}
