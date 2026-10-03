/**
 * 派工基线：作业单下达时冻结的派工安排快照。
 * 现场回传包带上基线，导入时据此与本地安排、现场登记两相比对；
 * 旧数据缺少基线时按兼容方式回填（见 utils/db.ts 的 ensureDispatchBaselines）。
 */
import type { Revisioned } from './persistence';

/** 基线来源：下达时冻结 / 旧数据兼容回填 */
export type DispatchBaselineSource = 'issued' | 'legacyBackfill';

export interface DispatchBaseline {
  /** 冻结时的作业单编号 */
  code: string;
  /** 派工负责人 */
  leader: string;
  /** 派工作业人员 */
  members: string[];
  /** 派工机具 */
  machines: string[];
  /** 天窗起 yyyy-MM-dd HH:mm */
  windowStart: string;
  /** 天窗止 yyyy-MM-dd HH:mm */
  windowEnd: string;
  /** 关联病害 id 列表（派工时的挂接基线） */
  faultIds: string[];
  /** 冻结时间 */
  frozenAt: string;
  /** 基线来源 */
  source: DispatchBaselineSource;
}

/** 派工基线版本（随现场回传包导出，供导入方识别口径） */
export const DISPATCH_BASELINE_VERSION = 1;

/** 给落库实体复用的行修订号（基线内嵌于作业单，不单独成行） */
export type BaselineRevisioned = Revisioned;
