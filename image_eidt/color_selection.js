/*
 * 颜色选区算法（独立模块）
 * ------------------------------------------------------------------
 * 图片编辑模块调用：对图片层内容自动判断“文字颜色”（这类图片通常是
 * 背景 + 文字），再按 Photoshop 魔棒的默认容差（32）建立颜色选区，
 * 并做适度外扩以覆盖文字抗锯齿边缘。若自动判断不准，可在外层用吸管
 * 拾取目标颜色后重新调用 buildColorMask。
 *
 * 全部为纯函数，挂在 window.ColorSelection 上，方便单独测试与复用。
 */
(function (global) {
    'use strict';

    var DEFAULT_TOLERANCE = 32;   // Photoshop 魔棒默认容差
    var DEFAULT_EXPAND = 1;       // 默认外扩像素
    var FOREGROUND_THRESHOLD = 48; // 判定“与背景明显不同”的门限
    var ALPHA_MIN = 16;           // 低于此 alpha 视为透明，不参与统计

    var BINS_PER_CHANNEL = 32;    // 每通道量化等级（5 bit）
    var BIN_COUNT = BINS_PER_CHANNEL * BINS_PER_CHANNEL * BINS_PER_CHANNEL;
    var SHIFT = 3;                // 每通道右移位数

    function clampByte(value) {
        return value < 0 ? 0 : value > 255 ? 255 : value;
    }

    // 每个通道取最大差值：与 Photoshop 魔棒容差的直觉一致（0-255）。
    function colorDistance(r, g, b, color) {
        var dr = r - color.r;
        var dg = g - color.g;
        var db = b - color.b;
        if (dr < 0) dr = -dr;
        if (dg < 0) dg = -dg;
        if (db < 0) db = -db;
        return dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
    }

    function quantize(r, g, b) {
        return ((r >> SHIFT) * BINS_PER_CHANNEL + (g >> SHIFT)) * BINS_PER_CHANNEL + (b >> SHIFT);
    }

    function createHistogram() {
        return {
            count: new Uint32Array(BIN_COUNT),
            sumR: new Float64Array(BIN_COUNT),
            sumG: new Float64Array(BIN_COUNT),
            sumB: new Float64Array(BIN_COUNT)
        };
    }

    function histogramPeak(hist) {
        var bin = -1;
        var best = -1;
        for (var i = 0; i < BIN_COUNT; i += 1) {
            if (hist.count[i] > best) {
                best = hist.count[i];
                bin = i;
            }
        }
        return bin;
    }

    function histogramColor(hist, bin) {
        var count = hist.count[bin] || 1;
        return {
            r: hist.sumR[bin] / count,
            g: hist.sumG[bin] / count,
            b: hist.sumB[bin] / count
        };
    }

    /*
     * 估计文字颜色。
     * 思路：出现次数最多的颜色簇视为背景；再统计“与背景差异明显”的像素，
     * 其中出现次数最多的颜色簇视为文字颜色。返回 {r,g,b} 或 null。
     */
    function detectTextColor(imageData, options) {
        if (!imageData || !imageData.data) return null;
        options = options || {};
        var data = imageData.data;
        var total = imageData.width * imageData.height;
        if (!total) return null;
        var step = Math.max(1, Math.floor(total / 262144)); // 大图采样，避免卡顿
        var threshold = options.foregroundThreshold || FOREGROUND_THRESHOLD;

        var bgHist = createHistogram();
        var i, p, a, r, g, b, bin, sampled = 0;
        for (i = 0; i < total; i += step) {
            p = i * 4;
            a = data[p + 3];
            if (a < ALPHA_MIN) continue;
            r = data[p]; g = data[p + 1]; b = data[p + 2];
            bin = quantize(r, g, b);
            bgHist.count[bin] += 1;
            bgHist.sumR[bin] += r;
            bgHist.sumG[bin] += g;
            bgHist.sumB[bin] += b;
            sampled += 1;
        }
        if (!sampled) return null;

        var bgBin = histogramPeak(bgHist);
        if (bgBin < 0) return null;
        var bg = histogramColor(bgHist, bgBin);

        var fgHist = createHistogram();
        var fgSampled = 0;
        for (i = 0; i < total; i += step) {
            p = i * 4;
            a = data[p + 3];
            if (a < ALPHA_MIN) continue;
            r = data[p]; g = data[p + 1]; b = data[p + 2];
            if (colorDistance(r, g, b, bg) < threshold) continue;
            bin = quantize(r, g, b);
            fgHist.count[bin] += 1;
            fgHist.sumR[bin] += r;
            fgHist.sumG[bin] += g;
            fgHist.sumB[bin] += b;
            fgSampled += 1;
        }
        if (!fgSampled) {
            // 整张图接近纯色：退化为背景色本身。
            return { r: clampByte(Math.round(bg.r)), g: clampByte(Math.round(bg.g)), b: clampByte(Math.round(bg.b)) };
        }

        var fgBin = histogramPeak(fgHist);
        if (fgBin < 0) return null;
        var fg = histogramColor(fgHist, fgBin);
        return { r: clampByte(Math.round(fg.r)), g: clampByte(Math.round(fg.g)), b: clampByte(Math.round(fg.b)) };
    }

    /*
     * 建立颜色选区：返回 Uint8ClampedArray，选中为 255，未选中为 0。
     */
    function buildColorMask(imageData, target, tolerance) {
        if (!imageData || !imageData.data || !target) return null;
        var limit = tolerance == null ? DEFAULT_TOLERANCE : Math.max(0, Math.min(255, Math.round(tolerance)));
        var data = imageData.data;
        var total = imageData.width * imageData.height;
        var mask = new Uint8ClampedArray(total);
        for (var i = 0; i < total; i += 1) {
            var p = i * 4;
            if (data[p + 3] < ALPHA_MIN) continue;
            if (colorDistance(data[p], data[p + 1], data[p + 2], target) <= limit) mask[i] = 255;
        }
        return mask;
    }

    /*
     * 形态学外扩（膨胀），用于把文字选区适当扩大，覆盖抗锯齿边缘。
     * 返回新的 mask，不修改入参。
     */
    function dilateMask(mask, width, height, radius) {
        var r = Math.max(0, Math.min(8, Math.round(radius || 0)));
        if (!mask || !r) return mask;
        if (!width || !height) return mask;
        var out = new Uint8ClampedArray(mask.length);
        for (var y = 0; y < height; y += 1) {
            for (var x = 0; x < width; x += 1) {
                var idx = y * width + x;
                if (mask[idx]) { out[idx] = 255; continue; }
                var found = false;
                for (var dy = -r; dy <= r && !found; dy += 1) {
                    var ny = y + dy;
                    if (ny < 0 || ny >= height) continue;
                    var rowBase = ny * width;
                    for (var dx = -r; dx <= r; dx += 1) {
                        var nx = x + dx;
                        if (nx < 0 || nx >= width) continue;
                        if (mask[rowBase + nx]) { found = true; break; }
                    }
                }
                if (found) out[idx] = 255;
            }
        }
        return out;
    }

    function countSelected(mask) {
        if (!mask) return 0;
        var n = 0;
        for (var i = 0; i < mask.length; i += 1) if (mask[i]) n += 1;
        return n;
    }

    global.ColorSelection = {
        DEFAULT_TOLERANCE: DEFAULT_TOLERANCE,
        DEFAULT_EXPAND: DEFAULT_EXPAND,
        colorDistance: colorDistance,
        detectTextColor: detectTextColor,
        buildColorMask: buildColorMask,
        dilateMask: dilateMask,
        countSelected: countSelected
    };
})(typeof window !== 'undefined' ? window : this);
