/*!
 * xlsx-read.js — 极简 XLSX 读取器（浏览器离线）
 * 版本 1.0.0
 *
 * 只读取本软件需要的内容：单元格值、单元格样式（是否删除线/加粗）、合并单元格由首个单元格承载。
 * 支持：
 *   - ZIP 存储（method 0）和 deflate（method 8，需浏览器 DecompressionStream）
 *   - inlineStr / sharedStrings / 数字
 *   - styles.xml 中 font 的 strike、bold
 *
 * 用法：
 *   const wb = await XlsxRead.readWorkbook(arrayBuffer);
 *   // wb.sheets = [{ name, rows: [[{ v, s, strike, bold }]] }]
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XlsxRead = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

  function u16(a, i) { return a[i] | (a[i + 1] << 8); }
  function u32(a, i) { return (a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24)) >>> 0; }

  function text(bytes) {
    if (!decoder) throw new Error('当前浏览器不支持 UTF-8 解码');
    return decoder.decode(bytes);
  }

  function parseXml(str) {
    if (typeof DOMParser === 'undefined') throw new Error('当前浏览器不支持 Excel 解析');
    var doc = new DOMParser().parseFromString(str, 'application/xml');
    if (!doc || doc.getElementsByTagName('parsererror').length) {
      throw new Error('Excel 内部 XML 解析失败');
    }
    return doc;
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持解压，请在 Chrome / Edge 新版本中导入');
    }
    var ds;
    try {
      ds = new DecompressionStream('deflate-raw');
    } catch (e) {
      ds = new DecompressionStream('deflate');
    }
    var stream = new Blob([data]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function unzip(buffer) {
    var arr = new Uint8Array(buffer);
    var eocd = -1;
    var min = Math.max(0, arr.length - 65557);
    for (var i = arr.length - 22; i >= min; i--) {
      if (u32(arr, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 .xlsx 文件');

    var count = u16(arr, eocd + 10);
    var cdOff = u32(arr, eocd + 16);
    var files = {};
    var p = cdOff;

    for (var n = 0; n < count; n++) {
      if (u32(arr, p) !== 0x02014b50) throw new Error('Excel 压缩包目录损坏');
      var method = u16(arr, p + 10);
      var compSize = u32(arr, p + 20);
      var nameLen = u16(arr, p + 28);
      var extraLen = u16(arr, p + 30);
      var commentLen = u16(arr, p + 32);
      var localOff = u32(arr, p + 42);
      var name = text(arr.subarray(p + 46, p + 46 + nameLen));

      if (u32(arr, localOff) !== 0x04034b50) throw new Error('Excel 文件头损坏');
      var lNameLen = u16(arr, localOff + 26);
      var lExtraLen = u16(arr, localOff + 28);
      var dataStart = localOff + 30 + lNameLen + lExtraLen;
      var comp = arr.subarray(dataStart, dataStart + compSize);

      if (method === 0) files[name] = comp;
      else if (method === 8) files[name] = await inflateRaw(comp);
      else throw new Error('Excel 使用了不支持的压缩方式');

      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  function parseStyles(files) {
    var data = files['xl/styles.xml'];
    if (!data) return [];
    var doc = parseXml(text(data));
    var fonts = [];
    var fontEls = doc.getElementsByTagName('fonts');
    if (fontEls.length) {
      var fs = fontEls[0].getElementsByTagName('font');
      for (var i = 0; i < fs.length; i++) {
        fonts.push({
          strike: fs[i].getElementsByTagName('strike').length > 0,
          bold: fs[i].getElementsByTagName('b').length > 0
        });
      }
    }
    var styles = [];
    var xfsEls = doc.getElementsByTagName('cellXfs');
    if (xfsEls.length) {
      var xfs = xfsEls[0].getElementsByTagName('xf');
      for (var j = 0; j < xfs.length; j++) {
        var fid = Number(xfs[j].getAttribute('fontId') || 0);
        var f = fonts[fid] || { strike: false, bold: false };
        styles.push({ strike: !!f.strike, bold: !!f.bold });
      }
    }
    return styles;
  }

  function parseShared(files) {
    var data = files['xl/sharedStrings.xml'];
    if (!data) return [];
    var doc = parseXml(text(data));
    var sis = doc.getElementsByTagName('si');
    var out = [];
    for (var i = 0; i < sis.length; i++) {
      var ts = sis[i].getElementsByTagName('t');
      var s = '';
      for (var j = 0; j < ts.length; j++) s += ts[j].textContent || '';
      out.push(s);
    }
    return out;
  }

  function colIndex(ref) {
    var m = String(ref).match(/^([A-Z]+)/);
    if (!m) return -1;
    var s = m[1];
    var n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  function cellText(c) {
    var v = c.getElementsByTagName('v');
    if (!v.length) return '';
    return v[0].textContent || '';
  }

  function parseSheet(xml, shared, styles) {
    var doc = parseXml(xml);
    var rowEls = doc.getElementsByTagName('row');
    var rows = [];
    for (var i = 0; i < rowEls.length; i++) {
      var rowEl = rowEls[i];
      var rowNum = Number(rowEl.getAttribute('r')) || rows.length + 1;
      var row = [];
      var cells = rowEl.getElementsByTagName('c');
      for (var j = 0; j < cells.length; j++) {
        var c = cells[j];
        var ref = c.getAttribute('r') || '';
        var ci = colIndex(ref);
        if (ci < 0) ci = row.length;
        var t = c.getAttribute('t');
        var s = Number(c.getAttribute('s') || 0);
        var st = styles[s] || { strike: false, bold: false };
        var v = null;

        if (t === 'inlineStr') {
          var ts = c.getElementsByTagName('t');
          var str = '';
          for (var k = 0; k < ts.length; k++) str += ts[k].textContent || '';
          v = str;
        } else if (t === 's') {
          var idx = Number(cellText(c));
          v = shared[idx] == null ? '' : shared[idx];
        } else {
          var raw = cellText(c);
          if (raw !== '') {
            var num = Number(raw);
            v = isFinite(num) ? num : raw;
          }
        }
        row[ci] = { v: v, s: s, strike: !!st.strike, bold: !!st.bold };
      }
      rows[rowNum - 1] = row;
    }
    return rows;
  }

  function sheetList(files) {
    var wbData = files['xl/workbook.xml'];
    if (!wbData) throw new Error('Excel 缺少 workbook.xml');
    var wbDoc = parseXml(text(wbData));
    var rels = {};
    var relData = files['xl/_rels/workbook.xml.rels'];
    if (relData) {
      var relDoc = parseXml(text(relData));
      var rs = relDoc.getElementsByTagName('Relationship');
      for (var i = 0; i < rs.length; i++) rels[rs[i].getAttribute('Id')] = rs[i].getAttribute('Target');
    }
    var els = wbDoc.getElementsByTagName('sheet');
    var out = [];
    for (var j = 0; j < els.length; j++) {
      var name = els[j].getAttribute('name') || ('Sheet' + (j + 1));
      var rid = els[j].getAttribute('r:id') || els[j].getAttributeNS(R_NS, 'id');
      var target = rels[rid] || ('worksheets/sheet' + (j + 1) + '.xml');
      var path = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target;
      if (path.indexOf('xl/') !== 0) path = 'xl/' + path;
      out.push({ name: name, path: path });
    }
    return out;
  }

  async function readWorkbook(buffer) {
    var files = await unzip(buffer);
    var styles = parseStyles(files);
    var shared = parseShared(files);
    var list = sheetList(files);
    var sheets = [];
    for (var i = 0; i < list.length; i++) {
      var data = files[list[i].path];
      if (!data) continue;
      sheets.push({ name: list[i].name, rows: parseSheet(text(data), shared, styles) });
    }
    if (!sheets.length) throw new Error('Excel 里没有工作表');
    return { sheets: sheets };
  }

  return { readWorkbook: readWorkbook };
});
