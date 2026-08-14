import base64
import io
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image


sys.modules.setdefault(
    "cv2",
    SimpleNamespace(
        magnitude=lambda *args: None,
        Sobel=lambda *args, **kwargs: None,
        CV_32F=0,
    ),
)
sys.modules.setdefault("requests", SimpleNamespace())
sys.path.insert(0, str(Path(__file__).parents[1] / "image_eidt"))
import image_edit


def encoded_png(color, size=(32, 32)):
    stream = io.BytesIO()
    Image.new("RGB", size, color).save(stream, "PNG")
    return base64.b64encode(stream.getvalue()).decode("ascii")


class FakeGptImages:
    def __init__(self):
        self.calls = []

    def edit(self, **kwargs):
        source = kwargs["image"]
        source = source[0] if isinstance(source, list) else source
        self.calls.append((kwargs["n"], len(source.read()), len(kwargs["mask"].read())))
        if kwargs["n"] == 2:
            return SimpleNamespace(
                data=[
                    SimpleNamespace(b64_json=encoded_png("red")),
                    SimpleNamespace(b64_json=None),
                ]
            )
        return SimpleNamespace(data=[SimpleNamespace(b64_json=encoded_png("blue"))])


class FakeChatCompletions:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs["n"])
        urls = [
            f"data:image/png;base64,{encoded_png('red')}",
            f"data:image/png;base64,{encoded_png('blue')}",
        ]
        return SimpleNamespace(model_dump=lambda: {"choices": urls})


class SingleOnlyChatCompletions:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs["n"])
        if kwargs["n"] > 1:
            raise ValueError("n is not supported")
        color = "red" if self.calls.count(1) == 1 else "blue"
        url = f"data:image/png;base64,{encoded_png(color)}"
        return SimpleNamespace(model_dump=lambda: {"choices": [url]})


class WrongRatioGeminiCompletions:
    def create(self, **kwargs):
        url = f"data:image/png;base64,{encoded_png('red', (1376, 768))}"
        return SimpleNamespace(model_dump=lambda: {"choices": [url]})


class MultiImageGenerationTests(unittest.TestCase):
    def test_gemini_native_size_mapping(self):
        self.assertEqual((1200, 896), image_edit.gemini_output_size("1K", "4:3"))
        self.assertEqual((1376, 768), image_edit.gemini_output_size("1K", "16:9"))

    def test_gpt_tops_up_using_decoded_image_count_and_rewinds_files(self):
        images_api = FakeGptImages()
        client = SimpleNamespace(images=images_api)
        config = {
            "id": "provider::gpt-image-2",
            "model": "gpt-image-2",
            "baseurl": "https://example.test/v1",
        }
        with patch.object(image_edit, "get_model_config", return_value=config), patch.object(
            image_edit, "_model_client", return_value=client
        ):
            results = image_edit.edit_patch_gpt(
                Image.new("RGB", (32, 32)), model=config["id"], count=2
            )

        self.assertEqual(2, len(results))
        self.assertEqual([2, 1], [call[0] for call in images_api.calls])
        self.assertTrue(all(source_bytes > 0 for _, source_bytes, _ in images_api.calls))
        self.assertTrue(all(mask_bytes > 0 for _, _, mask_bytes in images_api.calls))

    def test_legacy_uses_one_request_when_batch_response_contains_all_images(self):
        completions = FakeChatCompletions()
        client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
        config = {
            "id": "provider::nano-banana",
            "model": "nano-banana",
            "baseurl": "https://example.test/v1",
        }
        with patch.object(image_edit, "get_model_config", return_value=config), patch.object(
            image_edit, "_model_client", return_value=client
        ):
            results = image_edit.edit_patch_legacy(
                Image.new("RGB", (32, 32)), model=config["id"], count=2
            )

        self.assertEqual(2, len(results))
        self.assertEqual([2], completions.calls)

    def test_legacy_falls_back_to_single_requests_when_batch_is_unsupported(self):
        completions = SingleOnlyChatCompletions()
        client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
        config = {
            "id": "provider::nano-banana",
            "model": "nano-banana",
            "baseurl": "https://example.test/v1",
        }
        with patch.object(image_edit, "get_model_config", return_value=config), patch.object(
            image_edit, "_model_client", return_value=client
        ):
            results = image_edit.edit_patch_legacy(
                Image.new("RGB", (32, 32)), model=config["id"], count=2
            )

        self.assertEqual(2, len(results))
        self.assertEqual([2, 1, 1], completions.calls)

    def test_gemini_validates_against_ratio_instead_of_frontend_pixel_size(self):
        completions = WrongRatioGeminiCompletions()
        client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
        config = {
            "id": "provider::gemini-image",
            "model": "gemini-image",
            "baseurl": "https://example.test/v1",
        }
        with patch.object(image_edit, "get_model_config", return_value=config), patch.object(
            image_edit, "_model_client", return_value=client
        ), self.assertRaises(image_edit.OutputSizeMismatch) as raised:
            image_edit.edit_patch_legacy(
                Image.new("RGB", (32, 32)),
                model=config["id"],
                output_size=(1376, 768),
                generation_options={"image_size": "1K", "aspect_ratio": "4:3"},
            )

        self.assertEqual((1200, 896), raised.exception.requested_size)
        self.assertEqual((1376, 768), raised.exception.actual_size)


if __name__ == "__main__":
    unittest.main()
