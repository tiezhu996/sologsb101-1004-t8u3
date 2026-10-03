/**
 * 现场回传领域模型
 * 天窗修作业队在区间断网施工，现场记录离线保存，回站后按作业单导入合并回传包。
 * - 导出时携带：作业单派工基线（冻结快照）、关联病害摘要、登记中的封锁条件
 * - 现场完工登记（负责人/人员/机具实际安排、见证资料、病害与封锁核对）离线保存在包内
 * 本文件只定义结构与展示字典，比对 / 合并规则在 utils/fieldReturn.ts。
 */
import type { FaultPart, FaultSeverity, FaultType } from './fault';

/** 派工基线：作业单编排 / 下达时冻结的现场核对基准（回传挂回主索引） */
export interface DispatchBaseline {
  /** 作业单 id（回传挂回本地记录的主索引） */
  workOrderId: string;
  /** 作业单编号（人工核对兜底索引） */
  workOrderCode: string;
  /** 派工时的天窗起 */
  windowStart: string;
  /** 派工时的天窗止 */
  windowEnd: string;
  /** 派工负责人 */
  leader: string;
  /** 派工作业人员 */
  members: string[];
  /** 派工机具 */
  machines: string[];
  /** 派工时关联病害 id 列表（冻结快照，作业单后续调整不影响基线） */
  faultIds: string[];
  /** 基线冻结时间 */
  frozenAt: string;
  /** 兼容回填标记：旧数据缺少派工基线时，按当前作业单内容回填 */
  backfilled?: boolean;
}

/** 见证资料类型：照片 / 视频 / 测量记录 / 签认单 */
export type FieldEvidenceKind = 'photo' | 'video' | 'measure' | 'sign';

export const FIELD_EVIDENCE_KIND_LABEL: Record<FieldEvidenceKind, string> = {
  photo: '现场照片',
  video: '视频',
  measure: '测量记录',
  sign: '签认单',
};

/** 见证资料条目（断网现场登记，仅留引用编号与说明） */
export interface FieldEvidence {
  kind: FieldEvidenceKind;
  /** 资料引用（文件名 / 编号 / 本地路径） */
  ref: string;
  /** 备注 */
  note: string;
}

/** 单条关联病害的现场核对结论 */
export type FieldFaultCheck = 'repaired' | 'confirmed' | 'notFound' | 'gap';

export const FIELD_FAULT_CHECK_LABEL: Record<FieldFaultCheck, string> = {
  repaired: '已修复',
  confirmed: '确认存在',
  notFound: '现场未找到',
  gap: '存疑缺口',
};

/** 现场对单条关联病害的核对记录 */
export interface FieldFaultResult {
  /** 对应派工基线中的病害 id */
  faultId: string;
  /** 道岔编号（现场按作业单誊抄，便于离线识别） */
  switchCode: string;
  /** 部件（誊抄自导出摘要，缺失为空串） */
  part: FaultPart | '';
  /** 病害类型 */
  type: FaultType | '';
  /** 等级 */
  severity: FaultSeverity | '';
  /** 现场核对结论 */
  check: FieldFaultCheck;
  /** 现场说明 */
  note: string;
}

/** 封锁条件现场状态：已解除 / 仍在封锁 / 未能确认 */
export type FieldRestrictionState = 'lifted' | 'active' | 'unknown';

export const FIELD_RESTRICTION_STATE_LABEL: Record<FieldRestrictionState, string> = {
  lifted: '已解除',
  active: '仍在封锁',
  unknown: '未能确认',
};

/** 现场对登记封锁条件的核对记录 */
export interface FieldRestrictionResult {
  /** 对应导出时封锁条件登记行 id */
  restrictionId: string;
  yardId: string;
  switchCode: string;
  state: FieldRestrictionState;
  note: string;
}

/** 封锁条件引用（回传包只携带核对所需字段，登记行结构以 utils/db.ts 为准） */
export interface RestrictionRef {
  restrictionId: string;
  yardId: string;
  /** 空串表示站场级 */
  switchCode: string;
  limitKmh: number;
  period: string;
  reason: string;
}

/** 现场完工登记（断网离线保存，回站随回传包导入） */
export interface FieldCompletion {
  /** 完工登记时间（现场设备时间） */
  registeredAt: string;
  /** 登记人 */
  registrar: string;
  /** 现场实际负责人 */
  leaderActual: string;
  /** 现场实际作业人员 */
  membersActual: string[];
  /** 现场实际使用机具 */
  machinesActual: string[];
  /** 完工说明 */
  finishNote: string;
  /** 见证资料 */
  evidences: FieldEvidence[];
  /** 关联病害逐条核对 */
  faultResults: FieldFaultResult[];
  /** 封锁条件逐条核对 */
  restrictionResults: FieldRestrictionResult[];
}

/** 回传包内病害摘要（供现场誊抄核对，不参与本地建档） */
export interface FieldFaultRef {
  faultId: string;
  switchCode: string;
  part: FaultPart;
  type: FaultType;
  severity: FaultSeverity;
}

/** 回传包中一张作业单的完整内容 */
export interface FieldReturnEntry {
  /** 作业单 id，与派工基线一致，导入时按此挂回本地记录 */
  workOrderId: string;
  workOrderCode: string;
  /** 导出时携带的派工基线 */
  baseline: DispatchBaseline;
  /** 现场完成登记；仅导出模板、现场尚未登记时为 null */
  completion: FieldCompletion | null;
  /** 导出时关联病害摘要 */
  faultRefs: FieldFaultRef[];
  /** 导出时登记中、与本单相关的封锁条件 */
  restrictions: RestrictionRef[];
}

/** 回传包文件结构（现场离线记录 → 回站导入合并） */
export interface FieldReturnPackage {
  /** 固定标识，导入时校验 */
  packageType: 'gbrailswitch-field-return';
  packageVersion: 1;
  /** 包唯一编号，重复导入据此去重 */
  packageId: string;
  exportedAt: string;
  /** 回站填写（导出 / 导入班组） */
  station: string;
  /** 导出端数据结构版本 */
  schemaVersion: number;
  entries: FieldReturnEntry[];
}

/** 回传包类型标识 */
export const FIELD_RETURN_PACKAGE_TYPE = 'gbrailswitch-field-return';
/** 回传包版本 */
export const FIELD_RETURN_PACKAGE_VERSION = 1;

/** 一条待处理缺口的阻塞类型（reconcile 的 kind 在 ./reconcile.ts 定义，这里只给页面提示口径） */
export type FieldGapBlock = 'fault' | 'restriction';

/** 兼容旧作业单：取派工基线，缺失时按当前作业单内容回填 */
export function baselineOf(
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
  frozenAt: string,
): DispatchBaseline {
  if (order.dispatchBaseline) return order.dispatchBaseline;
  return {
    workOrderId: order.id,
    workOrderCode: order.code,
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    leader: order.leader,
    members: [...order.members],
    machines: [...order.machines],
    faultIds: [...order.faultIds],
    frozenAt,
    backfilled: true,
  };
}
