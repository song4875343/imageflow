/*
 * 颜色匹配算法（独立模块）
 * ------------------------------------------------------------------
 * 复刻 Photoshop「图像 > 调整 > 匹配颜色（Match Color）」的核心算法。
 *
 * Photoshop 的匹配颜色基于 Reinhard et al. 2001 论文
 * "Color Transfer between Images"：把“当前图层”的每个像素映射到“参考图层”
 * 在 CIE L*a*b* 颜色空间中的一阶统计量上，即让当前图层各通道的均值/标准差
 * 逼近参考图层，从而把参考图层的整体色调/光照迁移到当前图层：
 *
 *     out = (src - mean_src) * (std_ref / std_src) + mean_ref
 *
 * 这里在 CIE L*a*b* (D65) 空间按 L / a / b 三个通道分别做上述线性变换，
 * 并补充 Photoshop 面板里的：
 *   - 亮度（Luminance）：L 通道匹配强度，1 表示完整匹配；
 *   - 色彩强度（Color Intensity）：a / b 通道匹配强度；
 *   - 渐隐（Fade）：结果与原图按比例混合；
 *   - 中和（Neutralize）：把参考色偏拉向中性灰（a/b 均值置零）。
 *
 * 全部为纯函数，挂在 window.ColorMatch 上，便于单独测试与复用。
 */
(function (global) {
    'use strict';

    var ALPHA_MIN = 16;          // 低于此 alpha 视为透明，不参与统计/匹配
    var EPS = 1e-4;              // 标准差下限，避免除零
    var MAX_SAMPLES = 262144;    // 统计采样上限，避免大图卡顿

    // ---- sRGB <-> 线性 RGB（0-255 <-> 0-1） ----
    function srgbToLinear(c) {
        var v = c / 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }

    function linearToSrgb(c) {
        var v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
        v *= 255;
        return v < 0 ? 0 : v > 255 ? 255 : v;
    }

    // 线性 RGB(0-1) -> CIELAB(D65)，返回 [L, a, b]（L:0-100, a/b:约 -128..127）
    function linearRgbToLab(r, g, b) {
        var x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
        var y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
        var z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
        x = x > 0.008856 ? Math.cbrt(x) : (7.787 * x + 16 / 116);
        y = y > 0.008856 ? Math.cbrt(y) : (7.787 * y + 16 / 116);
        z = z > 0.008856 ? Math.cbrt(z) : (7.787 * z + 16 / 116);
        return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    }

    // CIELAB(D65) -> sRGB(0-255)，返回 [r, g, b]
    function labToSrgb(L, a, b) {
        var fy = (L + 16) / 116;
        var fx = fy + a / 500;
        var fz = fy - b / 200;
        var x3 = fx * fx * fx;
        var y3 = fy * fy * fy;
        var z3 = fz * fz * fz;
        var xr = x3 > 0.008856 ? x3 : (fx - 16 / 116) / 7.787;
        var yr = y3 > 0.008856 ? y3 : (fy - 16 / 116) / 7.787;
        var zr = z3 > 0.008856 ? z3 : (fz - 16 / 116) / 7.787;
        var x = xr * 0.95047;
        var y = yr;
        var z = zr * 1.08883;
        var r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
        var g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
        var bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
        return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(bl)];
    }

    function rgbToLab(r, g, b) {
        return linearRgbToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
    }

    function labToRgb(L, a, b) {
        var out = labToSrgb(L, a, b);
        return { r: Math.round(out[0]), g: Math.round(out[1]), b: Math.round(out[2]) };
    }

    // 预计算整图 LAB，供逐帧预览复用，避免重复做 cbrt。
    // 返回 Float32Array（每像素 3 个值）；透明像素置 0。
    function buildLabCache(imageData) {
        if (!imageData || !imageData.data) return null;
        var data = imageData.data;
        var total = imageData.width * imageData.height;
        var cache = new Float32Array(total * 3);
        for (var i = 0, p = 0; i < total; i += 1, p += 4) {
            if (data[p + 3] < ALPHA_MIN) continue;
            var lab = linearRgbToLab(
                srgbToLinear(data[p]),
                srgbToLinear(data[p + 1]),
                srgbToLinear(data[p + 2])
            );
            cache[i * 3] = lab[0];
            cache[i * 3 + 1] = lab[1];
            cache[i * 3 + 2] = lab[2];
        }
        return cache;
    }

    /*
     * 统计图像在 LAB 空间各通道的均值与标准差（总体标准差）。
     * options.selectionData：可选 RGBA 数组；仅统计 alpha>阈值 且被选中的像素。
     * options.maxSamples：采样上限。
     * 返回 {mean:{l,a,b}, std:{l,a,b}, count} 或 null。
     */
    function computeStats(imageData, options) {
        if (!imageData || !imageData.data) return null;
        options = options || {};
        var data = imageData.data;
        var total = imageData.width * imageData.height;
        if (!total) return null;
        var selection = options.selectionData || null;
        var maxSamples = options.maxSamples || MAX_SAMPLES;
        var step = Math.max(1, Math.floor(total / maxSamples));

        var n = 0, sl = 0, sa = 0, sb = 0, sl2 = 0, sa2 = 0, sb2 = 0;
        for (var i = 0; i < total; i += step) {
            var p = i * 4;
            if (data[p + 3] < ALPHA_MIN) continue;
            if (selection && selection[p + 3] < ALPHA_MIN) continue;
            var lab = linearRgbToLab(
                srgbToLinear(data[p]),
                srgbToLinear(data[p + 1]),
                srgbToLinear(data[p + 2])
            );
            sl += lab[0]; sa += lab[1]; sb += lab[2];
            sl2 += lab[0] * lab[0]; sa2 += lab[1] * lab[1]; sb2 += lab[2] * lab[2];
            n += 1;
        }
        if (!n) return null;
        var ml = sl / n, ma = sa / n, mb = sb / n;
        return {
            mean: { l: ml, a: ma, b: mb },
            std: {
                l: Math.sqrt(Math.max(0, sl2 / n - ml * ml)),
                a: Math.sqrt(Math.max(0, sa2 / n - ma * ma)),
                b: Math.sqrt(Math.max(0, sb2 / n - mb * mb))
            },
            count: n
        };
    }

    /*
     * 把 baseImageData 的颜色匹配到 refStats，结果写入 outData（可复用）。
     * srcLab 为可选预计算 LAB 缓存（buildLabCache 的返回值）。
     * 返回 Uint8ClampedArray（长度 = baseImageData.data.length）。
     */
    function matchInto(baseImageData, srcStats, refStats, options, outData, srcLab) {
        if (!baseImageData || !baseImageData.data) return null;
        var data = baseImageData.data;
        var total = baseImageData.width * baseImageData.height;
        var out = (outData && outData.length === data.length) ? outData : new Uint8ClampedArray(data.length);
        if (!srcStats || !refStats) { out.set(data); return out; }

        options = options || {};
        var luminance = options.luminance == null ? 1 : options.luminance;
        var colorIntensity = options.colorIntensity == null ? 1 : options.colorIntensity;
        var fade = options.fade == null ? 0 : options.fade;
        if (fade < 0) fade = 0; else if (fade > 1) fade = 1;
        var selection = options.selectionData || null;
        var labCache = (srcLab && srcLab.length === total * 3) ? srcLab : null;

        var sL = srcStats.std.l > EPS ? refStats.std.l / srcStats.std.l : 1;
        var sA = srcStats.std.a > EPS ? refStats.std.a / srcStats.std.a : 1;
        var sB = srcStats.std.b > EPS ? refStats.std.b / srcStats.std.b : 1;
        // 中和：把参考色的 a/b 均值拉向中性灰 0。
        var refMA = options.neutralize ? 0 : refStats.mean.a;
        var refMB = options.neutralize ? 0 : refStats.mean.b;

        // 强度缩放后仍是 LAB 各通道的仿射变换：out = coefA * in + coefB
        var cL = 1 + (sL - 1) * luminance;
        var dL = (refStats.mean.l - srcStats.mean.l * sL) * luminance;
        var cA = 1 + (sA - 1) * colorIntensity;
        var dA = (refMA - srcStats.mean.a * sA) * colorIntensity;
        var cB = 1 + (sB - 1) * colorIntensity;
        var dB = (refMB - srcStats.mean.b * sB) * colorIntensity;

        for (var i = 0, p = 0; i < total; i += 1, p += 4) {
            var alpha = data[p + 3];
            if (alpha < ALPHA_MIN || (selection && selection[p + 3] < ALPHA_MIN)) {
                out[p] = data[p]; out[p + 1] = data[p + 1]; out[p + 2] = data[p + 2]; out[p + 3] = alpha;
                continue;
            }
            var L, A, B;
            if (labCache) {
                L = labCache[i * 3]; A = labCache[i * 3 + 1]; B = labCache[i * 3 + 2];
            } else {
                var lab = linearRgbToLab(
                    srgbToLinear(data[p]),
                    srgbToLinear(data[p + 1]),
                    srgbToLinear(data[p + 2])
                );
                L = lab[0]; A = lab[1]; B = lab[2];
            }
            // LAB -> XYZ（内联，避免逐像素分配临时数组）
            var fy = (cL * L + dL + 16) / 116;
            var fx = fy + (cA * A + dA) / 500;
            var fz = fy - (cB * B + dB) / 200;
            var x3 = fx * fx * fx, y3 = fy * fy * fy, z3 = fz * fz * fz;
            var xr = x3 > 0.008856 ? x3 : (fx - 16 / 116) / 7.787;
            var yr = y3 > 0.008856 ? y3 : (fy - 16 / 116) / 7.787;
            var zr = z3 > 0.008856 ? z3 : (fz - 16 / 116) / 7.787;
            var X = xr * 0.95047, Y = yr, Z = zr * 1.08883;
            // XYZ -> 线性 sRGB -> 伽马编码
            var lr = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
            var lg = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
            var lb = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
            var sr = lr <= 0.0031308 ? 12.92 * lr : 1.055 * Math.pow(lr, 1 / 2.4) - 0.055;
            var sg = lg <= 0.0031308 ? 12.92 * lg : 1.055 * Math.pow(lg, 1 / 2.4) - 0.055;
            var sb = lb <= 0.0031308 ? 12.92 * lb : 1.055 * Math.pow(lb, 1 / 2.4) - 0.055;
            var r255 = sr * 255, g255 = sg * 255, b255 = sb * 255;
            if (r255 < 0) r255 = 0; else if (r255 > 255) r255 = 255;
            if (g255 < 0) g255 = 0; else if (g255 > 255) g255 = 255;
            if (b255 < 0) b255 = 0; else if (b255 > 255) b255 = 255;
            if (fade > 0) {
                var inv = 1 - fade;
                out[p] = r255 * inv + data[p] * fade;
                out[p + 1] = g255 * inv + data[p + 1] * fade;
                out[p + 2] = b255 * inv + data[p + 2] * fade;
            } else {
                out[p] = r255; out[p + 1] = g255; out[p + 2] = b255;
            }
            out[p + 3] = alpha;
        }
        return out;
    }

    /*
     * 便捷函数：将 baseImageData 匹配到 referenceImageData，返回新的 ImageData。
     */
    function match(baseImageData, referenceImageData, options) {
        var srcStats = computeStats(baseImageData, options);
        var refStats = computeStats(referenceImageData, options);
        if (!srcStats || !refStats) return null;
        var out = new Uint8ClampedArray(baseImageData.data.length);
        matchInto(baseImageData, srcStats, refStats, options, out, null);
        var result = new ImageData(baseImageData.width, baseImageData.height);
        result.data.set(out);
        return result;
    }

    global.ColorMatch = {
        ALPHA_MIN: ALPHA_MIN,
        rgbToLab: rgbToLab,
        labToRgb: labToRgb,
        buildLabCache: buildLabCache,
        computeStats: computeStats,
        matchInto: matchInto,
        match: match
    };
})(typeof window !== 'undefined' ? window : this);
