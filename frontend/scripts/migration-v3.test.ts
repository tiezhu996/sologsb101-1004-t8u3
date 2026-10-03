/**
 * v2 旧库 → v3 升级迁移验证：
 * 旧作业单无派工基线 / completionId，旧封锁条件无 liftedAt；
 * 打开正式库后经 upgrade + ensureDispatchBaselines 完成兼容回填。
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import Dexie from 'dexie';

// 1) 用临时 Dexie 实例声明并填充 v2 结构
const oldDb = new Dexie('gbrailswitch');
oldDb.version(2).stores({
  yards: 'id, name, region, mileage',
  switches: 'id, yardId, code, frogNumber, railType, [yardId+code]',
  inspections: 'id, switchId, date, inspector, [switchId+date]',
  faults: 'id, inspectionId, part, severity, state, [inspectionId+part]',
  workOrders: 'id, code, state, windowStart, leader',
  restrictions: 'id, yardId, switchCode',
  settings: 'id',
});
await oldDb.open();
await oldDb.table('yards').put({ id: 'yard-1', name: '旧站', region: '车间', mileage: 'K1', trackCount: 1, createdAt: 't', revision: 2 });
await oldDb.table('workOrders').put({
  id: 'wo-old',
  code: 'TW-OLD-01',
  faultIds: ['f1'],
  windowStart: '2026-10-03 09:00',
  windowEnd: '2026-10-03 10:00',
  leader: '赵铁军',
  members: ['赵铁军'],
  machines: ['道尺'],
  state: 'issued',
  createdAt: 't',
  updatedAt: 't',
  revision: 2,
});
await oldDb.table('restrictions').put({
  id: 'r-old',
  yardId: 'yard-1',
  switchCode: '',
  limitKmh: 0,
  period: '2026-10-01 ~ 2026-10-05',
  reason: '旧封锁条件',
  createdAt: 't',
  revision: 2,
});
await oldDb.close();

// 2) 打开正式应用库（声明到 v3），应跑 v3 upgrade
const { db, initDatabase } = await import('../src/utils/db.ts');
await initDatabase();

const order = await db.workOrders.get('wo-old');
assert.ok(order, '旧作业单仍存在');
assert.equal(order.completionId, null, '迁移补 completionId=null');
assert.ok(order.dispatchBaseline, '兼容回填派工基线');
assert.equal(order.dispatchBaseline?.source, 'legacyBackfill', '回填基线标记 legacyBackfill');
assert.equal(order.dispatchBaseline?.leader, '赵铁军', '基线取本地安排');
assert.equal(order.revision, 3, '行修订号升到 3');

const restriction = await db.restrictions.get('r-old');
assert.equal(restriction.liftedAt, null, '旧封锁条件补 liftedAt=null（仍登记中）');

const tableNames = db.tables.map((t) => t.name);
for (const name of ['completions', 'pendingItems', 'importBatches']) {
  assert.ok(tableNames.includes(name), `新表 ${name} 已建立`);
}
console.log('✓ v2 → v3 迁移全部断言通过');
db.close();
process.exit(0);
