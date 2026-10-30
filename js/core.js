/*!
 * core.js — 加热炉文丘里压力 · 数据与导出核心
 * 版本 2.0.0
 *
 * 业务模型
 *   - 4 台加热炉：2号、3号、4号、5号；每台 8 组。
 *   - 2号炉每组 2 块表；3/4/5号炉每组 12 块表。
 *   - 第 1～4 组属于 A 炉膛，第 5～8 组属于 B 炉膛。
 *   - 每台炉可选择测整台 / 只测 A 炉膛 / 只测 B 炉膛。
 *   - 每台炉、每个炉膛各有一个集合管压力；绝压比 =
 *       (单炉膛最高读数 + 大气压) / (该炉膛集合管压力 + 大气压)，大气压 0.1 MPa。
 *     两个炉膛取较大者作为“最大绝压比”。
 *
 * 不依赖任何第三方库，浏览器与 Node 通用（UMD），便于单测和后续识别模块复用。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GaugeCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '2.0.0';

  var ATM = 0.1; // 大气压，MPa

  var CONFIG = {
    min: 0,
    max: 0.4,
    unit: 'MPa',
    decimals: 3,
    atmosphere: ATM
  };

  /** 炉子定义：2号炉每组只有 2 块表 */
  var FURNACE_DEFS = [
    { id: '2', label: '2号炉', groups: 8, perGroup: 2 },
    { id: '3', label: '3号炉', groups: 8, perGroup: 12 },
    { id: '4', label: '4号炉', groups: 8, perGroup: 12 },
    { id: '5', label: '5号炉', groups: 8, perGroup: 12 }
  ];

  var CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

  var SIDES = ['full', 'A', 'B'];

  /* ------------------------------------------------------------------ *
   * 一、基础工具
   * ------------------------------------------------------------------ */

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clampInt(n, lo, hi) {
    n = Math.round(Number(n));
    if (!isFinite(n)) return lo;
    return n < lo ? lo : n > hi ? hi : n;
  }

  function roundTo(v, decimals) {
    var f = Math.pow(10, clampInt(decimals, 0, 6));
    var r = Math.round((Number(v) + Number.EPSILON) * f) / f;
    return r === 0 ? 0 : r;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function nowStr(d) {
    d = d || new Date();
    return todayStr(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function nowTimeStr(d) {
    d = d || new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 第 g 组属于哪个炉膛（g 从 0 开始）：0～3 → A，4～7 → B */
  function chamberOf(g) {
    return g < 4 ? 'A' : 'B';
  }

  function sideLabel(side) {
    return side === 'full' ? '整台' : side + '炉膛';
  }

  /* ------------------------------------------------------------------ *
   * 二、结构
   * ------------------------------------------------------------------ */

  function emptyCell() {
    return { v: null, ex: false, skip: false };
  }

  function createBatch(meta) {
    var m = meta || {};
    var furnaces = FURNACE_DEFS.map(function (def) {
      var cells = [];
      for (var g = 0; g < def.groups; g++) {
        var row = [];
        for (var i = 0; i < def.perGroup; i++) row.push(emptyCell());
        cells.push(row);
      }
      return {
        id: def.id,
        label: def.label,
        groups: def.groups,
        perGroup: def.perGroup,
        side: 'full',
        headerA: null,
        headerB: null,
        cells: cells
      };
    });
    return {
      version: VERSION,
      meta: {
        date: /^\d{4}-\d{2}-\d{2}$/.test(m.date || '') ? m.date : todayStr(),
        time: /^\d{1,2}:\d{2}/.test(m.time || '') ? String(m.time).slice(0, 5) : nowTimeStr(),
        operator: String(m.operator || '').slice(0, 40),
        note: String(m.note || '').slice(0, 200)
      },
      config: {
        min: CONFIG.min,
        max: CONFIG.max,
        unit: CONFIG.unit,
        decimals: CONFIG.decimals,
        atmosphere: CONFIG.atmosphere
      },
      furnaces: furnaces
    };
  }

  function furnaceById(batch, id) {
    if (!batch || !Array.isArray(batch.furnaces)) return null;
    for (var i = 0; i < batch.furnaces.length; i++) {
      if (batch.furnaces[i].id === String(id)) return batch.furnaces[i];
    }
    return null;
  }

  function groupsInScope(f) {
    var out = [];
    for (var g = 0; g < f.groups; g++) {
      if (f.side === 'full') out.push(g);
      else if (f.side === 'A' && g < 4) out.push(g);
      else if (f.side === 'B' && g >= 4) out.push(g);
    }
    return out;
  }

  function isGroupInScope(f, g) {
    return groupsInScope(f).indexOf(g) >= 0;
  }

  function setSide(batch, id, side) {
    var f = furnaceById(batch, id);
    if (!f || SIDES.indexOf(side) < 0) return f;
    f.side = side;
    return f;
  }

  function nextInScopeGroup(f, g) {
    var list = groupsInScope(f);
    var idx = list.indexOf(g);
    return idx >= 0 && idx < list.length - 1 ? list[idx + 1] : -1;
  }

  function prevInScopeGroup(f, g) {
    var list = groupsInScope(f);
    var idx = list.indexOf(g);
    return idx > 0 ? list[idx - 1] : -1;
  }

  /* ------------------------------------------------------------------ *
   * 三、读数解析 / 格式化
   * ------------------------------------------------------------------ */

  function normalizeText(text) {
    return String(text)
      .replace(/[０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
      .replace(/[．。]/g, '.')
      .replace(/[－—–ー]/g, '-')
      .replace(/＋/g, '+')
      .replace(/[，、]/g, ',')
      .replace(/\u00a0/g, ' ')
      .trim();
  }

  /** 解析一个读数，支持 "0.12"、"0.12 MPa"、"０.１２"、"0,12" */
  function parseValue(text) {
    if (text == null) return { ok: true, empty: true, value: null };
    var s = normalizeText(text);
    if (!s) return { ok: true, empty: true, value: null };
    if (s.indexOf(',') !== -1) {
      s = s.indexOf('.') === -1 ? s.replace(/,/g, '.') : s.replace(/,/g, '');
    }
    s = s.replace(/[^0-9.+\-]/g, '');
    if (!s) return { ok: false, empty: false, error: '未识别到数字' };
    var neg = s.charAt(0) === '-';
    s = s.replace(/[+\-]/g, '');
    if (!s) return { ok: false, empty: false, error: '格式无效' };
    if (s.indexOf('.') !== s.lastIndexOf('.')) return { ok: false, empty: false, error: '小数点过多' };
    if (s === '.') return { ok: false, empty: false, error: '格式无效' };
    var n = Number((neg ? '-' : '') + s);
    if (!isFinite(n)) return { ok: false, empty: false, error: '格式无效' };
    return { ok: true, empty: false, value: n };
  }

  /** 固定小数位，如 0.170（界面与方式2用） */
  function formatFixed(v, decimals) {
    if (v == null || v === '' || !isFinite(v)) return '';
    return Number(v).toFixed(clampInt(decimals != null ? decimals : 3, 0, 4));
  }

  /** 去掉多余 0，如 0.400 → "0.4"（方式1用，贴近历史文本习惯） */
  function formatReading(v, decimals) {
    if (v == null || v === '' || !isFinite(v)) return '';
    var s = Number(v).toFixed(clampInt(decimals != null ? decimals : 3, 0, 4));
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  function formatRatio(r) {
    if (r == null || !isFinite(r)) return '—';
    return Number(r).toFixed(5);
  }

  /**
   * 解析「导出文丘里压力」（方式1）的文本，供绝压比计算使用。
   * 标题支持：4号炉 / 4号炉A / 4号炉 A / 4号炉Ａ / 4号炉A炉膛 / 4号炉B侧 …
   * 返回 { furnaces:[{id,label,side,ambiguous,rawLines,groups,headerA,headerB}], issues:[...] }
   * issues: { level:'error'|'warn', line?, msg }
   */
  function parseMode1(text) {
    var src = String(text == null ? '' : text)
      .replace(/^\ufeff/, '')
      .replace(/\r\n?/g, '\n');
    var lines = src.split('\n');
    var furnaces = [];
    var issues = [];
    var current = null;

    lines.forEach(function (raw, i) {
      var line = raw.replace(/\u3000/g, ' ')
        .replace(/[０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
        .replace(/[Ａａ]/g, 'A')
        .replace(/[Ｂｂ]/g, 'B')
        .trim();
      if (!line) return;
      if (line.indexOf('文丘里压力') === 0) return;

      // 去掉空格后再认标题：4号炉A / 4号炉 A / 4号炉A炉膛 / 4号炉B侧 都行
      var fm = line.replace(/\s+/g, '').match(/^(\d+)[#号]炉(?:([AB])(?:炉膛|膛|侧)?)?$/i);
      if (fm) {
        var label = fm[1] + '号炉';
        var exist = null;
        furnaces.forEach(function (f) { if (f.id === fm[1]) exist = f; });
        if (exist) {
          current = exist;
          issues.push({ level: 'warn', line: i + 1, msg: label + ' 重复出现，已合并到前一处' });
        } else {
          current = { id: fm[1], label: label, side: fm[2] ? fm[2].toUpperCase() : null, rawLines: [] };
          furnaces.push(current);
        }
        return;
      }

      if (!current) {
        issues.push({ level: 'error', line: i + 1, msg: '读数行不在炉子标题下：' + line });
        return;
      }

      if (/^[-—–]\s+[-—–]$/.test(line)) {
        current.rawLines.push({ gauge: null, value: null });
        return;
      }

      // 支持：3 0.170 / 3# 0.170 / 3#0.170 / 第3块 0.170 / 第3块0.170
      var m = line.match(/^(?:第)?\s*(\d+)\s*(?:#|块)\s*(.+)$/);
      if (!m) m = line.match(/^(?:第)?\s*(\d+)\s+(.+)$/);
      if (!m) {
        issues.push({ level: 'error', line: i + 1, msg: '无法解析：' + line });
        return;
      }
      var p = parseValue(m[2]);
      if (!p.ok || p.empty) {
        issues.push({ level: 'error', line: i + 1, msg: '读数无法解析：' + line });
        return;
      }
      current.rawLines.push({ gauge: Number(m[1]), value: p.value });
    });

    if (!furnaces.length) issues.push({ level: 'error', msg: '没有识别到「X号炉」标题' });

    var out = [];
    furnaces.forEach(function (f) {
      var def = null;
      FURNACE_DEFS.forEach(function (d) { if (d.id === f.id) def = d; });
      if (!def) {
        issues.push({ level: 'error', msg: '不认识的炉号：' + f.label });
        return;
      }

      var side = f.side;
      var ambiguous = false;
      if (!side) {
        if (f.rawLines.length === def.groups) {
          side = 'full';
        } else if (f.rawLines.length === 4) {
          side = 'A';
          ambiguous = true;
          issues.push({ level: 'warn', msg: f.label + ' 有 4 行但没写 A/B 炉膛，暂按 A 炉膛；可在结果里切换' });
        } else {
          issues.push({ level: 'error', msg: f.label + ' 行数应为 8（整台）或 4（半台），实际 ' + f.rawLines.length });
          return;
        }
      } else if (f.side && f.rawLines.length === def.groups) {
        // 标题写了 A/B，但给了整台 8 行：按整台处理
        issues.push({ level: 'warn', msg: f.label + ' 标注了 ' + sideLabel(side) + '，但给了 8 行，已按整台处理' });
        side = 'full';
        ambiguous = false;
      }

      var groups = side === 'full' ? [0, 1, 2, 3, 4, 5, 6, 7] : side === 'A' ? [0, 1, 2, 3] : [4, 5, 6, 7];
      if (f.rawLines.length !== groups.length) {
        issues.push({
          level: 'error',
          msg: f.label + ' 标注为 ' + sideLabel(side) + '，应有 ' + groups.length + ' 行，实际 ' + f.rawLines.length
        });
        return;
      }

      var bad = false;
      var mapped = f.rawLines.map(function (ln, k) {
        if (ln.value == null) return { index: groups[k], gauge: null, value: null };
        if (!(ln.gauge >= 1 && ln.gauge <= def.perGroup)) {
          issues.push({ level: 'error', msg: f.label + ' 第 ' + (k + 1) + ' 行表号 ' + ln.gauge + ' 超出 1~' + def.perGroup });
          bad = true;
        }
        return { index: groups[k], gauge: ln.gauge, value: ln.value };
      });
      if (bad) return;

      out.push({
        id: f.id,
        label: f.label,
        side: side,
        ambiguous: ambiguous,
        rawLines: f.rawLines.slice(),
        groups: mapped,
        headerA: null,
        headerB: null
      });
    });

    return { furnaces: out, issues: issues };
  }

  /** 转换器里手动改半台炉的 A/B（只有 4 行的无标注炉才需要） */
  function converterSetSide(item, side) {
    var def = null;
    FURNACE_DEFS.forEach(function (d) { if (d.id === item.id) def = d; });
    if (!def) return false;
    var groups = side === 'full' ? [0, 1, 2, 3, 4, 5, 6, 7] : side === 'A' ? [0, 1, 2, 3] : [4, 5, 6, 7];
    if (item.rawLines.length !== groups.length) return false;
    item.side = side;
    item.ambiguous = false;
    item.groups = item.rawLines.map(function (ln, k) {
      return { index: groups[k], gauge: ln.gauge, value: ln.value };
    });
    return true;
  }

  /** 把解析结果还原成 batch（只还原每组最高值，足够生成方式2与绝压比） */
  function converterToBatch(items) {
    var b = createBatch();
    items.forEach(function (it) {
      var f = furnaceById(b, it.id);
      if (!f) return;
      setSide(b, it.id, it.side);
      it.groups.forEach(function (g) {
        if (g.value != null && g.gauge != null) setValue(b, it.id, g.index, g.gauge - 1, g.value);
      });
      if (it.headerA != null) setHeader(b, it.id, 'A', it.headerA);
      if (it.headerB != null) setHeader(b, it.id, 'B', it.headerB);
    });
    return b;
  }

  /** 把一段文本解析成读数数组（识别结果批量填入用） */
  function parseReadings(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return [];
    if (t.charAt(0) === '{' || t.charAt(0) === '[') {
      try {
        var obj = JSON.parse(t);
        var rows = Array.isArray(obj) ? obj : (obj.readings || obj.cells || null);
        if (Array.isArray(rows)) {
          var flat = [];
          rows.forEach(function (row) {
            if (Array.isArray(row)) {
              row.forEach(function (x) {
                var p = parseValue(x);
                flat.push(p.ok && !p.empty ? p.value : null);
              });
            } else {
              var p2 = parseValue(row);
              flat.push(p2.ok && !p2.empty ? p2.value : null);
            }
          });
          return flat;
        }
      } catch (e) { /* 不是 JSON，按普通文本处理 */ }
    }
    var lines = t.split(/[\r\n]+/).filter(function (l) { return l.trim(); });
    var out = [];
    if (lines.length > 1) {
      lines.forEach(function (line) {
        var nums = line.match(/-?\d+(?:\.\d+)?/g) || [];
        out.push(nums.length ? Number(nums[nums.length - 1]) : null);
      });
    } else {
      var nums = t.match(/-?\d+(?:\.\d+)?/g) || [];
      nums.forEach(function (n) { out.push(Number(n)); });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 四、写入
   * ------------------------------------------------------------------ */

  function setValue(batch, id, g, i, value) {
    var f = furnaceById(batch, id);
    if (!f || !f.cells[g] || !f.cells[g][i]) return null;
    var cell = f.cells[g][i];
    if (value == null || value === '') {
      cell.v = null;
      cell.skip = false;
      return cell;
    }
    var n;
    if (isNum(value)) n = value;
    else {
      var p = parseValue(value);
      n = p.ok && !p.empty ? p.value : null;
    }
    cell.v = n == null ? null : roundTo(n, batch.config.decimals);
    if (cell.v != null) cell.skip = false;
    return cell;
  }

  function setExcluded(batch, id, g, i, ex) {
    var f = furnaceById(batch, id);
    if (!f || !f.cells[g] || !f.cells[g][i]) return null;
    f.cells[g][i].ex = !!ex;
    if (ex) f.cells[g][i].skip = false;
    return f.cells[g][i];
  }

  /** 送检跳过：与「剔除」不同，表示这块表不在本次测量范围 */
  function setSkipped(batch, id, g, i, skip) {
    var f = furnaceById(batch, id);
    if (!f || !f.cells[g] || !f.cells[g][i]) return null;
    var cell = f.cells[g][i];
    cell.skip = !!skip;
    if (skip) {
      cell.v = null;
      cell.ex = false;
    }
    return cell;
  }

  /** 把“快捷最高表”更新写回 batch：只改指定表，旧最高表若换位则清空，其他表保留 */
  function applyQuickUpdate(batch, updates) {
    var updated = 0;
    var warnings = [];
    (updates || []).forEach(function (u) {
      var f = furnaceById(batch, u && u.id);
      if (!f) return;
      if (u.side && SIDES.indexOf(u.side) >= 0) setSide(batch, f.id, u.side);
      (u.groups || []).forEach(function (item) {
        if (!item || item.gauge == null || item.value == null) return;
        var g = Number(item.group);
        if (!f.cells[g] || !isGroupInScope(f, g)) return;
        var idx = Number(item.gauge) - 1;
        if (!(idx >= 0 && idx < f.perGroup)) {
          warnings.push({ id: f.id, group: g, msg: '表号超出范围，已跳过' });
          return;
        }
        var value = Number(item.value);
        if (!isFinite(value)) return;

        var before = groupStat(f, g);
        if (before.maxIndex >= 0 && before.maxIndex !== idx) {
          setValue(batch, f.id, g, before.maxIndex, null);
        }
        setValue(batch, f.id, g, idx, value);
        setExcluded(batch, f.id, g, idx, false);
        updated++;

        var after = groupStat(f, g);
        if (after.maxIndex >= 0 && after.maxIndex !== idx) {
          warnings.push({
            id: f.id,
            group: g,
            msg: '本组其他表读数更高（' + (after.maxIndex + 1) + '#），快捷最高表可能不对'
          });
        }
      });
    });
    return { updated: updated, warnings: warnings };
  }

  function setHeader(batch, id, ch, value) {
    var f = furnaceById(batch, id);
    if (!f) return;
    var n = null;
    if (value != null && value !== '') {
      if (isNum(value)) n = value;
      else {
        var p = parseValue(value);
        n = p.ok && !p.empty ? p.value : null;
      }
    }
    if (ch === 'A') f.headerA = n == null ? null : roundTo(n, batch.config.decimals);
    else if (ch === 'B') f.headerB = n == null ? null : roundTo(n, batch.config.decimals);
  }

  function clearGroup(batch, id, g) {
    var f = furnaceById(batch, id);
    if (!f || !f.cells[g]) return;
    for (var i = 0; i < f.cells[g].length; i++) f.cells[g][i] = emptyCell();
  }

  function clearFurnace(batch, id) {
    var f = furnaceById(batch, id);
    if (!f) return;
    for (var g = 0; g < f.groups; g++) clearGroup(batch, id, g);
    f.headerA = null;
    f.headerB = null;
  }

  /** 当前组里第一个空位（没读数的格子），没有返回 -1 */
  function nextEmptyIndex(f, g, reverse) {
    var row = f.cells[g] || [];
    if (reverse) {
      for (var i = row.length - 1; i >= 0; i--) {
        if (row[i].v == null && !row[i].skip) return i;
      }
      return -1;
    }
    for (var j = 0; j < row.length; j++) {
      if (row[j].v == null && !row[j].skip) return j;
    }
    return -1;
  }

  /* ------------------------------------------------------------------ *
   * 五、统计
   * ------------------------------------------------------------------ */

  function groupStat(f, g) {
    var cells = f.cells[g] || [];
    var st = {
      group: g,
      chamber: chamberOf(g),
      count: cells.length,
      filled: 0,
      skipped: 0,
      handled: 0,
      valid: 0,
      excluded: 0,
      missing: 0,
      complete: false,
      max: null,
      maxIndex: -1,
      over: 0
    };
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (c && c.skip) { st.skipped++; continue; }
      if (!c || !isNum(c.v)) { st.missing++; continue; }
      st.filled++;
      if (c.ex) { st.excluded++; continue; }
      st.valid++;
      if (st.max === null || c.v > st.max) { st.max = c.v; st.maxIndex = i; }
      if (c.v > CONFIG.max) st.over++;
    }
    st.handled = st.filled + st.skipped;
    st.complete = st.count > 0 && st.handled === st.count;
    return st;
  }

  function chamberStat(f, ch) {
    var groups = groupsInScope(f).filter(function (g) { return chamberOf(g) === ch; });
    var out = {
      chamber: ch,
      groups: groups,
      count: 0,
      filled: 0,
      skipped: 0,
      handled: 0,
      valid: 0,
      excluded: 0,
      missing: 0,
      complete: false,
      max: null,
      maxGroup: -1,
      maxIndex: -1
    };
    groups.forEach(function (g) {
      var s = groupStat(f, g);
      out.count += s.count;
      out.filled += s.filled;
      out.skipped += s.skipped;
      out.handled += s.handled;
      out.valid += s.valid;
      out.excluded += s.excluded;
      out.missing += s.missing;
      if (s.max !== null && (out.max === null || s.max > out.max)) {
        out.max = s.max;
        out.maxGroup = g;
        out.maxIndex = s.maxIndex;
      }
    });
    out.complete = out.count > 0 && out.handled === out.count;
    return out;
  }

  function headerOf(f, ch) {
    return ch === 'A' ? f.headerA : ch === 'B' ? f.headerB : null;
  }

  /** 单个炉膛的绝压比；缺读数或缺集合管压力时 ratio = null */
  function ratioOf(f, ch) {
    var inScope = groupsInScope(f).some(function (g) { return chamberOf(g) === ch; });
    if (!inScope) return { chamber: ch, inScope: false, ratio: null };
    var cs = chamberStat(f, ch);
    var h = headerOf(f, ch);
    var atm = ATM;
    var ratio = cs.max !== null && isNum(h) ? (cs.max + atm) / (h + atm) : null;
    return {
      chamber: ch,
      inScope: true,
      ratio: ratio,
      max: cs.max,
      maxGroup: cs.maxGroup,
      maxIndex: cs.maxIndex,
      header: isNum(h) ? h : null,
      groups: cs.groups,
      valid: cs.valid,
      filled: cs.filled,
      skipped: cs.skipped,
      excluded: cs.excluded,
      missing: cs.missing,
      count: cs.count
    };
  }

  /** 两个炉膛中较大的绝压比（含对应组号、表号） */
  function bestRatioOf(f) {
    var best = null;
    ['A', 'B'].forEach(function (ch) {
      var r = ratioOf(f, ch);
      if (r.ratio !== null && (best === null || r.ratio > best.ratio)) best = r;
    });
    return best;
  }

  function furnaceStat(f) {
    var groups = groupsInScope(f).map(function (g) { return groupStat(f, g); });
    var total = 0;
    var filled = 0;
    var skipped = 0;
    var handled = 0;
    var valid = 0;
    var excluded = 0;
    var missing = 0;
    var max = null;
    var maxGroup = -1;
    var maxIndex = -1;
    groups.forEach(function (s) {
      total += s.count;
      filled += s.filled;
      skipped += s.skipped;
      handled += s.handled;
      valid += s.valid;
      excluded += s.excluded;
      missing += s.missing;
      if (s.max !== null && (max === null || s.max > max)) {
        max = s.max;
        maxGroup = s.group;
        maxIndex = s.maxIndex;
      }
    });
    var chambers = {
      A: ratioOf(f, 'A'),
      B: ratioOf(f, 'B')
    };
    var best = bestRatioOf(f);
    return {
      furnace: f,
      groups: groups,
      total: total,
      filled: filled,
      skipped: skipped,
      handled: handled,
      valid: valid,
      excluded: excluded,
      missing: missing,
      complete: total > 0 && handled === total,
      max: max,
      maxGroup: maxGroup,
      maxIndex: maxIndex,
      chambers: chambers,
      best: best
    };
  }

  function batchStat(batch) {
    var furnaces = batch.furnaces.map(function (f) { return furnaceStat(f); });
    var total = 0;
    var filled = 0;
    var skipped = 0;
    var handled = 0;
    var measured = 0;
    var complete = 0;
    var best = null;
    var bestFurnace = null;
    furnaces.forEach(function (st) {
      total += st.total;
      filled += st.filled;
      skipped += st.skipped;
      handled += st.handled;
      if (st.filled > 0) measured++;
      if (st.complete) complete++;
      if (st.best && (best === null || st.best.ratio > best.ratio)) {
        best = st.best;
        bestFurnace = st.furnace;
      }
    });
    return {
      furnaces: furnaces,
      total: total,
      filled: filled,
      skipped: skipped,
      handled: handled,
      measured: measured,
      complete: complete,
      best: best,
      bestFurnace: bestFurnace
    };
  }

  function hasFurnaceData(f) {
    for (var g = 0; g < f.groups; g++) {
      var row = f.cells[g] || [];
      for (var i = 0; i < row.length; i++) {
        if (row[i] && row[i].v != null) return true;
      }
    }
    return false;
  }

  /** 当前炉膛范围内是否有读数（导出只看这个范围） */
  function hasScopeData(f) {
    var groups = groupsInScope(f);
    for (var k = 0; k < groups.length; k++) {
      var row = f.cells[groups[k]] || [];
      for (var i = 0; i < row.length; i++) {
        if (row[i] && row[i].v != null) return true;
      }
    }
    return false;
  }

  function hasBatchData(batch) {
    return batch.furnaces.some(hasFurnaceData);
  }

  /* ------------------------------------------------------------------ *
   * 六、文本快捷导出
   * ------------------------------------------------------------------ */

  function furnacesWithData(batch) {
    var scope = batch.meta && batch.meta.exportScope;
    var limited = Array.isArray(scope) && scope.length;
    return batch.furnaces.filter(function (f) {
      if (limited && scope.indexOf(f.id) < 0) return false;
      return hasScopeData(f);
    });
  }

  /** 与 xlsx-lite.js 中 cellXfs 的顺序一一对应 */
  var REPORT_STYLE = {
    text: 0,
    num: 1,
    label: 2,
    boldNum: 3,
    strikeNum: 4,
    title: 5,
    header: 6,
    ratio: 8,
    boldRatio: 9,
    plain: 10,
    plainBold: 11
  };

  function colLetter(n) {
    var s = '';
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function rcell(v, s) {
    return { v: v == null ? null : v, s: s };
  }

  /**
   * “导出所有数据”用的 Excel 工作簿：
   *   所有数据一张表：每台炉一块，一组一行；组最高值加粗；剔除读数划线；
   *   每台炉补充 A/B 集合管压力；最大绝压比注明第几组第几块。
   */
  function toReportWorkbook(batch) {
    var cfg = batch.config;
    var m = batch.meta;
    var S = REPORT_STYLE;
    var list = furnacesWithData(batch);

    var maxCols = 15;
    var rows = [];
    var merges = [];
    var add = function (row) { rows.push(row); return rows.length; };

    add([rcell('加热炉文丘里压力', S.title)]);
    merges.push('A1:' + colLetter(maxCols) + '1');
    add([rcell('日期', S.plainBold), rcell(m.date, S.plain)]);
    add([rcell('时间', S.plainBold), rcell(m.time || nowTimeStr(), S.plain)]);
    add([rcell('记录人', S.plainBold), rcell(m.operator || '', S.plain)]);
    add([rcell('导出时间', S.plainBold), rcell(nowStr(), S.plain)]);
    add([rcell('A炉膛 = 第1～4组，B炉膛 = 第5～8组；送检的表写作“送检”，最大绝压比后注明第几组第几块', S.plain)]);
    merges.push('A6:' + colLetter(maxCols) + '6');
    add([]);

    list.forEach(function (f) {
      var width = f.perGroup + 3;
      var titleRow = add([rcell(f.label + '（' + sideLabel(f.side) + '）', S.title)]);
      merges.push('A' + titleRow + ':' + colLetter(width) + titleRow);

      var header = [rcell('组', S.header)];
      for (var i = 0; i < f.perGroup; i++) header.push(rcell((i + 1) + '#', S.header));
      header.push(rcell('最高值', S.header), rcell('表号', S.header));
      add(header);

      groupsInScope(f).forEach(function (g) {
        var st = groupStat(f, g);
        var row = [rcell('第' + (g + 1) + '组', S.label)];
        for (var i = 0; i < f.perGroup; i++) {
          var c = f.cells[g][i];
          if (c && c.skip) {
            row.push(rcell('送检', S.text));
          } else if (!c || c.v == null) {
            row.push(rcell(null, S.num));
          } else if (c.ex) {
            row.push(rcell(c.v, S.strikeNum));
          } else if (i === st.maxIndex) {
            row.push(rcell(c.v, S.boldNum));
          } else {
            row.push(rcell(c.v, S.num));
          }
        }
        row.push(st.max == null ? rcell(null, S.boldNum) : rcell(st.max, S.boldNum));
        row.push(st.maxIndex >= 0 ? rcell((st.maxIndex + 1) + '#', S.text) : rcell(null, S.text));
        add(row);
      });

      var a = ratioOf(f, 'A');
      var b = ratioOf(f, 'B');
      var best = bestRatioOf(f);

      // 每台炉补充 A/B 集合管压力
      var headerRow = [];
      if (a.inScope) {
        headerRow.push(rcell('A集合管压力', S.label));
        headerRow.push(a.header == null ? rcell(null, S.num) : rcell(a.header, S.num));
      }
      if (b.inScope) {
        if (a.inScope) {
          headerRow.push(rcell('B集合管压力', S.label));
          headerRow.push(rcell(null, S.text));
          headerRow.push(b.header == null ? rcell(null, S.num) : rcell(b.header, S.num));
        } else {
          headerRow.push(rcell('B集合管压力', S.label));
          headerRow.push(b.header == null ? rcell(null, S.num) : rcell(b.header, S.num));
        }
      }
      var hdrRow = add(headerRow);
      if (a.inScope && b.inScope) merges.push('C' + hdrRow + ':D' + hdrRow);

      // 最大绝压比 + 位置（第5组第4块）
      var pos = best ? '第' + (best.maxGroup + 1) + '组第' + (best.maxIndex + 1) + '块' : '';
      var maxRow = add([
        rcell('最大绝压比', S.label),
        best ? rcell(best.ratio, S.boldRatio) : rcell(null, S.boldRatio),
        best ? rcell(pos, S.text) : rcell(null, S.text)
      ]);
      merges.push('C' + maxRow + ':E' + maxRow);
      add([]);
    });

    var sheetCols = [12];
    for (var ci = 0; ci < 12; ci++) sheetCols.push(8);
    sheetCols.push(10, 8);

    return {
      sheets: [
        {
          name: '读数',
          cols: sheetCols,
          merges: merges,
          rows: rows
        }
      ]
    };
  }

  function furnaceTitle(f) {
    return f.label + (f.side === 'full' ? '' : ' ' + sideLabel(f.side));
  }

  /* ------------------------------------------------------------------ *
   * 导出的 Excel 再读回来
   * ------------------------------------------------------------------ */

  function readCellText(c) {
    return c && c.v != null ? String(c.v).trim() : '';
  }

  function readCellNum(c) {
    if (!c || c.v == null) return null;
    if (typeof c.v === 'number' && isFinite(c.v)) return c.v;
    var p = parseValue(String(c.v));
    return p.ok && !p.empty ? p.value : null;
  }

  function normalizeExcelDate(v) {
    if (typeof v === 'number' && v > 0) {
      var d = new Date(Math.round((v - 25569) * 86400000));
      return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    var s = String(v == null ? '' : v).trim();
    var dm = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return dm ? dm[1] : null;
  }

  function normalizeExcelTime(v) {
    if (typeof v === 'number' && v >= 0 && v < 1) {
      var mins = Math.round(v * 1440);
      return pad2(Math.floor(mins / 60) % 24) + ':' + pad2(mins % 60);
    }
    var s = String(v == null ? '' : v).trim();
    var m = s.match(/^(\d{1,2}):(\d{2})/);
    return m ? pad2(Number(m[1])) + ':' + m[2] : null;
  }

  /**
   * 解析「导出所有数据」的 Excel（也兼容旧的两表格式）。
   * 返回新的 batch；失败时 throw Error，消息可直接展示给用户。
   */
  function parseReportWorkbook(wb) {
    var sheets = (wb && wb.sheets) || [];
    if (!sheets.length) throw new Error('Excel 里没有工作表');

    var sheet = null;
    sheets.forEach(function (s) { if (s.name === '读数') sheet = s; });
    if (!sheet) sheet = sheets[0];
    var rows = sheet.rows || [];

    var meta = { date: null, time: null, operator: '' };
    rows.forEach(function (row) {
      if (!row) return;
      var key = readCellText(row[0]);
      if (key === '日期') meta.date = normalizeExcelDate(row[1] && row[1].v);
      else if (key === '时间') meta.time = normalizeExcelTime(row[1] && row[1].v);
      else if (key === '记录人') meta.operator = readCellText(row[1]);
    });

    var b = createBatch({
      date: meta.date || todayStr(),
      time: meta.time || nowTimeStr(),
      operator: meta.operator || ''
    });

    var blocks = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row) continue;
      var title = readCellText(row[0]);
      var tm = title.match(/^(\d+)号炉(?:[（(](整台|A炉膛|B炉膛)[）)])?$/);
      if (!tm) continue;

      var id = tm[1];
      var f = furnaceById(b, id);
      if (!f) throw new Error('不认识的炉号：' + title);
      var side = !tm[2] || tm[2] === '整台' ? 'full' : tm[2].charAt(0);

      var h = i + 1;
      while (h < rows.length && !rows[h]) h++;
      if (h >= rows.length || readCellText(rows[h][0]) !== '组') {
        throw new Error(title + ' 下面没有找到表头行');
      }

      var per = 0;
      var hr = rows[h];
      for (var c = 1; c < hr.length; c++) {
        if (/^\d+#$/.test(readCellText(hr[c]))) per++;
      }
      if (per !== f.perGroup) {
        throw new Error(title + ' 的表数应为 ' + f.perGroup + '，Excel 里是 ' + per);
      }

      var startGroups = [];
      var j = h + 1;
      for (; j < rows.length; j++) {
        var gr = rows[j];
        if (!gr) break;
        var gm = readCellText(gr[0]).match(/^第(\d+)组$/);
        if (!gm) break;
        var g = Number(gm[1]) - 1;
        if (g < 0 || g >= f.groups) throw new Error(title + ' 组号超出范围：第' + gm[1] + '组');
        if (side === 'A' && g > 3) throw new Error(title + ' 是 A 炉膛，不应出现第' + gm[1] + '组');
        if (side === 'B' && g < 4) throw new Error(title + ' 是 B 炉膛，不应出现第' + gm[1] + '组');
        startGroups.push({ g: g, row: gr });
      }
      if (!startGroups.length) throw new Error(title + ' 下面没有组数据');

      setSide(b, id, side);
      startGroups.forEach(function (item) {
        for (var k = 0; k < per; k++) {
          var c = item.row[k + 1];
          if (!c || c.v == null) continue;
          if (readCellText(c) === '送检') {
            setSkipped(b, id, item.g, k, true);
            continue;
          }
          var v = readCellNum(c);
          if (v == null) throw new Error(title + ' 第' + (item.g + 1) + '组第' + (k + 1) + '块读数无法识别');
          setValue(b, id, item.g, k, v);
          if (c.strike) setExcluded(b, id, item.g, k, true);
        }
      });

      // 集合管压力（A/B 标签后面的第一个有值单元格）
      for (; j < rows.length; j++) {
        var rr = rows[j];
        if (!rr) continue;
        if (/^\d+号炉/.test(readCellText(rr[0]))) break;
        for (var q = 0; q < rr.length; q++) {
          var label = readCellText(rr[q]);
          var hm = label.match(/^([AB])集合管压力$/);
          if (!hm) continue;
          var val = null;
          for (var d = q + 1; d < rr.length; d++) {
            if (rr[d] && rr[d].v != null) { val = readCellNum(rr[d]); break; }
          }
          setHeader(b, id, hm[1], val);
        }
      }

      blocks++;
      i = j - 1;
    }

    // 兼容旧版两张表：从「绝压比」表补集合管压力
    var ratioSheet = null;
    sheets.forEach(function (s) { if (s.name === '绝压比') ratioSheet = s; });
    if (ratioSheet) {
      var rrows = ratioSheet.rows || [];
      var aCol = -1, bCol = -1;
      var headerIdx = -1;
      for (var r = 0; r < rrows.length; r++) {
        var row2 = rrows[r];
        if (!row2 || readCellText(row2[0]) !== '炉号') continue;
        headerIdx = r;
        for (var c2 = 0; c2 < row2.length; c2++) {
          var lab = readCellText(row2[c2]);
          if (lab === 'A集合管压力') aCol = c2;
          if (lab === 'B集合管压力') bCol = c2;
        }
        break;
      }
      if (headerIdx >= 0) {
        for (var r2 = headerIdx + 1; r2 < rrows.length; r2++) {
          var row3 = rrows[r2];
          if (!row3) continue;
          var idm = readCellText(row3[0]).match(/^(\d+)号炉$/);
          if (!idm || !furnaceById(b, idm[1])) continue;
          if (aCol >= 0) setHeader(b, idm[1], 'A', readCellNum(row3[aCol]));
          if (bCol >= 0) setHeader(b, idm[1], 'B', readCellNum(row3[bCol]));
        }
      }
    }

    if (!hasBatchData(b)) throw new Error('Excel 里没有读到任何读数');
    if (!blocks) throw new Error('Excel 里没有找到炉子数据');
    return b;
  }

  /**
   * 方式1：纯文本
   *   文丘里压力
   *
   *   2号炉
   *   1 0.183
   *   ...
   * 每个组一行：最高值表号 + 空格 + 最高值（固定 3 位小数，与方式2一致）。
   */
  function exportMode1(batch) {
    var lines = ['文丘里压力', ''];
    var list = furnacesWithData(batch);
    if (!list.length) {
      lines.push('（暂无读数）');
      return lines.join('\n');
    }
    list.forEach(function (f, idx) {
      lines.push(furnaceTitle(f));
      groupsInScope(f).forEach(function (g) {
        var s = groupStat(f, g);
        if (s.max === null) lines.push('- -');
        else lines.push((s.maxIndex + 1) + ' ' + formatFixed(s.max, batch.config.decimals));
      });
      if (idx < list.length - 1) lines.push('');
    });
    return lines.join('\n');
  }

  /**
   * 方式2：带圈号与绝压比
   *   3号炉
   *   ①<3>0.170 ②<3>0.148 ③<3>0.148 ④<3>0.148 A集合管 0.230
   *   ⑤<4>0.170 ⑥<3>0.134 ⑦<3>0.148 ⑧<3>0.148 B集合管 0.220
   *   最大绝压比 ⑤ 0.84375
   */
  function exportMode2(batch) {
    var lines = [];
    var list = furnacesWithData(batch);
    if (!list.length) return '（暂无读数）\n';
    list.forEach(function (f, idx) {
      if (idx > 0) lines.push('');
      lines.push(furnaceTitle(f));
      ['A', 'B'].forEach(function (ch) {
        var groups = groupsInScope(f).filter(function (g) { return chamberOf(g) === ch; });
        if (!groups.length) return;
        var parts = groups.map(function (g) {
          var s = groupStat(f, g);
          var num = CIRCLED[g];
          if (s.max === null) return num + '<->-';
          return num + '<' + (s.maxIndex + 1) + '>' + formatFixed(s.max, batch.config.decimals);
        });
        var h = headerOf(f, ch);
        parts.push(ch + '集合管 ' + (isNum(h) ? formatFixed(h, batch.config.decimals) : '—'));
        lines.push(parts.join(' '));
      });
      var best = bestRatioOf(f);
      lines.push('最大绝压比 ' + (best ? CIRCLED[best.maxGroup] + ' ' + formatRatio(best.ratio) : '— —'));
    });
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 七、JSON 备份 / 恢复
   * ------------------------------------------------------------------ */

  function toJSON(batch) {
    return {
      format: 'heater-venturi-batch',
      version: VERSION,
      savedAt: new Date().toISOString(),
      meta: batch.meta,
      config: batch.config,
      furnaces: batch.furnaces.map(function (f) {
        return {
          id: f.id,
          label: f.label,
          groups: f.groups,
          perGroup: f.perGroup,
          side: f.side,
          headerA: f.headerA,
          headerB: f.headerB,
          cells: f.cells.map(function (row) {
            return row.map(function (c) { return { v: c.v == null ? null : c.v, ex: !!c.ex, skip: !!c.skip }; });
          })
        };
      })
    };
  }

  /** 把任意来源的 JSON 整理成标准 batch（容错） */
  function normalizeBatch(input) {
    var src = input && typeof input === 'object' ? input : {};
    var batch = createBatch(src.meta);
    if (src.config) {
      if (isNum(src.config.decimals)) batch.config.decimals = clampInt(src.config.decimals, 0, 4);
      if (isNum(src.config.atmosphere)) batch.config.atmosphere = src.config.atmosphere;
    }
    var list = Array.isArray(src.furnaces) ? src.furnaces : [];
    FURNACE_DEFS.forEach(function (def) {
      var s = list.filter(function (x) { return x && String(x.id) === def.id; })[0];
      if (!s) return;
      var f = furnaceById(batch, def.id);
      if (SIDES.indexOf(s.side) >= 0) f.side = s.side;
      var pa = parseValue(s.headerA);
      var pb = parseValue(s.headerB);
      f.headerA = pa.ok && !pa.empty ? pa.value : null;
      f.headerB = pb.ok && !pb.empty ? pb.value : null;
      if (!Array.isArray(s.cells)) return;
      for (var g = 0; g < f.groups; g++) {
        var srcRow = s.cells[g];
        if (!Array.isArray(srcRow)) continue;
        for (var i = 0; i < f.perGroup; i++) {
          var c = srcRow[i];
          if (c == null) continue;
          var cell = { v: null, ex: false, skip: false };
          if (isNum(c)) {
            cell.v = roundTo(c, batch.config.decimals);
          } else if (typeof c === 'object') {
            cell.skip = !!c.skip;
            if (!cell.skip) {
              if (isNum(c.v)) cell.v = roundTo(c.v, batch.config.decimals);
              else if (c.v != null && c.v !== '') {
                var p = parseValue(c.v);
                if (p.ok && !p.empty) cell.v = roundTo(p.value, batch.config.decimals);
              }
              cell.ex = !!c.ex;
            }
          }
          f.cells[g][i] = cell;
        }
      }
    });
    return batch;
  }

  /* ------------------------------------------------------------------ *
   * 导出 API
   * ------------------------------------------------------------------ */

  return {
    VERSION: VERSION,
    ATM: ATM,
    CONFIG: CONFIG,
    FURNACE_DEFS: FURNACE_DEFS,
    CIRCLED: CIRCLED,

    todayStr: todayStr,
    nowStr: nowStr,
    nowTimeStr: nowTimeStr,
    chamberOf: chamberOf,
    sideLabel: sideLabel,
    roundTo: roundTo,

    createBatch: createBatch,
    normalizeBatch: normalizeBatch,
    toJSON: toJSON,
    furnaceById: furnaceById,
    groupsInScope: groupsInScope,
    isGroupInScope: isGroupInScope,
    setSide: setSide,
    nextInScopeGroup: nextInScopeGroup,
    prevInScopeGroup: prevInScopeGroup,

    parseValue: parseValue,
    parseReadings: parseReadings,
    parseMode1: parseMode1,
    converterSetSide: converterSetSide,
    converterToBatch: converterToBatch,
    formatFixed: formatFixed,
    formatReading: formatReading,
    formatRatio: formatRatio,

    setValue: setValue,
    setExcluded: setExcluded,
    setSkipped: setSkipped,
    applyQuickUpdate: applyQuickUpdate,
    setHeader: setHeader,
    clearGroup: clearGroup,
    clearFurnace: clearFurnace,
    nextEmptyIndex: nextEmptyIndex,

    groupStat: groupStat,
    chamberStat: chamberStat,
    ratioOf: ratioOf,
    bestRatioOf: bestRatioOf,
    furnaceStat: furnaceStat,
    batchStat: batchStat,
    hasFurnaceData: hasFurnaceData,
    hasScopeData: hasScopeData,
    hasBatchData: hasBatchData,
    furnacesWithData: furnacesWithData,
    headerOf: headerOf,

    exportMode1: exportMode1,
    exportMode2: exportMode2,
    toReportWorkbook: toReportWorkbook,
    parseReportWorkbook: parseReportWorkbook,
    REPORT_STYLE: REPORT_STYLE
  };
});
