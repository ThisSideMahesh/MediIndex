/**
 * Compact, zero-dependency QR Code (Model 2) Matrix Generator & SVG Renderer
 * Implements ISO/IEC 18004 standard QR Code generation in pure Vanilla JavaScript.
 */
(function (global) {
  // Mode indicators
  const MODE_BYTE = 4;
  const ECC_M = 0; // Error correction Medium (15% recovery)

  // GF(256) tables for Reed-Solomon encoding
  const EXP_TABLE = new Uint8Array(256);
  const LOG_TABLE = new Uint8Array(256);
  for (let i = 0, x = 1; i < 256; i++) {
    EXP_TABLE[i] = x;
    LOG_TABLE[x] = i;
    x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
  }

  function gfMul(x, y) {
    if (x === 0 || y === 0) return 0;
    return EXP_TABLE[(LOG_TABLE[x] + LOG_TABLE[y]) % 255];
  }

  function rsGenPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      const root = EXP_TABLE[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= gfMul(poly[j], root);
        next[j + 1] ^= poly[j];
      }
      poly = next;
    }
    return poly;
  }

  function rsCompute(data, eccLength) {
    const poly = rsGenPoly(eccLength);
    const result = new Array(eccLength).fill(0);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ result[0];
      for (let j = 0; j < eccLength - 1; j++) {
        result[j] = result[j + 1] ^ gfMul(poly[j + 1], factor);
      }
      result[eccLength - 1] = gfMul(poly[eccLength], factor);
    }
    return result;
  }

  // Version 2 QR Code (25x25 matrix, up to 32 bytes with ECC Medium)
  // Version 3 QR Code (29x29 matrix, up to 55 bytes with ECC Medium)
  // Version 4 QR Code (33x33 matrix, up to 80 bytes with ECC Medium)
  // Version 5 QR Code (37x37 matrix, up to 108 bytes with ECC Medium)
  const VERSIONS = [
    null,
    { version: 1, size: 21, dataBytes: 16, eccBytes: 10, align: [] },
    { version: 2, size: 25, dataBytes: 28, eccBytes: 16, align: [6, 18] },
    { version: 3, size: 29, dataBytes: 44, eccBytes: 26, align: [6, 22] },
    { version: 4, size: 33, dataBytes: 64, eccBytes: 36, align: [6, 26] },
    { version: 5, size: 37, dataBytes: 86, eccBytes: 48, align: [6, 30] },
    { version: 6, size: 41, dataBytes: 108, eccBytes: 60, align: [6, 34] }
  ];

  function chooseVersion(byteCount) {
    for (let v = 1; v < VERSIONS.length; v++) {
      if (VERSIONS[v].dataBytes >= byteCount + 3) return VERSIONS[v];
    }
    return VERSIONS[VERSIONS.length - 1];
  }

  function createMatrix(size) {
    return Array.from({ length: size }, () => Array(size).fill(null));
  }

  function placeFinder(matrix, r, c) {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const row = r + i, col = c + j;
        if (row < 0 || row >= matrix.length || col < 0 || col >= matrix.length) continue;
        if ((i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6)) || (i >= 2 && i <= 4 && j >= 2 && j <= 4)) {
          matrix[row][col] = 1;
        } else {
          matrix[row][col] = 0;
        }
      }
    }
  }

  function placeAlignment(matrix, r, c) {
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        if (Math.abs(i) === 2 || Math.abs(j) === 2 || (i === 0 && j === 0)) {
          matrix[r + i][c + j] = 1;
        } else {
          matrix[r + i][c + j] = 0;
        }
      }
    }
  }

  function generateQRMatrix(text) {
    const utf8Bytes = new TextEncoder().encode(text);
    const ver = chooseVersion(utf8Bytes.length);
    const size = ver.size;
    const matrix = createMatrix(size);

    // 1. Finder patterns
    placeFinder(matrix, 0, 0);
    placeFinder(matrix, 0, size - 7);
    placeFinder(matrix, size - 7, 0);

    // 2. Timing patterns
    for (let i = 8; i < size - 8; i++) {
      matrix[6][i] = (i % 2 === 0) ? 1 : 0;
      matrix[i][6] = (i % 2 === 0) ? 1 : 0;
    }

    // 3. Alignment patterns (version >= 2)
    if (ver.align.length > 0) {
      for (const r of ver.align) {
        for (const c of ver.align) {
          if (matrix[r][c] === null) placeAlignment(matrix, r, c);
        }
      }
    }

    // 4. Dark module
    matrix[size - 8][8] = 1;

    // 5. Build data bitstream
    const bitstream = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bitstream.push((val >> i) & 1);
    };

    // Mode: Byte (4)
    pushBits(MODE_BYTE, 4);
    // Count (8 bits for ver 1-9)
    pushBits(utf8Bytes.length, 8);
    // Data
    for (const b of utf8Bytes) pushBits(b, 8);
    // Terminator
    for (let i = 0; i < 4 && bitstream.length < ver.dataBytes * 8; i++) bitstream.push(0);
    // Align to byte
    while (bitstream.length % 8 !== 0) bitstream.push(0);
    // Pad bytes
    const padBytes = [0xec, 0x11];
    let padIdx = 0;
    while (bitstream.length < ver.dataBytes * 8) {
      pushBits(padBytes[padIdx % 2], 8);
      padIdx++;
    }

    // 6. Convert bitstream to bytes & calculate Reed-Solomon ECC
    const rawBytes = [];
    for (let i = 0; i < bitstream.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bitstream[i + j];
      rawBytes.push(b);
    }
    const eccBytes = rsCompute(rawBytes, ver.eccBytes);
    const finalBytes = rawBytes.concat(eccBytes);

    const allBits = [];
    for (const b of finalBytes) {
      for (let i = 7; i >= 0; i--) allBits.push((b >> i) & 1);
    }

    // 7. Place data into matrix (Mask 0: (row + col) % 2 == 0)
    let bitIdx = 0;
    let upward = true;
    for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right--; // Skip vertical timing column
      const cols = [right, right - 1];
      const rows = upward ? Array.from({ length: size }, (_, i) => size - 1 - i) : Array.from({ length: size }, (_, i) => i);

      for (const r of rows) {
        for (const c of cols) {
          if (matrix[r][c] === null) {
            let bit = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
            // Apply Mask 0: flip if (r + c) % 2 === 0
            if ((r + c) % 2 === 0) bit ^= 1;
            matrix[r][c] = bit;
          }
        }
      }
      upward = !upward;
    }

    // 8. Add Format Info for ECC Medium + Mask 0 (Format string 0x5412)
    const formatBits = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0];
    for (let i = 0; i < 6; i++) matrix[8][i] = formatBits[i];
    matrix[8][7] = formatBits[6];
    matrix[8][8] = formatBits[7];
    matrix[7][8] = formatBits[8];
    for (let i = 9; i < 15; i++) matrix[14 - i][8] = formatBits[i];

    for (let i = 0; i < 8; i++) matrix[size - 1 - i][8] = formatBits[i];
    for (let i = 8; i < 15; i++) matrix[8][size - 15 + i] = formatBits[i];

    return matrix;
  }

  function renderSVG(matrix, cellSize = 6, margin = 4) {
    const size = matrix.length;
    const totalSize = (size + margin * 2) * cellSize;
    let rects = '';

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (matrix[r][c] === 1) {
          const x = (c + margin) * cellSize;
          const y = (r + margin) * cellSize;
          rects += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="#102a43" />`;
        }
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="100%" height="100%" shape-rendering="crispEdges">
      <rect width="${totalSize}" height="${totalSize}" fill="#ffffff" />
      ${rects}
    </svg>`;
  }

  global.QRCodeGenerator = {
    generateSVG(text, cellSize = 5) {
      try {
        const matrix = generateQRMatrix(text);
        return renderSVG(matrix, cellSize, 3);
      } catch (err) {
        console.error('QR Generation failed:', err);
        return `<div class="error">QR Generation error: ${err.message}</div>`;
      }
    }
  };
})(window);
