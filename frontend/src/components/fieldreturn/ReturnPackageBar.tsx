/**
 * 现场回传包导出 / 导入工具条
 * - 导出：勾选作业单，按作业单带上派工基线、关联病害与登记中的封锁条件，生成离线回传包
 * - 导入：回站合并回传包（分阶段检查点），重复导入不重复建档，整包失败可从检查点重试
 * 数据来自 workOrderStore（作业单）与 fieldReturnStore（回传包记录）。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
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
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import ReplayIcon from '@mui/icons-material/Replay';
import { useAppDispatch, useAppSelector } from '../../hooks/useAppStore';
import { selectWorkOrderViews } from '../../stores/workOrderStore';
import {
  exportFieldReturn,
  importFieldReturnFile,
  retryFieldReturnPackage,
  selectFieldReturnViews,
} from '../../stores/fieldReturnStore';
import { WORK_ORDER_STATE_LABEL } from '../../types/workOrder';
import { FIELD_IMPORT_STAGE_LABEL } from '../../types/reconcile';
import { downloadJson, readJsonFile, backupFilename } from '../../utils/format';
import type { FieldReturnPackage } from '../../types/fieldReturn';

export default function ReturnPackageBar() {
  const dispatch = useAppDispatch();
  const orders = useAppSelector(selectWorkOrderViews);
  const packages = useAppSelector(selectFieldReturnViews);

  const [toast, setToast] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [station, setStation] = useState('');
  const [checked, setChecked] = useState<string[]>([]);

  const exportable = useMemo(() => orders.filter((item) => item.state !== 'done'), [orders]);

  const openExport = (): void => {
    setChecked(exportable.map((item) => item.id));
    setStation('');
    setExportOpen(true);
  };

  const toggle = (id: string): void => {
    setChecked((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const handleExport = async (): Promise<void> => {
    if (checked.length === 0) {
      setToast('请至少勾选一张作业单');
      return;
    }
    try {
      const result = await dispatch(exportFieldReturn({ workOrderIds: checked, station })).unwrap();
      downloadJson(
        backupFilename(`gbrailswitch-field-return-${result.pkg.packageId.slice(4, 12)}`),
        result.pkg as FieldReturnPackage,
      );
      const backfill = result.backfilledCount > 0 ? `，${result.backfilledCount} 张旧作业单已兼容回填派工基线` : '';
      setToast(`已导出含 ${result.entries.length} 张作业单的现场回传包（派工基线 / 关联病害 / 封锁条件）${backfill}`);
      setExportOpen(false);
    } catch (error) {
      setToast(`导出失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const handleImport = async (file: File): Promise<void> => {
    try {
      const parsed = await readJsonFile<unknown>(file);
      const result = await dispatch(importFieldReturnFile(parsed)).unwrap();
      if (result.unmatchedCodes.length > 0) {
        setToast(
          `导入完成：挂回 ${result.linked} 张，${result.unmatchedCodes.length} 张未挂回（${result.unmatchedCodes.join(
            '、',
          )}），缺口已留在待处理处`,
        );
      } else {
        setToast(`回传包已导入：挂回 ${result.linked} 张作业单，缺口进入待处理处核对`);
      }
    } catch (error) {
      setToast(`导入失败（已保留检查点，可重试）：${error instanceof Error ? error.message : '文件解析异常'}`);
    }
  };

  const handleRetry = async (packageId: string): Promise<void> => {
    try {
      const result = await dispatch(retryFieldReturnPackage(packageId)).unwrap();
      setToast(`已从检查点重试完成：挂回 ${result.linked} 张作业单`);
    } catch (error) {
      setToast(`重试失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  return (
    <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap>
        <Box>
          <Typography variant="subtitle1" fontWeight={600}>
            现场回传（断网作业 → 回站合并）
          </Typography>
          <Typography variant="body2" color="text.secondary">
            导出携带派工基线、关联病害与登记中的封锁条件；现场完工先登记见证资料，回站按编号挂回，缺口处理后再销号。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button variant="contained" startIcon={<CloudDownloadIcon />} onClick={openExport}>
            导出现场回传包
          </Button>
          <Button
            variant="outlined"
            component="label"
            startIcon={<CloudUploadIcon />}
          >
            导入合并回传包
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

      {packages.length > 0 ? (
        <TableContainer sx={{ mt: 1.25 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>回传包</TableCell>
                <TableCell>班组 / 站</TableCell>
                <TableCell>导出于</TableCell>
                <TableCell>检查点</TableCell>
                <TableCell>待处理</TableCell>
                <TableCell>未挂回</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {packages.map((pkg) => (
                <TableRow key={pkg.id} hover selected={pkg.failed}>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {pkg.id}
                    </Typography>
                  </TableCell>
                  <TableCell>{pkg.station}</TableCell>
                  <TableCell>{pkg.exportedAt}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      color={pkg.stage === 'done' ? 'success' : 'error'}
                      label={pkg.failed ? `中断于「${FIELD_IMPORT_STAGE_LABEL[pkg.stage]}」` : FIELD_IMPORT_STAGE_LABEL[pkg.stage]}
                    />
                    {pkg.error ? (
                      <Typography variant="caption" color="error" display="block" title={pkg.error}>
                        {pkg.error}
                      </Typography>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Chip size="small" color={pkg.pendingCount > 0 ? 'warning' : 'default'} label={`${pkg.pendingCount} 项`} />
                  </TableCell>
                  <TableCell>{pkg.unmatchedCodes.length > 0 ? pkg.unmatchedCodes.join('、') : '—'}</TableCell>
                  <TableCell align="right">
                    {pkg.failed ? (
                      <Tooltip title="整包写入失败后从检查点重试（已写入部分不重复建档）">
                        <Button size="small" variant="contained" color="warning" startIcon={<ReplayIcon />} onClick={() => void handleRetry(pkg.id)}>
                          从检查点重试
                        </Button>
                      </Tooltip>
                    ) : (
                      <Chip size="small" variant="outlined" color="success" label="已导入" />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Alert severity="info" sx={{ mt: 1.25 }}>
          尚未导入过现场回传包。区间断网施工前先导出回传包，现场离线登记完工与见证资料，回站后在此导入合并。
        </Alert>
      )}

      <Dialog open={exportOpen} onClose={() => setExportOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>导出现场回传包</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} mt={0.5}>
            <Alert severity="info">
              每张作业单会携带派工基线（冻结的负责人 / 人员 / 机具 / 时间窗 / 关联病害编号）、关联病害摘要与登记中、
              时间窗重叠的封锁条件。现场按这些编号记录，回站导入据此挂回。
            </Alert>
            <TextField
              fullWidth
              size="small"
              label="作业队 / 回站站名（写入包内标识）"
              value={station}
              onChange={(event) => setStation(event.target.value)}
              InputProps={{ startAdornment: <InputAdornment position="start">班组</InputAdornment> }}
            />
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="subtitle2">勾选作业单（已完成的不导出）</Typography>
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={() => setChecked(exportable.map((item) => item.id))}>
                  全选
                </Button>
                <Button size="small" onClick={() => setChecked([])}>
                  清空
                </Button>
              </Stack>
            </Stack>
            <TableContainer sx={{ maxHeight: 360 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell>作业单号</TableCell>
                    <TableCell>状态</TableCell>
                    <TableCell>天窗</TableCell>
                    <TableCell>关联病害</TableCell>
                    <TableCell>派工基线</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {exportable.map((order) => (
                    <TableRow key={order.id} hover onClick={() => toggle(order.id)} selected={checked.includes(order.id)}>
                      <TableCell padding="checkbox">
                        <Checkbox checked={checked.includes(order.id)} size="small" />
                      </TableCell>
                      <TableCell>{order.code}</TableCell>
                      <TableCell>{WORK_ORDER_STATE_LABEL[order.state]}</TableCell>
                      <TableCell>
                        {order.windowStart} ~ {order.windowEnd.slice(-5)}
                      </TableCell>
                      <TableCell>{order.faultIds.length} 处</TableCell>
                      <TableCell>
                        {order.dispatchBaseline ? (
                          order.dispatchBaseline.backfilled ? (
                            <Tooltip title="旧数据原无派工基线，导出时按当前作业单内容兼容回填（已标记）">
                              <Chip size="small" color="warning" label="兼容回填基线" />
                            </Tooltip>
                          ) : (
                            <Chip size="small" variant="outlined" label="已冻结" />
                          )
                        ) : (
                          <Tooltip title="旧数据缺少派工基线，导出时按当前作业单内容兼容回填">
                            <Chip size="small" color="warning" label="导出时回填" />
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExportOpen(false)}>取消</Button>
          <Button variant="contained" startIcon={<CloudDownloadIcon />} onClick={() => void handleExport()}>
            导出 {checked.length} 张
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
