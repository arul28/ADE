// A QR code for the terminal, so a sign-in link can be scanned with a phone
// instead of typed. Byte mode, error correction level L, versions 1-10: enough
// for a URL of up to 271 bytes. A longer text gets no QR code, and the caller
// still prints the link as text.
//
// Written here, with no QR package, because the packaged CLI resolves its
// external packages from the desktop app's production dependencies.

const MAX_VERSION = 10;
/** Error correction codewords per block, level L, indexed by version. */
const EC_CODEWORDS_PER_BLOCK = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
/** Error correction blocks, level L, indexed by version. */
const EC_BLOCK_COUNT = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
/** The two format bits that name level L. */
const FORMAT_LEVEL_L = 1;
const QUIET_ZONE_MODULES = 2;

function rawCodewordCount(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignmentCount = Math.floor(version / 7) + 2;
    modules -= (25 * alignmentCount - 10) * alignmentCount - 55;
    if (version >= 7) modules -= 36;
  }
  return Math.floor(modules / 8);
}

function dataCodewordCount(version: number): number {
  return rawCodewordCount(version) - EC_CODEWORDS_PER_BLOCK[version] * EC_BLOCK_COUNT[version];
}

function characterCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let position = size - 7; positions.length < count; position -= step) {
    positions.splice(1, 0, position);
  }
  return positions;
}

function gfMultiply(left: number, right: number): number {
  let product = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((right >>> bit) & 1) * left;
  }
  return product;
}

function reedSolomonDivisor(degree: number): number[] {
  const divisor = new Array<number>(degree).fill(0);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      divisor[j] = gfMultiply(divisor[j], root);
      if (j + 1 < degree) divisor[j] ^= divisor[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return divisor;
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const remainder = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() as number);
    remainder.push(0);
    divisor.forEach((coefficient, index) => {
      remainder[index] ^= gfMultiply(coefficient, factor);
    });
  }
  return remainder;
}

function dataCodewords(bytes: Uint8Array, version: number): number[] {
  const capacityBits = dataCodewordCount(version) * 8;
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let bit = length - 1; bit >= 0; bit -= 1) bits.push((value >>> bit) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, characterCountBits(version));
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, capacityBits - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);

  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    codewords.push(bits.slice(index, index + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  return codewords;
}

function withErrorCorrection(data: number[], version: number): number[] {
  const blockCount = EC_BLOCK_COUNT[version];
  const ecLength = EC_CODEWORDS_PER_BLOCK[version];
  const rawCount = rawCodewordCount(version);
  const shortBlockCount = blockCount - (rawCount % blockCount);
  const shortDataLength = Math.floor(rawCount / blockCount) - ecLength;
  const divisor = reedSolomonDivisor(ecLength);

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let block = 0, offset = 0; block < blockCount; block += 1) {
    const length = shortDataLength + (block < shortBlockCount ? 0 : 1);
    const blockData = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(blockData);
    ecBlocks.push(reedSolomonRemainder(blockData, divisor));
  }

  const result: number[] = [];
  for (let index = 0; index <= shortDataLength; index += 1) {
    for (const block of dataBlocks) {
      if (index < block.length) result.push(block[index]);
    }
  }
  for (let index = 0; index < ecLength; index += 1) {
    for (const block of ecBlocks) result.push(block[index]);
  }
  return result;
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The standard's four penalty rules; the mask with the lowest total wins. */
function maskPenalty(modules: boolean[][]): number {
  const size = modules.length;
  let penalty = 0;
  const finderLike = [
    [true, false, true, true, true, false, true, false, false, false, false],
    [false, false, false, false, true, false, true, true, true, false, true],
  ];
  const lines = [
    ...modules,
    ...modules.map((_row, x) => modules.map((row) => row[x])),
  ];
  for (const line of lines) {
    for (let start = 0; start < size; ) {
      let end = start + 1;
      while (end < size && line[end] === line[start]) end += 1;
      if (end - start >= 5) penalty += 3 + (end - start - 5);
      start = end;
    }
    for (let start = 0; start + 11 <= size; start += 1) {
      for (const pattern of finderLike) {
        if (pattern.every((dark, offset) => line[start + offset] === dark)) penalty += 40;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) dark += 1;
      if (
        x + 1 < size
        && y + 1 < size
        && modules[y][x] === modules[y][x + 1]
        && modules[y][x] === modules[y + 1][x]
        && modules[y][x] === modules[y + 1][x + 1]
      ) {
        penalty += 3;
      }
    }
  }
  penalty += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return penalty;
}

/**
 * The QR code for `text` as rows of modules (`true` is dark), with no quiet
 * zone, or `null` when the text does not fit in a version 10 code.
 */
export function encodeQrModules(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (4 + characterCountBits(version) + bytes.length * 8 > dataCodewordCount(version) * 8) {
    version += 1;
    if (version > MAX_VERSION) return null;
  }
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFunction = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  for (let index = 0; index < size; index += 1) {
    setFunction(6, index, index % 2 === 0);
    setFunction(index, 6, index % 2 === 0);
  }
  for (const [centerX, centerY] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(centerX + dx, centerY + dy, distance !== 2 && distance !== 4);
      }
    }
  }
  const alignment = alignmentPositions(version);
  alignment.forEach((centerY, row) => {
    alignment.forEach((centerX, column) => {
      const last = alignment.length - 1;
      const onFinder = (row === 0 && column === 0) || (row === 0 && column === last) || (row === last && column === 0);
      if (onFinder) return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });

  const drawFormat = (mask: number) => {
    const data = (FORMAT_LEVEL_L << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (index: number) => ((bits >>> index) & 1) !== 0;
    for (let i = 0; i <= 5; i += 1) setFunction(8, i, bit(i));
    setFunction(8, 7, bit(6));
    setFunction(8, 8, bit(7));
    setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) setFunction(8, size - 15 + i, bit(i));
    setFunction(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }

  const codewords = withErrorCorrection(dataCodewords(bytes, version), version);
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (reserved[y][x] || bitIndex >= codewords.length * 8) continue;
        modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
        bitIndex += 1;
      }
    }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!reserved[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
      }
    }
  };
  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < MASKS.length; mask += 1) {
    applyMask(mask);
    drawFormat(mask);
    const penalty = maskPenalty(modules);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(mask);
  }
  applyMask(bestMask);
  drawFormat(bestMask);
  return modules;
}

/**
 * The QR code for `text` as terminal lines, two module rows per line, or
 * `null` when the text does not fit or the code is wider than `maxColumns`.
 *
 * With `color`, the code is drawn black on white whatever the terminal theme
 * is. Without it, the code assumes light text on a dark background.
 */
export function renderTerminalQr(
  text: string,
  options: { color?: boolean; maxColumns?: number } = {},
): string | null {
  const modules = encodeQrModules(text);
  if (!modules) return null;
  const width = modules.length + QUIET_ZONE_MODULES * 2;
  if (options.maxColumns != null && width > options.maxColumns) return null;
  const isDark = (x: number, y: number) =>
    modules[y - QUIET_ZONE_MODULES]?.[x - QUIET_ZONE_MODULES] === true;
  const color = options.color !== false;
  const lines: string[] = [];
  for (let y = 0; y < width; y += 2) {
    let line = "";
    for (let x = 0; x < width; x += 1) {
      // Colored: the glyph is the dark part. Plain: the glyph is the light
      // part, because the terminal's own text color is the light one.
      const top = isDark(x, y) === color;
      const bottom = (y + 1 < width ? isDark(x, y + 1) : false) === color;
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(color ? `\u001b[38;5;16;48;5;231m${line}\u001b[0m` : line);
  }
  return lines.join("\n");
}
