# 铁路道岔巡检与天窗修编排台（sologsb101-1004 / gbrailswitch）

## 一、Docker 一键启动（推荐）

```bash
cd sologsb101-1004
cp .env.example .env
docker compose up -d --build
```

启动后访问：**http://localhost:22804**

停止与清理：

```bash
docker compose down          # 停止并删除容器
docker compose up -d --build # 代码改动后重建
```

## 二、项目简介

面向工务段线路巡检与天窗修作业人员，把管内道岔的巡检病害按部件汇总，并在天窗点内编排检修顺序、人员与机具。

核心动作：

- 建立站场与道岔台账（辙叉号 9/12/18、轨型 60kg/m 与 50kg/m），按辙叉号与轨型筛选
- 按巡检批次录入病害并定位到部件（尖轨 / 基本轨 / 辙叉 / 转辙机）
- 评定病害等级（轻 / 中 / 重）、批量调整、批量升级、手工销号与撤销
- 勾选待修病害编排天窗作业单，分配时间窗 / 负责人 / 作业人员 / 机具，并做**时间窗 + 人员 + 机具三重冲突校验**
- 按天窗批次推进状态（待编排 → 已下达 → 作业中 → 已完成），推进到已完成时**自动回写病害销号**
- **现场回传**：导出时携带作业单派工基线（冻结快照）、关联病害与登记中的封锁条件；区间断网离线登记完工与见证资料，回站按编号挂回；负责人 / 人员 / 机具差异两方来源都保留并先入待处理处，处理前状态冻结；封锁解除且核对病害后再核对销号，整包失败按检查点重试、重复导入不重复建档、旧数据兼容回填派工基线
- 登记慢行 / 封锁条件，查看结构版本并导出 / 导入整库 JSON

本项目为**纯前端单页应用**：无后端、无数据库服务、无外部接口，全部数据保存在浏览器 IndexedDB。

## 三、技术栈

| 分类 | 选型 | 版本 |
| --- | --- | --- |
| 框架 | React | 18.3 |
| 语言 | TypeScript | 5.7 |
| UI 组件库 | MUI（@mui/material + icons） | 5.16 |
| 构建工具 | Vite | 5.4 |
| 状态管理 | Redux Toolkit + React Redux | 2.5 / 9.2 |
| 路由 | React Router（History 路由，`createBrowserRouter`） | 6.28 |
| 本地持久化 | Dexie（IndexedDB） | 4.0 |
| 容器 | 多阶段构建 node:20-alpine → nginx:alpine | — |

## 四、路由一览

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/yards` | 站场与道岔台账 | 建立站场与道岔，按辙叉号与轨型筛选 |
| `/inspections` | 巡检与病害录入 | 按巡检批次录入病害并定位到部件 |
| `/faults` | 病害评定与销号 | 评定等级、批量调整、手工销号与撤销 |
| `/workorders` | 天窗作业单编排 | 勾选病害成单、分配时间窗与人员机具并校验冲突 |
| `/progress` | 作业进度与销号回写 | 更新状态，完成项自动回写病害销号 |
| `/backup` | 封锁条件与版本 | 登记慢行 / 封锁条件，结构版本与 JSON 管理 |

> 路由使用 `createBrowserRouter`（History 模式），真实路径 `/yards`、`/workorders` 等可直接访问，
> 刷新任意深链接由 `nginx.conf` 的 `try_files $uri $uri/ /index.html;` 回落到 `index.html` 后交给前端路由。
> 路径常量与导航配置抽到叶子模块 `src/router/routes.ts`，切断 `App.tsx ⇄ router/index.tsx` 的循环依赖
> （该环会在模块顶层读取尚未初始化的 `ROUTES`，触发 TDZ 报错导致整站白屏）。

## 五、目录结构

```
sologsb101-1004/
├── README.md
├── docker-compose.yml           # 顶层 name: gbrailswitch，无 version 字段
├── .env / .env.example          # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile               # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf               # try_files 前端路由回退 + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / tsconfig.node.json
    ├── vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx             # 入口：Redux Provider + ThemeProvider + RouterProvider
        ├── App.tsx              # 应用外壳（侧边导航 + 站场上下文 + 统计）
        ├── styles/main.css
        ├── types/               # yard.ts switch.ts inspection.ts fault.ts workOrder.ts fieldReturn.ts reconcile.ts persistence.ts
        ├── stores/              # index.ts yardStore.ts switchStore.ts faultStore.ts workOrderStore.ts fieldReturnStore.ts
        ├── components/common/   # SeverityTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── components/fieldreturn/ # ReturnPackageBar.tsx（回传包导出/导入/检查点）PendingReturnPanel.tsx（待处理处与核对销号）
        ├── hooks/               # useFaultFilter.ts useIdbTable.ts useAppStore.ts
        ├── pages/               # YardList.tsx InspectionEntry.tsx FaultBoard.tsx WorkOrderPlan.tsx ProgressView.tsx BackupView.tsx
        ├── router/index.tsx     # 路由表（懒加载页面 + App 布局）
        ├── router/routes.ts     # 叶子模块：仅路径常量，切断 App ⇄ router 循环依赖
        └── utils/               # severity.ts window.ts db.ts fieldReturn.ts fieldImport.ts events.ts format.ts
```

## 六、数据存储说明

- **存储介质**：浏览器 IndexedDB，库名 **`gbrailswitch`**，通过 Dexie 4.x 封装。
- **数据结构版本**：`utils/db.ts` 中 `DB_SCHEMA_VERSION = 3`，登记了 v1 → v2（行修订号、`faultType → type` / `faultPart → part`、`faultIds` 字符串拆数组、新增 `restrictions` / `settings` 表）与 v2 → v3（新增现场回传三表、旧作业单缺少派工基线时兼容回填并冻结、行修订号升至 3）的 `upgrade` 迁移。
- **数据表**：

  | 表名 | 实体 | 主要索引 |
  | --- | --- | --- |
  | `yards` | 站场 | id / name / region / mileage |
  | `switches` | 道岔 | id / yardId / code / frogNumber / railType / [yardId+code] |
  | `inspections` | 巡检 | id / switchId / date / inspector / [switchId+date] |
  | `faults` | 病害 | id / inspectionId / part / severity / state / [inspectionId+part] |
  | `workOrders` | 天窗作业单（含派工基线快照 `dispatchBaseline`） | id / code / state / windowStart / leader |
  | `restrictions` | 封锁 / 慢行条件 | id / yardId / switchCode |
  | `fieldReturns` | 现场回传包导入记录（含原始 JSON 与检查点 stage） | id / importedAt / stage |
  | `reconciles` | 待处理缺口（人员机具差异 / 病害 / 封锁 / 未挂回，两方来源并存） | id / packageId / workOrderId / kind / status |
  | `fieldCompletions` | 现场完工与见证资料登记（按作业单一对一） | workOrderId / packageId |
  | `settings` | 自定义字典 | id |

- **现场回传流程**（入口在「作业进度与销号回写」页）：
  1. **导出**：勾选作业单 → 生成离线回传包，内含派工基线（冻结的负责人 / 人员 / 机具 / 时间窗 / 关联病害编号）、关联病害摘要与登记中、时间窗重叠的封锁条件；旧作业单缺基线时按当前内容兼容回填（`backfilled=true`）。
  2. **现场离线登记**：完工时间 / 登记人、实际负责人 / 人员 / 机具、见证资料（照片 / 视频 / 测量记录 / 签认单）、逐条病害核对结论与封锁状态，写回包内 JSON。
  3. **回站导入合并**：按基线编号（id 优先、单号兜底）挂回本地；分 `register → link → reconcile → done` 四个检查点、每阶段独立事务，整包失败可从检查点重试；回传包按 `packageId`、缺口按确定性主键去重，重复导入不重复建档；挂不回的作业单进待处理处。
  4. **待处理处核对**：负责人 / 人员 / 机具与本地不一致时两方来源都保留，处理仅记录结论、不覆盖作业单；缺口未清时作业单任何状态推进都被冻结。
  5. **核对销号**：封锁条件全部解除（导入后实时复核本地登记）、关联病害现场确认已修复并核对通过后才销号并置作业单为已完成；缺口没清掉时留在待处理处并说明。

- **首屏自动播种**：`initDatabase()` 在 `yards` 表为空时写入演示数据（幂等）——2 个站场 × 各 4 组道岔 × 1~2 次巡检 × 每次 0~3 条病害 + 3 张天窗作业单（含 1 张刻意与人员时间窗冲突）+ 2 条封锁条件，父子记录通过 `yardId / switchId / inspectionId / faultIds` 互相引用。
- **跨页状态**：全部放在 Redux Toolkit store（`yardStore / switchStore / faultStore / workOrderStore`），页面只读 store；Dexie 写入后由 `utils/events.ts` 广播，store 自动重新拉取。
- **数据不出浏览器**：容器无状态，不挂载卷、不使用数据库服务。

## 七、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22804
npm run typecheck  # tsc --noEmit
npm run build      # tsc --noEmit && vite build
npm run preview    # 预览构建产物
```

## 八、容器化细节

- `Dockerfile` 两阶段构建：`node:20-alpine` 安装依赖并执行 `npm run build`（内含 TypeScript 类型检查），随后拷贝 `dist` 到 `nginx:alpine`。
- 运行阶段在 `COPY --from=builder /app/dist /usr/share/nginx/html` 之后执行 `RUN chmod -R a+rX /usr/share/nginx/html`，规避历史遗留的 favicon 权限 0600 导致 nginx 403 的问题。
- `nginx.conf` 使用 `try_files $uri $uri/ /index.html;` 支持前端路由直接刷新，并开启 gzip。
- `docker-compose.yml` 不写 `version:`，顶层 `name: gbrailswitch` 兜底（避免中文目录名导致项目名为空），服务名 `frontend`，容器名 `${COMPOSE_PROJECT_NAME:-gbrailswitch}-frontend`，端口 `${FRONTEND_PORT:-22804}:80`，`restart: unless-stopped`。
