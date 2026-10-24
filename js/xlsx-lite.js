/*!
 * xlsx-lite.js — 极简 XLSX 生成器（带单元格样式）
 * 版本 2.0.0
 *
 * 只做本软件需要的事：数字/文本、列宽、合并单元格、加粗/划线/边框、数字格式。
 * 生成标准 OOXML 包（ZIP 存储法），Excel / WPS / LibreOffice 均可打开。
 *
 * 样式索引与 js/core.js 中的 REPORT_STYLE 一一对应：
 *   0 普通文本（边框、居中）      1 普通数字 0.000
 *   2 加粗标签（边框、左对齐）      3 加粗数字 0.000
 *   4 划线数字 0.000               5 标题（14pt 加粗）
 *   6 表头（加粗、浅灰底、边框）    7 加粗数字 0.00000（备用）
 *   8 普通数字 0.00000             9 加粗数字 0.00000
 *  10 无边框文本                   11 无边框加粗文本
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XlsxLite = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- CRC32 ---------------- */

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------------- 编码 / 转义 ---------------- */

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'utf8'));
    throw new Error('当前环境不支持 UTF-8 编码');
  }

  function xmlEscape(str) {
    return String(str)
      .replace(/[&<>"']/g, function (ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch];
      })
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  }

  function colName(n) {
    var s = '';
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function sheetName(name, idx) {
    var s = String(name || 'Sheet' + (idx + 1)).replace(/[\[\]\*\?\/\\:]/g, ' ').trim().slice(0, 31);
    return s || 'Sheet' + (idx + 1);
  }

  /* ---------------- 样式 ---------------- */

  function stylesXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2">' +
      '<numFmt numFmtId="164" formatCode="0.000"/>' +
      '<numFmt numFmtId="165" formatCode="0.00000"/>' +
      '</numFmts>' +
      '<fonts count="4">' +
      '<font><sz val="11"/><name val="等线"/><charset val="134"/></font>' +
      '<font><b/><sz val="11"/><name val="等线"/><charset val="134"/></font>' +
      '<font><strike/><sz val="11"/><name val="等线"/><charset val="134"/></font>' +
      '<font><b/><sz val="14"/><name val="等线"/><charset val="134"/></font>' +
      '</fonts>' +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFEDF2F7"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border>' +
      '<left style="thin"><color rgb="FFBFBFBF"/></left>' +
      '<right style="thin"><color rgb="FFBFBFBF"/></right>' +
      '<top style="thin"><color rgb="FFBFBFBF"/></top>' +
      '<bottom style="thin"><color rgb="FFBFBFBF"/></bottom>' +
      '<diagonal/>' +
      '</border>' +
      '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="12">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' +
      '<alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">' +
      '<alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">' +
      '<alignment horizontal="left" vertical="center"/></xf>' +
      '<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1">' +
      '<alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="164" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1">' +
      '<alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">' +
      '<alignment horizontal="left" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
      '<alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1">' +
      '<alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">' +
      '<alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1">' +
      '<alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">' +
      '<alignment horizontal="left" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">' +
      '<alignment horizontal="left" vertical="center"/></xf>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  }

  /* ---------------- 工作表 ---------------- */

  function cellXml(rowNum, colNum, cell) {
    if (cell == null) return '';
    var ref = colName(colNum) + rowNum;
    var v = cell;
    var s = 0;
    if (typeof cell === 'object') {
      v = cell.v;
      s = Number(cell.s) || 0;
    }
    var sAttr = s ? ' s="' + s + '"' : '';
    if (v == null || v === '') {
      return s ? '<c r="' + ref + '" s="' + s + '"/>' : '';
    }
    if (typeof v === 'number' && isFinite(v)) {
      return '<c r="' + ref + '"' + sAttr + '><v>' + v + '</v></c>';
    }
    return '<c r="' + ref + '"' + sAttr + ' t="inlineStr"><is><t xml:space="preserve">' +
      xmlEscape(String(v)) + '</t></is></c>';
  }

  function sheetXml(sheet) {
    var rows = sheet.rows || [];
    var cols = sheet.cols || [];
    var merges = sheet.merges || [];
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    out.push('<sheetViews><sheetView workbookViewId="0"/></sheetViews>');
    if (cols.length) {
      out.push('<cols>');
      for (var ci = 0; ci < cols.length; ci++) {
        out.push('<col min="' + (ci + 1) + '" max="' + (ci + 1) + '" width="' +
          (Number(cols[ci]) || 10) + '" customWidth="1"/>');
      }
      out.push('</cols>');
    }
    out.push('<sheetData>');
    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri] || [];
      var cells = [];
      for (var cj = 0; cj < row.length; cj++) {
        var xml = cellXml(ri + 1, cj + 1, row[cj]);
        if (xml) cells.push(xml);
      }
      out.push('<row r="' + (ri + 1) + '">' + cells.join('') + '</row>');
    }
    out.push('</sheetData>');
    if (merges.length) {
      out.push('<mergeCells count="' + merges.length + '">');
      merges.forEach(function (ref) { out.push('<mergeCell ref="' + xmlEscape(ref) + '"/>'); });
      out.push('</mergeCells>');
    }
    out.push('</worksheet>');
    return out.join('');
  }

  /* ---------------- 工作簿 / 关系 ---------------- */

  function workbookXml(sheets) {
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'];
    for (var i = 0; i < sheets.length; i++) {
      out.push('<sheet name="' + xmlEscape(sheetName(sheets[i].name, i)) + '" sheetId="' + (i + 1) +
        '" r:id="rId' + (i + 1) + '"/>');
    }
    out.push('</sheets></workbook>');
    return out.join('');
  }

  function workbookRels(count) {
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'];
    for (var i = 0; i < count; i++) {
      out.push('<Relationship Id="rId' + (i + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
        (i + 1) + '.xml"/>');
    }
    out.push('<Relationship Id="rId' + (count + 1) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
    out.push('</Relationships>');
    return out.join('');
  }

  function contentTypes(count) {
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'];
    for (var i = 0; i < count; i++) {
      out.push('<Override PartName="/xl/worksheets/sheet' + (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    }
    out.push('<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>');
    out.push('</Types>');
    return out.join('');
  }

  function rootRels() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';
  }

  /* ---------------- ZIP（仅存储） ---------------- */

  function dosDateTime(d) {
    d = d || new Date(2026, 0, 1, 8, 0, 0);
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  function zip(files) {
    var locals = [];
    var centrals = [];
    var offset = 0;
    var dt = dosDateTime();

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var nameBytes = utf8(f.name);
      var data = f.data;
      var crc = crc32(data);

      var local = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, dt.time, true);
      dv.setUint16(12, dt.date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      locals.push(local, data);

      var central = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dt.time, true);
      cv.setUint16(14, dt.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centrals.push(central);

      offset += local.length + data.length;
    }

    var centralSize = centrals.reduce(function (a, b) { return a + b.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var total = offset + centralSize + 22;
    var out = new Uint8Array(total);
    var pos = 0;
    locals.forEach(function (p) { out.set(p, pos); pos += p.length; });
    centrals.forEach(function (p) { out.set(p, pos); pos += p.length; });
    out.set(eocd, pos);
    return out;
  }

  /* ---------------- 对外接口 ---------------- */

  function build(workbook) {
    var sheets = (workbook && workbook.sheets) || [];
    if (!sheets.length) throw new Error('工作簿至少需要一个工作表');
    var files = [
      { name: '[Content_Types].xml', data: utf8(contentTypes(sheets.length)) },
      { name: '_rels/.rels', data: utf8(rootRels()) },
      { name: 'xl/workbook.xml', data: utf8(workbookXml(sheets)) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels(sheets.length)) },
      { name: 'xl/styles.xml', data: utf8(stylesXml()) }
    ];
    for (var i = 0; i < sheets.length; i++) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(sheetXml(sheets[i])) });
    }
    return zip(files);
  }

  return { build: build, colName: colName, crc32: crc32 };
});
