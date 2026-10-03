/**
 * 待处理处：现场回传合并后的缺口核对面板
 * - 按作业单分组：现场完工与见证资料、待处理缺口（两方来源都保留）
 * - 负责人 / 人员 / 机具与本地安排不同：给出处理结论后才解除阻塞（两方来源并存留档，不覆盖作业单）
 * - 封锁条件未解除、关联病害缺口未清：留在待处理处并说明，作业状态不能推进
 * - 缺口清零且封锁解除、关联病害核对通过后，执行「核对销号」
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
  Divider,
  Paper,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import VerifiedIcon from '@mui/icons-material/Verified';
import { useAppDispatch, useAppSelector } from '../../hooks/useAppStore';
import { selectWorkOrderViews } from '../../stores/workOrderStore';
import {
  completionEvidences,
  completionFaultResults,
  completionRestrictionResults,
  resolveReconcile,
  selectCompletionByOrder,
  selectFieldReturnViews,
  selectPendingReconciles,
  verifyAndCloseOrder,
} from '../../stores/fieldReturnStore';
import { RECONCILE_KIND_LABEL, type ReconcileKind } from '../../types/reconcile';
import type { ReconcileItemRow } from '../../utils/db';
import {
  FIELD_EVIDENCE_KIND_LABEL,
  FIELD_FAULT_CHECK_LABEL,
  FIELD_RESTRICTION_STATE_LABEL,
} from '../../types/fieldReturn';
import { WORK_ORDER_STATE_LABEL } from '../../types/workOrder';
import EmptyPanel from '../common/EmptyPanel';

const KIND_COLOR: Record<ReconcileKind, 'error' | 'warning' | 'info' | 'secondary'> = {
  leader: 'info',
  members: 'info',
  machines: 'info',
  fault: 'warning',
  restriction: 'error',
  unmatched: 'secondary',
};

export default function PendingReturnPanel() {
  const dispatch = useAppDispatch();
  const orders = useAppSelector(selectWorkOrderViews);
  const pending = useAppSelector(selectPendingReconciles);
  const completionByOrder = useAppSelector(selectCompletionByOrder);
  const packages = useAppSelector(selectFieldReturnViews);

  const [toast, setToast] = useState('');
  const [resolveTarget, setResolveTarget] = useState<ReconcileItemRow | null>(null);
  const [resolution, setResolution] = useState('');

  const orderCodeById = useMemo(() => new Map(orders.map((item) => [item.id, item.code])), [orders]);

  /** 未挂回项单独成组（workOrderId 为空） */
  const unmatched = pending.filter((item) => !item.workOrderId);
  const linkedPending = pending.filter((item) => item.workOrderId);

  /** 按作业单聚合：有待处理缺口，或有现场完工登记的作业单都展示 */
  const groups = useMemo(() => {
    const map = new Map<string, ReconcileItemRow[]>();
    for (const item of linkedPending) {
      const list = map.get(item.workOrderId) ?? [];
      list.push(item);
      map.set(item.workOrderId, list);
    }
    const orderIds = [...new Set([...map.keys(), ...completionByOrder.keys()])];
    return orderIds
      .map((orderId) => ({
        orderId,
        order: orders.find((item) => item.id === orderId),
        items: map.get(orderId) ?? [],
        completion: completionByOrder.get(orderId),
      }))
      .sort((a, b) => {
        if (b.items.length !== a.items.length) return b.items.length - a.items.length;
        return (a.order?.windowStart ?? '').localeCompare(b.order?.windowStart ?? '');
      });
  }, [linkedPending, completionByOrder, orders]);

  const failedPackages = packages.filter((item) => item.failed);

  const submitResolve = async (): Promise<void> => {
    if (!resolveTarget) return;
    try {
      await dispatch(resolveReconcile({ id: resolveTarget.id, resolution })).unwrap();
      setToast(`已处理「${RECONCILE_KIND_LABEL[resolveTarget.kind]}」，两方来源并存留档`);
      setResolveTarget(null);
      setResolution('');
    } catch (error) {
      setToast(`处理失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const handleVerifyClose = async (orderId: string, code: string): Promise<void> => {
    try {
      const result = await dispatch(verifyAndCloseOrder(orderId)).unwrap();
      if (result.closed) {
        setToast(`${code} 封锁已解除、关联病害核对通过，销号 ${result.solvedFaultIds.length} 处并置为已完成`);
      } else {
        setToast(`${code} 仍有缺口未清，留在待处理处：${result.blocked[0] ?? ''}`);
      }
    } catch (error) {
      setToast(`核对销号失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  if (pending.length === 0 && completionByOrder.size === 0) {
    return (
      <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
        <Typography variant="subtitle1" fontWeight={600} mb={1}>
          待处理处
        </Typography>
        <EmptyPanel
          title="没有待处理的现场回传"
          description="导入现场回传包后，现场与本地不一致的负责人 / 人员 / 机具、关联病害缺口与未解除的封锁条件会在这里列出，处理前不能推进作业状态。"
        />
      </Paper>
    );
  }

  return (
    <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
        <Typography variant="subtitle1" fontWeight={600}>
          待处理处
        </Typography>
        <Stack direction="row" spacing={1}>
          <Chip size="small" color="warning" label={`待处理缺口 ${pending.length} 项`} />
          <Chip size="small" variant="outlined" label={`已登记完工 ${completionByOrder.size} 张`} />
        </Stack>
      </Stack>

      {failedPackages.length > 0 ? (
        <Alert severity="error" sx={{ mb: 1.25 }}>
          有 {failedPackages.length} 个回传包写入中断，请到上方「现场回传」区从检查点重试后再核对缺口。
        </Alert>
      ) : null}

      <Stack spacing={1.5}>
        {groups.map((group) => {
          const code = group.order?.code ?? orderCodeById.get(group.orderId) ?? '本地作业单已缺失';
          const completion = group.completion;
          const evidences = completionEvidences(completion);
          const faultResults = completionFaultResults(completion);
          const restrictionResults = completionRestrictionResults(completion);
          const blocking = group.items.length > 0;
          return (
            <Box key={group.orderId} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.25 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap>
                <Box>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="subtitle2" fontWeight={600}>
                      {code}
                    </Typography>
                    {group.order ? (
                      <Chip size="small" label={WORK_ORDER_STATE_LABEL[group.order.state]} />
                    ) : (
                      <Chip size="small" color="error" label="本地未挂回" />
                    )}
                    {completion ? (
                      <Chip
                        size="small"
                        icon={<CheckCircleIcon />}
                        color="success"
                        variant="outlined"
                        label={`现场完工 ${completion.registeredAt} · ${completion.registrar} 登记`}
                      />
                    ) : null}
                    {blocking ? (
                      <Chip size="small" color="error" label={`待处理 ${group.items.length} 项，作业状态暂停推进`} />
                    ) : (
                      <Chip size="small" color="success" variant="outlined" label="缺口已清零，可核对销号" />
                    )}
                  </Stack>
                </Box>
                {completion ? (
                  <Tooltip
                    title={
                      blocking
                        ? '待处理缺口清零后，且封锁条件解除、关联病害核对通过，才能核对销号'
                        : '复核封锁已解除并把现场确认修复的病害销号，作业单置为已完成'
                    }
                  >
                    <span>
                      <Button
                        size="small"
                        variant="contained"
                        color="success"
                        startIcon={<VerifiedIcon />}
                        disabled={blocking || !group.order}
                        onClick={() => void handleVerifyClose(group.orderId, code)}
                      >
                        核对销号
                      </Button>
                    </span>
                  </Tooltip>
                ) : null}
              </Stack>

              {completion ? (
                <Box mt={1}>
                  <Typography variant="caption" color="text.secondary" component="div">
                    现场安排：负责人 {completion.leaderActual} · 作业人员 {completion.membersActual.join('、') || '—'} ·
                    机具 {completion.machinesActual.join('、') || '—'}
                  </Typography>
                  {completion.finishNote ? (
                    <Typography variant="caption" color="text.secondary" component="div">
                      完工说明：{completion.finishNote}
                    </Typography>
                  ) : null}
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap mt={0.5}>
                    {evidences.map((evidence, index) => (
                      <Tooltip key={`${evidence.ref}-${index}`} title={evidence.note || evidence.ref}>
                        <Chip
                          size="small"
                          variant="outlined"
                          label={`${FIELD_EVIDENCE_KIND_LABEL[evidence.kind]} · ${evidence.ref}`}
                        />
                      </Tooltip>
                    ))}
                    {evidences.length === 0 ? (
                      <Typography variant="caption" color="text.secondary">
                        无见证资料
                      </Typography>
                    ) : null}
                  </Stack>

                  {(faultResults.length > 0 || restrictionResults.length > 0) ? (
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap mt={0.5}>
                      {faultResults.map((result) => (
                        <Chip
                          key={result.faultId}
                          size="small"
                          color={result.check === 'repaired' ? 'success' : result.check === 'confirmed' ? 'warning' : 'default'}
                          label={`病害 ${result.switchCode || result.faultId}：${FIELD_FAULT_CHECK_LABEL[result.check]}`}
                        />
                      ))}
                      {restrictionResults.map((result) => (
                        <Chip
                          key={result.restrictionId}
                          size="small"
                          color={result.state === 'lifted' ? 'success' : result.state === 'active' ? 'error' : 'warning'}
                          label={`封锁 ${result.switchCode || '站场级'}：${FIELD_RESTRICTION_STATE_LABEL[result.state]}`}
                        />
                      ))}
                    </Stack>
                  ) : null}
                </Box>
              ) : null}

              {group.items.length > 0 ? (
                <Box mt={1}>
                  <Divider sx={{ mb: 0.75 }} />
                  <Stack spacing={0.75}>
                    {group.items.map((item) => (
                      <ReconcileRow key={item.id} item={item} onResolve={() => { setResolveTarget(item); setResolution(''); }} />
                    ))}
                  </Stack>
                </Box>
              ) : null}
            </Box>
          );
        })}

        {unmatched.length > 0 ? (
          <Box sx={{ border: '1px dashed', borderColor: 'warning.main', borderRadius: 2, p: 1.25 }}>
            <Typography variant="subtitle2" fontWeight={600} gutterBottom>
              未挂回本地的作业单
            </Typography>
            <Stack spacing={0.75}>
              {unmatched.map((item) => (
                <ReconcileRow key={item.id} item={item} onResolve={() => { setResolveTarget(item); setResolution(''); }} />
              ))}
            </Stack>
            <Typography variant="caption" color="text.secondary" display="block" mt={0.75}>
              派工基线编号与作业单号都未命中本地记录，完工内容暂存；确认对应本地作业单后可人工挂接并处理。
            </Typography>
          </Box>
        ) : null}
      </Stack>

      <Dialog open={Boolean(resolveTarget)} onClose={() => setResolveTarget(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          处理缺口：{resolveTarget ? RECONCILE_KIND_LABEL[resolveTarget.kind] : ''}
        </DialogTitle>
        <DialogContent dividers>
          {resolveTarget ? (
            <Stack spacing={1.5} mt={0.5}>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  本地来源
                </Typography>
                <Typography variant="body2">{resolveTarget.localValue}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  现场来源
                </Typography>
                <Typography variant="body2">{resolveTarget.fieldValue}</Typography>
              </Box>
              <Alert severity="info" icon={false}>
                {resolveTarget.detail}
              </Alert>
              <TextField
                fullWidth
                size="small"
                multiline
                minRows={2}
                label="处理结论（两方来源都保留，不覆盖作业单安排）"
                placeholder="如：经核实采用现场人员安排，本地计划单已另行修订；或两方并存留档"
                value={resolution}
                onChange={(event) => setResolution(event.target.value)}
              />
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResolveTarget(null)}>取消</Button>
          <Button variant="contained" onClick={() => void submitResolve()}>
            确认处理
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={3600}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Paper>
  );
}

function ReconcileRow({ item, onResolve }: { item: ReconcileItemRow; onResolve: () => void }) {
  return (
    <Stack
      direction="row"
      justifyContent="space-between"
      alignItems="center"
      spacing={1}
      sx={{ bgcolor: 'action.hover', borderRadius: 1.5, px: 1, py: 0.5 }}
    >
      <Box>
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip size="small" color={KIND_COLOR[item.kind]} label={RECONCILE_KIND_LABEL[item.kind]} />
          <Typography variant="caption" color="text.secondary">
            {item.detail}
          </Typography>
        </Stack>
        <Typography variant="caption" component="div" color="text.secondary">
          {item.localValue} ｜ {item.fieldValue}
        </Typography>
      </Box>
      <Button size="small" variant="outlined" onClick={onResolve} sx={{ flexShrink: 0 }}>
        处理
      </Button>
    </Stack>
  );
}
