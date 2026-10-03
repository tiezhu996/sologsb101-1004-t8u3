/**
 * 现场回传（Redux Toolkit slice）
 * 维护完工见证登记、待处理缺口、封锁条件解除、检查点批次，以及核对销号的闸门。
 * 人员/机具/负责人分歧未处理时推进作业状态由 workOrderStore 查本 slice 数据判定。
 */
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import {
  db,
  listCompletions,
  listImportBatches,
  listPendingItems,
  listRestrictions,
  putCompletion,
  putFaults,
  putPendingItem,
  putRestriction,
  putWorkOrder,
  type FaultRow,
  type FieldCompletionRow,
  type ImportBatchRow,
  type PendingItemRow,
  type SpeedRestrictionRow,
  type WorkOrderRow,
} from '../utils/db';
import type { WitnessMaterial } from '../types/fieldReturn';
import { pendingGateOf, type PendingStatus } from '../types/pending';
import { ROW_REVISION } from '../types/persistence';
import { nowDateTime } from '../utils/window';
import { importFieldReturnPackage, retryFailedImport, syncLocalCompletionGaps } from '../utils/fieldImport';
import type { FieldImportResult } from '../utils/fieldImport';
import type { FieldReturnPackage } from '../types/fieldReturn';
import { isRestrictionActive } from '../types/restriction';
import { emitChange } from '../utils/events';

export interface RegisterCompletionInput {
  workOrder: WorkOrderRow;
  leader: string;
  members: string[];
  machines: string[];
  witnesses: WitnessMaterial[];
  summary: string;
  completedAt: string;
}

export interface ResolvePendingInput {
  id: string;
  status: PendingStatus;
  note: string;
  /** 分歧类缺口选择「以现场为准」时，是否同步更新本地安排 */
  adoptField: boolean;
}

export interface FieldState {
  completions: FieldCompletionRow[];
  pendingItems: PendingItemRow[];
  restrictions: SpeedRestrictionRow[];
  batches: ImportBatchRow[];
  loading: boolean;
  error: string;
}

const initialState: FieldState = {
  completions: [],
  pendingItems: [],
  restrictions: [],
  batches: [],
  loading: false,
  error: '',
};

/** 载入现场回传相关数据（首屏与写入后） */
export const loadFieldData = createAsyncThunk<
  {
    completions: FieldCompletionRow[];
    pendingItems: PendingItemRow[];
    restrictions: SpeedRestrictionRow[];
    batches: ImportBatchRow[];
  },
  void,
  { rejectValue: string }
>('field/load', async (_arg, { rejectWithValue }) => {
  try {
    const [completions, pendingItems, restrictions, batches] = await Promise.all([
      listCompletions(),
      listPendingItems(),
      listRestrictions(),
      listImportBatches(),
    ]);
    return { completions, pendingItems, restrictions, batches };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '现场回传数据读取失败');
  }
});

/**
 * 现场完工登记（本机离线登记；现场包导入在 utils/fieldImport.ts）。
 * 只写完工与见证资料并挂到作业单，不推进作业状态。
 */
export const registerCompletion = createAsyncThunk<
  { completionId: string; workOrderId: string },
  RegisterCompletionInput,
  { rejectValue: string }
>('field/registerCompletion', async (input, { rejectWithValue }) => {
  try {
    const stamp = nowDateTime();
    const existing = await db.completions.where('workOrderId').equals(input.workOrder.id).first();
    const completion: FieldCompletionRow = {
      id: existing?.id ?? `comp-${input.workOrder.id}-${Date.now().toString(36)}`,
      workOrderId: input.workOrder.id,
      workOrderCode: input.workOrder.code,
      packageId: existing?.packageId ?? null,
      leader: input.leader.trim(),
      members: input.members,
      machines: input.machines,
      faultResults:
        existing?.faultResults ??
        input.workOrder.faultIds.map((faultId) => ({ faultId, result: 'treated' as const, note: '' })),
      witnesses: input.witnesses.filter((item) => item.ref.trim()),
      summary: input.summary.trim(),
      completedAt: input.completedAt,
      recordedAt: stamp,
      source: existing?.source ?? 'local',
      revision: ROW_REVISION,
    };
    await putCompletion(completion);
    if (input.workOrder.completionId !== completion.id) {
      await putWorkOrder({ ...input.workOrder, completionId: completion.id, updatedAt: stamp });
    }
    // 与回传包导入同一口径：按派工基线/封锁/病害生成本机待处理缺口（处理前不能推进 / 核对前不能销号）
    await syncLocalCompletionGaps(completion.workOrderId);
    emitChange();
    return { completionId: completion.id, workOrderId: input.workOrder.id };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '完工登记失败');
  }
});

/** 导入现场回传包（内部按检查点分阶段、判重） */
export const importFieldPackage = createAsyncThunk<FieldImportResult, FieldReturnPackage, { rejectValue: string }>(
  'field/importPackage',
  async (pkg, { rejectWithValue }) => {
    try {
      const result = await importFieldReturnPackage(pkg);
      emitChange();
      return result;
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '回传包导入失败');
    }
  },
);

/** 整包写入失败后从检查点重试 */
export const retryFieldImport = createAsyncThunk<FieldImportResult, string, { rejectValue: string }>(
  'field/retryImport',
  async (packageId, { rejectWithValue }) => {
    try {
      const result = await retryFailedImport(packageId);
      emitChange();
      return result;
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '检查点重试失败');
    }
  },
);

/** 封锁条件解除（销号前必须解除） */
export const liftRestriction = createAsyncThunk<void, string, { rejectValue: string }>(
  'field/liftRestriction',
  async (id, { rejectWithValue }) => {
    try {
      const restriction = await db.restrictions.get(id);
      if (!restriction) return;
      await putRestriction({ ...restriction, liftedAt: nowDateTime() });
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '封锁条件解除失败');
    }
  },
);

/** 处理 / 挂起待处理缺口；分歧类可选择以现场为准更新本地安排 */
export const resolvePendingItem = createAsyncThunk<void, ResolvePendingInput, { rejectValue: string }>(
  'field/resolvePending',
  async (input, { rejectWithValue }) => {
    try {
      const stamp = nowDateTime();
      const item = await db.pendingItems.get(input.id);
      if (!item) return;
      const next: PendingItemRow = {
        ...item,
        status: input.status,
        resolutionNote: input.note.trim(),
        resolvedAt: stamp,
        updatedAt: stamp,
      };
      if (input.adoptField && input.status === 'resolved') {
        const order = await db.workOrders.get(item.workOrderId);
        const completion = (await db.completions.where('workOrderId').equals(item.workOrderId).first()) ?? null;
        if (order && completion) {
          const adopted: WorkOrderRow = { ...order, updatedAt: stamp };
          if (item.kind === 'leaderMismatch') adopted.leader = completion.leader;
          if (item.kind === 'memberMismatch') adopted.members = [...completion.members];
          if (item.kind === 'machineMismatch') adopted.machines = [...completion.machines];
          await putWorkOrder(adopted);
        }
      }
      await putPendingItem(next);
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '待处理项更新失败');
    }
  },
);

/** 核对销号结果 */
export interface CloseoutResult {
  workOrderId: string;
  solvedCount: number;
  autoResolvedCount: number;
  /** 仍阻断销号的缺口说明 */
  blockers: string[];
}

/**
 * 核对销号：封锁条件已解除并核对关联病害后才销号。
 * - 自动清理已自然解除 / 病害已销号的过期缺口
 * - 仍有 open 的销号闸门缺口时拒绝推进
 * - 现场标记已处治（或本地登记默认已处治）的待修病害回写销号；现场未处治的保留待修（缺口挂起）
 */
export const closeoutWorkOrder = createAsyncThunk<
  CloseoutResult,
  { workOrderId: string },
  { rejectValue: string }
>('field/closeout', async ({ workOrderId }, { rejectWithValue }) => {
  try {
    const stamp = nowDateTime();
    const order = await db.workOrders.get(workOrderId);
    if (!order) return { workOrderId, solvedCount: 0, autoResolvedCount: 0, blockers: ['作业单不存在'] };
    if (!order.completionId) {
      return { workOrderId, solvedCount: 0, autoResolvedCount: 0, blockers: ['尚未登记完工与见证资料'] };
    }

    const pending = await db.pendingItems.where('workOrderId').equals(workOrderId).toArray();
    const restrictions = await db.restrictions.toArray();
    const faults = await db.faults.toArray();
    const completion = await db.completions.get(order.completionId);

    // 自动复核：封锁已解除 / 病害已销号的缺口自动关闭
    let autoResolvedCount = 0;
    for (const item of pending) {
      if (item.status !== 'open') continue;
      let autoClose = false;
      if (item.kind === 'restrictionActive' && item.restrictionId) {
        const restriction = restrictions.find((row) => row.id === item.restrictionId);
        if (restriction && !isRestrictionActive(restriction)) autoClose = true;
      } else if (item.kind === 'faultMissing') {
        autoClose = faults.some((row) => row.id === item.faultId);
      } else if (item.kind === 'faultUntreated' && item.faultId) {
        const fault = faults.find((row) => row.id === item.faultId);
        if (fault?.state === 'solved') autoClose = true;
      }
      if (autoClose) {
        await putPendingItem({
          ...item,
          status: 'resolved',
          resolutionNote: '核对时条件已满足，自动关闭',
          resolvedAt: stamp,
          updatedAt: stamp,
        });
        autoResolvedCount += 1;
      }
    }

    const refreshed = await db.pendingItems.where('workOrderId').equals(workOrderId).toArray();
    const blockers = refreshed
      .filter((item) => item.status === 'open' && pendingGateOf(item.kind) === 'closeout')
      .map((item) => item.detail);
    if (blockers.length > 0) {
      return { workOrderId, solvedCount: 0, autoResolvedCount, blockers };
    }

    // 核对关联病害：现场已处治（未标记 untreated）的回写销号；untreated 保留待修，其缺口须已挂起
    const untreatedIds = new Set(
      (completion?.faultResults ?? [])
        .filter((row) => row.result === 'untreated')
        .map((row) => row.faultId),
    );
    const related = faults.filter(
      (item) => order.faultIds.includes(item.id) && item.state === 'pending' && !untreatedIds.has(item.id),
    );
    if (related.length > 0) {
      await putFaults(related.map((item): FaultRow => ({ ...item, state: 'solved', solvedAt: stamp })));
    }
    await putWorkOrder({ ...order, state: 'done', updatedAt: stamp });
    emitChange();
    return { workOrderId, solvedCount: related.length, autoResolvedCount, blockers: [] };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '核对销号失败');
  }
});

/** 删除失败的导入检查点（清理无效批次，不动业务数据） */
export const discardImportBatch = createAsyncThunk<void, string, { rejectValue: string }>(
  'field/discardBatch',
  async (id, { rejectWithValue }) => {
    try {
      await db.importBatches.delete(id);
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '检查点删除失败');
    }
  },
);

const fieldSlice = createSlice({
  name: 'field',
  initialState,
  reducers: {
    clearFieldError(state) {
      state.error = '';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadFieldData.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(loadFieldData.fulfilled, (state, action) => {
        state.loading = false;
        state.completions = action.payload.completions;
        state.pendingItems = action.payload.pendingItems;
        state.restrictions = action.payload.restrictions;
        state.batches = action.payload.batches;
      })
      .addCase(loadFieldData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '现场回传数据读取失败';
      });
  },
});

export const { clearFieldError } = fieldSlice.actions;
export default fieldSlice.reducer;

/* ============================== 选择器 ============================== */

interface RootLike {
  field: FieldState;
}

export const selectFieldData = (state: RootLike): FieldState => state.field;

/** 作业单的未处理缺口（按闸门分类） */
export function selectPendingByOrder(state: RootLike): Record<string, PendingItemRow[]> {
  const grouped: Record<string, PendingItemRow[]> = {};
  for (const item of state.field.pendingItems) {
    (grouped[item.workOrderId] ??= []).push(item);
  }
  return grouped;
}

export function selectOpenPendingCount(state: RootLike): number {
  return state.field.pendingItems.filter((item) => item.status === 'open').length;
}

export function selectFailedBatches(state: RootLike): ImportBatchRow[] {
  return state.field.batches.filter((item) => item.status === 'failed');
}

export { pendingGateOf };
