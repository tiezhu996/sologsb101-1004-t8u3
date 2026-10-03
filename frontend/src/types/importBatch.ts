/**
 * 回传包导入批次（检查点）。
 * 整包写入分阶段落检查点；写入失败后从检查点重试（已完成阶段跳过）。
 * 同一回传包重复导入：completed 的批次直接跳过，不重复建档。
 */
import type { Revisioned } from './persistence';
import type { FieldReturnPackage } from './fieldReturn';

/** 导入阶段（顺序执行） */
export type ImportStage = 'order' | 'completion' | 'restriction' | 'gaps' | 'completed';

export const IMPORT_STAGE_ORDER: ImportStage[] = ['order', 'completion', 'restriction', 'gaps', 'completed'];

export const IMPORT_STAGE_LABEL: Record<ImportStage, string> = {
  order: '挂回作业单与派工基线',
  completion: '写入完工与见证资料',
  restriction: '核对封锁条件',
  gaps: '登记待处理缺口',
  completed: '整包写入完成',
};

/** 批次状态 */
export type ImportBatchStatus = 'completed' | 'failed';

export interface ImportBatch extends Revisioned {
  /** 即回传包 packageId */
  id: string;
  workOrderId: string;
  workOrderCode: string;
  /** 已完成的最后阶段（下次从此阶段之后重试） */
  checkpoint: ImportStage;
  status: ImportBatchStatus;
  /** 失败原因（成功后清空） */
  lastError: string;
  attempts: number;
  importedAt: string;
  updatedAt: string;
  /** 原始回传包：失败重试时直接从检查点继续，无需用户重新选文件 */
  payload: FieldReturnPackage;
}
