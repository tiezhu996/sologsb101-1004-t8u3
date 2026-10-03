/**
 * 天窗作业单状态（Redux Toolkit slice）
 * 维护作业单编排、时间窗冲突校验、人员机具占用校验与进度推进（完成回写销号）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  ROW_REVISION,
  db,
  listFaults,
  listInspections,
  listSwitches,
  listWorkOrders,
  listYards,
  putWorkOrder,
  removeWorkOrder,
  type FaultRow,
  type InspectionRow,
  type SwitchRow,
  type WorkOrderRow,
  type YardRow,
  type PendingItemRow,
} from '../utils/db';
import {
  WORK_ORDER_STATE_FLOW,
  buildWorkOrderCode,
  type WorkOrderDraft,
  type WorkOrderState,
  type WorkOrderView,
} from '../types/workOrder';
import {
  findConflicts,
  findMachineConflicts,
  findMemberConflicts,
  nowDateTime,
  windowMinutes,
} from '../utils/window';
import { emitChange } from '../utils/events';
import { buildDispatchBaseline } from '../utils/export';
import { pendingGateOf } from '../types/pending';

export interface WorkOrderStateSlice {
  workOrders: WorkOrderRow[];
  faults: FaultRow[];
  inspections: InspectionRow[];
  switches: SwitchRow[];
  yards: YardRow[];
  /** 待处理缺口（来自现场回传，负责人/人员/机具分歧未处理前阻断推进） */
  pendingItems: PendingItemRow[];
  /** 编排时勾选的病害 */
  selectedFaultIds: string[];
  loading: boolean;
  error: string;
}

const initialState: WorkOrderStateSlice = {
  workOrders: [],
  faults: [],
  inspections: [],
  switches: [],
  yards: [],
  pendingItems: [],
  selectedFaultIds: [],
  loading: false,
  error: '',
};

export const loadWorkOrderData = createAsyncThunk<
  {
    workOrders: WorkOrderRow[];
    faults: FaultRow[];
    inspections: InspectionRow[];
    switches: SwitchRow[];
    yards: YardRow[];
    pendingItems: PendingItemRow[];
  },
  void,
  { rejectValue: string }
>('workOrder/load', async (_arg, { rejectWithValue }) => {
  try {
    const [workOrders, faults, inspections, switches, yards, pendingItems] = await Promise.all([
      listWorkOrders(),
      listFaults(),
      listInspections(),
      listSwitches(),
      listYards(),
      db.pendingItems.toArray(),
    ]);
    return { workOrders, faults, inspections, switches, yards, pendingItems };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '作业单读取失败');
  }
});

/** 新建作业单：把勾选病害编排进同一时间窗，并回传时间窗冲突编号 */
export const createWorkOrder = createAsyncThunk<
  { created: boolean; conflicts: string[] },
  WorkOrderDraft,
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/create', async (draft, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const conflicts = findConflicts(
      { id: 'pending', windowStart: draft.windowStart, windowEnd: draft.windowEnd },
      state.workOrders.map((item) => ({
        id: item.id,
        code: item.code,
        windowStart: item.windowStart,
        windowEnd: item.windowEnd,
      })),
    ).map((item) => item.code);

    await putWorkOrder({
      id: `wo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      code: draft.code.trim() || buildWorkOrderCode(new Date(), state.workOrders.length + 1),
      faultIds: draft.faultIds,
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader.trim(),
      machines: draft.machines,
      members: draft.members,
      state: 'planned',
      // 待编排阶段先按当前安排回填兼容基线；下达到达时会重新冻结为正式派工基线
      dispatchBaseline: undefined,
      completionId: null,
      createdAt: nowDateTime(),
      updatedAt: nowDateTime(),
      revision: ROW_REVISION,
    });
    emitChange();
    return { created: true, conflicts };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '新建作业单失败');
  }
});

export const updateWorkOrder = createAsyncThunk<
  void,
  { id: string; draft: WorkOrderDraft },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/update', async ({ id, draft }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return;
    // 尚未下达的作业单被重新编排时，同步刷新兼容派工基线（正式基线在下达时冻结）
    const refreshBaseline =
      existing.state === 'planned'
        ? buildDispatchBaseline(
            {
              code: draft.code.trim(),
              faultIds: draft.faultIds,
              windowStart: draft.windowStart,
              windowEnd: draft.windowEnd,
              leader: draft.leader.trim(),
              machines: draft.machines,
              members: draft.members,
            },
            nowDateTime(),
            existing.dispatchBaseline?.source === 'legacyBackfill' ? 'legacyBackfill' : 'issued',
          )
        : existing.dispatchBaseline;
    await putWorkOrder({
      ...existing,
      code: draft.code.trim(),
      faultIds: draft.faultIds,
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      leader: draft.leader.trim(),
      machines: draft.machines,
      members: draft.members,
      dispatchBaseline: refreshBaseline,
      updatedAt: nowDateTime(),
    });
    emitChange();
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '更新作业单失败');
  }
});

/**
 * 推进作业单状态。
 * - 负责人 / 人员 / 机具现场分歧未处理（open 且阻断推进）时拒绝推进。
 * - 推进到「已完成」仅作兼容保留：正常流程改为现场页「核对销号」闸门
 *   （先登记完工与见证，封锁解除并核对关联病害后才销号），故此处不再自动销号。
 */
export const advanceWorkOrder = createAsyncThunk<
  { state: WorkOrderState; solvedCount: number },
  { id: string; next: WorkOrderState },
  { rejectValue: string; state: { workOrder: WorkOrderStateSlice } }
>('workOrder/advance', async ({ id, next }, { getState, rejectWithValue }) => {
  try {
    const state = getState().workOrder;
    const existing = state.workOrders.find((item) => item.id === id);
    if (!existing) return { state: next, solvedCount: 0 };
    const allowed = WORK_ORDER_STATE_FLOW[existing.state];
    if (!allowed.includes(next)) return { state: existing.state, solvedCount: 0 };

    // 人员 / 负责人 / 机具分歧两方来源未对账前，不能推进作业状态
    const advanceBlockers = state.pendingItems.filter(
      (item) =>
        item.workOrderId === id &&
        item.status === 'open' &&
        pendingGateOf(item.kind) === 'advance',
    );
    if (advanceBlockers.length > 0) {
      return rejectWithValue(
        `现场安排与派工基线尚有 ${advanceBlockers.length} 处分歧未处理（${advanceBlockers
          .map((item) => item.detail)
          .join('；')}），处理后才能推进`,
      );
    }

    const stamp = nowDateTime();
    const updated: WorkOrderRow = {
      ...existing,
      state: next,
      updatedAt: stamp,
      // 下达到达：冻结派工基线（已有基线的历史单不重复冻结）
      dispatchBaseline:
        next === 'issued'
          ? existing.dispatchBaseline ?? buildDispatchBaseline(existing, stamp, 'issued')
          : existing.dispatchBaseline,
      completionId: existing.completionId ?? null,
    };
    await putWorkOrder(updated);
    emitChange();
    return { state: next, solvedCount: 0 };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '推进作业单失败');
  }
});

export const deleteWorkOrder = createAsyncThunk<void, string, { rejectValue: string }>(
  'workOrder/delete',
  async (id, { rejectWithValue }) => {
    try {
      await removeWorkOrder(id);
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '删除作业单失败');
    }
  },
);

const workOrderSlice = createSlice({
  name: 'workOrder',
  initialState,
  reducers: {
    toggleFaultSelection(state, action: PayloadAction<string>) {
      const id = action.payload;
      state.selectedFaultIds = state.selectedFaultIds.includes(id)
        ? state.selectedFaultIds.filter((item) => item !== id)
        : [...state.selectedFaultIds, id];
    },
    setFaultSelection(state, action: PayloadAction<string[]>) {
      state.selectedFaultIds = action.payload;
    },
    clearFaultSelection(state) {
      state.selectedFaultIds = [];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadWorkOrderData.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(loadWorkOrderData.fulfilled, (state, action) => {
        state.loading = false;
        state.workOrders = action.payload.workOrders;
        state.faults = action.payload.faults;
        state.inspections = action.payload.inspections;
        state.switches = action.payload.switches;
        state.yards = action.payload.yards;
        state.pendingItems = action.payload.pendingItems;
        const validIds = new Set(action.payload.faults.map((item) => item.id));
        state.selectedFaultIds = state.selectedFaultIds.filter((id) => validIds.has(id));
      })
      .addCase(loadWorkOrderData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '作业单读取失败';
      });
  },
});

export const { toggleFaultSelection, setFaultSelection, clearFaultSelection } = workOrderSlice.actions;
export default workOrderSlice.reducer;

interface RootLike {
  workOrder: WorkOrderStateSlice;
}

/** 作业单视图：带病害标签、时长、冲突、未销号数量与现场回传闸门计数 */
export function selectWorkOrderViews(state: RootLike): WorkOrderView[] {
  const { workOrders, faults, inspections, switches, yards, pendingItems } = state.workOrder;
  const switchIdOfFault = (fault: FaultRow): string | undefined => {
    const inspection = inspections.find((row) => row.id === fault.inspectionId);
    return inspection?.switchId;
  };
  return workOrders
    .map((order) => {
      const related = faults.filter((item) => order.faultIds.includes(item.id));
      const orderPending = pendingItems.filter((item) => item.workOrderId === order.id && item.status === 'open');
      const labels = related.map((item) => {
        const switchRow = switches.find((row) => row.id === switchIdOfFault(item));
        return `${switchRow?.code ?? '-'} ${item.part}/${item.type}`;
      });
      const yardNames = [
        ...new Set(
          related
            .map((item) => switches.find((row) => row.id === switchIdOfFault(item))?.yardId)
            .map((yardId) => yards.find((row) => row.id === yardId)?.name)
            .filter((name): name is string => Boolean(name)),
        ),
      ];
      const others = workOrders.filter((item) => item.id !== order.id);
      const conflictCodes = others
        .filter((item) => item.windowStart < order.windowEnd && order.windowStart < item.windowEnd)
        .map((item) => item.code);
      const memberConflicts = findMemberConflicts(
        { id: order.id, windowStart: order.windowStart, windowEnd: order.windowEnd, members: order.members },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          members: item.members,
        })),
      );
      const machineConflicts = findMachineConflicts(
        { id: order.id, windowStart: order.windowStart, windowEnd: order.windowEnd, machines: order.machines },
        others.map((item) => ({
          id: item.id,
          code: item.code,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          machines: item.machines,
        })),
      );
      return {
        ...order,
        faultLabels: labels,
        yardNames,
        durationMinutes: windowMinutes({ windowStart: order.windowStart, windowEnd: order.windowEnd }),
        conflict: conflictCodes.length > 0,
        conflictCodes,
        memberConflict: memberConflicts.length > 0,
        machineConflict: machineConflicts.length > 0,
        pendingFaultCount: related.filter((item) => item.state === 'pending').length,
        completionRegistered: Boolean(order.completionId),
        advanceBlockCount: orderPending.filter((item) => pendingGateOf(item.kind) === 'advance').length,
        closeoutBlockCount: orderPending.filter((item) => pendingGateOf(item.kind) === 'closeout').length,
      };
    })
    .sort((a, b) => a.windowStart.localeCompare(b.windowStart));
}

/** 待编排病害（未销号且未编排） */
export function selectPlanableFaults(state: {
  workOrder: WorkOrderStateSlice;
}): Array<{ id: string; label: string; severity: string; state: string }> {
  const { faults, inspections, workOrders, switches } = state.workOrder;
  const plannedIds = new Set(workOrders.flatMap((item) => item.faultIds));
  return faults
    .filter((item) => item.state === 'pending' && !plannedIds.has(item.id))
    .map((item) => {
      const inspection = inspections.find((row) => row.id === item.inspectionId);
      const switchRow = inspection ? switches.find((row) => row.id === inspection.switchId) : undefined;
      return {
        id: item.id,
        label: `${switchRow?.code ?? '-'} · ${item.part} / ${item.type}`,
        severity: item.severity,
        state: item.state,
      };
    });
}

/** 天窗占用统计 */
export function selectWindowStats(state: RootLike): {
  total: number;
  minutes: number;
  occupationRate: number;
  conflictCount: number;
  doneCount: number;
} {
  const views = selectWorkOrderViews(state);
  const minutes = views.reduce((sum, item) => sum + item.durationMinutes, 0);
  return {
    total: views.length,
    minutes,
    occupationRate: Number(((minutes / 180) * 100).toFixed(1)),
    conflictCount: views.filter((item) => item.conflict).length,
    doneCount: views.filter((item) => item.state === 'done').length,
  };
}
