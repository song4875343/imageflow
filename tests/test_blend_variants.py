import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image


sys.path.insert(0, str(Path(__file__).parents[1] / "image_eidt"))
import image_edit


def sample_images(size=(96, 96)):
    width, height = size
    x = np.linspace(40, 180, width, dtype=np.float32)
    y = np.linspace(0, 35, height, dtype=np.float32)[:, None]
    base = np.stack(
        [
            np.broadcast_to(x, (height, width)) + y,
            np.broadcast_to(x[::-1], (height, width)) * 0.7 + y,
            np.full((height, width), 105.0) + y,
        ],
        axis=2,
    )
    base = np.clip(base, 0, 255).astype(np.uint8)
    generated = base.copy()
    generated[24:72, 24:72] = np.clip(
        generated[24:72, 24:72].astype(np.int16) + (28, -12, 18), 0, 255
    )
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[28:68, 28:68] = 255
    return Image.fromarray(base), Image.fromarray(generated), Image.fromarray(mask)


class BlendVariantTests(unittest.TestCase):
    def test_all_hybrid_pipelines_return_the_original_size(self):
        base, generated, mask = sample_images()
        patch_image = generated.crop((24, 24, 72, 72))

        for method, _, pipeline in image_edit.BLEND_PIPELINES:
            with self.subTest(method=method):
                result = pipeline(
                    base,
                    patch_image,
                    (24, 24, 72, 72),
                    selection_mask=mask,
                )
                self.assertEqual(base.size, result.size)
                self.assertEqual(
                    tuple(np.asarray(base)[0, 0]), tuple(np.asarray(result)[0, 0])
                )

    def test_local_generation_expands_one_model_result_to_three_variants(self):
        base, generated, mask = sample_images()
        with patch.object(image_edit, "edit_patch", return_value=[generated]):
            results = image_edit.generate_correction_overlay(
                base,
                (24, 24, 72, 72),
                prompt="replace the selected area",
                model="test-model",
                selection_mask=mask,
            )

        self.assertEqual(3, len(results))
        self.assertEqual(
            [method for method, _, _ in image_edit.BLEND_PIPELINES],
            [item[2] for item in results],
        )
        self.assertEqual(3, len({item[3] for item in results}))
        self.assertTrue(all(item[4] == 1 for item in results))

    def test_masked_full_image_generation_returns_unaligned_aligned_and_confidence_variants(self):
        base, generated, mask = sample_images()
        with patch.object(image_edit, "edit_patch", return_value=[generated]):
            results = image_edit.generate_correction_overlay(
                base,
                (0, 0, base.width, base.height),
                prompt="edit the masked area",
                model="test-model",
                selection_mask=mask,
                full_image_edit=True,
            )

        self.assertEqual(3, len(results))
        self.assertEqual(
            ["full_original", "pre_alignment", "confidence"],
            [item[2] for item in results],
        )
        self.assertTrue(all(item[5] for item in results))

    def test_alignment_uses_protected_pixels_to_remove_small_translation(self):
        rng = np.random.default_rng(7)
        source_array = rng.integers(0, 256, (96, 96, 3), dtype=np.uint8)
        shifted = image_edit.cv2.warpAffine(
            source_array,
            np.float32([[1, 0, 3], [0, 1, -2]]),
            (96, 96),
            borderMode=image_edit.cv2.BORDER_REFLECT_101,
        )
        mask = np.zeros((96, 96), dtype=np.uint8)
        mask[32:64, 32:64] = 255
        aligned = image_edit.align_generated_to_source(
            Image.fromarray(source_array), Image.fromarray(shifted), Image.fromarray(mask)
        )
        error = np.abs(np.asarray(aligned).astype(np.int16) - source_array.astype(np.int16))
        self.assertLess(float(np.median(error)), 2.0)

    def test_masked_full_image_direct_thumbnail_uses_aligned_result(self):
        rng = np.random.default_rng(11)
        source_array = rng.integers(0, 256, (96, 96, 3), dtype=np.uint8)
        shifted = image_edit.cv2.warpAffine(
            source_array,
            np.float32([[1, 0, -4], [0, 1, 3]]),
            (96, 96),
            borderMode=image_edit.cv2.BORDER_REFLECT_101,
        )
        mask_array = np.zeros((96, 96), dtype=np.uint8)
        mask_array[32:64, 32:64] = 255
        source = Image.fromarray(source_array)
        mask = Image.fromarray(mask_array)
        with patch.object(image_edit, "edit_patch", return_value=[Image.fromarray(shifted)]):
            results = image_edit.generate_correction_overlay(
                source,
                (0, 0, 96, 96),
                prompt="edit the masked area",
                model="test-model",
                selection_mask=mask,
                full_image_edit=True,
            )

        aligned_result = next(item[0] for item in results if item[2] == "full_original")
        direct = np.asarray(aligned_result.convert("RGB"))
        error = np.abs(direct.astype(np.int16) - source_array.astype(np.int16))
        self.assertLessEqual(float(np.median(error[mask_array == 0])), 2.0)

    def test_size_mismatch_composite_uses_alignment_and_confidence_fusion(self):
        rng = np.random.default_rng(19)
        source_array = rng.integers(0, 256, (96, 96, 3), dtype=np.uint8)
        shifted = image_edit.cv2.warpAffine(
            source_array,
            np.float32([[1, 0, 3], [0, 1, 2]]),
            (96, 96),
            borderMode=image_edit.cv2.BORDER_REFLECT_101,
        )
        mask_array = np.zeros((96, 96), dtype=np.uint8)
        mask_array[32:64, 32:64] = 255
        result = image_edit.composite_aligned_selection_result(
            Image.fromarray(source_array),
            Image.fromarray(shifted),
            Image.fromarray(mask_array),
            target_size=(96, 96),
        )
        error = np.abs(np.asarray(result).astype(np.int16) - source_array.astype(np.int16))
        self.assertLessEqual(float(np.median(error[mask_array == 0])), 2.0)

    def test_confidence_patch_layer_is_limited_by_mask_and_source_alpha(self):
        base, _, mask = sample_images()
        source = Image.new("RGBA", base.size, (0, 0, 0, 0))
        source.paste((230, 45, 80, 255), (20, 20, 55, 55))

        result, _ = image_edit.confidence_patch_layer(base, source, mask)

        alpha = np.asarray(result.getchannel("A"))
        effective = np.minimum(
            np.asarray(mask),
            np.asarray(source.getchannel("A")),
        )
        self.assertIsNotNone(result.getbbox())
        self.assertTrue(np.all(alpha[effective == 0] == 0))

    def test_confidence_patch_layer_rejects_non_overlapping_source(self):
        base, _, mask = sample_images()
        source = Image.new("RGBA", base.size, (0, 0, 0, 0))
        source.paste((230, 45, 80, 255), (0, 0, 12, 12))

        with self.assertRaisesRegex(ValueError, "没有重叠区域"):
            image_edit.confidence_patch_layer(base, source, mask)


if __name__ == "__main__":
    unittest.main()
