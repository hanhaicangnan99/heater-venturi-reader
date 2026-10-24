'use strict';
/* 模拟现场数据，供 demo 页、截图、示例文件共用 */
const C = require('../js/core.js');

function buildDemoBatch() {
  const b = C.createBatch({ date: '2026-10-24', time: '14:30', operator: '张三' });

  // 2号炉：8 组 × 2 块（整台）
  const p2 = [
    [0.183, 0.110], [0.120, 0.136], [0.148, 0.110], [0.130, 0.137],
    [0.125, 0.120], [0.110, 0.132], [0.126, 0.118], [0.120, 0.120]
  ];
  p2.forEach((vals, g) => vals.forEach((v, i) => C.setValue(b, '2', g, i, v)));
  C.setHeader(b, '2', 'A', 0.240);
  C.setHeader(b, '2', 'B', 0.230);

  // 3号炉：复刻“快捷导出方式2”示例
  const d3 = [
    [0.170, 3], [0.148, 3], [0.148, 3], [0.148, 3],
    [0.170, 4], [0.134, 3], [0.148, 3], [0.148, 3]
  ];
  d3.forEach(([max, idx], g) => {
    for (let i = 0; i < 12; i++) C.setValue(b, '3', g, i, 0.100);
    C.setValue(b, '3', g, idx - 1, max);
  });
  C.setHeader(b, '3', 'A', 0.230);
  C.setHeader(b, '3', 'B', 0.220);

  // 4号炉：只测 B 炉膛（第 5～8 组）
  C.setSide(b, '4', 'B');
  const d4 = [[0.111, 9], [0.115, 2], [0.121, 1], [0.110, 7]];
  d4.forEach(([max, idx], k) => {
    const g = 4 + k;
    for (let i = 0; i < 12; i++) C.setValue(b, '4', g, i, 0.100);
    C.setValue(b, '4', g, idx - 1, max);
  });
  C.setHeader(b, '4', 'A', 0.240);
  C.setHeader(b, '4', 'B', 0.230);

  // 5号炉：只录了前 3 组，展示“进行中”
  const d5 = [[0.118, 1], [0.122, 3], [0.115, 2]];
  d5.forEach(([max, idx], g) => {
    for (let i = 0; i < 12; i++) C.setValue(b, '5', g, i, 0.090);
    C.setValue(b, '5', g, idx - 1, max);
  });
  C.setHeader(b, '5', 'A', 0.230);
  C.setHeader(b, '5', 'B', 0.220);

  return b;
}

module.exports = { buildDemoBatch };
