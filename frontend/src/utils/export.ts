/**
 * 现场回传包导出工具（纯函数）：
 * - 作业单下达时冻结派工基线
 * - 导出时把派工基线、关联病害快照、登记中的封锁条件一起打进回传包
 * 导入侧按编号挂回本地记录的合并逻辑见 utils/fieldImport.ts。
 */
import type { DispatchBaseline, DispatchBaselineSource } from '../types/baseline';
import { DISPATCH_BASELINE_VERSION } from '../types/baseline';
import type { Fault } from '../types/fault';
import type { Inspection } from '../types/inspection';
import type { Switch } from '../types/switch';
import {
  FIELD_RETURN_PACKAGE_KIND,
  FIELD_RETURN_PACKAGE_VERSION,
  type FieldCompletion,
  type FieldReturnPackage,
} from '../types/fieldReturn';
import type { SpeedRestriction } from '../types/restriction';
import type { WorkOrder } from '../types/workOrder';
import { nowDateTime } from './window';
import { uuid } from './format';

/** 冻结派工基线所需的最小字段集 */
export type BaselineSourceOrder = Pick<
  WorkOrder,
  'code' | 'leader' | 'members' | 'machines' | 'windowStart' | 'windowEnd' | 'faultIds'
>;

/** 由作业单当前安排冻结派工基线 */
export function buildDispatchBaseline(
  order: BaselineSourceOrder,
  frozenAt: string = nowDateTime(),
  source: DispatchBaselineSource = 'issued',
): DispatchBaseline {
  return {
    code: order.code,
    leader: order.leader,
    members: [...order.members],
    machines: [...order.machines],
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    faultIds: [...order.faultIds],
    frozenAt,
    source,
  };
}

export { DISPATCH_BASELINE_VERSION };

/**
 * 组装现场回传包：带上作业单的派工基线、关联病害和登记中的封锁条件。
 * 关联病害与封锁条件即便已销号/已解除也随包导出（由导入方按当前登记口径核对）。
 */
export function buildFieldReturnPackage(input: {
  order: WorkOrder;
  faults: Fault[];
  restrictions: SpeedRestriction[];
  completion?: FieldCompletion | null;
  packageId?: string;
  exportedAt?: string;
}): FieldReturnPackage {
  const baseline =
    input.order.dispatchBaseline ??
    buildDispatchBaseline(input.order, input.exportedAt ?? nowDateTime(), 'legacyBackfill');
  return {
    kind: FIELD_RETURN_PACKAGE_KIND,
    packageVersion: FIELD_RETURN_PACKAGE_VERSION,
    packageId: input.packageId ?? `pkg-${uuid()}`,
    workOrderId: input.order.id,
    workOrderCode: input.order.code,
    exportedAt: input.exportedAt ?? nowDateTime(),
    baseline,
    workOrder: { ...input.order, dispatchBaseline: baseline },
    faults: input.faults.map((item) => ({ ...item })),
    restrictions: input.restrictions.map((item) => ({ ...item })),
    completion: input.completion ? { ...input.completion } : null,
  };
}

/**
 * 挑出与作业单关联的封锁 / 慢行条件：
 * 病害经巡检挂到道岔（yardId + code），封锁条件按同站场且（站场级或道岔号命中）关联。
 */
export function restrictionsForOrder(
  order: Pick<WorkOrder, 'faultIds'>,
  faults: Fault[],
  inspections: Inspection[],
  switches: Switch[],
  restrictions: SpeedRestriction[],
): SpeedRestriction[] {
  const inspectionOf = new Map(faults.map((fault) => [fault.id, fault.inspectionId]));
  const switchOf = new Map(inspections.map((inspection) => [inspection.id, inspection.switchId]));
  const targets = new Set(
    order.faultIds
      .map((faultId) => {
        const switchId = switchOf.get(inspectionOf.get(faultId) ?? '');
        return switches.find((item) => item.id === switchId);
      })
      .filter((item): item is Switch => Boolean(item))
      .map((item) => `${item.yardId}::${item.code}`),
  );
  const yardIds = new Set(
    [...targets].map((key) => key.split('::')[0]),
  );
  return restrictions.filter((item) => {
    if (!yardIds.has(item.yardId)) return false;
    if (!item.switchCode) return true; // 站场级
    return targets.has(`${item.yardId}::${item.switchCode}`);
  });
}

/** 回传包文件名 */
export function fieldReturnFilename(order: Pick<WorkOrder, 'code'>, stamp: string = nowDateTime()): string {
  const day = stamp.slice(0, 10).replace(/-/g, '');
  return `gbrailswitch-field-${order.code}-${day}.json`;
}
