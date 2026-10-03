/**
 * 现场完工登记与见证资料。
 * 作业队在区间断网时先把完工情况离线保存，回站后随回传包导入挂回作业单；
 * 完工登记不推进作业单状态 —— 须等封锁条件解除并核对关联病害后才允许销号。
 */
import type { Revisioned } from './persistence';
import type { DispatchBaseline } from './baseline';
import type { Fault } from './fault';
import type { SpeedRestriction } from './restriction';
import type { WorkOrder } from './workOrder';

/** 完工记录来源：现场回传包导入 / 在本机离线登记 */
export type CompletionSource = 'fieldPackage' | 'local';

/** 见证资料项（照片编号、视频、签字单等资料引用） */
export interface WitnessMaterial {
  /** 资料类型：照片 / 视频 / 签字单 / 其它 */
  kind: 'photo' | 'video' | 'signoff' | 'other';
  /** 资料编号或文件名，现场离线填写 */
  ref: string;
  /** 备注（拍摄部位、见证人等） */
  note: string;
}

export const WITNESS_KIND_LABEL: Record<WitnessMaterial['kind'], string> = {
  photo: '照片',
  video: '视频',
  signoff: '签字单',
  other: '其它',
};

/** 现场作业结果（按关联病害逐条登记） */
export interface FieldFaultResult {
  /** 关联病害 id（与派工基线 / 本地病害按编号挂回） */
  faultId: string;
  /** 现场处置结果：已处治待销号 / 未处治 */
  result: 'treated' | 'untreated';
  /** 现场备注 */
  note: string;
}

/** 现场完工登记（一张作业单一条，重复导入按 workOrderId 去重，不重复建档） */
export interface FieldCompletion extends Revisioned {
  id: string;
  /** 挂接的作业单 id */
  workOrderId: string;
  /** 作业单编号（冗余，便于作业单缺失时展示） */
  workOrderCode: string;
  /** 回传包 id（本机离线登记时为 null） */
  packageId: string | null;
  /** 现场实际负责人（可能与派工基线不同，两方来源都保留） */
  leader: string;
  /** 现场实际作业人员 */
  members: string[];
  /** 现场实际机具 */
  machines: string[];
  /** 各关联病害的现场处置结果 */
  faultResults: FieldFaultResult[];
  /** 见证资料 */
  witnesses: WitnessMaterial[];
  /** 完工说明 */
  summary: string;
  /** 现场完工时间 yyyy-MM-dd HH:mm */
  completedAt: string;
  /** 登记时间（导入或本机登记时间） */
  recordedAt: string;
  /** 来源 */
  source: CompletionSource;
}

/** 现场回传包：导出时带派工基线、关联病害与登记中的封锁条件 */
export interface FieldReturnPackage {
  /** 包类型标识，导入时校验 */
  kind: 'gbrailswitch-field-return';
  /** 包格式版本 */
  packageVersion: number;
  /** 回传包 id（同一包重复导入时据此判重，不重复建档） */
  packageId: string;
  /** 导出的作业单 id（导入先按编号挂回本地记录） */
  workOrderId: string;
  /** 作业单编号 */
  workOrderCode: string;
  exportedAt: string;
  /** 作业单的派工基线 */
  baseline: DispatchBaseline;
  /** 作业单快照（本地缺少该作业单时按快照兼容建档） */
  workOrder: WorkOrder;
  /** 关联病害快照（仅作核对参照，不覆盖本地病害） */
  faults: Fault[];
  /** 导出时登记中的封锁 / 慢行条件（封锁是否已解除的核对依据） */
  restrictions: SpeedRestriction[];
  /** 现场完工登记（离线登记后随包带回） */
  completion: FieldCompletion | null;
}

export const FIELD_RETURN_PACKAGE_KIND = 'gbrailswitch-field-return';
export const FIELD_RETURN_PACKAGE_VERSION = 1;
