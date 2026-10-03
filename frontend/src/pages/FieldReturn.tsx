/**
 * /field-return 现场回传与待处理缺口
 * - 导出回传包：带上作业单的派工基线、关联病害和登记中的封锁条件
 * - 导入回传包：按编号挂回本地记录；分歧两方来源都保留，落待处理；检查点失败可重试，重复导入不重复建档
 * - 先登记完工与见证；封锁解除并核对关联病害后再销号，缺口没清掉时留在待处理处并说明
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
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
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import { useAppDispatch, useAppSelector } from '../hooks/useAppStore';
import { selectWorkOrderViews } from '../stores/workOrderStore';
import {
  closeoutWorkOrder,
  discardImportBatch,
  importFieldPackage,
  liftRestriction,
  resolvePendingItem,
  retryFieldImport,
  selectFieldData,
} from '../stores/fieldStore';
import { IMPORT_STAGE_LABEL } from '../types/importBatch';
import {
  PENDING_GATE_LABEL,
  PENDING_KIND_LABEL,
  PENDING_STATUS_LABEL,
  type PendingItem,
  type PendingStatus,
} from '../types/pending';
import { isBlockRestriction, isRestrictionActive } from '../types/restriction';
import { WITNESS_KIND_LABEL } from '../types/fieldReturn';
import { listFaults, listInspections, listRestrictions, listSwitches } from '../utils/db';
import { buildFieldReturnPackage, fieldReturnFilename, restrictionsForOrder } from '../utils/export';
import { validateFieldReturnPackage } from '../utils/fieldImport';
import { downloadJson, readJsonFile } from '../utils/format';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { useIdbTable } from '../hooks/useIdbTable';
import { ROUTES } from '../router/routes';
import { useNavigate } from 'react-router-dom';

const STATUS_COLOR: Record<PendingStatus, 'warning' | 'success' | 'default'> = {
  open: 'warning',
  resolved: 'success',
  ignored: 'default',
};

const CREW_KINDS = new Set(['leaderMismatch', 'memberMismatch', 'machineMismatch']);

interface ResolveDialogState {
  open: boolean;
  item: PendingItem | null;
  status: PendingStatus;
  note: string;
  adoptField: boolean;
}

const initialResolveDialog: ResolveDialogState = {
  open: false,
  item: null,
  status: 'resolved',
  note: '',
  adoptField: false,
};

export default function FieldReturn() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const orders = useAppSelector(selectWorkOrderViews);
  const { pendingItems, completions, restrictions, batches } = useAppSelector(selectFieldData);
  const { data: faults } = useIdbTable(listFaults, []);
  const { data: inspections } = useIdbTable(listInspections, []);
  const { data: switches } = useIdbTable(listSwitches, []);
  const { reload: reloadRestrictions } = useIdbTable(listRestrictions, []);

  const [toast, setToast] = useState('');
  const [exportOrderId, setExportOrderId] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | PendingStatus>('open');
  const [resolveDialog, setResolveDialog] = useState<ResolveDialogState>(initialResolveDialog);

  const overview = useMemo(() => {
    const open = pendingItems.filter((item) => item.status === 'open');
    return {
      openCount: open.length,
      advanceCount: open.filter((item) => item.gate === 'advance').length,
      closeoutCount: open.filter((item) => item.gate === 'closeout').length,
      completionCount: completions.length,
      failedBatchCount: batches.filter((item) => item.status === 'failed').length,
    };
  }, [pendingItems, completions, batches]);

  const shownPending = useMemo(() => {
    const filtered = statusFilter === 'all' ? pendingItems : pendingItems.filter((item) => item.status === statusFilter);
    const rank: Record<PendingStatus, number> = { open: 0, ignored: 1, resolved: 2 };
    return [...filtered].sort((a, b) => {
      const byStatus = rank[a.status] - rank[b.status];
      if (byStatus !== 0) return byStatus;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [pendingItems, statusFilter]);

  const completionMap = useMemo(
    () => new Map(completions.map((item) => [item.workOrderId, item])),
    [completions],
  );

  /** 导出回传包：派工基线 + 关联病害 + 登记中的封锁条件（已解除的一并带上供核对） */
  const handleExport = async (): Promise<void> => {
    const orderId = exportOrderId || orders[0]?.id;
    const order = orders.find((item) => item.id === orderId);
    if (!order) {
      setToast('暂无可导出的作业单');
      return;
    }
    const allFaults = faults ?? [];
    const relatedFaults = allFaults.filter((item) => order.faultIds.includes(item.id));
    const relatedRestrictions = restrictionsForOrder(
      order,
      allFaults,
      inspections ?? [],
      switches ?? [],
      restrictions,
    );
    const pkg = buildFieldReturnPackage({
      order,
      faults: relatedFaults,
      restrictions: relatedRestrictions,
      completion: completionMap.get(order.id) ?? null,
    });
    downloadJson(fieldReturnFilename(order), pkg);
    setToast(`已导出 ${order.code} 回传包（派工基线冻结于 ${pkg.baseline.frozenAt}）`);
  };

  const handleImport = async (file: File): Promise<void> => {
    try {
      const raw = await readJsonFile<unknown>(file);
      const validation = validateFieldReturnPackage(raw);
      if (!validation.ok) {
        setToast(`回传包无法导入：${validation.message}`);
        return;
      }
      const result = await dispatch(importFieldPackage(validation.pkg)).unwrap();
      if (result.outcome === 'duplicate') {
        setToast(`${result.orderCode} 的回传包此前已导入完成，重复导入未重复建档`);
      } else if (result.gapCount > 0) {
        setToast(`${result.orderCode} 已挂回本地记录，登记 ${result.gapCount} 项待处理缺口`);
      } else {
        setToast(`${result.orderCode} 回传包导入完成，无对账缺口`);
      }
    } catch (error) {
      setToast(`导入失败（已保存检查点，可在下方重试）：${error instanceof Error ? error.message : '文件解析异常'}`);
    }
  };

  const submitResolve = async (): Promise<void> => {
    const item = resolveDialog.item;
    if (!item) return;
    if (!resolveDialog.note.trim()) {
      setToast('请填写处理说明');
      return;
    }
    try {
      await dispatch(
        resolvePendingItem({
          id: item.id,
          status: resolveDialog.status,
          note: resolveDialog.note,
          adoptField: resolveDialog.adoptField,
        }),
      ).unwrap();
      setToast(
        resolveDialog.status === 'ignored'
          ? '缺口已挂起并说明，仍留在待处理处'
          : resolveDialog.adoptField
            ? '已按现场登记更新本地安排并关闭缺口'
            : '缺口已处理关闭',
      );
      setResolveDialog(initialResolveDialog);
    } catch (error) {
      setToast(`处理失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const handleLift = async (restrictionId: string): Promise<void> => {
    try {
      await dispatch(liftRestriction(restrictionId)).unwrap();
      await reloadRestrictions();
      setToast('封锁 / 慢行条件已解除');
    } catch (error) {
      setToast(`解除失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const handleCloseout = async (workOrderId: string, code: string): Promise<void> => {
    try {
      const result = await dispatch(closeoutWorkOrder({ workOrderId })).unwrap();
      if (result.blockers.length > 0) {
        setToast(`${code} 暂不能销号：${result.blockers.join('；')}`);
      } else {
        setToast(
          `${code} 封锁条件已解除、关联病害核对完成，回写销号 ${result.solvedCount} 处${
            result.autoResolvedCount > 0 ? `，自动关闭过期缺口 ${result.autoResolvedCount} 项` : ''
          }`,
        );
      }
    } catch (error) {
      setToast(`核对销号失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const handleRetry = async (packageId: string): Promise<void> => {
    try {
      const result = await dispatch(retryFieldImport(packageId)).unwrap();
      setToast(
        result.outcome === 'duplicate'
          ? '该批次此前已完成，未重复写入'
          : `已从检查点重试完成，登记 ${result.gapCount} 项缺口`,
      );
    } catch (error) {
      setToast(`重试失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const restrictionOf = (id: string | null) => restrictions.find((item) => item.id === id);

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            现场回传与待处理缺口
          </Typography>
          <Typography variant="body2" color="text.secondary">
            区间断网作业离线记录，回站后按作业单导入合并：先按编号挂回本地记录，人员机具分歧两方保留；
            完工与见证先登记，封锁解除并核对病害后再销号。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <FormControl size="small" sx={{ minWidth: 260 }}>
            <InputLabel>导出回传包的作业单</InputLabel>
            <Select
              label="导出回传包的作业单"
              value={exportOrderId}
              onChange={(event) => setExportOrderId(event.target.value)}
            >
              {orders.map((order) => (
                <MenuItem key={order.id} value={order.id}>
                  {order.code}（{order.state === 'done' ? '已完成' : `待销号 ${order.pendingFaultCount}`}）
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button variant="outlined" startIcon={<CloudDownloadIcon />} onClick={() => void handleExport()}>
            导出回传包
          </Button>
          <Button variant="contained" component="label" startIcon={<CloudUploadIcon />}>
            导入回传包
            <input
              hidden
              type="file"
              accept="application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleImport(file);
                event.target.value = '';
              }}
            />
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={1.5} mb={1.75}>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="待处理缺口" value={overview.openCount} suffix="项" color="#ed6c02" hint="缺口未清前留在待处理处" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="阻断状态推进"
            value={overview.advanceCount}
            suffix="项"
            color="#d32f2f"
            hint="负责人 / 人员 / 机具分歧"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="阻断核对销号"
            value={overview.closeoutCount}
            suffix="项"
            color="#6a1b9a"
            hint="封锁未解除 / 病害未处治 / 见证缺失"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="完工登记 / 失败批次"
            value={`${overview.completionCount} / ${overview.failedBatchCount}`}
            color="#1565c0"
            hint="完工见证条数 / 待重试检查点"
          />
        </Grid>
      </Grid>

      <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5, mb: 1.75 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap mb={1}>
          <Typography variant="subtitle1" fontWeight={600}>
            待处理缺口
          </Typography>
          <Stack direction="row" spacing={0.5}>
            {(['all', 'open', 'ignored', 'resolved'] as const).map((value) => (
              <Button
                key={value}
                size="small"
                variant={statusFilter === value ? 'contained' : 'text'}
                onClick={() => setStatusFilter(value)}
              >
                {value === 'all' ? '全部' : PENDING_STATUS_LABEL[value]}
              </Button>
            ))}
          </Stack>
        </Stack>
        {shownPending.length === 0 ? (
          <EmptyPanel
            title="没有待处理缺口"
            description="导入现场回传包后，封锁条件、关联病害、人员机具对不上的记录会在此逐条登记并说明。"
          />
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>作业单</TableCell>
                  <TableCell>缺口类型</TableCell>
                  <TableCell>说明</TableCell>
                  <TableCell>现场 / 本地</TableCell>
                  <TableCell>闸门</TableCell>
                  <TableCell>状态</TableCell>
                  <TableCell align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {shownPending.map((item) => {
                  const restriction = restrictionOf(item.restrictionId);
                  return (
                    <TableRow key={item.id} hover selected={item.status === 'open'}>
                      <TableCell>{item.workOrderCode}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          color={item.gate === 'advance' ? 'error' : 'warning'}
                          variant={item.gate === 'advance' ? 'filled' : 'outlined'}
                          label={PENDING_KIND_LABEL[item.kind]}
                        />
                      </TableCell>
                      <TableCell sx={{ maxWidth: 320 }}>
                        <Typography variant="body2">{item.detail}</Typography>
                        {item.resolutionNote ? (
                          <Typography variant="caption" color="text.secondary">
                            处理说明：{item.resolutionNote}
                          </Typography>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" display="block">
                          现场：{item.fieldValue || '—'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" display="block">
                          本地：{item.localValue || '—'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Tooltip title={PENDING_GATE_LABEL[item.gate]}>
                          <Chip size="small" label={item.gate === 'advance' ? '卡推进' : '卡销号'} />
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <Chip size="small" color={STATUS_COLOR[item.status]} label={PENDING_STATUS_LABEL[item.status]} />
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
                          {item.kind === 'restrictionActive' && restriction && isRestrictionActive(restriction) ? (
                            <Button
                              size="small"
                              startIcon={<LockOpenIcon />}
                              onClick={() => void handleLift(restriction.id)}
                            >
                              解除封锁
                            </Button>
                          ) : null}
                          {item.status === 'open' ? (
                            <Button
                              size="small"
                              variant="outlined"
                              onClick={() =>
                                setResolveDialog({
                                  open: true,
                                  item,
                                  status: 'resolved',
                                  note: item.resolutionNote,
                                  adoptField: false,
                                })
                              }
                            >
                              {CREW_KINDS.has(item.kind) ? '对账处理' : '核对处理'}
                            </Button>
                          ) : (
                            <Button
                              size="small"
                              onClick={() =>
                                setResolveDialog({
                                  open: true,
                                  item,
                                  status: item.status,
                                  note: item.resolutionNote,
                                  adoptField: false,
                                })
                              }
                            >
                              查看
                            </Button>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      <Grid container spacing={1.75}>
        <Grid item xs={12} lg={7}>
          <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5, height: '100%' }}>
            <Typography variant="subtitle1" fontWeight={600} mb={1}>
              完工与见证登记（先登记、后销号）
            </Typography>
            {completions.length === 0 ? (
              <EmptyPanel
                title="暂无完工登记"
                description="现场完成后先在作业进度页登记完工与见证资料，作业状态不推进；待封锁解除、病害核对后再销号。"
                createLabel="去作业进度登记"
                onCreate={() => navigate(ROUTES.progress)}
              />
            ) : (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>作业单</TableCell>
                      <TableCell>完工时间</TableCell>
                      <TableCell>现场实际（负责人 / 人员 / 机具）</TableCell>
                      <TableCell>见证资料</TableCell>
                      <TableCell>未处治</TableCell>
                      <TableCell align="right">核对销号</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {completions.map((completion) => {
                      const order = orders.find((item) => item.id === completion.workOrderId);
                      const untreated = completion.faultResults.filter((item) => item.result === 'untreated').length;
                      return (
                        <TableRow key={completion.id} hover>
                          <TableCell>
                            <Stack spacing={0.5}>
                              <Typography variant="body2">{completion.workOrderCode}</Typography>
                              <Chip
                                size="small"
                                variant="outlined"
                                label={completion.source === 'fieldPackage' ? '回传包导入' : '本机离线登记'}
                              />
                            </Stack>
                          </TableCell>
                          <TableCell>{completion.completedAt}</TableCell>
                          <TableCell sx={{ maxWidth: 260 }}>
                            <Typography variant="caption" display="block">
                              {completion.leader}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" display="block">
                              {completion.members.join('、') || '—'}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" display="block">
                              {completion.machines.join('、') || '—'}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            {completion.witnesses.length === 0 ? (
                              <Chip size="small" color="warning" label="缺失" />
                            ) : (
                              <Stack spacing={0.25}>
                                {completion.witnesses.map((witness, index) => (
                                  <Typography key={`${witness.ref}-${index}`} variant="caption" display="block">
                                    {WITNESS_KIND_LABEL[witness.kind]} {witness.ref}
                                    {witness.note ? `（${witness.note}）` : ''}
                                  </Typography>
                                ))}
                              </Stack>
                            )}
                          </TableCell>
                          <TableCell>{untreated > 0 ? <Chip size="small" color="warning" label={`${untreated} 处`} /> : '—'}</TableCell>
                          <TableCell align="right">
                            {order?.state === 'done' ? (
                              <Chip icon={<CheckCircleIcon />} color="success" size="small" label="已销号" />
                            ) : order?.state === 'working' ? (
                              <Button
                                size="small"
                                variant="contained"
                                color="success"
                                startIcon={<FactCheckIcon />}
                                onClick={() => void handleCloseout(completion.workOrderId, completion.workOrderCode)}
                              >
                                核对销号
                              </Button>
                            ) : (
                              <Tooltip title="先在作业进度页把作业单推进为「作业中」，再核对销号">
                                <Button size="small" variant="outlined" disabled>
                                  待作业中
                                </Button>
                              </Tooltip>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </Grid>

        <Grid item xs={12} lg={5}>
          <Stack spacing={1.75}>
            <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
              <Typography variant="subtitle1" fontWeight={600} mb={1}>
                导入检查点
              </Typography>
              {batches.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  尚无导入批次。整包写入分阶段落检查点，失败后可从检查点重试；重复导入同一包不重复建档。
                </Typography>
              ) : (
                <Stack spacing={1}>
                  {batches.map((batch) => (
                    <Paper key={batch.id} variant="outlined" sx={{ p: 1, borderRadius: 1.5 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                        <Box>
                          <Typography variant="body2" fontWeight={600}>
                            {batch.workOrderCode}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            检查点：{IMPORT_STAGE_LABEL[batch.checkpoint]} · 尝试 {batch.attempts} 次
                          </Typography>
                          {batch.lastError ? (
                            <Typography variant="caption" color="error" display="block">
                              {batch.lastError}
                            </Typography>
                          ) : null}
                        </Box>
                        <Stack direction="row" spacing={0.5}>
                          {batch.status === 'failed' ? (
                            <>
                              <Button
                                size="small"
                                variant="contained"
                                startIcon={<RestartAltIcon />}
                                onClick={() => void handleRetry(batch.id)}
                              >
                                从检查点重试
                              </Button>
                              <Button
                                size="small"
                                color="inherit"
                                onClick={async () => {
                                  await dispatch(discardImportBatch(batch.id));
                                  setToast('失败批次检查点已删除');
                                }}
                              >
                                丢弃
                              </Button>
                            </>
                          ) : (
                            <Chip icon={<CheckCircleIcon />} color="success" size="small" label="已完成" />
                          )}
                        </Stack>
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
              )}
            </Paper>

            <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
              <Typography variant="subtitle1" fontWeight={600} mb={1}>
                登记中的封锁 / 慢行条件
              </Typography>
              {restrictions.filter((item) => isRestrictionActive(item)).length === 0 ? (
                <Chip icon={<PauseCircleIcon />} color="success" size="small" label="无生效中的封锁条件" />
              ) : (
                <Stack spacing={0.75}>
                  {restrictions
                    .filter((item) => isRestrictionActive(item))
                    .map((item) => (
                      <Stack key={item.id} direction="row" justifyContent="space-between" alignItems="center">
                        <Box>
                          <Typography variant="body2">
                            <Chip
                              size="small"
                              color={isBlockRestriction(item) ? 'error' : 'warning'}
                              label={isBlockRestriction(item) ? '封锁' : `${item.limitKmh}km/h`}
                              sx={{ mr: 0.5 }}
                            />
                            {item.switchCode || '站场级'} · {item.period}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {item.reason}
                          </Typography>
                        </Box>
                        <Button size="small" startIcon={<LockOpenIcon />} onClick={() => void handleLift(item.id)}>
                          解除
                        </Button>
                      </Stack>
                    ))}
                </Stack>
              )}
            </Paper>
          </Stack>
        </Grid>
      </Grid>

      <Alert severity="info" sx={{ mt: 2 }}>
        口径：导出回传包带派工基线、关联病害与登记中的封锁条件；导入先按编号挂回本地记录，负责人 / 人员 / 机具不同时
        两方来源都保留为待处理分歧，处理前不能推进作业状态。现场完成先登记完工和见证资料，等封锁条件解除并核对关联
        病害后再销号；缺口没清掉时留在待处理处并说明。整包写入失败后从检查点重试，重复导入不重复建档，旧数据缺少
        派工基线时按兼容方式回填。
      </Alert>

      <Dialog open={resolveDialog.open} onClose={() => setResolveDialog(initialResolveDialog)} fullWidth maxWidth="sm">
        <DialogTitle>处理待处理缺口</DialogTitle>
        <DialogContent dividers>
          {resolveDialog.item ? (
            <Stack spacing={2} mt={1}>
              <Alert severity={resolveDialog.item.gate === 'advance' ? 'error' : 'warning'}>
                <Typography variant="body2" fontWeight={600}>
                  {PENDING_KIND_LABEL[resolveDialog.item.kind]}（{resolveDialog.item.workOrderCode}）
                </Typography>
                {resolveDialog.item.detail}
                <Typography variant="caption" display="block">
                  {PENDING_GATE_LABEL[resolveDialog.item.gate]}
                </Typography>
              </Alert>
              <FormControl fullWidth size="small">
                <InputLabel>处理结果</InputLabel>
                <Select
                  label="处理结果"
                  value={resolveDialog.status}
                  onChange={(event) =>
                    setResolveDialog((prev) => ({ ...prev, status: event.target.value as PendingStatus }))
                  }
                >
                  <MenuItem value="resolved">已核对处理（关闭缺口）</MenuItem>
                  <MenuItem value="ignored">挂起并说明（留在待处理处，不计为已清）</MenuItem>
                </Select>
              </FormControl>
              {CREW_KINDS.has(resolveDialog.item.kind) ? (
                <Alert severity="info">
                  <Stack>
                    <Typography variant="body2">现场值：{resolveDialog.item.fieldValue || '—'}</Typography>
                    <Typography variant="body2">派工基线：{resolveDialog.item.localValue || '—'}</Typography>
                    <Button
                      size="small"
                      color={resolveDialog.adoptField ? 'success' : 'inherit'}
                      variant={resolveDialog.adoptField ? 'contained' : 'outlined'}
                      sx={{ mt: 1, alignSelf: 'flex-start' }}
                      onClick={() =>
                        setResolveDialog((prev) => ({ ...prev, adoptField: !prev.adoptField }))
                      }
                    >
                      {resolveDialog.adoptField ? '✓ 将按现场登记更新本地安排' : '以现场为准，更新本地安排'}
                    </Button>
                  </Stack>
                </Alert>
              ) : null}
              <TextField
                fullWidth
                size="small"
                multiline
                minRows={2}
                label="处理 / 挂起说明"
                value={resolveDialog.note}
                onChange={(event) => setResolveDialog((prev) => ({ ...prev, note: event.target.value }))}
              />
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResolveDialog(initialResolveDialog)}>取消</Button>
          <Button variant="contained" onClick={() => void submitResolve()}>
            保存处理结果
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={3200}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}
