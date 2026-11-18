/* 離線 QR Code 產生器：byte 模式、容錯等級 M、版本 1–10（約可編 150 字元以內的網址）。
   不需要網路，現場沒有外網也能產生 QR code。 */
(function (root) {
  'use strict';

  var ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  var NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  var MAX_VERSION = 10;

  function rawModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }

  function dataCodewords(ver) {
    return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
  }

  // GF(256)，多項式 0x11D
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree; i++) result.push(0);
    result[degree - 1] = 1;
    var root = 1;
    for (i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 2);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMul(coef, factor); });
    });
    return result;
  }

  function buildCodewords(text) {
    var bytes = Array.prototype.slice.call(new TextEncoder().encode(text));
    var ver, cap;
    for (ver = 1; ver <= MAX_VERSION; ver++) {
      cap = dataCodewords(ver) * 8;
      if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= cap) break;
    }
    if (ver > MAX_VERSION) throw new Error('網址太長，無法產生 QR code');

    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);

    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      data.push(v);
    }

    var numBlocks = NUM_BLOCKS[ver];
    var eccLen = ECC_PER_BLOCK[ver];
    var raw = Math.floor(rawModules(ver) / 8);
    var numShort = numBlocks - (raw % numBlocks);
    var shortLen = Math.floor(raw / numBlocks);
    var div = rsDivisor(eccLen);
    var blocks = [];
    for (var b = 0, k = 0; b < numBlocks; b++) {
      var dat = data.slice(k, k + shortLen - eccLen + (b < numShort ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, div);
      if (b < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var out = [];
    for (i = 0; i < blocks[0].length; i++) {
      for (var bi = 0; bi < blocks.length; bi++) {
        if (i !== shortLen - eccLen || bi >= numShort) out.push(blocks[bi][i]);
      }
    }
    return { version: ver, codewords: out };
  }

  function alignPositions(ver) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2;
    var step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    var res = [6];
    for (var pos = ver * 4 + 17 - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
    return res;
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0;
      default: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
    }
  }

  function makeQR(text) {
    var built = buildCodewords(text);
    var ver = built.version;
    var size = ver * 4 + 17;
    var mod = [], fn = [];
    for (var y = 0; y < size; y++) {
      mod.push(new Array(size).fill(false));
      fn.push(new Array(size).fill(false));
    }
    function setFn(x, y, dark) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      mod[y][x] = dark;
      fn[y][x] = true;
    }

    // 定位用圖樣：timing、finder、alignment
    for (var i = 0; i < size; i++) {
      setFn(6, i, i % 2 === 0);
      setFn(i, 6, i % 2 === 0);
    }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var d = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(cx + dx, cy + dy, d !== 2 && d !== 4);
        }
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var ap = alignPositions(ver);
    for (i = 0; i < ap.length; i++) {
      for (var j = 0; j < ap.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    function drawFormat(mask) {
      var data = (0 << 3) | mask; // 容錯等級 M 的格式位元為 00
      var rem = data;
      for (var k = 0; k < 10; k++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412;
      function bit(n) { return ((bits >>> n) & 1) !== 0; }
      for (var a = 0; a <= 5; a++) setFn(8, a, bit(a));
      setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
      for (a = 9; a < 15; a++) setFn(14 - a, 8, bit(a));
      for (a = 0; a < 8; a++) setFn(size - 1 - a, 8, bit(a));
      for (a = 8; a < 15; a++) setFn(8, size - 15 + a, bit(a));
      setFn(8, size - 8, true);
    }
    drawFormat(0);

    if (ver >= 7) {
      var rem = ver;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vbits = (ver << 12) | rem;
      for (i = 0; i < 18; i++) {
        var dark = ((vbits >>> i) & 1) !== 0;
        var a2 = size - 11 + (i % 3);
        var b2 = Math.floor(i / 3);
        setFn(a2, b2, dark);
        setFn(b2, a2, dark);
      }
    }

    // 放入資料位元（蛇形）
    var cw = built.codewords;
    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var jj = 0; jj < 2; jj++) {
          var x = right - jj;
          var upward = ((right + 1) & 2) === 0;
          var yy = upward ? size - 1 - vert : vert;
          if (!fn[yy][x] && idx < cw.length * 8) {
            mod[yy][x] = ((cw[idx >>> 3] >>> (7 - (idx & 7))) & 1) !== 0;
            idx++;
          }
        }
      }
    }

    function applyMask(mask) {
      for (var yy2 = 0; yy2 < size; yy2++) {
        for (var xx = 0; xx < size; xx++) {
          if (!fn[yy2][xx] && maskBit(mask, xx, yy2)) mod[yy2][xx] = !mod[yy2][xx];
        }
      }
    }

    function penalty() {
      var score = 0, dark = 0, x, y, run, prev, line;
      for (y = 0; y < size; y++) {
        run = 0; prev = null;
        for (x = 0; x < size; x++) {
          if (mod[y][x]) dark++;
          if (mod[y][x] === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
          else { prev = mod[y][x]; run = 1; }
        }
      }
      for (x = 0; x < size; x++) {
        run = 0; prev = null;
        for (y = 0; y < size; y++) {
          if (mod[y][x] === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
          else { prev = mod[y][x]; run = 1; }
        }
      }
      for (y = 0; y < size - 1; y++) {
        for (x = 0; x < size - 1; x++) {
          var c = mod[y][x];
          if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
        }
      }
      var pat1 = '10111010000', pat2 = '00001011101';
      for (y = 0; y < size; y++) {
        line = mod[y].map(function (v) { return v ? '1' : '0'; }).join('');
        score += 40 * (countOf(line, pat1) + countOf(line, pat2));
      }
      for (x = 0; x < size; x++) {
        line = '';
        for (y = 0; y < size; y++) line += mod[y][x] ? '1' : '0';
        score += 40 * (countOf(line, pat1) + countOf(line, pat2));
      }
      var total = size * size;
      score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return score;
    }

    function countOf(str, pat) {
      var n = 0, p = str.indexOf(pat);
      while (p !== -1) { n++; p = str.indexOf(pat, p + 1); }
      return n;
    }

    var best = 0, bestScore = Infinity;
    for (var m = 0; m < 8; m++) {
      drawFormat(m);
      applyMask(m);
      var s = penalty();
      if (s < bestScore) { bestScore = s; best = m; }
      applyMask(m); // 還原
    }
    drawFormat(best);
    applyMask(best);

    return { size: size, version: ver, modules: mod };
  }

  function qrSvg(text, opts) {
    opts = opts || {};
    var border = opts.border == null ? 4 : opts.border;
    var dark = opts.dark || '#000';
    var light = opts.light || '#fff';
    var qr = makeQR(text);
    var dim = qr.size + border * 2;
    var d = [];
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) d.push('M' + (x + border) + ',' + (y + border) + 'h1v1h-1z');
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim +
      '" shape-rendering="crispEdges" role="img" aria-label="加入遊戲的 QR code">' +
      '<rect width="100%" height="100%" fill="' + light + '"/>' +
      '<path d="' + d.join('') + '" fill="' + dark + '"/></svg>';
  }

  var api = { makeQR: makeQR, qrSvg: qrSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof window !== 'undefined' ? window : this);
