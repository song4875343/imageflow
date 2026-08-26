try:
    from openai import OpenAI
except ImportError:
    OpenAI = None
import base64
import importlib.util
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
from io import BytesIO
from pathlib import Path

import cv2
import numpy as np
import requests
from PIL import Image, ImageChops


INPUT_FOLDER = "img_input"
OUTPUT_FOLDER = "img"
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif")
FEATHER_PIXELS = 6
ALIGNMENT_BAND_RATIO = 0.015
ALIGNMENT_BAND_MIN = 8
ALIGNMENT_BAND_MAX = 32
PYRAMID_LEVELS = 4
MATCH_SCALES = (1.0, 0.95, 1.05, 0.90, 1.10, 0.85, 1.15, 0.80, 1.20)
MIN_MATCH_CONFIDENCE = 0.80


class OutputSizeMismatch(RuntimeError):
    def __init__(self, image, requested_size, actual_size, baseurl, images=None):
        self.image = image
        self.images = list(images or [image])
        self.requested_size = tuple(requested_size)
        self.actual_size = tuple(actual_size)
        self.baseurl = baseurl
        super().__init__(
            f"模型接口返回尺寸不一致：请求 {self.requested_size[0]}×{self.requested_size[1]}，"
            f"实际 {self.actual_size[0]}×{self.actual_size[1]}。"
        )


MODEL_CONFIG_PATH = Path(__file__).with_name("image_models.json")
TEXT_TO_IMAGE_MODELS = {
    "qwen/qwen-image-2512",
    "tongyi-mai/z-image-turbo",
}

GEMINI_1K_SIZES = {
    "1:1": (1024, 1024),
    "2:3": (848, 1264),
    "3:2": (1264, 848),
    "3:4": (896, 1200),
    "4:3": (1200, 896),
    "9:16": (768, 1376),
    "16:9": (1376, 768),
    "21:9": (1584, 672),
}

PATCH_PROMPT = (
    "Edit this image crop and return the complete crop without any text. Remove every visible "
    "or faint title, body character, number, punctuation mark, and partial glyph. Reconstruct "
    "the exact background behind the text. Preserve the existing panel, blur, colors, lighting, "
    "texture, framing, and sharpness. Do not add text, symbols, lines, objects, gradients, "
    "sharpening, denoising, or redesign the image."
)


UNSET_PROVIDER = "未设置"

WEBRIDGE_SITES = {
    "gemini": "Gemini",
    "chatgpt": "ChatGPT",
}
DEFAULT_WEBRIDGE_SITE = "gemini"


def _webridge_config_payload():
    try:
        payload = json.loads(MODEL_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if isinstance(payload, list):
        payload = {"models": payload}
    return payload if isinstance(payload, dict) else {}


def _write_webridge_config(payload):
    if not payload.get("models"):
        raise ValueError("模型配置中没有可用模型，无法保存生成设置")
    temporary = MODEL_CONFIG_PATH.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(MODEL_CONFIG_PATH)


def load_generation_mode():
    mode = str(_webridge_config_payload().get("generation_mode", "api")).strip().lower()
    return "webridge" if mode == "webridge" else "api"


def load_webridge_site():
    site = (
        str(_webridge_config_payload().get("webridge_site", DEFAULT_WEBRIDGE_SITE))
        .strip()
        .lower()
    )
    return site if site in WEBRIDGE_SITES else DEFAULT_WEBRIDGE_SITE


def set_generation_mode(mode):
    normalized = "webridge" if str(mode or "").strip().lower() == "webridge" else "api"
    payload = _webridge_config_payload()
    payload["generation_mode"] = normalized
    _write_webridge_config(payload)
    return normalized


def set_webridge_site(site):
    normalized = str(site or DEFAULT_WEBRIDGE_SITE).strip().lower()
    if normalized not in WEBRIDGE_SITES:
        raise ValueError(f"不支持的 WebBridge 站点: {site}")
    payload = _webridge_config_payload()
    payload["webridge_site"] = normalized
    _write_webridge_config(payload)
    return normalized


def image_model_id(model, provider=UNSET_PROVIDER):
    normalized_provider = str(provider).strip() or UNSET_PROVIDER
    return f"{normalized_provider}::{str(model).strip()}"


def load_image_model_config():
    """Load the global current model and configured image endpoints."""
    try:
        payload = json.loads(MODEL_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"无法读取模型配置 {MODEL_CONFIG_PATH.name}: {exc}") from exc
    if isinstance(payload, list):
        raw_models = payload
        current_model = ""
    elif isinstance(payload, dict):
        raw_models = payload.get("models", [])
        current_model = str(payload.get("current_model", "")).strip()
    else:
        raise ValueError("模型配置必须是 JSON 对象或数组")
    models = []
    for item in raw_models:
        if not isinstance(item, dict):
            continue
        model = str(item.get("model", "")).strip()
        provider = str(item.get("provider", UNSET_PROVIDER)).strip() or UNSET_PROVIDER
        if provider in {"???", "??????"}:
            provider = UNSET_PROVIDER
        normalized = {
            "id": str(item.get("id", "")).strip() or image_model_id(model, provider),
            "model": model,
            "provider": provider,
            "baseurl": str(item.get("baseurl", "")).strip().rstrip("/"),
            "key": str(item.get("key", "")).strip(),
        }
        if all(normalized.values()):
            models.append(normalized)
    if not models:
        raise ValueError("模型配置中没有可用模型")
    ids = {item["id"] for item in models}
    if current_model not in ids:
        legacy = next((item for item in models if item["model"] == current_model), None)
        current_model = legacy["id"] if legacy else models[0]["id"]
    return {"current_model": current_model, "models": models}


def load_image_models():
    return load_image_model_config()["models"]


def save_image_models(models, current_model=None):
    normalized = []
    seen = set()
    for item in models:
        model = str(item.get("model", "")).strip()
        provider = str(item.get("provider", UNSET_PROVIDER)).strip() or UNSET_PROVIDER
        if provider in {"???", "??????"}:
            provider = UNSET_PROVIDER
        baseurl = str(item.get("baseurl", "")).strip().rstrip("/")
        key = str(item.get("key", "")).strip()
        item_id = str(item.get("id", "")).strip() or image_model_id(model, provider)
        if not model or not baseurl or not key or item_id in seen:
            continue
        seen.add(item_id)
        normalized.append(
            {
                "id": item_id,
                "model": model,
                "provider": provider,
                "baseurl": baseurl,
                "key": key,
            }
        )
    if not normalized:
        raise ValueError("至少需要保留一个模型")
    ids = {item["id"] for item in normalized}
    selected = str(current_model or "").strip()
    if selected not in ids:
        legacy = next((item for item in normalized if item["model"] == selected), None)
        selected = legacy["id"] if legacy else normalized[0]["id"]
    payload = {"current_model": selected, "models": normalized}
    try:
        existing = json.loads(MODEL_CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(existing, dict):
            for key in ("generation_mode", "webridge_site"):
                if key in existing:
                    payload[key] = existing[key]
    except (OSError, json.JSONDecodeError):
        pass
    temporary = MODEL_CONFIG_PATH.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(MODEL_CONFIG_PATH)
    return normalized


def add_image_model(baseurl, key, model, provider="未设置"):
    values = {
        "model": str(model).strip(),
        "provider": str(provider).strip(),
        "baseurl": str(baseurl).strip(),
        "key": str(key).strip(),
    }
    if not all(values.values()):
        raise ValueError("模型名称?服务商?Base URL 和 Key 均不能为空")
    config = load_image_model_config()
    models = config["models"]
    if any(
        item["model"] == values["model"] and item["provider"] == values["provider"]
        for item in models
    ):
        raise ValueError(f"模型 {values['model']}?{values['provider']}?已存在")
    values["id"] = image_model_id(values["model"], values["provider"])
    models.append(values)
    return save_image_models(models, config["current_model"])


def update_image_model(original_id, baseurl, key, model, provider=UNSET_PROVIDER):
    original = str(original_id).strip()
    config = load_image_model_config()
    target = next((item for item in config["models"] if item["id"] == original), None)
    values = {
        "model": str(model).strip(),
        "provider": str(provider).strip() or "???",
        "baseurl": str(baseurl).strip(),
        "key": str(key).strip() or (target["key"] if target else ""),
    }
    if not original or not all(values.values()):
        raise ValueError("?????????Base URL ? Key ?????")
    if target is None:
        raise ValueError(f"??????? {original}")
    new_id = image_model_id(values["model"], values["provider"])
    if any(item is not target and item["id"] == new_id for item in config["models"]):
        raise ValueError(f"?? {values['model']}?{values['provider']}????")
    old_id = target["id"]
    target.update(values)
    target["id"] = new_id
    current = new_id if config["current_model"] == old_id else config["current_model"]
    return save_image_models(config["models"], current)


def delete_image_model(model_id):
    requested = str(model_id).strip()
    config = load_image_model_config()
    remaining = [item for item in config["models"] if item["id"] != requested]
    if len(remaining) == len(config["models"]):
        raise ValueError(f"??????? {requested}")
    return save_image_models(remaining, config["current_model"])


def set_current_image_model(model_id):
    requested = str(model_id or "").strip()
    config = load_image_model_config()
    if requested not in {item["id"] for item in config["models"]}:
        raise ValueError(f"???????: {requested}")
    save_image_models(config["models"], requested)
    return requested


def get_model_config(model=None):
    config = load_image_model_config()
    models = config["models"]
    requested = str(model or config["current_model"]).strip()
    for item in models:
        if item["id"] == requested:
            return item
    legacy = next((item for item in models if item["model"] == requested), None)
    if legacy:
        return legacy
    raise ValueError(f"???????: {requested}")


def image_model_capability(model):
    return (
        "text-to-image"
        if str(model).strip().lower() in TEXT_TO_IMAGE_MODELS
        else "image-edit"
    )


def gemini_output_size(image_size, aspect_ratio):
    normalized_size = str(image_size or "1K").strip().upper()
    normalized_ratio = str(aspect_ratio or "1:1").strip()
    if normalized_size not in {"1K", "2K"}:
        raise ValueError(f"Gemini 不支持的生成档位: {normalized_size}")
    if normalized_ratio not in GEMINI_1K_SIZES:
        raise ValueError(f"Gemini 不支持的宽高比: {normalized_ratio}")
    multiplier = 2 if normalized_size == "2K" else 1
    width, height = GEMINI_1K_SIZES[normalized_ratio]
    return width * multiplier, height * multiplier


def _model_client(config):
    if OpenAI is None:
        raise RuntimeError("缺少 openai 依赖，请先安装项目依赖")
    return OpenAI(base_url=config["baseurl"], api_key=config["key"])


def _check_cancelled(cancel_check):
    if cancel_check and cancel_check():
        raise RuntimeError("修改已终止")


def _modelscope_image_edit(
    image,
    prompt,
    config,
    cancel_check=None,
    output_size=None,
    reference_images=None,
    count=1,
):
    """Call ModelScope's asynchronous image generation or editing API.

    ModelScope's OpenAI-compatible image endpoints do not expose a parameter
    to request several images in one call, so we submit ``count`` tasks.
    """
    if image_model_capability(config["model"]) == "text-to-image":
        raise ValueError(
            f"{config['model']} 仅支持文生图，不能用于专家图像修改；ModelScope Base URL 与子路由均正确。"
        )
    _check_cancelled(cancel_check)
    base_url = config["baseurl"].rstrip("/")
    if not base_url.lower().endswith("/v1"):
        base_url += "/v1"
    headers = {
        "Authorization": f"Bearer {config['key']}",
        "Content-Type": "application/json",
        "X-ModelScope-Async-Mode": "true",
    }
    task_headers = {
        "Authorization": f"Bearer {config['key']}",
        "X-ModelScope-Task-Type": "image_generation",
    }
    reference_data = []
    for index, reference in enumerate(reference_images or []):
        reference_stream = image_file(
            reference.convert("RGB"), f"reference-{index}.png"
        )
        try:
            reference_data.append(
                "data:image/png;base64,"
                + base64.b64encode(reference_stream.read()).decode("ascii")
            )
        finally:
            reference_stream.close()
    count = max(1, int(count or 1))
    results = []
    for _ in range(count):
        _check_cancelled(cancel_check)
        image_stream = image_file(image.convert("RGB"), "reference.png")
        image_data = "data:image/png;base64," + base64.b64encode(
            image_stream.read()
        ).decode("ascii")
        image_stream.close()
        payload = {
            "model": config["model"],
            "prompt": prompt,
            "size": f"{output_size[0]}x{output_size[1]}"
            if output_size
            else f"{image.width}x{image.height}",
            "image_url": [image_data, *reference_data],
        }
        response = requests.post(
            f"{base_url}/images/generations", headers=headers, json=payload, timeout=60
        )
        _check_cancelled(cancel_check)
        try:
            response.raise_for_status()
        except requests.HTTPError as exc:
            detail = response.text[:800]
            raise RuntimeError(f"ModelScope 请求失败: {detail}") from exc
        task_id = (response.json() or {}).get("task_id")
        if not task_id:
            raise RuntimeError("ModelScope 未返回 task_id")

        # ModelScope edit models can remain queued for several minutes at busy times.
        for _ in range(180):
            _check_cancelled(cancel_check)
            result = requests.get(
                f"{base_url}/tasks/{task_id}", headers=task_headers, timeout=30
            )
            result.raise_for_status()
            data = result.json() or {}
            status = str(data.get("task_status", "")).upper()
            if status == "SUCCEED":
                outputs = data.get("output_images") or []
                if not outputs:
                    raise RuntimeError("ModelScope 任务成功但没有返回图片")
                output = outputs[0]
                if isinstance(output, str) and output.startswith("data:image/"):
                    encoded = output.split(",", 1)[1]
                    results.append(
                        Image.open(BytesIO(base64.b64decode(encoded))).convert("RGB")
                    )
                else:
                    image_response = requests.get(str(output), timeout=60)
                    image_response.raise_for_status()
                    results.append(
                        Image.open(BytesIO(image_response.content)).convert("RGB")
                    )
                break
            if status == "FAILED":
                raise RuntimeError(
                    f"ModelScope 图像任务失败: {data.get('message') or data.get('error') or data}"
                )
            time.sleep(5)
        else:
            raise TimeoutError("ModelScope 图像任务等待超过 15 分钟")
    return results


def encode_data_url(image_bytes, image_format):
    image_format = image_format.lower()
    mime = "jpeg" if image_format in ("jpg", "jpeg") else image_format
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:image/{mime};base64,{encoded}"


def extract_data_image(value):
    if isinstance(value, str):
        match = re.search(
            r"data:image/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+={0,2})",
            value,
        )
        if match:
            return Image.open(BytesIO(base64.b64decode(match.group(1)))).convert("RGB")
    elif isinstance(value, dict):
        for child in value.values():
            image = extract_data_image(child)
            if image is not None:
                return image
    elif isinstance(value, (list, tuple)):
        for child in value:
            image = extract_data_image(child)
            if image is not None:
                return image
    return None


def extract_data_images(value):
    """Return every unique data-URL image contained in an API response."""
    encoded_images = []
    seen = set()

    def visit(child):
        if isinstance(child, str):
            for match in re.finditer(
                r"data:image/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+={0,2})",
                child,
            ):
                encoded = match.group(1)
                if encoded not in seen:
                    seen.add(encoded)
                    encoded_images.append(encoded)
        elif isinstance(child, dict):
            for nested in child.values():
                visit(nested)
        elif isinstance(child, (list, tuple)):
            for nested in child:
                visit(nested)

    visit(value)
    return [
        Image.open(BytesIO(base64.b64decode(encoded))).convert("RGB")
        for encoded in encoded_images
    ]


def _clamp_box(box, width, height):
    x1, y1, x2, y2 = (int(round(value)) for value in box)
    x1 = max(0, min(width - 1, x1))
    y1 = max(0, min(height - 1, y1))
    x2 = max(x1 + 1, min(width, x2))
    y2 = max(y1 + 1, min(height, y2))
    return x1, y1, x2, y2


def decode_selection_mask(selection_mask, size=None):
    """Return a grayscale selection mask, using alpha for transparent PNG input."""
    if selection_mask is None:
        return None
    if isinstance(selection_mask, str):
        encoded = selection_mask.split(",", 1)[-1]
        selection_mask = base64.b64decode(encoded)
    if isinstance(selection_mask, (bytes, bytearray)):
        selection_mask = Image.open(BytesIO(selection_mask))
    if not isinstance(selection_mask, Image.Image):
        array = np.asarray(selection_mask)
        if array.dtype == np.bool_:
            array = array.astype(np.uint8) * 255
        elif array.dtype != np.uint8:
            array = np.nan_to_num(array)
            if array.size and np.max(array) <= 1:
                array = array * 255
            array = np.clip(array, 0, 255).astype(np.uint8)
        selection_mask = Image.fromarray(array)

    if "A" in selection_mask.getbands():
        mask = selection_mask.getchannel("A")
    else:
        mask = selection_mask.convert("L")
    if size is not None and mask.size != tuple(size):
        mask = mask.resize(tuple(size), Image.Resampling.LANCZOS)
    return mask


def align_generated_to_source(
    source, generated, selection_mask=None, max_shift=8, return_info=False
):
    """Align using only a narrow band immediately outside the selection mask."""
    source_image = source.convert("RGB")
    generated_image = generated.convert("RGB")
    if generated_image.size != source_image.size:
        generated_image = generated_image.resize(
            source_image.size, Image.Resampling.LANCZOS
        )
    unchanged = {"moved": False, "dx": 0, "dy": 0, "improvement": 0.0}
    if selection_mask is None:
        return (generated_image, unchanged) if return_info else generated_image

    width, height = source_image.size
    mask = np.asarray(decode_selection_mask(selection_mask, (width, height)))
    selected = (mask > 8).astype(np.uint8)
    if not np.any(selected):
        return (generated_image, unchanged) if return_info else generated_image

    # Build a true distance band outside the mask. Pixels elsewhere in the
    # image must not influence the registration because the generated image can
    # legitimately differ there.
    band_width = max(
        ALIGNMENT_BAND_MIN,
        min(
            ALIGNMENT_BAND_MAX,
            int(round(min(width, height) * ALIGNMENT_BAND_RATIO)),
        ),
    )
    outside = (~selected.astype(bool)).astype(np.uint8)
    outside_distance = cv2.distanceTransform(outside, cv2.DIST_L2, 5)
    ring = (outside_distance > 0.0) & (outside_distance <= float(band_width))
    if int(np.count_nonzero(ring)) < 64:
        return (generated_image, unchanged) if return_info else generated_image

    source_array = np.asarray(source_image)
    generated_array = np.asarray(generated_image)
    source_gray = cv2.cvtColor(source_array, cv2.COLOR_RGB2GRAY).astype(np.float32)
    generated_gray = cv2.cvtColor(generated_array, cv2.COLOR_RGB2GRAY).astype(
        np.float32
    )
    source_gray = cv2.GaussianBlur(source_gray, (0, 0), 0.8)
    generated_gray = cv2.GaussianBlur(generated_gray, (0, 0), 0.8)
    source_edge = gradient_image(source_gray)
    generated_edge = gradient_image(generated_gray)
    ys, xs = np.nonzero(ring)

    def shift_score(dx, dy):
        sample_x = xs + dx
        sample_y = ys + dy
        valid = (
            (sample_x >= 0) & (sample_x < width) & (sample_y >= 0) & (sample_y < height)
        )
        if int(np.count_nonzero(valid)) < 64:
            return float("inf")
        source_y, source_x = ys[valid], xs[valid]
        target_y, target_x = sample_y[valid], sample_x[valid]
        edge_error = np.median(
            np.abs(source_edge[source_y, source_x] - generated_edge[target_y, target_x])
        )
        intensity_delta = (
            generated_gray[target_y, target_x] - source_gray[source_y, source_x]
        )
        intensity_error = np.median(
            np.abs(intensity_delta - np.median(intensity_delta))
        )
        return float(edge_error + intensity_error * 0.35)

    baseline = shift_score(0, 0)
    best_score, best_dx, best_dy = baseline, 0, 0
    for dy in range(-int(max_shift), int(max_shift) + 1):
        for dx in range(-int(max_shift), int(max_shift) + 1):
            if dx == 0 and dy == 0:
                continue
            score = shift_score(dx, dy)
            if score < best_score:
                best_score, best_dx, best_dy = score, dx, dy

    improvement = (
        0.0
        if not np.isfinite(baseline) or baseline <= 1e-6
        else max(0.0, 1.0 - best_score / baseline)
    )
    if (best_dx == 0 and best_dy == 0) or improvement < 0.10:
        return (generated_image, unchanged) if return_info else generated_image

    warp = np.float32([[1, 0, -best_dx], [0, 1, -best_dy]])
    aligned = cv2.warpAffine(
        generated_array,
        warp,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )
    info = {
        "moved": True,
        "dx": int(-best_dx),
        "dy": int(-best_dy),
        "improvement": float(improvement),
    }
    result = Image.fromarray(aligned, "RGB")
    return (result, info) if return_info else result


def composite_selection_result(source, generated, selection_mask):
    if selection_mask is None:
        return generated
    protected = source.convert("RGB")
    if protected.size != generated.size:
        protected = protected.resize(generated.size, Image.Resampling.LANCZOS)
    mask = np.asarray(
        decode_selection_mask(selection_mask, generated.size), dtype=np.uint8
    ).copy()
    mask[mask <= 8] = 0
    return Image.composite(
        generated.convert("RGB"), protected, Image.fromarray(mask, "L")
    )


def composite_aligned_selection_result(
    source,
    generated,
    selection_mask,
    target_size=None,
    pixels=FEATHER_PIXELS,
    return_info=False,
):
    """Resize, register, and confidence-composite a generated masked result."""
    source_image = source.convert("RGB")
    generated_image = generated.convert("RGB")
    target_size = tuple(target_size or generated_image.size)
    if source_image.size != target_size:
        source_image = source_image.resize(target_size, Image.Resampling.LANCZOS)
    if generated_image.size != target_size:
        generated_image = generated_image.resize(target_size, Image.Resampling.LANCZOS)
    mask = decode_selection_mask(selection_mask, target_size)
    aligned, alignment = align_generated_to_source(
        source_image, generated_image, mask, return_info=True
    )
    result = blend_confidence(
        source_image,
        aligned,
        (0, 0, target_size[0], target_size[1]),
        pixels=max(1, int(pixels)),
        selection_mask=mask,
    )
    return (result, alignment) if return_info else result


def confidence_patch_layer(base, source_layer, selection_mask, pixels=FEATHER_PIXELS):
    """Return a transparent confidence-fused patch from a positioned source layer."""
    base_image = base.convert("RGB")
    source_image = source_layer.convert("RGBA")
    if source_image.size != base_image.size:
        source_image = source_image.resize(base_image.size, Image.Resampling.LANCZOS)
    mask = decode_selection_mask(selection_mask, base_image.size)
    if mask is None:
        raise ValueError("蒙版为空")
    effective_mask = ImageChops.multiply(mask, source_image.getchannel("A"))
    if effective_mask.getbbox() is None:
        raise ValueError("取图源与蒙版没有重叠区域")
    candidate = Image.composite(
        source_image.convert("RGB"), base_image, source_image.getchannel("A")
    )
    aligned, alignment = align_generated_to_source(
        base_image, candidate, effective_mask, return_info=True
    )
    corrected = blend_confidence(
        base_image,
        aligned,
        (0, 0, base_image.width, base_image.height),
        pixels=max(1, int(pixels)),
        selection_mask=effective_mask,
    )
    patch = correction_layer(base_image, corrected)
    patch.putalpha(ImageChops.multiply(patch.getchannel("A"), effective_mask))
    return patch, alignment


def gpt_edit_mask(image, editable_box=None, editable_mask=None):
    width, height = image.size
    rgba_mask = np.zeros((height, width, 4), dtype=np.uint8)
    rgba_mask[:, :, 3] = 255
    if editable_box is None:
        editable_box = (0, 0, width, height)
    x1, y1, x2, y2 = _clamp_box(editable_box, width, height)
    if editable_mask is None:
        rgba_mask[y1:y2, x1:x2, :3] = 255
        rgba_mask[y1:y2, x1:x2, 3] = 0
    else:
        selected = np.asarray(decode_selection_mask(editable_mask, (width, height)))
        selected = selected.copy()
        selected[:y1] = 0
        selected[y2:] = 0
        selected[:, :x1] = 0
        selected[:, x2:] = 0
        rgba_mask[:, :, :3] = selected[:, :, None]
        rgba_mask[:, :, 3] = 255 - selected
    return Image.fromarray(rgba_mask, "RGBA")


def aligned_gpt_output_size(size):
    width, height = (int(size[0]), int(size[1]))
    if width <= 0 or height <= 0:
        raise ValueError("\u56fe\u7247\u5bbd\u9ad8\u5fc5\u987b\u5927\u4e8e 0")
    ratio = width / height
    if not 1 / 3 <= ratio <= 3:
        raise ValueError(
            "GPT Image 2 \u7684\u8f93\u5165\u5bbd\u9ad8\u6bd4\u5fc5\u987b\u5728 1:3 \u5230 3:1 \u4e4b\u95f4\uff0c"
            "\u7a0b\u5e8f\u4e0d\u4f1a\u7528\u8865\u8fb9\u6216\u62c9\u4f38\u89c4\u907f"
        )
    scale = min(
        1.0,
        4096 / width,
        4096 / height,
        (16777216 / (width * height)) ** 0.5,
    )
    aligned_width = max(16, int(round(width * scale / 16)) * 16)
    aligned_height = max(16, int(round(height * scale / 16)) * 16)
    return validate_gpt_output_size((aligned_width, aligned_height))


def image_file(image, name):
    stream = BytesIO()
    image.save(stream, "PNG")
    stream.seek(0)
    stream.name = name
    return stream


def validate_gpt_output_size(output_size):
    if output_size is None:
        return None
    width, height = (int(output_size[0]), int(output_size[1]))
    if not 16 <= width <= 4096 or not 16 <= height <= 4096:
        raise ValueError("GPT Image 2 的宽高必须在 16 到 4096 像素之间")
    if width % 16 or height % 16:
        raise ValueError("GPT Image 2 的宽高必须是 16 的倍数")
    if width * height > 16777216:
        raise ValueError("GPT Image 2 的总像素数不能超过 16777216")
    ratio = width / height
    if not 1 / 3 <= ratio <= 3:
        raise ValueError("GPT Image 2 的宽高比必须在 1:3 到 3:1 之间")
    return width, height


def edit_patch_gpt(
    image,
    editable_box=None,
    prompt=PATCH_PROMPT,
    model=None,
    cancel_check=None,
    editable_mask=None,
    output_size=None,
    reference_images=None,
    count=1,
    reference_size=None,
):
    """Edit with a GPT-image model, returning a list of ``count`` images.

    GPT-image endpoints accept an ``n`` parameter so several images can be
    generated in one request; when the endpoint rejects or ignores ``n`` we
    fall back to repeated single-image requests.

    ``reference_size`` overrides the size used for mismatch enforcement with
    the untouched source (main image), so responses that do not match it raise
    ``OutputSizeMismatch``. Full-image edits pass the main image size here.
    """
    _check_cancelled(cancel_check)
    config = get_model_config(model)
    requested_size = (
        validate_gpt_output_size(output_size)
        if output_size
        else aligned_gpt_output_size(image.size)
    )
    enforce_size = tuple(reference_size) if reference_size else requested_size
    enforce_requested_size = output_size is not None or reference_size is not None
    client = _model_client(config)
    source = image.convert("RGB")
    mask = gpt_edit_mask(source, editable_box, editable_mask)
    source_file = image_file(source, "region.png")
    mask_file = image_file(mask, "mask.png")
    reference_files = [
        image_file(reference.convert("RGB"), f"reference-{index}.png")
        for index, reference in enumerate(reference_images or [])
    ]
    count = max(1, int(count or 1))

    def rewind_inputs():
        for stream in (source_file, mask_file, *reference_files):
            stream.seek(0)

    def decode_response(response):
        decoded = []
        for item in list(getattr(response, "data", None) or []):
            encoded = (
                item.get("b64_json")
                if isinstance(item, dict)
                else getattr(item, "b64_json", None)
            )
            if encoded:
                decoded.append(
                    Image.open(BytesIO(base64.b64decode(encoded))).convert("RGB")
                )
        return decoded

    generated_list = []
    try:
        image_input = (
            [source_file, *reference_files] if reference_files else source_file
        )
        if count > 1:
            try:
                rewind_inputs()
                response = client.images.edit(
                    model=config["model"],
                    image=image_input,
                    mask=mask_file,
                    prompt=prompt,
                    quality="high",
                    size=f"{requested_size[0]}x{requested_size[1]}",
                    output_format="png",
                    response_format="b64_json",
                    n=count,
                )
                generated_list.extend(decode_response(response))
            except Exception:
                generated_list = []
        while len(generated_list) < count:
            _check_cancelled(cancel_check)
            before = len(generated_list)
            rewind_inputs()
            response = client.images.edit(
                model=config["model"],
                image=image_input,
                mask=mask_file,
                prompt=prompt,
                quality="high",
                size=f"{requested_size[0]}x{requested_size[1]}",
                output_format="png",
                response_format="b64_json",
                n=1,
            )
            generated_list.extend(decode_response(response))
            if len(generated_list) == before:
                break
    finally:
        source_file.close()
        mask_file.close()
        for reference_file in reference_files:
            reference_file.close()
    _check_cancelled(cancel_check)

    if not generated_list:
        raise ValueError(f"{config['model']} response did not contain b64_json")
    generated_list = generated_list[:count]
    if enforce_requested_size:
        mismatch = next(
            (
                generated
                for generated in generated_list
                if generated.size != enforce_size
            ),
            None,
        )
        if mismatch is not None:
            raise OutputSizeMismatch(
                mismatch,
                enforce_size,
                mismatch.size,
                config["baseurl"],
                images=generated_list,
            )
    results = []
    for generated in generated_list:
        if enforce_requested_size:
            results.append(generated)
        else:
            if generated.size != source.size:
                generated = generated.resize(source.size, Image.Resampling.LANCZOS)
            results.append(generated)
    return results


def edit_patch_legacy(
    image,
    editable_box=None,
    prompt=PATCH_PROMPT,
    model=None,
    cancel_check=None,
    output_size=None,
    reference_images=None,
    generation_options=None,
    count=1,
    reference_size=None,
):
    _check_cancelled(cancel_check)
    config = get_model_config(model)
    client = _model_client(config)
    count = max(1, int(count or 1))
    if editable_box is not None:
        x1, y1, x2, y2 = _clamp_box(editable_box, image.width, image.height)
        target = image.crop((x1, y1, x2, y2))
        cleaned = edit_patch_legacy(
            target,
            prompt=prompt,
            model=config["id"],
            cancel_check=cancel_check,
            count=count,
        )
        return [
            feather_patch(image, cleaned_image, (x1, y1, x2, y2))
            for cleaned_image in cleaned
        ]
    source = image_file(image.convert("RGB"), "region.png")
    image_bytes = source.getvalue()
    source.close()
    content = [
        {"type": "image_url", "image_url": {"url": encode_data_url(image_bytes, "png")}}
    ]
    for reference in reference_images or []:
        reference_stream = image_file(reference.convert("RGB"), "reference.png")
        try:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": encode_data_url(reference_stream.getvalue(), "png")
                    },
                }
            )
        finally:
            reference_stream.close()
    request_prompt = prompt
    extra_body = {}
    if "gemini" in config["model"].lower() and generation_options:
        aspect_ratio = generation_options.get("aspect_ratio") or "1:1"
        image_size = generation_options.get("image_size") or "1K"
        expected_output_size = gemini_output_size(image_size, aspect_ratio)
        extra_body = {
            "size": aspect_ratio,
            "imageSize": image_size,
        }
        request_prompt = f"{prompt}\n\nGenerate the edited image at {image_size} resolution with a {aspect_ratio} aspect ratio."
    else:
        expected_output_size = output_size
        extra_body = {
            "size": f"{output_size[0]}x{output_size[1]}"
            if output_size
            else f"{image.width}x{image.height}"
        }
    content.append({"type": "text", "text": request_prompt})
    messages = [
        {
            "role": "user",
            "content": content,
        }
    ]

    def request_images(request_count):
        _check_cancelled(cancel_check)
        response = client.chat.completions.create(
            model=config["model"],
            extra_body=extra_body,
            messages=messages,
            n=request_count,
        )
        payload = response.model_dump() if hasattr(response, "model_dump") else response
        return extract_data_images(payload)

    results = []
    if count > 1:
        try:
            results.extend(request_images(count))
        except Exception:
            results = []
    while len(results) < count:
        before = len(results)
        results.extend(request_images(1))
        if len(results) == before:
            raise ValueError("legacy endpoint response did not contain an image")
    results = results[:count]
    enforce_size = tuple(reference_size) if reference_size else None
    if enforce_size is None:
        if "gemini" in config["model"].lower() and generation_options:
            enforce_size = expected_output_size
    if enforce_size is not None:
        mismatch = next(
            (result for result in results if result.size != enforce_size), None
        )
        if mismatch is not None:
            raise OutputSizeMismatch(
                mismatch,
                enforce_size,
                mismatch.size,
                config["baseurl"],
                images=results,
            )
    normalized_results = []
    for result in results:
        if (
            output_size is not None
            or generation_options is not None
            or reference_size is not None
        ):
            normalized_results.append(result)
        else:
            normalized_results.append(
                result.resize(image.size, Image.Resampling.LANCZOS)
            )
    return normalized_results


class _CancelAdapter:
    """Adapt the app's cancel_check callable to the threading.Event API used by webridge."""

    def __init__(self, cancel_check):
        self._check = cancel_check

    def is_set(self):
        return bool(self._check and self._check())


_WEBRIDGE_BRIDGE = None


def _import_webridge_bridge():
    global _WEBRIDGE_BRIDGE
    if _WEBRIDGE_BRIDGE is not None:
        return _WEBRIDGE_BRIDGE
    candidates = [
        Path(__file__).resolve().parents[1] / "webridge" / "bridge.py",
        Path(__file__).resolve().parents[2] / "webridge" / "bridge.py",
    ]
    for candidate in candidates:
        if not candidate.is_file():
            continue
        spec = importlib.util.spec_from_file_location(
            "image_webridge_bridge", candidate
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules["image_webridge_bridge"] = module
        if spec.loader is None:
            continue
        spec.loader.exec_module(module)
        _WEBRIDGE_BRIDGE = module
        return module
    raise RuntimeError("未找到 webridge 模块（bridge.py），无法使用 WebBridge 模式")


def _webridge_prompt(prompt, size):
    width, height = (int(size[0]), int(size[1]))
    return (
        f"{str(prompt).strip()}\n"
        f"要求：生成尺寸 {width}×{height}（主图尺寸），宽高比 {_simplest_aspect_ratio(width, height)}，质量：高。"
    )


def _simplest_aspect_ratio(width, height):
    """Reduce width:height to a simple ratio, snapped to common ratios when close.

    Examples: 1920×1080 -> 16:9, 1408×768 -> 16:9, 1024×1024 -> 1:1.
    """
    width, height = int(width), int(height)
    if width <= 0 or height <= 0:
        return "1:1"
    ratio = width / height
    common = [
        (16, 9),
        (9, 16),
        (4, 3),
        (3, 4),
        (3, 2),
        (2, 3),
        (1, 1),
        (21, 9),
        (9, 21),
        (5, 4),
        (4, 5),
    ]
    best = None
    best_error = 0.04
    for rw, rh in common:
        error = abs((rw / rh) / ratio - 1.0)
        if error < best_error:
            best_error = error
            best = (rw, rh)
    if best is not None:
        return f"{best[0]}:{best[1]}"
    divisor = math.gcd(width, height)
    return f"{width // divisor}:{height // divisor}"


def _webridge_generate(
    image,
    prompt,
    site,
    cancel_check=None,
    output_size=None,
    reference_images=None,
    count=1,
):
    """Generate an edited image through the WebBridge browser flow.

    The image and any reference images are saved to temp PNG files, uploaded to
    the selected site (Gemini / ChatGPT) via ``bridge.run``, and the downloaded
    result is loaded back as a Pillow image. The prompt is appended with the
    image's own size / aspect ratio / quality, and the result is normalized to
    that size (the browser sites have no explicit size parameters).
    """
    _check_cancelled(cancel_check)
    bridge = _import_webridge_bridge()
    webridge_prompt = _webridge_prompt(prompt, image.size)
    pending_images = [image.convert("RGB")]
    pending_images.extend(
        reference.convert("RGB") for reference in (reference_images or [])
    )
    cancel_adapter = _CancelAdapter(cancel_check)
    count = max(1, int(count or 1))
    target_size = (image.width, image.height)
    temp_dir = tempfile.mkdtemp(prefix="webridge_edit_")
    results = []
    try:
        image_paths = []
        for index, pending in enumerate(pending_images):
            path = os.path.join(temp_dir, f"image-{index}.png")
            pending.save(path, "PNG")
            image_paths.append(path)
        for i in range(count):
            _check_cancelled(cancel_check)
            try:
                out_path = bridge.run(
                    site,
                    image_paths,
                    webridge_prompt,
                    cancel_event=cancel_adapter,
                )
            except requests.exceptions.ConnectionError as exc:
                raise RuntimeError(
                    f"无法连接 WebBridge daemon(127.0.0.1:10086)，请先启动 webridge 服务: {exc}"
                ) from exc
            except Exception as exc:
                raise RuntimeError(f"WebBridge 生图失败: {exc}") from exc
            if not out_path or not os.path.exists(str(out_path)):
                raise RuntimeError("WebBridge 未返回生成结果")
            # 保留 alpha：webridge/浏览器下载的可能是透明 PNG，转 RGB 会把透明区填黑
            generated = Image.open(str(out_path)).convert("RGBA")
            if generated.size != target_size:
                generated = generated.resize(target_size, Image.Resampling.LANCZOS)
            results.append(generated)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
    _check_cancelled(cancel_check)
    return results


def _webridge_edit_patch(
    image,
    editable_box,
    prompt,
    cancel_check,
    editable_mask,
    output_size,
    reference_images,
    count,
):
    """WebBridge edit dispatcher: full-image or local crop-and-paste."""
    _check_cancelled(cancel_check)
    site = load_webridge_site()
    count = max(1, int(count or 1))
    if editable_box is not None:
        x1, y1, x2, y2 = _clamp_box(editable_box, image.width, image.height)
        target = image.crop((x1, y1, x2, y2))
        generated_list = _webridge_generate(
            target,
            prompt,
            site,
            cancel_check,
            reference_images=reference_images,
            count=count,
        )
        # 生成的局部图可能带透明背景：先合成回原裁剪区（透明处保留原图），
        # 再 feather 拼贴，避免透明区被 RGB 转换填成黑色
        base_rgba = target.convert("RGBA")
        composited = [
            Image.alpha_composite(base_rgba, generated.convert("RGBA")).convert("RGB")
            for generated in generated_list
        ]
        return [
            feather_patch(
                image, composed, (x1, y1, x2, y2), selection_mask=editable_mask
            )
            for composed in composited
        ]
    return _webridge_generate(
        image,
        prompt,
        site,
        cancel_check,
        output_size,
        reference_images,
        count,
    )


def edit_patch(
    image,
    editable_box=None,
    prompt=PATCH_PROMPT,
    model=None,
    cancel_check=None,
    editable_mask=None,
    output_size=None,
    reference_images=None,
    generation_options=None,
    count=1,
    reference_size=None,
):
    _check_cancelled(cancel_check)
    count = max(1, int(count or 1))
    if load_generation_mode() == "webridge":
        return _webridge_edit_patch(
            image,
            editable_box,
            prompt,
            cancel_check,
            editable_mask,
            output_size,
            reference_images,
            count,
        )
    config = get_model_config(model)
    if "modelscope.cn" in config["baseurl"].lower():
        if editable_box is not None:
            x1, y1, x2, y2 = _clamp_box(editable_box, image.width, image.height)
            target = image.crop((x1, y1, x2, y2))
            generated_list = _modelscope_image_edit(
                target,
                prompt,
                config,
                cancel_check,
                reference_images=reference_images,
                count=count,
            )
            return [
                feather_patch(image, generated, (x1, y1, x2, y2))
                for generated in generated_list
            ]
        generated_list = _modelscope_image_edit(
            image,
            prompt,
            config,
            cancel_check,
            output_size,
            reference_images,
            count=count,
        )
        if reference_size is not None:
            mismatch = next(
                (
                    generated
                    for generated in generated_list
                    if generated.size != tuple(reference_size)
                ),
                None,
            )
            if mismatch is not None:
                raise OutputSizeMismatch(
                    mismatch,
                    reference_size,
                    mismatch.size,
                    config["baseurl"],
                    images=generated_list,
                )
        results = []
        for generated in generated_list:
            if output_size is not None:
                results.append(generated)
            else:
                results.append(generated.resize(image.size, Image.Resampling.LANCZOS))
        return results
    if config["model"].lower().startswith("gpt-image"):
        return edit_patch_gpt(
            image,
            editable_box,
            prompt,
            config["id"],
            cancel_check,
            editable_mask,
            output_size,
            reference_images,
            count,
            reference_size,
        )
    return edit_patch_legacy(
        image,
        editable_box,
        prompt,
        config["id"],
        cancel_check,
        output_size,
        reference_images,
        generation_options,
        count,
        reference_size,
    )


def gradient_image(gray):
    return cv2.magnitude(
        cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3),
        cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3),
    )


def locate_patch_pyramid(base_rgb, patch_rgb):
    """Locate an exact or resized crop using multi-scale intensity and edge matching."""
    base_gray = cv2.cvtColor(base_rgb, cv2.COLOR_RGB2GRAY)
    base_edge = gradient_image(base_gray)
    best = None

    for scale in MATCH_SCALES:
        width = max(8, int(round(patch_rgb.shape[1] * scale)))
        height = max(8, int(round(patch_rgb.shape[0] * scale)))
        if width > base_rgb.shape[1] or height > base_rgb.shape[0]:
            continue
        interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
        resized = cv2.resize(patch_rgb, (width, height), interpolation=interpolation)
        patch_gray = cv2.cvtColor(resized, cv2.COLOR_RGB2GRAY)
        intensity_scores = cv2.matchTemplate(
            base_gray, patch_gray, cv2.TM_CCOEFF_NORMED
        )
        edge_scores = cv2.matchTemplate(
            base_edge, gradient_image(patch_gray), cv2.TM_CCOEFF_NORMED
        )
        scores = intensity_scores * 0.7 + edge_scores * 0.3
        _, score, _, location = cv2.minMaxLoc(scores)
        if best is None or score > best[0]:
            best = (score, location, (width, height), scale)

    if best is None or best[0] < MIN_MATCH_CONFIDENCE:
        score = 0.0 if best is None else best[0]
        raise ValueError(f"Region match confidence is too low: {score:.3f}")
    score, (x, y), (width, height), scale = best
    return (x, y, x + width, y + height), score, scale


def match_patch_boundary(patch, target, selection_mask=None):
    """Match patch color and contrast using robust samples along the edited boundary."""
    patch_array = patch.astype(np.float32)
    target_array = target.astype(np.float32)
    height, width = patch.shape[:2]
    thickness = max(2, min(8, min(width, height) // 4))

    if selection_mask is None:
        ring = np.zeros((height, width), dtype=bool)
        ring[:thickness] = True
        ring[-thickness:] = True
        ring[:, :thickness] = True
        ring[:, -thickness:] = True
    else:
        selected = (
            np.asarray(decode_selection_mask(selection_mask, (width, height))) > 8
        )
        kernel = np.ones((3, 3), dtype=np.uint8)
        eroded = cv2.erode(selected.astype(np.uint8), kernel, iterations=thickness)
        ring = selected & ~eroded.astype(bool)
        if np.count_nonzero(ring) < 8:
            ring = selected

    difference = np.abs(patch_array - target_array).mean(axis=2)
    cutoff = float(np.percentile(difference[ring], 60))
    sample = ring & (difference <= cutoff)

    matched = patch_array.copy()
    for channel in range(3):
        source = patch_array[:, :, channel][sample]
        destination = target_array[:, :, channel][sample]
        source_iqr = float(np.percentile(source, 75) - np.percentile(source, 25))
        destination_iqr = float(
            np.percentile(destination, 75) - np.percentile(destination, 25)
        )
        gain = min(1.15, max(0.85, destination_iqr / max(source_iqr, 1.0)))
        matched[:, :, channel] = (
            patch_array[:, :, channel] - float(np.median(source))
        ) * gain + float(np.median(destination))
    return np.clip(matched, 0, 255).astype(np.uint8)


def multiband_blend(base, candidate, alpha, levels=PYRAMID_LEVELS):
    base_pyramid = [base.astype(np.float32)]
    candidate_pyramid = [candidate.astype(np.float32)]
    mask_pyramid = [alpha.astype(np.float32)]
    for _ in range(levels):
        base_pyramid.append(cv2.pyrDown(base_pyramid[-1]))
        candidate_pyramid.append(cv2.pyrDown(candidate_pyramid[-1]))
        mask_pyramid.append(cv2.pyrDown(mask_pyramid[-1]))

    base_laplacian = []
    candidate_laplacian = []
    for level in range(levels):
        size = (base_pyramid[level].shape[1], base_pyramid[level].shape[0])
        base_laplacian.append(
            base_pyramid[level] - cv2.pyrUp(base_pyramid[level + 1], dstsize=size)
        )
        candidate_laplacian.append(
            candidate_pyramid[level]
            - cv2.pyrUp(candidate_pyramid[level + 1], dstsize=size)
        )
    base_laplacian.append(base_pyramid[-1])
    candidate_laplacian.append(candidate_pyramid[-1])

    blended_levels = []
    for base_level, candidate_level, mask_level in zip(
        base_laplacian, candidate_laplacian, mask_pyramid
    ):
        mask_level = mask_level[:, :, None]
        blended_levels.append(
            base_level * (1.0 - mask_level) + candidate_level * mask_level
        )
    result = blended_levels[-1]
    for level in range(levels - 1, -1, -1):
        size = (blended_levels[level].shape[1], blended_levels[level].shape[0])
        result = cv2.pyrUp(result, dstsize=size) + blended_levels[level]
    return np.clip(result, 0, 255).astype(np.uint8)


def feather_patch(base, patch, box, pixels=FEATHER_PIXELS, selection_mask=None):
    """Paste a crop using boundary matching and multi-band blending."""
    x1, y1, x2, y2 = box
    target_width = x2 - x1
    target_height = y2 - y1
    if patch.size != (target_width, target_height):
        patch = patch.resize((target_width, target_height), Image.Resampling.LANCZOS)

    if selection_mask is None:
        patch_rgb = np.asarray(patch.convert("RGB"))
        base_array = np.asarray(base.convert("RGB")).copy()
        height, width = base_array.shape[:2]
        target_patch = base_array[y1:y2, x1:x2]
        patch_rgb = match_patch_boundary(patch_rgb, target_patch)

        border = pixels * 2
        extended = cv2.copyMakeBorder(
            patch_rgb, border, border, border, border, cv2.BORDER_REFLECT_101
        )
        ex1 = max(0, x1 - border)
        ey1 = max(0, y1 - border)
        ex2 = min(width, x2 + border)
        ey2 = min(height, y2 + border)
        sx1 = ex1 - (x1 - border)
        sy1 = ey1 - (y1 - border)
        sx2 = sx1 + (ex2 - ex1)
        sy2 = sy1 + (ey2 - ey1)
        source = extended[sy1:sy2, sx1:sx2]

        alpha_full = np.zeros((height, width), dtype=np.float32)
        for distance in range(pixels, 0, -1):
            weight = (pixels - distance + 1) / (pixels + 1)
            ax1 = max(0, x1 - distance)
            ay1 = max(0, y1 - distance)
            ax2 = min(width, x2 + distance)
            ay2 = min(height, y2 + distance)
            alpha_full[ay1:ay2, ax1:ax2] = weight
        alpha_full[y1:y2, x1:x2] = 1.0
        candidate = base_array.copy()
        candidate[ey1:ey2, ex1:ex2] = source
        result = multiband_blend(base_array, candidate, alpha_full)

        support = pixels * 4
        keep = np.zeros((height, width), dtype=bool)
        keep[
            max(0, y1 - support) : min(height, y2 + support),
            max(0, x1 - support) : min(width, x2 + support),
        ] = True
        result[~keep] = base_array[~keep]
        return Image.fromarray(result, "RGB")

    base_array = np.asarray(base.convert("RGB")).copy()
    height, width = base_array.shape[:2]
    selected_level = (
        np.asarray(
            decode_selection_mask(selection_mask, (width, height)), dtype=np.float32
        )
        / 255.0
    )
    selected = selected_level > (8.0 / 255.0)
    if not np.any(selected):
        raise ValueError("涂抹选区为空")

    target_selected = selected[y1:y2, x1:x2]
    if not np.any(target_selected):
        raise ValueError("涂抹选区不在修改区域内")
    patch_rgb = np.asarray(patch.convert("RGB"))
    target_patch = base_array[y1:y2, x1:x2]
    patch_rgb = match_patch_boundary(
        patch_rgb, target_patch, target_selected.astype(np.uint8) * 255
    )

    candidate = base_array.copy()
    candidate_target = candidate[y1:y2, x1:x2]
    candidate_target[target_selected] = patch_rgb[target_selected]

    outside = (~selected).astype(np.uint8)
    distance = cv2.distanceTransform(outside, cv2.DIST_L2, 3)
    alpha_full = np.maximum(
        selected_level,
        np.clip(1.0 - distance / (max(1, int(pixels)) + 1.0), 0.0, 1.0),
    )
    result = multiband_blend(base_array, candidate, alpha_full)

    support_pixels = max(1, int(pixels)) * 4
    kernel_size = support_pixels * 2 + 1
    support = cv2.dilate(
        selected.astype(np.uint8),
        np.ones((kernel_size, kernel_size), dtype=np.uint8),
    ).astype(bool)
    result[~support] = base_array[~support]
    return Image.fromarray(result, "RGB")


def _adaptive_blend_radius(box, pixels, selection_mask=None):
    x1, y1, x2, y2 = box
    effective_width, effective_height = x2 - x1, y2 - y1
    if selection_mask is not None:
        mask_array = np.asarray(decode_selection_mask(selection_mask))
        points = cv2.findNonZero((mask_array > 8).astype(np.uint8))
        if points is not None:
            _, _, mask_width, mask_height = cv2.boundingRect(points)
            effective_width = min(effective_width, mask_width)
            effective_height = min(effective_height, mask_height)
    region_scale = round(min(effective_width, effective_height) * 0.015)
    return max(3, min(32, max(int(pixels), region_scale)))


def _blend_inputs(base, patch, box, selection_mask):
    """Return aligned RGB arrays and a full-size editable alpha mask."""
    x1, y1, x2, y2 = box
    target_size = (x2 - x1, y2 - y1)
    if patch.size != target_size:
        patch = patch.resize(target_size, Image.Resampling.LANCZOS)

    base_array = np.asarray(base.convert("RGB")).copy()
    patch_array = np.asarray(patch.convert("RGB"))
    height, width = base_array.shape[:2]
    alpha = np.zeros((height, width), dtype=np.float32)
    if selection_mask is None:
        alpha[y1:y2, x1:x2] = 1.0
        local_mask = None
    else:
        alpha = (
            np.asarray(
                decode_selection_mask(selection_mask, (width, height)),
                dtype=np.float32,
            )
            / 255.0
        )
        alpha[:y1] = 0.0
        alpha[y2:] = 0.0
        alpha[:, :x1] = 0.0
        alpha[:, x2:] = 0.0
        local_mask = alpha[y1:y2, x1:x2]
    if not np.any(alpha > (8.0 / 255.0)):
        raise ValueError("涂抹选区为空")

    target = base_array[y1:y2, x1:x2]
    patch_array = _lab_harmonize_patch(patch_array, target, local_mask)
    candidate = base_array.copy()
    candidate[y1:y2, x1:x2] = patch_array
    return base_array, candidate, np.clip(alpha, 0.0, 1.0)


def _lab_harmonize_patch(patch, target, selection_level=None):
    """Apply a bounded Lab correction near the editable boundary only."""
    height, width = patch.shape[:2]
    if selection_level is None:
        selected = np.ones((height, width), dtype=np.uint8)
    else:
        selected = (selection_level > (8.0 / 255.0)).astype(np.uint8)
    thickness = max(2, min(8, min(width, height) // 8))
    eroded = cv2.erode(selected, np.ones((3, 3), np.uint8), iterations=thickness)
    ring = selected.astype(bool) & ~eroded.astype(bool)
    if np.count_nonzero(ring) < 12:
        ring = selected.astype(bool)

    patch_lab = cv2.cvtColor(patch, cv2.COLOR_RGB2LAB).astype(np.float32)
    target_lab = cv2.cvtColor(target, cv2.COLOR_RGB2LAB).astype(np.float32)
    difference = np.linalg.norm(patch_lab - target_lab, axis=2)
    cutoff = float(np.percentile(difference[ring], 65))
    samples = ring & (difference <= cutoff)
    if np.count_nonzero(samples) < 8:
        samples = ring

    patch_l = patch_lab[:, :, 0][samples]
    target_l = target_lab[:, :, 0][samples]
    patch_iqr = float(np.percentile(patch_l, 75) - np.percentile(patch_l, 25))
    target_iqr = float(np.percentile(target_l, 75) - np.percentile(target_l, 25))
    gain = np.clip(target_iqr / max(patch_iqr, 1.0), 0.88, 1.12)
    offsets = np.median(target_lab[samples] - patch_lab[samples], axis=0)
    offsets[0] = np.clip(offsets[0], -24.0, 24.0)
    offsets[1:] = np.clip(offsets[1:], -12.0, 12.0)

    distance = cv2.distanceTransform(selected, cv2.DIST_L2, 5)
    decay = np.exp(-distance / max(4.0, min(width, height) * 0.08))
    decay = np.maximum(decay, ring.astype(np.float32))[:, :, None]
    corrected = patch_lab.copy()
    corrected_l = (patch_lab[:, :, 0] - np.median(patch_l)) * gain + np.median(target_l)
    corrected[:, :, 0] += (corrected_l - patch_lab[:, :, 0]) * decay[:, :, 0]
    corrected[:, :, 1:] += offsets[None, None, 1:] * decay
    return cv2.cvtColor(np.clip(corrected, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)


def _srgb_to_linear(array):
    value = array.astype(np.float32) / 255.0
    return np.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(array):
    value = np.clip(array, 0.0, 1.0)
    encoded = np.where(
        value <= 0.0031308,
        value * 12.92,
        1.055 * np.power(value, 1.0 / 2.4) - 0.055,
    )
    return np.clip(encoded * 255.0 + 0.5, 0, 255).astype(np.uint8)


def _normalized_detail_maps(base_array):
    gray = cv2.cvtColor(base_array, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    gradient = gradient_image(gray)
    mean = cv2.GaussianBlur(gray, (0, 0), 2.0)
    variance = np.maximum(cv2.GaussianBlur(gray * gray, (0, 0), 2.0) - mean * mean, 0.0)
    texture = np.sqrt(variance)

    def normalize(values):
        scale = max(float(np.percentile(values, 95)), 1e-4)
        return np.clip(values / scale, 0.0, 1.0)

    return normalize(gradient), normalize(texture)


def _inner_alpha(mask_level, radius, edge_map=None):
    selected = (mask_level > (8.0 / 255.0)).astype(np.uint8)
    distance = cv2.distanceTransform(selected, cv2.DIST_L2, 5)
    if edge_map is None:
        local_radius = float(radius)
    else:
        local_radius = np.maximum(1.5, radius * (1.0 - 0.72 * edge_map))
    progress = np.clip(distance / local_radius, 0.0, 1.0)
    smooth = progress * progress * (3.0 - 2.0 * progress)
    return np.minimum(smooth, mask_level)


def blend_color_light(base, patch, box, pixels=FEATHER_PIXELS, selection_mask=None):
    """Lab harmonization + linear-light, edge-aware dual-frequency blending."""
    base_array, candidate, mask_level = _blend_inputs(base, patch, box, selection_mask)
    radius = _adaptive_blend_radius(box, pixels, selection_mask)
    edge, _ = _normalized_detail_maps(base_array)
    alpha_low = _inner_alpha(mask_level, radius * 1.8, edge * 0.45)[:, :, None]
    alpha_high = _inner_alpha(mask_level, max(2.0, radius * 0.65), edge)[:, :, None]

    base_linear = _srgb_to_linear(base_array)
    candidate_linear = _srgb_to_linear(candidate)
    sigma = max(1.5, radius * 1.35)
    base_low = cv2.GaussianBlur(base_linear, (0, 0), sigma)
    candidate_low = cv2.GaussianBlur(candidate_linear, (0, 0), sigma)
    base_high = base_linear - base_low
    candidate_high = candidate_linear - candidate_low
    result = (
        base_low * (1.0 - alpha_low)
        + candidate_low * alpha_low
        + base_high * (1.0 - alpha_high)
        + candidate_high * alpha_high
    )
    return Image.fromarray(_linear_to_srgb(result), "RGB")


def blend_confidence(
    base,
    patch,
    box,
    pixels=FEATHER_PIXELS,
    selection_mask=None,
    components=None,
):
    """Choose between stable blends using measured boundary residuals."""
    base_array, _, mask_level = _blend_inputs(base, patch, box, selection_mask)
    radius = _adaptive_blend_radius(box, pixels, selection_mask)
    components = components or {}
    color_image = components.get("color_light") or blend_color_light(
        base, patch, box, pixels, selection_mask
    )
    original_image = components.get("original") or feather_patch(
        base, patch, box, pixels, selection_mask
    )
    color = np.asarray(color_image, dtype=np.uint8)
    original = np.asarray(original_image, dtype=np.uint8)
    base_gray = cv2.cvtColor(base_array, cv2.COLOR_RGB2GRAY).astype(np.float32)
    selected = (mask_level > (8.0 / 255.0)).astype(np.uint8)
    ring_kernel = np.ones(
        (max(3, radius // 2) * 2 + 1, max(3, radius // 2) * 2 + 1), np.uint8
    )
    ring = cv2.dilate(selected, ring_kernel).astype(bool)
    ring &= ~cv2.erode(selected, ring_kernel).astype(bool)
    base_lab = cv2.cvtColor(base_array, cv2.COLOR_RGB2LAB).astype(np.float32)
    ring_scores = []
    for candidate_image in (original, color):
        candidate_lab = cv2.cvtColor(candidate_image, cv2.COLOR_RGB2LAB).astype(
            np.float32
        )
        color_error = np.linalg.norm(candidate_lab - base_lab, axis=2) / 40.0
        candidate_gray = cv2.cvtColor(candidate_image, cv2.COLOR_RGB2GRAY).astype(
            np.float32
        )
        gradient_error = (
            np.abs(
                cv2.Laplacian(candidate_gray, cv2.CV_32F)
                - cv2.Laplacian(base_gray, cv2.CV_32F)
            )
            / 64.0
        )
        score = np.clip(0.62 * color_error + 0.38 * gradient_error, 0.0, 4.0)
        values = score[ring]
        ring_scores.append(float(np.median(values)) if values.size else 1.0)

    # Use the measured seam quality as a global prior, then allow a soft local
    # choice near the boundary. The original blend remains a stabilizing floor.
    scores = np.asarray(ring_scores, dtype=np.float32)
    quality = np.exp(-np.clip(scores - scores.min(), 0.0, 3.0) * 1.8)
    quality = quality / max(float(quality.sum()), 1e-6)
    candidate_stack = np.stack(
        [_srgb_to_linear(original), _srgb_to_linear(color)],
        axis=0,
    )
    weighted = np.tensordot(quality, candidate_stack, axes=(0, 0))
    local_edge = _normalized_detail_maps(base_array)[0]
    boundary_blend = _inner_alpha(mask_level, radius * 1.25, local_edge * 0.65)
    boundary_blend = cv2.GaussianBlur(boundary_blend, (0, 0), max(1.0, radius * 0.25))
    boundary_blend = np.clip(boundary_blend, 0.0, 1.0)[:, :, None]
    result = (
        _srgb_to_linear(base_array) * (1.0 - boundary_blend) + weighted * boundary_blend
    )
    return Image.fromarray(_linear_to_srgb(result), "RGB")


BLEND_PIPELINES = (
    ("original", "原始多频段", feather_patch),
    ("color_light", "色光优先", blend_color_light),
    ("confidence", "置信度自适应", blend_confidence),
)


def correction_layer(original, corrected, threshold=0):
    """Return an RGBA layer that reproduces corrected over original."""
    original_array = np.asarray(original.convert("RGB"))
    corrected_array = np.asarray(corrected.convert("RGB"))
    delta = np.max(
        np.abs(corrected_array.astype(np.int16) - original_array.astype(np.int16)),
        axis=2,
    )
    changed = delta > int(threshold)
    overlay = np.zeros((*original_array.shape[:2], 4), dtype=np.uint8)
    overlay[:, :, :3] = corrected_array
    overlay[changed, 3] = 255
    return Image.fromarray(overlay, "RGBA")


def generate_correction_overlay(
    page_image,
    target_box,
    context_pixels=24,
    feather_pixels=FEATHER_PIXELS,
    prompt=PATCH_PROMPT,
    model=None,
    cancel_check=None,
    selection_mask=None,
    output_size=None,
    reference_images=None,
    generation_options=None,
    full_image_edit=False,
    count=1,
):
    """Generate one or more full images / transparent overlays.

    Local edits return one item per blend pipeline as
    ``(overlay, box, method, label, source_index, comparison, alignment)``. A full-image
    edit with a mask returns the aligned full result, the unaligned full
    result, and a confidence composite; an unmasked full-image edit keeps the
    direct result only.
    """
    page = page_image.convert("RGB")
    x1, y1, x2, y2 = _clamp_box(target_box, page.width, page.height)
    count = max(1, int(count or 1))
    if full_image_edit:
        editable_mask = (
            decode_selection_mask(selection_mask, page.size) if selection_mask else None
        )
        generated_list = edit_patch(
            page,
            editable_box=None,
            prompt=prompt,
            model=model,
            cancel_check=cancel_check,
            editable_mask=editable_mask,
            output_size=output_size,
            reference_images=reference_images,
            generation_options=generation_options,
            count=count,
            reference_size=page.size,
        )
        results = []
        full_box = (0, 0, page.width, page.height)
        for index, generated in enumerate(generated_list, start=1):
            if editable_mask is None:
                results.append(
                    (
                        generated.convert("RGBA"),
                        (0, 0, generated.width, generated.height),
                        "direct",
                        "整图生成",
                        index,
                        False,
                        {"moved": False, "dx": 0, "dy": 0, "improvement": 0.0},
                    )
                )
                continue
            aligned_generated, alignment = align_generated_to_source(
                page, generated, editable_mask, return_info=True
            )
            results.append(
                (
                    aligned_generated.convert("RGBA"),
                    full_box,
                    "full_original",
                    "对位后整图",
                    index,
                    True,
                    alignment,
                )
            )
            # Keep the raw model output available for comparison. The aligned
            # result is useful for judging registration, while the confidence
            # layer is the compositing result used on the canvas.
            results.append(
                (
                    generated.convert("RGBA"),
                    full_box,
                    "pre_alignment",
                    "未对齐生成图",
                    index,
                    True,
                    alignment,
                )
            )
            corrected = blend_confidence(
                page,
                aligned_generated,
                full_box,
                pixels=max(1, int(feather_pixels)),
                selection_mask=editable_mask,
            )
            results.append(
                (
                    correction_layer(page, corrected),
                    full_box,
                    "confidence",
                    "置信度自适应",
                    index,
                    True,
                    alignment,
                )
            )
        return results
    if (
        selection_mask is None
        and x1 == 0
        and y1 == 0
        and x2 == page.width
        and y2 == page.height
    ):
        generated_list = edit_patch(
            page,
            editable_box=None,
            prompt=prompt,
            model=model,
            cancel_check=cancel_check,
            output_size=output_size,
            reference_images=reference_images,
            generation_options=generation_options,
            count=count,
            reference_size=page.size,
        )
        return [
            (
                generated.convert("RGBA"),
                (0, 0, generated.width, generated.height),
                "direct",
                "整图生成",
                index,
                False,
                {"moved": False, "dx": 0, "dy": 0, "improvement": 0.0},
            )
            for index, generated in enumerate(generated_list, start=1)
        ]
    margin = max(int(context_pixels), int(feather_pixels) * 4)
    overlay_box = (
        max(0, x1 - margin),
        max(0, y1 - margin),
        min(page.width, x2 + margin),
        min(page.height, y2 + margin),
    )
    ox1, oy1, ox2, oy2 = overlay_box
    context = page.crop(overlay_box)
    local_target = (x1 - ox1, y1 - oy1, x2 - ox1, y2 - oy1)

    context_mask = None
    if selection_mask is not None:
        page_mask = np.asarray(decode_selection_mask(selection_mask, page.size)).copy()
        page_mask[:y1] = 0
        page_mask[y2:] = 0
        page_mask[:, :x1] = 0
        page_mask[:, x2:] = 0
        if not np.any(page_mask > 8):
            raise ValueError("涂抹选区为空")
        context_mask = Image.fromarray(page_mask[oy1:oy2, ox1:ox2], "L")

    if prompt == PATCH_PROMPT and model is None and context_mask is None:
        kwargs = {"editable_box": local_target}
        if cancel_check is not None:
            kwargs["cancel_check"] = cancel_check
        kwargs["reference_images"] = reference_images
        kwargs["count"] = count
        generated_context_list = edit_patch(context, **kwargs)
    else:
        generated_context_list = edit_patch(
            context,
            editable_box=local_target,
            prompt=prompt,
            model=model,
            cancel_check=cancel_check,
            editable_mask=context_mask,
            reference_images=reference_images,
            count=count,
        )
    results = []
    for source_index, generated_context in enumerate(generated_context_list, start=1):
        aligned_context, alignment = align_generated_to_source(
            context, generated_context, context_mask, return_info=True
        )
        generated_target = aligned_context.crop(local_target)
        computed = {}
        for method, label, pipeline in BLEND_PIPELINES:
            kwargs = {
                "pixels": max(1, int(feather_pixels)),
                "selection_mask": context_mask,
            }
            if method == "confidence":
                kwargs["components"] = computed
            corrected_context = pipeline(
                context, generated_target, local_target, **kwargs
            )
            computed[method] = corrected_context
            results.append(
                (
                    correction_layer(context, corrected_context),
                    overlay_box,
                    method,
                    label,
                    source_index,
                    True,
                    alignment,
                )
            )
    return results


def save_png(image, output_path, source_info):
    options = {}
    for key in ("icc_profile", "exif", "dpi"):
        if key in source_info:
            options[key] = source_info[key]
    image.save(output_path, "PNG", **options)


def save_correction_layer(original, corrected, output_path):
    """Save an RGBA overlay that reproduces the corrected image at position (0, 0)."""
    layer = correction_layer(original, corrected)
    layer.save(output_path, "PNG")

    reconstructed = Image.alpha_composite(original.convert("RGBA"), layer).convert(
        "RGB"
    )
    if not np.array_equal(
        np.asarray(reconstructed), np.asarray(corrected.convert("RGB"))
    ):
        raise RuntimeError("correction layer verification failed")


def main():
    os.makedirs(OUTPUT_FOLDER, exist_ok=True)
    image_paths = [
        os.path.join(INPUT_FOLDER, name)
        for name in sorted(os.listdir(INPUT_FOLDER))
        if name.lower().endswith(IMAGE_EXTENSIONS)
    ]
    if len(image_paths) < 2:
        raise SystemExit("img_input must contain one base image and at least one crop")

    sizes = {}
    for path in image_paths:
        with Image.open(path) as image:
            sizes[path] = image.size
    base_path = max(image_paths, key=lambda path: sizes[path][0] * sizes[path][1])
    crop_paths = [path for path in image_paths if path != base_path]

    with Image.open(base_path) as source:
        source.load()
        result = source.convert("RGB")
        original = result.copy()
        reference = np.asarray(result).copy()
        source_info = source.info.copy()

    print(f"Model: {get_model_config()['model']}")
    print(f"Base image: {os.path.basename(base_path)}")
    for index, crop_path in enumerate(crop_paths, 1):
        with Image.open(crop_path) as crop_source:
            crop_source.load()
            crop = crop_source.convert("RGB")
        box, score, scale = locate_patch_pyramid(reference, np.asarray(crop))
        print(
            f"[{index}/{len(crop_paths)}] {os.path.basename(crop_path)}: "
            f"box={box}, confidence={score:.4f}, scale={scale:.2f}"
        )
        clean_crop = edit_patch(crop)[0]
        result = feather_patch(result, clean_crop, box)

    stem = os.path.splitext(os.path.basename(base_path))[0]
    output_path = os.path.join(OUTPUT_FOLDER, f"{stem}_no_text.png")
    layer_path = os.path.join(OUTPUT_FOLDER, f"{stem}_correction_layer.png")
    save_png(result, output_path, source_info)
    save_correction_layer(original, result, layer_path)
    print(f"Saved: {output_path} ({result.width}x{result.height})")
    print(f"Saved correction layer: {layer_path}")


if __name__ == "__main__":
    main()
