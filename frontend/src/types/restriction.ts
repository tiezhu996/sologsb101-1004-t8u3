/**
 * 封锁 / 慢行条件登记（/backup 页登记，现场回传包随包导出）。
 * 类型独立于 utils/db.ts，供回传包与作业单类型引用，避免类型层反向依赖数据层。
 */
import type { Revisioned } from './persistence';
import { todayDate } from '../utils/window';

/** 封锁 / 慢行条件 */
export interface SpeedRestriction extends Revisioned {
  id: string;
  /** 关联站场 */
  yardId: string;
  /** 关联道岔（可空，表示站场级） */
  switchCode: string;
  /** 限速值 km/h（封锁条件登记为 0） */
  limitKmh: number;
  /** 起止时间描述 yyyy-MM-dd ~ yyyy-MM-dd */
  period: string;
  /** 登记原因 */
  reason: string;
  createdAt: string;
  /** 解除时间；null 表示登记中（仍在封锁 / 慢行），现场销号前必须已解除 */
  liftedAt: string | null;
}

/** 封锁判定：限速 0 km/h 视为封锁（停车），其余为慢行 */
export function isBlockRestriction(restriction: Pick<SpeedRestriction, 'limitKmh'>): boolean {
  return restriction.limitKmh <= 0;
}

/**
 * 是否仍在生效（登记中）：未手动解除，且登记止期不早于今天。
 * 封锁条件解除以 liftedAt 为准；止期已过视为自然解除。
 */
export function isRestrictionActive(
  restriction: Pick<SpeedRestriction, 'liftedAt' | 'period'>,
  today: string = todayDate(),
): boolean {
  if (restriction.liftedAt) return false;
  const end = String(restriction.period ?? '')
    .split('~')
    .pop()
    ?.trim();
  if (!end) return true;
  return end >= today;
}
