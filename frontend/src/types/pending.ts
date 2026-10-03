/**
 * 回传待处理项：现场记录与本地安排 / 封锁条件 / 关联病害对不上时逐条登记，
 * 缺口没清掉时留在待处理处并说明，负责人/人员/机具分歧未处理前不能推进作业状态。
 */
import type { Revisioned } from './persistence';

/** 待处理项类型 */
export type PendingKind =
  | 'leaderMismatch'
  | 'memberMismatch'
  | 'machineMismatch'
  | 'restrictionActive'
  | 'faultUntreated'
  | 'faultMissing'
  | 'witnessMissing';

/** 阻断对象：人员机具分歧阻断「推进作业状态」；其余缺口阻断「核对销号」 */
export type PendingGate = 'advance' | 'closeout';

/** 处理状态 */
export type PendingStatus = 'open' | 'resolved' | 'ignored';

export interface PendingItem extends Revisioned {
  /** 确定性 id（同一缺口重复导入不重复建档） */
  id: string;
  /** 关联作业单 id */
  workOrderId: string;
  /** 作业单编号（冗余展示） */
  workOrderCode: string;
  /** 关联病害 id（人员/封锁/见证类为空） */
  faultId: string | null;
  /** 关联封锁条件 id（仅封锁类） */
  restrictionId: string | null;
  /** 缺口类型 */
  kind: PendingKind;
  /** 阻断环节 */
  gate: PendingGate;
  /** 缺口说明 */
  detail: string;
  /** 现场来源值（如现场负责人、现场人员清单） */
  fieldValue: string;
  /** 本地 / 派工基线值 */
  localValue: string;
  status: PendingStatus;
  /** 处理备注（销号核对、缺口挂起时说明） */
  resolutionNote: string;
  /** 处理时间 */
  resolvedAt: string | null;
  /** 来源回传包 id（兼容缺基线的旧包时也可能为本地登记） */
  packageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const PENDING_KIND_LABEL: Record<PendingKind, string> = {
  leaderMismatch: '负责人不一致',
  memberMismatch: '作业人员不一致',
  machineMismatch: '机具不一致',
  restrictionActive: '封锁条件未解除',
  faultUntreated: '病害现场未处治',
  faultMissing: '关联病害本地缺失',
  witnessMissing: '见证资料缺失',
};

export const PENDING_GATE_LABEL: Record<PendingGate, string> = {
  advance: '处理前不能推进作业状态',
  closeout: '核对前不能销号',
};

export const PENDING_STATUS_LABEL: Record<PendingStatus, string> = {
  open: '待处理',
  resolved: '已处理',
  ignored: '已挂起说明',
};

/** 负责人 / 人员 / 机具分歧：未处理前不能推进作业状态 */
const ADVANCE_KINDS: ReadonlySet<PendingKind> = new Set(['leaderMismatch', 'memberMismatch', 'machineMismatch']);

export function pendingGateOf(kind: PendingKind): PendingGate {
  return ADVANCE_KINDS.has(kind) ? 'advance' : 'closeout';
}

export function isPendingOpen(item: Pick<PendingItem, 'status'>): boolean {
  return item.status === 'open';
}
