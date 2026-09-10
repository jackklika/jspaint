// @ts-check
// A small QR Code encoder (byte mode, error correction level L, versions 1–10, mask 0), enough for a share link.
// Pure: returns the module matrix; rendering is the caller's. Follows the ISO 18004 procedure the way Nayuki's
// reference implementation lays it out. Verified against a decoder in test/site-builder/qr.test.mjs.

// Error-correction codewords per block and number of blocks, level L, versions 1..10.
const ECC_PER_BLOCK = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const NUM_BLOCKS = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
const MAX_VERSION = 10;

/** @param {number} version */
function size_of(version) {
	return version * 4 + 17;
}

/** Number of data modules available (all modules minus function patterns), per the spec's formula. @param {number} version */
function raw_data_modules(version) {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const align = Math.floor(version / 7) + 2;
		result -= (25 * align - 10) * align - 55;
		if (version >= 7) { result -= 36; }
	}
	return result;
}

/** @param {number} version */
function data_codewords(version) {
	return Math.floor(raw_data_modules(version) / 8) - ECC_PER_BLOCK[version] * NUM_BLOCKS[version];
}

/** GF(256) multiply with the QR polynomial 0x11D. @param {number} x @param {number} y */
function gf_mul(x, y) {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11D);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xFF;
}

/** Reed-Solomon generator polynomial of the given degree. @param {number} degree */
function rs_divisor(degree) {
	const result = new Array(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = gf_mul(result[j], root);
			if (j + 1 < result.length) { result[j] ^= result[j + 1]; }
		}
		root = gf_mul(root, 0x02);
	}
	return result;
}

/** @param {number[]} data @param {number[]} divisor */
function rs_remainder(data, divisor) {
	const result = new Array(divisor.length).fill(0);
	for (const b of data) {
		const factor = b ^ result.shift();
		result.push(0);
		divisor.forEach((coef, i) => { result[i] ^= gf_mul(coef, factor); });
	}
	return result;
}

/**
 * Encodes text (UTF-8, byte mode) and returns the module grid: modules[y][x] is true for dark.
 * @param {string} text
 * @returns {boolean[][]}
 */
function qr_modules(text) {
	const bytes = [...new TextEncoder().encode(text)];
	let version = 1;
	while (version <= MAX_VERSION && 4 + (version >= 10 ? 16 : 8) + bytes.length * 8 > data_codewords(version) * 8) { version++; }
	if (version > MAX_VERSION) { throw new Error(`Too much text for a QR code here (${bytes.length} bytes)`); }
	const size = size_of(version);
	const capacity_bits = data_codewords(version) * 8;

	// Data bits: mode, count, bytes, terminator, padding
	/** @type {number[]} */
	const bits = [];
	const push_bits = (/** @type {number} */ value, /** @type {number} */ count) => { for (let i = count - 1; i >= 0; i--) { bits.push((value >>> i) & 1); } };
	push_bits(0x4, 4);
	push_bits(bytes.length, version >= 10 ? 16 : 8);
	for (const b of bytes) { push_bits(b, 8); }
	push_bits(0, Math.min(4, capacity_bits - bits.length));
	while (bits.length % 8 !== 0) { bits.push(0); }
	for (let pad = 0xEC; bits.length < capacity_bits; pad ^= 0xEC ^ 0x11) { push_bits(pad, 8); }
	/** @type {number[]} */
	const data = [];
	for (let i = 0; i < bits.length; i += 8) { data.push(parseInt(bits.slice(i, i + 8).join(""), 2)); }

	// Error correction: split into blocks, interleave
	const blocks_count = NUM_BLOCKS[version];
	const ecc_len = ECC_PER_BLOCK[version];
	const raw_codewords = Math.floor(raw_data_modules(version) / 8);
	const short_blocks = blocks_count - raw_codewords % blocks_count;
	const short_len = Math.floor(raw_codewords / blocks_count);
	/** @type {number[][]} */
	const blocks = [];
	const divisor = rs_divisor(ecc_len);
	for (let i = 0, k = 0; i < blocks_count; i++) {
		const dat = data.slice(k, k + short_len - ecc_len + (i < short_blocks ? 0 : 1));
		k += dat.length;
		const ecc = rs_remainder(dat, divisor);
		if (i < short_blocks) { dat.push(0); } // placeholder so all blocks have the long length
		blocks.push(dat.concat(ecc));
	}
	/** @type {number[]} */
	const codewords = [];
	for (let i = 0; i < blocks[0].length; i++) {
		blocks.forEach((block, j) => {
			if (i !== short_len - ecc_len || j >= short_blocks) { codewords.push(block[i]); }
		});
	}

	// Function patterns
	/** @type {boolean[][]} */
	const modules = Array.from({ length: size }, () => new Array(size).fill(false));
	/** @type {boolean[][]} */
	const is_function = Array.from({ length: size }, () => new Array(size).fill(false));
	const set = (/** @type {number} */ x, /** @type {number} */ y, /** @type {boolean} */ dark) => { modules[y][x] = dark; is_function[y][x] = true; };
	for (let i = 0; i < size; i++) {
		set(6, i, i % 2 === 0);
		set(i, 6, i % 2 === 0);
	}
	const finder = (/** @type {number} */ cx, /** @type {number} */ cy) => {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const x = cx + dx, y = cy + dy;
				if (x < 0 || y < 0 || x >= size || y >= size) { continue; }
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				set(x, y, dist !== 2 && dist !== 4);
			}
		}
	};
	finder(3, 3);
	finder(size - 4, 3);
	finder(3, size - 4);
	// Alignment patterns
	/** @type {number[]} */
	let align_positions = [];
	if (version > 1) {
		const count = Math.floor(version / 7) + 2;
		const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
		align_positions = [6];
		for (let pos = size - 7; align_positions.length < count; pos -= step) { align_positions.splice(1, 0, pos); }
	}
	for (let i = 0; i < align_positions.length; i++) {
		for (let j = 0; j < align_positions.length; j++) {
			if ((i === 0 && j === 0) || (i === 0 && j === align_positions.length - 1) || (i === align_positions.length - 1 && j === 0)) { continue; }
			for (let dy = -2; dy <= 2; dy++) {
				for (let dx = -2; dx <= 2; dx++) {
					set(align_positions[i] + dx, align_positions[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
				}
			}
		}
	}
	// Format information (level L = 01, mask 0), both copies, plus the dark module
	const draw_format = () => {
		const data_bits = (1 << 3) | 0;
		let rem = data_bits;
		for (let i = 0; i < 10; i++) { rem = (rem << 1) ^ ((rem >>> 9) * 0x537); }
		const format = ((data_bits << 10) | rem) ^ 0x5412;
		const bit = (/** @type {number} */ i) => ((format >>> i) & 1) === 1;
		for (let i = 0; i <= 5; i++) { set(8, i, bit(i)); }
		set(8, 7, bit(6));
		set(8, 8, bit(7));
		set(7, 8, bit(8));
		for (let i = 9; i < 15; i++) { set(14 - i, 8, bit(i)); }
		for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, bit(i)); }
		for (let i = 8; i < 15; i++) { set(8, size - 15 + i, bit(i)); }
		set(8, size - 8, true);
	};
	draw_format();
	// Version information (versions 7 and up)
	if (version >= 7) {
		let rem = version;
		for (let i = 0; i < 12; i++) { rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25); }
		const info = (version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const dark = ((info >>> i) & 1) === 1;
			const a = size - 11 + (i % 3), b = Math.floor(i / 3);
			set(a, b, dark);
			set(b, a, dark);
		}
	}

	// Data placement (zigzag), with mask 0 applied
	let bit_index = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) { right = 5; }
		for (let vert = 0; vert < size; vert++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - vert : vert;
				if (!is_function[y][x] && bit_index < codewords.length * 8) {
					let dark = ((codewords[bit_index >>> 3] >>> (7 - (bit_index & 7))) & 1) === 1;
					if ((x + y) % 2 === 0) { dark = !dark; } // mask 0
					modules[y][x] = dark;
					bit_index++;
				} else if (!is_function[y][x] && (x + y) % 2 === 0) {
					modules[y][x] = true; // remainder bits are 0, masked
				}
			}
		}
	}
	return modules;
}

/**
 * Draws a QR code onto a canvas, with a quiet zone.
 * @param {boolean[][]} modules
 * @param {number} [scale] - px per module
 * @returns {HTMLCanvasElement}
 */
function render_qr_canvas(modules, scale = 4) {
	const quiet = 4;
	const size = (modules.length + quiet * 2) * scale;
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, size, size);
	ctx.fillStyle = "#000";
	modules.forEach((row, y) => {
		row.forEach((dark, x) => {
			if (dark) { ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale); }
		});
	});
	return canvas;
}

export { qr_modules, render_qr_canvas };
