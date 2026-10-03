/**
 * 待处理缺口（reconcile）领域模型
 * 导入回传包后，按派工基线 / 关联病害 / 封锁条件编号挂回本地记录：
 * - 现场安排（负责人 / 人员 / 机具）与本地不同 → 两方来源都保留，生成待处理项，处理前不能推进作业状态
 * - 关联病害缺口、封锁条件未解除、作业单挂不回 → 留在待处理处并说明
 * 处理（保留任一方 / 两方并存）后缺口置为 resolved，作业状态才允许继续推进。
 */
import type { Revisioned } from './persistence';
import type { FieldFaultCheck, FieldRestrictionState } from './fieldReturn';

/** 缺口类型 */
export type ReconcileKind =
  | 'leader' // 现场负责人与本地安排不一致
  | 'members' // 现场作业人员与本地安排不一致
  | 'machines' // 现场机具与本地安排不一致
  | 'fault' // 关联病害核对缺口（现场未找到 / 存疑 / 仍待修）
  | 'restriction' // 封锁条件尚未解除
  | 'unmatched'; // 包内作业单在本地挂不回

export const RECONCILE_KIND_LABEL: Record<ReconcileKind, string> = {
  leader: '负责人不一致',
  members: '作业人员不一致',
  machines: '机具不一致',
  fault: '病害核对缺口',
  restriction: '封锁条件未解除',
  unmatched: '作业单未挂回',
};

/** 缺口状态：待处理 / 已处理（处理后两方来源仍都保留在说明中） */
export type ReconcileStatus = 'pending' | 'resolved';

export const RECONCILE_STATUS_LABEL: Record<ReconcileStatus, string> = {
  pending: '待处理',
  resolved: '已处理',
};

/**
 * 待处理缺口行（本地落库）。
 * 两方来源（本地 local* / 现场 field*）都保留，处理只是给出结论，不覆盖任何一方。
 */
export interface ReconcileItem extends Revisioned {
  id: string;
  /** 来源回传包 id */
  packageId: string;
  /** 挂回的本地作业单 id；作业单未挂回时为空串 */
  workOrderId: string;
  /** 作业单编号（未挂回时用包内编号展示） */
  workOrderCode: string;
  kind: ReconcileKind;
  status: ReconcileStatus;
  /** 本地来源说明 */
  localValue: string;
  /** 现场来源说明 */
  fieldValue: string;
  /** 缺口说明（为什么阻塞） */
  detail: string;
  /** 关联病害 id（kind=fault） */
  faultId: string;
  /** 关联封锁条件登记行 id（kind=restriction） */
  restrictionId: string;
  /** 现场核对结论（病害） */
  faultCheck: FieldFaultCheck | '';
  /** 现场核对状态（封锁） */
  restrictionState: FieldRestrictionState | '';
  /** 处理结论（保留本地 / 采用现场 / 两方并存） */
  resolution: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 现场完工登记（落库，按作业单一对一挂在本地作业单上） */
export interface FieldCompletionRow extends Revisioned {
  /** 本地作业单 id（主索引） */
  workOrderId: string;
  packageId: string;
  registeredAt: string;
  registrar: string;
  leaderActual: string;
  membersActual: string[];
  machinesActual: string[];
  finishNote: string;
  /** 见证资料（JSON 序列化自 FieldEvidence[]，避免再开表） */
  evidencesJson: string;
  /** 病害逐条核对（JSON 序列化自 FieldFaultResult[]） */
  faultResultsJson: string;
  /** 封锁逐条核对（JSON 序列化自 FieldRestrictionResult[]） */
  restrictionResultsJson: string;
  importedAt: string;
}

/** 整包导入阶段（检查点；每阶段一个 Dexie 事务，全部幂等可重试） */
export type FieldImportStage =
  | 'register' // 建立 / 取回回传包记录
  | 'link' // 按派工基线编号挂回本地作业单，登记完工
  | 'reconcile' // 生成人员机具 / 病害 / 封锁 / 未挂回缺口
  | 'done';

export const FIELD_IMPORT_STAGE_LABEL: Record<FieldImportStage, string> = {
  register: '登记回传包',
  link: '挂回本地作业单',
  reconcile: '生成待处理缺口',
  done: '完成',
};

/** 回传包导入记录（检查点与整包状态） */
export interface FieldReturnRow extends Revisioned {
  /** 包唯一编号（主键，重复导入不重复建档） */
  id: string;
  /** 原始回传包 JSON 文本（失败后从检查点重试用） */
  rawJson: string;
  station: string;
  exportedAt: string;
  importedAt: string;
  /** 已完成阶段检查点 */
  stage: FieldImportStage;
  /** 最近一次失败信息 */
  error: string;
  entryCount: number;
  /** 未挂回的作业单编号列表 */
  unmatchedCodes: string[];
  createdAt: string;
  updatedAt: string;
}

/** 待处理缺口的确定性 id（包 + 作业单 + 类型 + 对象），重复导入不重复建档 */
export function reconcileKey(
  packageId: string,
  workOrderId: string,
  kind: ReconcileKind,
  targetId: string,
): string {
  return `rec:${packageId}:${workOrderId || 'unlinked'}:${kind}:${targetId}`;
}
