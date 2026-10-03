/**
 * /progress 作业进度与销号回写
 * 按天窗批次更新作业状态，完成项自动回写病害销号；
 * 消费 WorkOrder、Fault、Inspection 与 <FilterBar>。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import DownloadIcon from '@mui/icons-material/Download';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import { useAppDispatch, useAppSelector } from '../hooks/useAppStore';
import { advanceWorkOrder, selectWindowStats, selectWorkOrderViews } from '../stores/workOrderStore';
import { selectFaultViews } from '../stores/faultStore';
import {
  closeoutWorkOrder,
  registerCompletion,
  selectFieldData,
} from '../stores/fieldStore';
import {
  WORK_ORDER_STATE_FLOW,
  WORK_ORDER_STATE_LABEL,
  MEMBER_LIBRARY,
  MACHINE_LIBRARY,
  type WorkOrder,
  type WorkOrderState,
} from '../types/workOrder';
import { FAULT_SEVERITY_LABEL } from '../types/fault';
import { ROUTES } from '../router/routes';
import { formatDuration, nowDateTime } from '../utils/window';
import { downloadCsv, downloadJson, share } from '../utils/format';
import { SEVERITY_HEX } from '../utils/severity';
import { listFaults, listInspections, listSwitches } from '../utils/db';
import { buildFieldReturnPackage, fieldReturnFilename, restrictionsForOrder } from '../utils/export';
import {
  PENDING_GATE_LABEL,
  PENDING_KIND_LABEL,
} from '../types/pending';
import { WITNESS_KIND_LABEL, type WitnessMaterial } from '../types/fieldReturn';
import { useIdbTable } from '../hooks/useIdbTable';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar, { useFilterValues, useKeywordFilter } from '../components/common/FilterBar';

const STATE_ORDER: WorkOrderState[] = ['planned', 'issued', 'working', 'done'];

interface CompletionForm {
  leader: string;
  membersText: string;
  machinesText: string;
  completedAt: string;
  summary: string;
  witnesses: WitnessMaterial[];
}

function completionForm(order: WorkOrder): CompletionForm {
  return {
    leader: order.leader,
    membersText: order.members.join('、'),
    machinesText: order.machines.join('、'),
    completedAt: nowDateTime(),
    summary: '',
    witnesses: [{ kind: 'photo', ref: '', note: '' }],
  };
}

/** 按顿号/逗号/空格拆人员机具清单 */
function splitNameList(text: string): string[] {
  return text
    .split(/[、,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function ProgressView() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const orders = useAppSelector(selectWorkOrderViews);
  const faults = useAppSelector(selectFaultViews);
  const stats = useAppSelector(selectWindowStats);
  const { pendingItems, completions, restrictions } = useAppSelector(selectFieldData);
  const { data: faultRows } = useIdbTable(listFaults, []);
  const { data: inspectionRows } = useIdbTable(listInspections, []);
  const { data: switchRows } = useIdbTable(listSwitches, []);

  const keyword = useKeywordFilter();
  const filters = useFilterValues(['state', 'yard']);
  const [toast, setToast] = useState('');
  const [dialog, setDialog] = useState<{ open: boolean; order: WorkOrder | null; form: CompletionForm }>({
    open: false,
    order: null,
    form: completionForm({} as WorkOrder),
  });

  const rows = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    const stateFilter = (filters.state ?? []) as WorkOrderState[];
    const yardFilter = filters.yard ?? [];
    return orders
      .filter((order) => {
        if (stateFilter.length > 0 && !stateFilter.includes(order.state)) return false;
        if (yardFilter.length > 0 && !order.yardNames.some((name) => yardFilter.includes(name))) return false;
        if (lower && !`${order.code} ${order.leader} ${order.faultLabels.join(' ')}`.toLowerCase().includes(lower)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const byState = STATE_ORDER.indexOf(b.state) - STATE_ORDER.indexOf(a.state);
        if (byState !== 0) return byState;
        return a.windowStart.localeCompare(b.windowStart);
      });
  }, [orders, keyword, filters]);

  const overview = useMemo(() => {
    const done = orders.filter((item) => item.state === 'done').length;
    const working = orders.filter((item) => item.state === 'working').length;
    const issued = orders.filter((item) => item.state === 'issued').length;
    const planned = orders.filter((item) => item.state === 'planned').length;
    const pendingFaults = faults.filter((item) => item.state === 'pending').length;
    const solvedFaults = faults.filter((item) => item.state === 'solved').length;
    return {
      done,
      working,
      issued,
      planned,
      pendingFaults,
      solvedFaults,
      completion: orders.length === 0 ? 0 : Number(((done / orders.length) * 100).toFixed(1)),
      solveRate: faults.length === 0 ? 0 : Number(((solvedFaults / faults.length) * 100).toFixed(1)),
    };
  }, [orders, faults]);

  const advance = async (id: string, next: WorkOrderState, code: string): Promise<void> => {
    try {
      await dispatch(advanceWorkOrder({ id, next })).unwrap();
      setToast(`${code} 已推进为「${WORK_ORDER_STATE_LABEL[next]}」`);
    } catch (error) {
      setToast(`推进失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  /** 登记现场完工与见证（离线保存，不推进作业状态） */
  const submitCompletion = async (): Promise<void> => {
    const order = dialog.order;
    if (!order) return;
    const witnesses = dialog.form.witnesses.filter((item) => item.ref.trim());
    if (!dialog.form.leader.trim()) {
      setToast('请填写现场负责人');
      return;
    }
    if (witnesses.length === 0) {
      setToast('请至少登记 1 份见证资料（照片 / 视频 / 签字单编号）');
      return;
    }
    try {
      await dispatch(
        registerCompletion({
          workOrder: order,
          leader: dialog.form.leader,
          members: splitNameList(dialog.form.membersText),
          machines: splitNameList(dialog.form.machinesText),
          witnesses,
          summary: dialog.form.summary,
          completedAt: dialog.form.completedAt,
        }),
      ).unwrap();
      setToast(`${order.code} 完工与见证资料已登记，作业状态保持「${WORK_ORDER_STATE_LABEL[order.state]}」，待封锁解除并核对病害后销号`);
      setDialog({ open: false, order: null, form: completionForm({} as WorkOrder) });
    } catch (error) {
      setToast(`完工登记失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  /** 封锁解除并核对关联病害后销号 */
  const closeout = async (id: string, code: string): Promise<void> => {
    try {
      const result = await dispatch(closeoutWorkOrder({ workOrderId: id })).unwrap();
      if (result.blockers.length > 0) {
        setToast(`${code} 暂不能销号：${result.blockers.join('；')}`);
      } else {
        setToast(`${code} 核对完成，回写销号 ${result.solvedCount} 处病害`);
      }
    } catch (error) {
      setToast(`核对销号失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  /** 按作业单导出回传包（派工基线 + 关联病害 + 登记中的封锁条件） */
  const exportOrderPackage = (order: WorkOrder): void => {
    const relatedFaults = (faultRows ?? []).filter((item) => order.faultIds.includes(item.id));
    const relatedRestrictions = restrictionsForOrder(
      order,
      relatedFaults,
      inspectionRows ?? [],
      switchRows ?? [],
      restrictions,
    );
    const completion = completions.find((item) => item.workOrderId === order.id) ?? null;
    const pkg = buildFieldReturnPackage({ order, faults: relatedFaults, restrictions: relatedRestrictions, completion });
    downloadJson(fieldReturnFilename(order), pkg);
    setToast(`${order.code} 回传包已导出（含派工基线、关联病害与 ${relatedRestrictions.length} 条封锁条件）`);
  };

  const pendingByOrder = useMemo(() => {
    const map = new Map<string, typeof pendingItems>();
    for (const item of pendingItems) {
      if (item.status !== 'open') continue;
      const list = map.get(item.workOrderId) ?? [];
      list.push(item);
      map.set(item.workOrderId, list);
    }
    return map;
  }, [pendingItems]);

  const completionByOrder = useMemo(
    () => new Map(completions.map((item) => [item.workOrderId, item])),
    [completions],
  );

  const exportCsv = (): void => {
    const header = ['作业单', '状态', '天窗起', '天窗止', '时长(分钟)', '负责人', '作业人员', '机具', '关联病害', '待销号', '冲突'];
    const body = rows.map((order) => [
      order.code,
      WORK_ORDER_STATE_LABEL[order.state],
      order.windowStart,
      order.windowEnd,
      order.durationMinutes,
      order.leader,
      order.members.join(' '),
      order.machines.join(' '),
      order.faultIds.length,
      order.pendingFaultCount,
      order.conflict ? order.conflictCodes.join(' ') : '无',
    ]);
    downloadCsv(`gbrailswitch-progress-${nowDateTime().slice(0, 10)}.csv`, [header, ...body]);
    setToast('进度清单已导出 CSV');
  };

  const availableYards = useMemo(() => [...new Set(orders.flatMap((item) => item.yardNames))], [orders]);

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            作业进度与销号回写
          </Typography>
          <Typography variant="body2" color="text.secondary">
            按天窗批次推进状态：待编排 → 已下达 → 作业中 → 已完成；推进到已完成时自动回写关联病害销号。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<DownloadIcon />} onClick={exportCsv}>
            导出进度 CSV
          </Button>
          <Button variant="outlined" onClick={() => navigate(ROUTES.workorders)}>
            回编排台
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={1.5} mb={1.75}>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="作业完成率"
            value={overview.completion}
            suffix="%"
            percent={overview.completion}
            color="#2e7d32"
            hint={`已完成 ${overview.done} / 共 ${orders.length} 张`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="在办作业单"
            value={overview.working + overview.issued}
            suffix="张"
            color="#1565c0"
            hint={`已下达 ${overview.issued} · 作业中 ${overview.working} · 待编排 ${overview.planned}`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="病害销号率"
            value={overview.solveRate}
            suffix="%"
            percent={overview.solveRate}
            color="#00897b"
            hint={`已销号 ${overview.solvedFaults} 处 · 待修 ${overview.pendingFaults} 处`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="累计天窗时长"
            value={stats.minutes}
            suffix="分钟"
            color="#ed6c02"
            hint={`占用率 ${stats.occupationRate}%（基准 180 分钟/日）`}
          />
        </Grid>
      </Grid>

      <FilterBar
        keywordPlaceholder="按作业单号 / 负责人 / 病害搜索"
        selects={[
          {
            key: 'state',
            label: '作业状态',
            options: STATE_ORDER.map((item) => ({ label: WORK_ORDER_STATE_LABEL[item], value: item })),
            width: 180,
          },
          {
            key: 'yard',
            label: '涉及站场',
            options: availableYards.map((name) => ({ label: name, value: name })),
            width: 190,
          },
        ]}
        resultCount={rows.length}
        countUnit="张作业单"
      />

      <Box mt={1.75}>
        {rows.length === 0 ? (
          <EmptyPanel
            title="没有匹配的作业单"
            description="可到编排台新建作业单，或调整筛选条件。"
            extra={
              <Button variant="contained" onClick={() => navigate(ROUTES.workorders)}>
                去天窗编排
              </Button>
            }
          />
        ) : (
          <Stack spacing={1.5}>
            {rows.map((order) => {
              const progressPercent =
                order.state === 'done' ? 100 : order.state === 'working' ? 60 : order.state === 'issued' ? 30 : 10;
              const nextStates = WORK_ORDER_STATE_FLOW[order.state];
              const relatedFaults = faults.filter((item) => order.faultIds.includes(item.id));
              return (
                <Paper key={order.id} variant="outlined" sx={{ borderRadius: 2, p: 1.75 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap>
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Typography variant="subtitle1" fontWeight={600}>
                          {order.code}
                        </Typography>
                        <Chip
                          size="small"
                          color={order.state === 'done' ? 'success' : order.state === 'working' ? 'info' : 'default'}
                          label={WORK_ORDER_STATE_LABEL[order.state]}
                        />
                        {order.conflict ? (
                          <Tooltip title={`与 ${order.conflictCodes.join('、')} 时间窗重叠`}>
                            <Chip size="small" color="error" label="时间窗冲突" />
                          </Tooltip>
                        ) : null}
                        <Chip size="small" variant="outlined" label={`负责人 ${order.leader}`} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                        天窗 {order.windowStart} ~ {order.windowEnd}（{formatDuration(order.durationMinutes)}）· 涉及站场{' '}
                        {order.yardNames.join('、') || '—'}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      {nextStates.map((next) => (
                        <Button
                          key={next}
                          size="small"
                          variant="outlined"
                          color="primary"
                          startIcon={<PlayArrowIcon />}
                          onClick={() => void advance(order.id, next, order.code)}
                        >
                          推进为{WORK_ORDER_STATE_LABEL[next]}
                        </Button>
                      ))}
                      {order.state !== 'done' ? (
                        <Button
                          size="small"
                          variant={order.completionRegistered ? 'outlined' : 'contained'}
                          color="warning"
                          startIcon={<AssignmentTurnedInIcon />}
                          onClick={() =>
                            setDialog({
                              open: true,
                              order,
                              form: completionByOrder.get(order.id)
                                ? {
                                    leader: completionByOrder.get(order.id)!.leader,
                                    membersText: completionByOrder.get(order.id)!.members.join('、'),
                                    machinesText: completionByOrder.get(order.id)!.machines.join('、'),
                                    completedAt: completionByOrder.get(order.id)!.completedAt,
                                    summary: completionByOrder.get(order.id)!.summary,
                                    witnesses:
                                      completionByOrder.get(order.id)!.witnesses.length > 0
                                        ? completionByOrder.get(order.id)!.witnesses
                                        : [{ kind: 'photo', ref: '', note: '' }],
                                  }
                                : completionForm(order),
                            })
                          }
                        >
                          {order.completionRegistered ? '补录完工与见证' : '登记完工与见证'}
                        </Button>
                      ) : null}
                      {order.state === 'working' ? (
                        <Button
                          size="small"
                          variant="contained"
                          color="success"
                          startIcon={<FactCheckIcon />}
                          onClick={() => void closeout(order.id, order.code)}
                        >
                          核对销号
                        </Button>
                      ) : null}
                      <Tooltip title="导出该作业单的现场回传包（派工基线 / 关联病害 / 封锁条件）">
                        <Button
                          size="small"
                          startIcon={<CloudDownloadIcon />}
                          onClick={() => exportOrderPackage(order)}
                        >
                          回传包
                        </Button>
                      </Tooltip>
                      {order.state === 'done' ? <Chip icon={<CheckCircleIcon />} color="success" label="已核对销号" /> : null}
                    </Stack>
                  </Stack>

                  <Box mt={1.25}>
                    <LinearProgress
                      variant="determinate"
                      value={progressPercent}
                      sx={{ height: 8, borderRadius: 4 }}
                      color={order.state === 'done' ? 'success' : 'primary'}
                    />
                    <Stack direction="row" spacing={0.75} mt={0.5} flexWrap="wrap" useFlexGap>
                      <Typography variant="caption" color="text.secondary">
                        进度 {progressPercent}% · 关联病害 {order.faultIds.length} 处（待销号 {order.pendingFaultCount}）·
                        作业人员 {order.members.join('、')} · 机具 {order.machines.join('、')}
                      </Typography>
                      {order.completionRegistered ? (
                        <Chip size="small" color="warning" variant="outlined" label="完工与见证已登记" />
                      ) : null}
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`派工基线 ${order.dispatchBaseline?.source === 'legacyBackfill' ? '兼容回填' : '下达冻结'}`}
                      />
                      {(pendingByOrder.get(order.id) ?? []).map((item) => (
                        <Tooltip key={item.id} title={`${item.detail}（${PENDING_GATE_LABEL[item.gate]}）`}>
                          <Chip
                            size="small"
                            color={item.gate === 'advance' ? 'error' : 'warning'}
                            label={PENDING_KIND_LABEL[item.kind]}
                            onClick={() => navigate(ROUTES.fieldReturn)}
                          />
                        </Tooltip>
                      ))}
                    </Stack>
                  </Box>

                  <TableContainer sx={{ mt: 1 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>关联病害</TableCell>
                          <TableCell>部件 / 类型</TableCell>
                          <TableCell>等级</TableCell>
                          <TableCell>巡检日期</TableCell>
                          <TableCell>销号状态</TableCell>
                          <TableCell>销号时间</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {relatedFaults.map((fault) => (
                          <TableRow key={fault.id} hover>
                            <TableCell>
                              {fault.yardName} · {fault.switchCode}
                            </TableCell>
                            <TableCell>
                              {fault.part} / {fault.type}
                            </TableCell>
                            <TableCell>
                              <Chip
                                size="small"
                                label={FAULT_SEVERITY_LABEL[fault.severity]}
                                sx={{
                                  backgroundColor: `${SEVERITY_HEX[fault.severity]}1a`,
                                  color: SEVERITY_HEX[fault.severity],
                                }}
                              />
                            </TableCell>
                            <TableCell>{fault.inspectionDate}</TableCell>
                            <TableCell>
                              <Chip
                                size="small"
                                variant="outlined"
                                color={fault.state === 'solved' ? 'success' : 'warning'}
                                label={fault.state === 'solved' ? '已销号' : '待修'}
                              />
                            </TableCell>
                            <TableCell>{fault.solvedAt ?? '—'}</TableCell>
                          </TableRow>
                        ))}
                        {relatedFaults.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={6} align="center">
                              <Typography variant="caption" color="text.secondary">
                                关联病害已被删除或尚未加载
                              </Typography>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Paper>
              );
            })}
          </Stack>
        )}
      </Box>

      <Alert severity="info" sx={{ mt: 2 }}>
        说明：现场完成先登记完工与见证资料（作业状态不推进）；负责人 / 人员 / 机具与派工基线不一致的分歧未处理前不能
        推进作业状态。等封锁条件解除并核对关联病害后，在「现场回传与缺口」页或本页执行「核对销号」回写；缺口没清掉时
        留在待处理处并说明。回传包整包写入失败可从检查点重试，重复导入不重复建档。
      </Alert>

      <Dialog open={dialog.open} onClose={() => setDialog({ open: false, order: null, form: completionForm({} as WorkOrder) })} fullWidth maxWidth="sm">
        <DialogTitle>
          登记完工与见证资料{dialog.order ? ` · ${dialog.order.code}` : ''}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <Alert severity="warning">
              完工登记先离线保存，不推进作业状态；封锁条件解除并核对关联病害后再销号。
            </Alert>
            <TextField
              fullWidth
              size="small"
              label="现场实际负责人"
              value={dialog.form.leader}
              onChange={(event) => setDialog((prev) => ({ ...prev, form: { ...prev.form, leader: event.target.value } }))}
            />
            <TextField
              fullWidth
              size="small"
              label="现场实际作业人员（顿号/逗号分隔）"
              value={dialog.form.membersText}
              onChange={(event) => setDialog((prev) => ({ ...prev, form: { ...prev.form, membersText: event.target.value } }))}
              helperText={`常用：${MEMBER_LIBRARY.join('、')}`}
            />
            <TextField
              fullWidth
              size="small"
              label="现场实际机具（顿号/逗号分隔）"
              value={dialog.form.machinesText}
              onChange={(event) => setDialog((prev) => ({ ...prev, form: { ...prev.form, machinesText: event.target.value } }))}
              helperText={`常用：${MACHINE_LIBRARY.join('、')}`}
            />
            <TextField
              fullWidth
              size="small"
              type="datetime-local"
              label="现场完工时间"
              InputLabelProps={{ shrink: true }}
              value={dialog.form.completedAt.replace(' ', 'T')}
              onChange={(event) =>
                setDialog((prev) => ({
                  ...prev,
                  form: { ...prev.form, completedAt: event.target.value.replace('T', ' ') },
                }))
              }
            />
            <Box>
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={0.5}>
                <Typography variant="subtitle2">见证资料（至少 1 份）</Typography>
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={() =>
                    setDialog((prev) => ({
                      ...prev,
                      form: { ...prev.form, witnesses: [...prev.form.witnesses, { kind: 'photo', ref: '', note: '' }] },
                    }))
                  }
                >
                  增加
                </Button>
              </Stack>
              <Stack spacing={1}>
                {dialog.form.witnesses.map((witness, index) => (
                  <Stack key={index} direction="row" spacing={1} alignItems="flex-start">
                    <TextField
                      select
                      size="small"
                      sx={{ width: 110 }}
                      label="类型"
                      value={witness.kind}
                      onChange={(event) =>
                        setDialog((prev) => {
                          const witnesses = [...prev.form.witnesses];
                          witnesses[index] = { ...witnesses[index], kind: event.target.value as WitnessMaterial['kind'] };
                          return { ...prev, form: { ...prev.form, witnesses } };
                        })
                      }
                    >
                      {(Object.keys(WITNESS_KIND_LABEL) as WitnessMaterial['kind'][]).map((kind) => (
                        <MenuItem key={kind} value={kind}>
                          {WITNESS_KIND_LABEL[kind]}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      fullWidth
                      size="small"
                      label="资料编号 / 文件名"
                      placeholder="如 IMG-20261003-01 或 签字单编号"
                      value={witness.ref}
                      onChange={(event) =>
                        setDialog((prev) => {
                          const witnesses = [...prev.form.witnesses];
                          witnesses[index] = { ...witnesses[index], ref: event.target.value };
                          return { ...prev, form: { ...prev.form, witnesses } };
                        })
                      }
                    />
                    <TextField
                      sx={{ width: 180 }}
                      size="small"
                      label="备注（部位 / 见证人）"
                      value={witness.note}
                      onChange={(event) =>
                        setDialog((prev) => {
                          const witnesses = [...prev.form.witnesses];
                          witnesses[index] = { ...witnesses[index], note: event.target.value };
                          return { ...prev, form: { ...prev.form, witnesses } };
                        })
                      }
                    />
                    <IconButton
                      size="small"
                      disabled={dialog.form.witnesses.length === 1}
                      onClick={() =>
                        setDialog((prev) => ({
                          ...prev,
                          form: { ...prev.form, witnesses: prev.form.witnesses.filter((_, itemIndex) => itemIndex !== index) },
                        }))
                      }
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ))}
              </Stack>
            </Box>
            <TextField
              fullWidth
              size="small"
              multiline
              minRows={2}
              label="完工说明"
              value={dialog.form.summary}
              onChange={(event) => setDialog((prev) => ({ ...prev, form: { ...prev.form, summary: event.target.value } }))}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog({ open: false, order: null, form: completionForm({} as WorkOrder) })}>取消</Button>
          <Button variant="contained" color="warning" onClick={() => void submitCompletion()}>
            保存完工登记（不推进状态）
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={2800}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
      <Typography variant="caption" color="text.secondary" display="block" mt={1}>
        当前时间基准 {nowDateTime()} · 销号率 {share(overview.solvedFaults, faults.length)}%
      </Typography>
    </Box>
  );
}
