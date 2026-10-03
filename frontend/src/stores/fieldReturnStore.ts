/**
 * 现场回传状态（Redux Toolkit slice）
 * 维护回传包记录、待处理缺口、现场完工登记，以及：
 * - exportFieldReturn：导出时带上派工基线（旧数据兼容回填并落库）、关联病害、登记中的封锁条件
 * - importFieldReturnFile：分阶段导入合并（检查点见 utils/fieldImport），重复导入不重复建档
 * - resolveReconcile：处理缺口（两方来源都保留），处理结论不覆盖作业单
 * - verifyAndCloseOrder：封锁条件解除并核对关联病害后才销号；缺口没清掉时留在待处理处
 */
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import {
  listFaults,
  listInspections,
  listSwitches,
  listYards,
  listWorkOrders,
  listRestrictions,
  listFieldReturns,
  listReconciles,
  listFieldCompletions,
  getFieldReturnCompletion,
  listReconcilesByOrder,
  putWorkOrder,
  putFaults,
  putReconcile,
  type FaultRow,
  type InspectionRow,
  type SwitchRow,
  type YardRow,
  type WorkOrderRow,
  type FieldReturnRowRecord,
  type ReconcileItemRow,
  type FieldCompletionRowRecord,
} from '../utils/db';
import type { FieldReturnPackage, FieldReturnEntry, FieldEvidence, FieldFaultResult, FieldRestrictionResult } from '../types/fieldReturn';
import { buildEntry, buildFaultContext, buildPackage, orderActiveRestrictions } from '../utils/fieldReturn';
import { importFieldReturn, retryFieldReturn, type ImportResult } from '../utils/fieldImport';
import { DB_SCHEMA_VERSION } from '../utils/db';
import { nowDateTime } from '../utils/window';
import { nowIso } from '../utils/format';
import { emitChange } from '../utils/events';

export interface FieldReturnStateSlice {
  fieldReturns: FieldReturnRowRecord[];
  reconciles: ReconcileItemRow[];
  completions: FieldCompletionRowRecord[];
  loading: boolean;
  error: string;
}

const initialState: FieldReturnStateSlice = {
  fieldReturns: [],
  reconciles: [],
  completions: [],
  loading: false,
  error: '',
};

export const loadFieldReturnData = createAsyncThunk<
  {
    fieldReturns: FieldReturnRowRecord[];
    reconciles: ReconcileItemRow[];
    completions: FieldCompletionRowRecord[];
  },
  void,
  { rejectValue: string }
>('fieldReturn/load', async (_arg, { rejectWithValue }) => {
  try {
    const [fieldReturns, reconciles, completions] = await Promise.all([
      listFieldReturns(),
      listReconciles(),
      listFieldCompletions(),
    ]);
    return { fieldReturns, reconciles, completions };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '现场回传数据读取失败');
  }
});

/* ============================== 导出 ============================== */

export interface ExportFieldReturnInput {
  workOrderIds: string[];
  station: string;
}

/**
 * 导出现场回传包：携带派工基线、关联病害摘要、登记中的封锁条件。
 * 旧作业单缺少派工基线时按兼容方式回填（backfilled=true）并写回本地。
 */
export const exportFieldReturn = createAsyncThunk<
  { pkg: FieldReturnPackage; entries: FieldReturnEntry[]; backfilledCount: number },
  ExportFieldReturnInput,
  { rejectValue: string }
>('fieldReturn/export', async ({ workOrderIds, station }, { rejectWithValue }) => {
  try {
    const [orders, faults, inspections, switches, yards, restrictions] = await Promise.all([
      listWorkOrders(),
      listFaults(),
      listInspections(),
      listSwitches(),
      listYards(),
      listRestrictions(),
    ]);
    const picked = orders.filter((item) => workOrderIds.includes(item.id));
    if (picked.length === 0) return rejectWithValue('请先勾选要导出的作业单');
    const context = buildFaultContext(faults, inspections, switches, yards);
    const exportedAt = nowDateTime();

    // 兼容回填：缺少派工基线的旧作业单按当前内容冻结基线并持久化
    const backfilled = picked.filter((item) => !item.dispatchBaseline);
    if (backfilled.length > 0) {
      await Promise.all(
        backfilled.map((order) =>
          putWorkOrder({
            ...order,
            dispatchBaseline: {
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
            },
            updatedAt: exportedAt,
          }),
        ),
      );
    }
    const refreshed = backfilled.length
      ? picked.map((order) => {
          const updated = backfilled.find((item) => item.id === order.id);
          return updated && !order.dispatchBaseline
            ? {
                ...order,
                dispatchBaseline: {
                  workOrderId: order.id,
                  workOrderCode: order.code,
                  windowStart: order.windowStart,
                  windowEnd: order.windowEnd,
                  leader: order.leader,
                  members: [...order.members],
                  machines: [...order.machines],
                  faultIds: [...order.faultIds],
                  frozenAt: exportedAt,
                  backfilled: true as const,
                },
              }
            : order;
        })
      : picked;

    const entries = refreshed.map((order) => buildEntry(order, context, restrictions, exportedAt));
    const pkg = buildPackage(entries, station, DB_SCHEMA_VERSION, exportedAt);
    emitChange();
    return { pkg, entries, backfilledCount: backfilled.length };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '现场回传包导出失败');
  }
});

/* ============================== 导入 / 重试 ============================== */

export const importFieldReturnFile = createAsyncThunk<ImportResult, unknown, { rejectValue: string }>(
  'fieldReturn/import',
  async (input, { rejectWithValue }) => {
    try {
      const result = await importFieldReturn(input);
      emitChange();
      return result;
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '回传包导入失败');
    }
  },
);

export const retryFieldReturnPackage = createAsyncThunk<ImportResult, string, { rejectValue: string }>(
  'fieldReturn/retry',
  async (packageId, { rejectWithValue }) => {
    try {
      const result = await retryFieldReturn(packageId);
      emitChange();
      return result;
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '检查点重试失败');
    }
  },
);

/* ============================== 处理缺口 ============================== */

export interface ResolveReconcileInput {
  id: string;
  resolution: string;
}

/**
 * 处理待处理缺口：记录处理结论，两方来源（localValue / fieldValue）都原样保留。
 * 不覆盖作业单负责人 / 人员 / 机具——如需调整安排，到编排台单独修改。
 */
export const resolveReconcile = createAsyncThunk<
  void,
  ResolveReconcileInput,
  { rejectValue: string; state: { fieldReturn: FieldReturnStateSlice } }
>('fieldReturn/resolveReconcile', async ({ id, resolution }, { getState, rejectWithValue }) => {
  try {
    const existing = getState().fieldReturn.reconciles.find((item) => item.id === id);
    if (!existing) return;
    const stamp = nowIso();
    await putReconcile({
      ...existing,
      status: 'resolved',
      resolution: resolution.trim() || '已核对（两方来源并存留档）',
      resolvedAt: stamp,
      updatedAt: stamp,
    });
    emitChange();
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '缺口处理失败');
  }
});

/* ============================== 核对销号 ============================== */

export interface VerifyCloseResult {
  orderId: string;
  solvedFaultIds: string[];
  blocked: string[];
  closed: boolean;
}

/**
 * 现场完工后的“核对销号”：
 * 1) 待处理缺口未清（含封锁条件未解除）→ 不销号、不推进，缺口留在待处理处并说明；
 * 2) 封锁条件全部解除且关联病害核对通过 → 现场确认已修复 / 全部核对过的待修病害销号；
 * 3) 仍有现场确认存在 / 未找到 / 存疑 / 未核对的病害 → 留在待处理处，作业单不置完成。
 */
export const verifyAndCloseOrder = createAsyncThunk<
  VerifyCloseResult,
  string,
  {
    rejectValue: string;
    state: {
      fieldReturn: FieldReturnStateSlice;
      workOrder: { workOrders: WorkOrderRow[]; faults: FaultRow[]; inspections: InspectionRow[]; switches: SwitchRow[]; yards: YardRow[] };
    };
  }
>('fieldReturn/verifyAndClose', async (orderId, { getState, rejectWithValue }) => {
  try {
    const woState = getState().workOrder;
    const order = woState.workOrders.find((item) => item.id === orderId);
    if (!order) return rejectWithValue('本地未找到该作业单');
    // 直接读库：导入 / 重试刚写入后 Redux 状态可能尚未刷新，避免用到旧完工登记
    const [completion, orderReconciles] = await Promise.all([
      getFieldReturnCompletion(orderId),
      listReconcilesByOrder(orderId),
    ]);
    if (!completion) return rejectWithValue('该作业单尚无现场完工登记，请先导入回传包');

    // 1) 缺口闸门：本单所有待处理项必须先处理
    const pendingItems = orderReconciles.filter((item) => item.status === 'pending');
    const blocked = pendingItems.map((item) => item.detail);
    if (pendingItems.length > 0) {
      return { orderId, solvedFaultIds: [], blocked, closed: false };
    }

    // 2) 实时复核封锁条件（防止导入后本地又新增登记）
    const [restrictions, currentFaults] = await Promise.all([listRestrictions(), listFaults()]);
    const context = buildFaultContext(currentFaults, woState.inspections, woState.switches, woState.yards);
    const active = orderActiveRestrictions(order, context, restrictions);
    if (active.length > 0) {
      return {
        orderId,
        solvedFaultIds: [],
        blocked: active.map((item) => `封锁条件仍在登记期限内：${item.switchCode || '站场级'} 限速 ${item.limitKmh}km/h，${item.period}`),
        closed: false,
      };
    }

    // 3) 核对关联病害：现场确认已修复的待修病害销号
    const faultResults = parseJsonSafe<FieldFaultResult[]>(completion.faultResultsJson, []);
    const checkedMap = new Map(faultResults.map((item) => [item.faultId, item]));
    const related = currentFaults.filter((item) => order.faultIds.includes(item.id));
    const toSolve = related.filter(
      (fault) => fault.state === 'pending' && checkedMap.get(fault.id)?.check === 'repaired',
    );
    const stillPending = related.filter((fault) => {
      if (fault.state === 'solved') return false;
      return checkedMap.get(fault.id)?.check !== 'repaired';
    });
    if (stillPending.length > 0) {
      return {
        orderId,
        solvedFaultIds: [],
        blocked: stillPending.map((fault) => {
          const check = checkedMap.get(fault.id)?.check;
          return check ? `关联病害 ${fault.id} 现场结论未达修复标准，留在待处理处核对` : `关联病害 ${fault.id} 现场未核对，不能销号`;
        }),
        closed: false,
      };
    }

    const stamp = nowDateTime();
    if (toSolve.length > 0) {
      await putFaults(toSolve.map((fault) => ({ ...fault, state: 'solved' as const, solvedAt: stamp })));
    }
    // 状态推进到已完成
    if (order.state !== 'done') {
      await putWorkOrder({ ...order, state: 'done', updatedAt: stamp });
    }
    emitChange();
    return { orderId, solvedFaultIds: toSolve.map((item) => item.id), blocked: [], closed: true };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '核对销号失败');
  }
});

function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 解析完工登记中的见证资料 / 核对结果 */
export function completionEvidences(completion: FieldCompletionRowRecord | undefined): FieldEvidence[] {
  return completion ? parseJsonSafe<FieldEvidence[]>(completion.evidencesJson, []) : [];
}
export function completionFaultResults(completion: FieldCompletionRowRecord | undefined): FieldFaultResult[] {
  return completion ? parseJsonSafe<FieldFaultResult[]>(completion.faultResultsJson, []) : [];
}
export function completionRestrictionResults(
  completion: FieldCompletionRowRecord | undefined,
): FieldRestrictionResult[] {
  return completion ? parseJsonSafe<FieldRestrictionResult[]>(completion.restrictionResultsJson, []) : [];
}

const fieldReturnSlice = createSlice({
  name: 'fieldReturn',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(loadFieldReturnData.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(loadFieldReturnData.fulfilled, (state, action) => {
        state.loading = false;
        state.fieldReturns = action.payload.fieldReturns;
        state.reconciles = action.payload.reconciles;
        state.completions = action.payload.completions;
      })
      .addCase(loadFieldReturnData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '现场回传数据读取失败';
      });
  },
});

export default fieldReturnSlice.reducer;

/* ============================== 派生选择器 ============================== */

interface FieldRootLike {
  fieldReturn: FieldReturnStateSlice;
  workOrder: { workOrders: WorkOrderRow[] };
}

/** 回传包视图（带作业单号与检查点状态派生） */
export interface FieldReturnView extends FieldReturnRowRecord {
  workOrderCodes: string[];
  pendingCount: number;
  /** 是否停在失败检查点（可重试） */
  failed: boolean;
}

export function selectFieldReturnViews(state: FieldRootLike): FieldReturnView[] {
  const { fieldReturns, reconciles } = state.fieldReturn;
  const orderCodeById = new Map(state.workOrder.workOrders.map((item) => [item.id, item.code]));
  return fieldReturns.map((row) => {
    const codes = reconciles
      .filter((item) => item.packageId === row.id && item.workOrderId)
      .map((item) => orderCodeById.get(item.workOrderId) ?? item.workOrderCode);
    return {
      ...row,
      workOrderCodes: [...new Set(codes)],
      pendingCount: reconciles.filter((item) => item.packageId === row.id && item.status === 'pending').length,
      failed: Boolean(row.error) && row.stage !== 'done',
    };
  });
}

/** 按作业单 id 索引现场完工登记 */
export function selectCompletionByOrder(state: FieldRootLike): Map<string, FieldCompletionRowRecord> {
  return new Map(state.fieldReturn.completions.map((item) => [item.workOrderId, item]));
}

/** 按作业单 id 聚合待处理缺口 */
export function selectPendingByOrder(state: FieldRootLike): Map<string, ReconcileItemRow[]> {
  const map = new Map<string, ReconcileItemRow[]>();
  for (const item of state.fieldReturn.reconciles) {
    if (item.status !== 'pending' || !item.workOrderId) continue;
    const list = map.get(item.workOrderId) ?? [];
    list.push(item);
    map.set(item.workOrderId, list);
  }
  return map;
}

/** 全部待处理缺口（含未挂回项） */
export function selectPendingReconciles(state: { fieldReturn: FieldReturnStateSlice }): ReconcileItemRow[] {
  return state.fieldReturn.reconciles.filter((item) => item.status === 'pending');
}

/** 判断作业单是否被现场回传闸门阻塞（推进 / 完成前检查） */
export function selectOrderBlockedMap(
  state: FieldRootLike,
): Map<string, { blocked: boolean; reasons: string[]; hasCompletion: boolean }> {
  const pendingByOrder = selectPendingByOrder(state);
  const completionByOrder = selectCompletionByOrder(state);
  const map = new Map<string, { blocked: boolean; reasons: string[]; hasCompletion: boolean }>();
  for (const order of state.workOrder.workOrders) {
    const pending = pendingByOrder.get(order.id) ?? [];
    const hasCompletion = completionByOrder.has(order.id);
    map.set(order.id, {
      blocked: pending.length > 0,
      reasons: pending.map((item) => item.detail),
      hasCompletion,
    });
  }
  return map;
}
