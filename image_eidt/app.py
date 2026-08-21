"""Standalone image editor using the project's expert image-editing pipeline."""

import base64
import io
import json
import logging
import threading
import uuid
from pathlib import Path

import webview
from PIL import Image, ImageChops

LOG_PATH = Path(__file__).with_name("image_edit_debug.log")
logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    encoding="utf-8",
)
logger = logging.getLogger(__name__)


from image_edit import (
    add_image_model,
    update_image_model,
    delete_image_model,
    generate_correction_overlay,
    correction_layer,
    blend_confidence,
    align_generated_to_source,
    decode_selection_mask,
    confidence_patch_layer,
    OutputSizeMismatch,
    image_model_capability,
    load_image_model_config,
    get_model_config,
    set_current_image_model,
)


def _data_url(image: Image.Image, fmt="PNG"):
    stream = io.BytesIO()
    image.save(stream, fmt)
    encoded = base64.b64encode(stream.getvalue()).decode("ascii")
    return f"data:image/{fmt.lower()};base64,{encoded}"


class ImageEditorAPI:
    def __init__(self):
        self._window = None
        self.image = None
        self.image_path = None
        self._cancel_events = {}

    def open_image(self):
        result = self._window.create_file_dialog(
            webview.FileDialog.OPEN,
            file_types=(
                "Images (*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif)",
                "All files (*.*)",
            ),
        )
        if not result:
            return json.dumps({"cancelled": True})
        path = Path(result[0])
        self.image = Image.open(path).convert("RGB")
        self.image_path = path
        return self.get_slide_data()

    def open_image_data(self, image_data):
        """Open an image passed directly as a data URL (e.g. exported from the roomspace view)."""
        try:
            encoded = str(image_data).split(",", 1)[-1]
            image = Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB")
            self.image = image
            self.image_path = None
            return self.get_slide_data()
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)

    def save_image(self, image_data):
        if self.image is None:
            return json.dumps({"error": "请先打开图片"}, ensure_ascii=False)
        try:
            encoded = str(image_data).split(",", 1)[-1]
            image = Image.open(io.BytesIO(base64.b64decode(encoded)))
            default_name = (
                f"{self.image_path.stem}_edited.png"
                if self.image_path
                else "edited.png"
            )
            result = self._window.create_file_dialog(
                webview.FileDialog.SAVE,
                save_filename=default_name,
                file_types=(
                    "PNG image (*.png)",
                    "JPEG image (*.jpg;*.jpeg)",
                    "WebP image (*.webp)",
                ),
            )
            if not result:
                return json.dumps({"cancelled": True})
            path = Path(result[0] if isinstance(result, (list, tuple)) else result)
            if not path.suffix:
                path = path.with_suffix(".png")
            suffix = path.suffix.lower()
            if suffix in {".jpg", ".jpeg"}:
                image.convert("RGB").save(path, "JPEG", quality=95)
            elif suffix == ".webp":
                image.save(path, "WEBP", quality=95)
            else:
                image.save(path, "PNG")
            return json.dumps({"success": True, "path": str(path)}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)

    def resize_image_data(
        self,
        image_data,
        width,
        height,
        source_image=None,
        selection_mask=None,
        fit_to_source=False,
    ):
        request_id = uuid.uuid4().hex[:8]
        logger.info(
            "resize start id=%s input=%s target=%sx%s source=%s mask=%s",
            request_id,
            len(str(image_data or "")),
            width,
            height,
            bool(source_image),
            bool(selection_mask),
        )
        try:
            encoded = str(image_data).split(",", 1)[-1]
            image = Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB")
            requested_size = (max(1, int(width)), max(1, int(height)))
            source = None
            if source_image:
                try:
                    source_encoded = str(source_image).split(",", 1)[-1]
                    source = Image.open(
                        io.BytesIO(base64.b64decode(source_encoded))
                    ).convert("RGB")
                    logger.info(
                        "resize source decoded id=%s source=%sx%s",
                        request_id,
                        source.width,
                        source.height,
                    )
                except Exception:
                    logger.exception("resize source decode failed id=%s", request_id)
                    source = None
            target_size = (
                source.size
                if fit_to_source and source is not None
                else requested_size
            )
            resized = image.resize(target_size, Image.Resampling.LANCZOS)
            logger.info(
                "resize target id=%s requested=%sx%s effective=%sx%s fit_to_source=%s",
                request_id,
                requested_size[0],
                requested_size[1],
                target_size[0],
                target_size[1],
                bool(fit_to_source),
            )
            mask_protected = bool(source_image and selection_mask)
            patch_image = None
            pre_alignment = resized.copy() if mask_protected else None
            if mask_protected:
                # Match the normal full-image flow: resize first, then align the
                # generated image, then produce the confidence-fused patch.
                source_target = source.resize(target_size, Image.Resampling.LANCZOS)
                aligned, alignment = align_generated_to_source(
                    source_target, resized, selection_mask, return_info=True
                )
                corrected = blend_confidence(
                    source_target,
                    aligned,
                    (0, 0, target_size[0], target_size[1]),
                    selection_mask=selection_mask,
                )
                resized = aligned
                patch_image = correction_layer(source_target, corrected)
                # correction_layer detects pixel differences, while confidence
                # blending feathers across the boundary. Keep that blend, but
                # constrain the returned patch to the actual selection mask.
                patch_mask = decode_selection_mask(selection_mask, target_size)
                patch_image.putalpha(
                    ImageChops.multiply(patch_image.getchannel("A"), patch_mask)
                )
            else:
                alignment = {"moved": False, "dx": 0, "dy": 0}
            payload = {
                "imageData": _data_url(resized),
                "width": resized.width,
                "height": resized.height,
                "maskProtected": mask_protected,
                "alignmentMoved": bool(alignment.get("moved")),
                "alignmentDx": int(alignment.get("dx", 0)),
                "alignmentDy": int(alignment.get("dy", 0)),
            }
            if pre_alignment is not None:
                payload["preAlignmentImageData"] = _data_url(pre_alignment)
            if patch_image is not None:
                payload["patchImageData"] = _data_url(patch_image)
                payload["patchWidth"] = patch_image.width
                payload["patchHeight"] = patch_image.height
            result = json.dumps(payload, ensure_ascii=False)
            logger.info(
                "resize success id=%s output=%sx%s patch=%s",
                request_id,
                resized.width,
                resized.height,
                "patchImageData" in payload,
            )
            return result
        except Exception as exc:
            logger.exception("resize failed id=%s", request_id)
            return json.dumps(
                {"error": str(exc), "requestId": request_id}, ensure_ascii=False
            )

    def create_patch_image_data(self, source_image, image_data, width, height):
        request_id = uuid.uuid4().hex[:8]
        logger.info(
            "patch start id=%s source=%s image=%s target=%sx%s",
            request_id,
            len(str(source_image or "")),
            len(str(image_data or "")),
            width,
            height,
        )
        try:
            source_encoded = str(source_image).split(",", 1)[-1]
            image_encoded = str(image_data).split(",", 1)[-1]
            source = Image.open(io.BytesIO(base64.b64decode(source_encoded))).convert("RGB")
            image = Image.open(io.BytesIO(base64.b64decode(image_encoded))).convert("RGB")
            target_size = (max(1, int(width)), max(1, int(height)))
            source = source.resize(target_size, Image.Resampling.LANCZOS)
            image = image.resize(target_size, Image.Resampling.LANCZOS)
            patch = correction_layer(source, image)
            alpha = patch.getchannel("A")
            encoded_patch = _data_url(patch)
            logger.info(
                "patch success id=%s output=%sx%s encoded=%s alpha_bbox=%s alpha_extrema=%s",
                request_id,
                patch.width,
                patch.height,
                len(encoded_patch),
                alpha.getbbox(),
                alpha.getextrema(),
            )
            return json.dumps(
                {"imageData": encoded_patch, "width": patch.width, "height": patch.height},
                ensure_ascii=False,
            )
        except Exception as exc:
            logger.exception("patch failed id=%s", request_id)
            return json.dumps({"error": str(exc), "requestId": request_id}, ensure_ascii=False)

    def create_mask_patch_image_data(self, base_image, source_layer_image, selection_mask):
        """Fuse a positioned source layer into the base only inside an editable mask."""
        request_id = uuid.uuid4().hex[:8]
        logger.info(
            "mask patch start id=%s base=%s source=%s mask=%s",
            request_id,
            len(str(base_image or "")),
            len(str(source_layer_image or "")),
            len(str(selection_mask or "")),
        )
        try:
            decode = lambda value, mode: Image.open(
                io.BytesIO(base64.b64decode(str(value).split(",", 1)[-1]))
            ).convert(mode)
            base = decode(base_image, "RGB")
            source = decode(source_layer_image, "RGBA").resize(base.size, Image.Resampling.LANCZOS)
            patch, alignment = confidence_patch_layer(base, source, selection_mask)
            return json.dumps(
                {
                    "imageData": _data_url(patch),
                    "width": patch.width,
                    "height": patch.height,
                    "blendMethod": "confidence",
                    "blendLabel": "置信度补丁",
                    "alignmentMoved": bool(alignment.get("moved")),
                    "alignmentDx": int(alignment.get("dx", 0)),
                    "alignmentDy": int(alignment.get("dy", 0)),
                },
                ensure_ascii=False,
            )
        except Exception as exc:
            logger.exception("mask patch failed id=%s", request_id)
            return json.dumps({"error": str(exc), "requestId": request_id}, ensure_ascii=False)

    def debug_log(self, event, details=None):
        try:
            logger.info(
                "frontend event=%s details=%s",
                str(event),
                json.dumps(details or {}, ensure_ascii=False, default=str),
            )
            return json.dumps({"success": True})
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)

    def get_slide_data(self):
        # A transparent placeholder lets the canvas and thumbnail use the
        # active theme background instead of baking in a dark rectangle.
        image = self.image or Image.new("RGBA", (960, 640), (0, 0, 0, 0))
        return json.dumps(
            {
                "width": image.width,
                "height": image.height,
                "bg_image": _data_url(image),
                "masks": [],
                "advanced_masks": [],
                "texts": [],
                "page_info": {"current": 1, "total": 1},
            }
        )

    def get_hq_background(self, page_index=None):
        payload = json.loads(self.get_slide_data())
        return json.dumps({"bg_image": payload["bg_image"]})

    def get_image_models(self):
        try:
            config = load_image_model_config()
            return json.dumps(
                {
                    "current_model": config["current_model"],
                    "models": [
                        {
                            "id": m["id"],
                            "baseurl": m["baseurl"],
                            "model": m["model"],
                            "provider": m.get("provider", "未设置"),
                            "capability": image_model_capability(m["model"]),
                        }
                        for m in config["models"]
                    ],
                },
                ensure_ascii=False,
            )
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)

    def set_current_image_model(self, model):
        try:
            return json.dumps(
                {"success": True, "current_model": set_current_image_model(model)},
                ensure_ascii=False,
            )
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)

    def add_image_model(self, baseurl, key, model, provider="未设置"):
        try:
            models = add_image_model(baseurl, key, model, provider)
            return json.dumps({"success": True, "models": models}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)

    def update_image_model(
        self, original_model, baseurl, key, model, provider="未设置"
    ):
        try:
            models = update_image_model(original_model, baseurl, key, model, provider)
            return json.dumps({"success": True, "models": models}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)

    def delete_image_model(self, model):
        try:
            models = delete_image_model(model)
            return json.dumps({"success": True, "models": models}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)

    def expert_edit_image(
        self,
        x,
        y,
        w,
        h,
        prompt,
        model,
        job_id=None,
        selection_mask=None,
        source_image=None,
        output_width=None,
        output_height=None,
        reference_sources=None,
        output_preset=None,
        aspect_ratio=None,
        full_image_edit=False,
        count=1,
    ):
        if self.image is None:
            return json.dumps({"error": "请先打开图片"}, ensure_ascii=False)
        job_id = str(job_id or uuid.uuid4().hex)
        event = threading.Event()
        self._cancel_events[job_id] = event
        try:
            selected_model = get_model_config(model)
            edit_source = self.image
            if source_image:
                encoded = str(source_image).split(",", 1)[-1]
                edit_source = Image.open(io.BytesIO(base64.b64decode(encoded))).convert(
                    "RGB"
                )
            output_size = None
            generation_options = None
            if full_image_edit and output_width and output_height:
                output_size = (int(output_width), int(output_height))
            if full_image_edit and output_preset and aspect_ratio:
                generation_options = {
                    "image_size": str(output_preset).upper(),
                    "aspect_ratio": str(aspect_ratio),
                }
            reference_images = []
            for reference_source in reference_sources or []:
                encoded_reference = str(reference_source).split(",", 1)[-1]
                reference_images.append(
                    Image.open(io.BytesIO(base64.b64decode(encoded_reference))).convert(
                        "RGB"
                    )
                )
            overlays = generate_correction_overlay(
                edit_source,
                (x, y, x + w, y + h),
                prompt=prompt,
                model=model,
                cancel_check=event.is_set,
                selection_mask=selection_mask,
                output_size=output_size,
                reference_images=reference_images,
                generation_options=generation_options,
                full_image_edit=bool(full_image_edit),
                count=max(1, int(count or 1)),
            )
            results = []
            for (
                overlay,
                box,
                blend_method,
                blend_label,
                source_index,
                blend_comparison,
                alignment,
            ) in overlays:
                ox1, oy1, ox2, oy2 = box
                results.append(
                    {
                        "id": uuid.uuid4().hex,
                        "assetId": uuid.uuid4().hex,
                        "target": {"x": x, "y": y, "w": w, "h": h},
                        "overlay": {
                            "x": ox1,
                            "y": oy1,
                            "w": ox2 - ox1,
                            "h": oy2 - oy1,
                        },
                        "imageData": _data_url(overlay),
                        "blendMethod": blend_method,
                        "blendLabel": blend_label,
                        "sourceIndex": source_index,
                        "sourceCount": max(1, int(count or 1)),
                        "blendComparison": blend_comparison,
                        "alignmentMoved": bool(alignment.get("moved")),
                        "alignmentDx": int(alignment.get("dx", 0)),
                        "alignmentDy": int(alignment.get("dy", 0)),
                        "submittedModelId": selected_model["id"],
                        "submittedModel": selected_model["model"],
                        "submittedProvider": selected_model["provider"],
                    }
                )
            if len(results) == 1:
                return json.dumps(results[0])
            return json.dumps({"results": results}, ensure_ascii=False)
        except OutputSizeMismatch as exc:
            has_selection_mask = bool(selection_mask)
            mismatch_results = []
            for mismatch_image in exc.images:
                raw_image = mismatch_image.convert("RGB")
                mismatch_results.append({
                    "error": "size_mismatch",
                    "message": str(exc),
                    "requested": {
                        "width": exc.requested_size[0],
                        "height": exc.requested_size[1],
                    },
                    "actual": {
                        "width": raw_image.width,
                        "height": raw_image.height,
                    },
                    "baseurl": exc.baseurl,
                    "id": uuid.uuid4().hex,
                    "assetId": uuid.uuid4().hex,
                    "target": {"x": x, "y": y, "w": w, "h": h},
                    "overlay": {
                        "x": 0,
                        "y": 0,
                        "w": raw_image.width,
                        "h": raw_image.height,
                    },
                    "imageData": _data_url(raw_image),
                    "rawImageData": _data_url(raw_image),
                    "hasSelectionMask": has_selection_mask,
                    "submittedModelId": selected_model["id"],
                    "submittedModel": selected_model["model"],
                    "submittedProvider": selected_model["provider"],
                })
            payload = dict(mismatch_results[0])
            if len(mismatch_results) > 1:
                payload["results"] = mismatch_results
            return json.dumps(payload, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)
        finally:
            self._cancel_events.pop(job_id, None)

    def cancel_expert_edit(self, job_id):
        event = self._cancel_events.get(str(job_id or ""))
        if event:
            event.set()
        return json.dumps({"success": bool(event)})

    def save_roomspace_models(self, models_json):
        """Persist the roomspace model list to roomspace/public/models.json."""
        try:
            parsed = json.loads(models_json)
            if isinstance(parsed, list):
                parsed = {"models": parsed}
            if not isinstance(parsed, dict) or not isinstance(parsed.get("models"), list):
                raise ValueError("模型数据格式错误")
            target = _ROOMSPACE_ROOT / "public" / "models.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                json.dumps(parsed, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            return json.dumps(
                {"success": True, "path": str(target)}, ensure_ascii=False
            )
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)

    def save_roomspace_json(self, content, default_name="space.json"):
        """Save an exported roomspace JSON through the native file dialog."""
        try:
            result = self._window.create_file_dialog(
                webview.FileDialog.SAVE,
                save_filename=str(default_name or "space.json"),
                file_types=("JSON files (*.json)", "All files (*.*)"),
            )
            if not result:
                return json.dumps({"cancelled": True})
            path = Path(result[0] if isinstance(result, (list, tuple)) else result)
            if not path.suffix:
                path = path.with_suffix(".json")
            path.write_text(str(content), encoding="utf-8")
            return json.dumps({"success": True, "path": str(path)}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)

    @staticmethod
    def _theme_file():
        return Path(__file__).with_name("theme.json")

    def get_theme(self):
        try:
            config = json.loads(self._theme_file().read_text(encoding="utf-8"))
            return json.dumps(
                {"theme": config.get("theme", "light")}, ensure_ascii=False
            )
        except Exception:
            return json.dumps({"theme": "light"}, ensure_ascii=False)

    def set_theme(self, theme):
        theme = "dark" if str(theme).lower() == "dark" else "light"
        try:
            self._theme_file().write_text(
                json.dumps({"theme": theme}), encoding="utf-8"
            )
            return json.dumps({"success": True, "theme": theme}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)


_ROOMSPACE_ROOT = Path(__file__).resolve().parent.parent / "roomspace"
_THREE_VERSION = "0.162.0"

_ROOMSPACE_DARK_THEME = """
/* ---- 深色主题 ---- */
body[data-theme="dark"] { background:#1e2124; color:#d6dce1; }
body[data-theme="dark"] #app { background:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px),#1e2124; background-size:24px 24px; }
body[data-theme="dark"] .topbar { background:rgba(30,33,36,.9); border-bottom-color:rgba(255,255,255,.1); }
body[data-theme="dark"] .brand strong { color:#eef2f5; }
body[data-theme="dark"] .brand span:last-child { color:#9aa5ad; }
body[data-theme="dark"] .icon-button, body[data-theme="dark"] .mode-button, body[data-theme="dark"] .legend button { border-color:rgba(255,255,255,.16); color:#d6dce1; background:rgba(255,255,255,.05); }
body[data-theme="dark"] .icon-button:hover, body[data-theme="dark"] .mode-button:hover, body[data-theme="dark"] .legend button:hover { border-color:#2f8a63; background:#262a2e; }
body[data-theme="dark"] .mode-button[aria-pressed="true"] { color:#fff; background:#1f6b4c; border-color:#2f8a63; }
body[data-theme="dark"] .spec-panel { color:#d6dce1; border-color:rgba(255,255,255,.12); background:rgba(36,39,43,.93); box-shadow:0 16px 42px rgba(0,0,0,.5); }
body[data-theme="dark"] .spec-panel h1 { color:#eef2f5; }
body[data-theme="dark"] .spec-panel dt, body[data-theme="dark"] .spec-panel dd { color:#c6cdd3; }
body[data-theme="dark"] .spec-panel dl div { border-top-color:rgba(255,255,255,.1); }
body[data-theme="dark"] .eyebrow { color:#d06a4a; }
body[data-theme="dark"] .model-picker-button { border-color:rgba(255,255,255,.18); color:#d6dce1; background:rgba(255,255,255,.06); }
body[data-theme="dark"] .model-picker-button:hover, body[data-theme="dark"] .model-picker-button[aria-expanded="true"] { border-color:#2f8a63; background:#262a2e; }
body[data-theme="dark"] .model-picker-menu { border-color:rgba(255,255,255,.16); background:#262a2e; box-shadow:0 18px 45px rgba(0,0,0,.5); }
body[data-theme="dark"] .model-picker-option { color:#d6dce1; }
body[data-theme="dark"] .model-picker-option:hover { color:#5fd3a0; }
body[data-theme="dark"] .model-picker-item[aria-selected="true"] { background:rgba(47,138,99,.2); }
body[data-theme="dark"] .model-picker-delete { color:#9aa5ad; }
body[data-theme="dark"] .data-file-button { color:#5fd3a0; }
body[data-theme="dark"] .wall-controls { border-top-color:rgba(255,255,255,.1); color:#9aa5ad; }
body[data-theme="dark"] .wall-controls button { border-color:rgba(255,255,255,.16); color:#d6dce1; background:rgba(255,255,255,.05); }
body[data-theme="dark"] .wall-controls button[aria-pressed="false"] { background:#a34d32; border-color:#a34d32; color:#fff; }
body[data-theme="dark"] .quick-hide-toggle[aria-pressed="false"] { border-color:rgba(255,255,255,.16); background:rgba(255,255,255,.05); color:#d6dce1; }
body[data-theme="dark"] .focal-control, body[data-theme="dark"] .sun-controls, body[data-theme="dark"] .camera-presets { border-top-color:rgba(255,255,255,.1); color:#9aa5ad; }
body[data-theme="dark"] .focal-control output, body[data-theme="dark"] .sun-controls output { color:#eef2f5; }
body[data-theme="dark"] .sun-toggle b, body[data-theme="dark"] .sun-controls .sun-toggle b { color:#d6dce1; }
body[data-theme="dark"] .inline-number, body[data-theme="dark"] .camera-presets select, body[data-theme="dark"] .camera-presets input, body[data-theme="dark"] .output-field select, body[data-theme="dark"] .output-size input { background:#23272b; border-color:rgba(255,255,255,.16); color:#e5eaee; }
body[data-theme="dark"] .camera-presets button, body[data-theme="dark"] .output-location button, body[data-theme="dark"] .close-output { border-color:rgba(255,255,255,.16); background:#262a2e; color:#d6dce1; }
body[data-theme="dark"] .camera-presets>label, body[data-theme="dark"] .output-field span, body[data-theme="dark"] .output-location>span { color:#9aa5ad; }
body[data-theme="dark"] .save-image { border-color:#2f8a63; background:#1f6b4c; color:#fff; }
body[data-theme="dark"] .hint, body[data-theme="dark"] .scale-bar { color:#b8c2c9; }
body[data-theme="dark"] .hint { background:rgba(30,33,36,.86); border-left-color:#2f8a63; }
body[data-theme="dark"] .scale-bar span { border-color:#c6cdd3; }
body[data-theme="dark"] .loading { color:#cfd6db; background:#1e2124; }
body[data-theme="dark"] .loading span { border-color:rgba(95,211,160,.2); border-top-color:#2f8a63; }
body[data-theme="dark"] .space-dialog { color:#d6dce1; background:#2a2e33; border-color:rgba(255,255,255,.16); box-shadow:0 28px 80px rgba(0,0,0,.6); }
body[data-theme="dark"] .space-dialog p { color:#9aa5ad; }
body[data-theme="dark"] .dialog-field, body[data-theme="dark"] .dialog-file { color:#9aa5ad; }
body[data-theme="dark"] .dialog-field input, body[data-theme="dark"] .dialog-file input { background:#23272b; border-color:rgba(255,255,255,.16); color:#e5eaee; }
body[data-theme="dark"] .dialog-field input:focus, body[data-theme="dark"] .dialog-file input:focus { border-color:#2f8a63; box-shadow:0 0 0 3px rgba(47,138,99,.18); }
body[data-theme="dark"] .dialog-divider { color:#9aa5ad; }
body[data-theme="dark"] .dialog-divider::before, body[data-theme="dark"] .dialog-divider::after { background:rgba(255,255,255,.14); }
body[data-theme="dark"] .dialog-actions button { border-color:rgba(255,255,255,.16); background:#262a2e; color:#d6dce1; }
body[data-theme="dark"] .dialog-actions .confirm-button { border-color:#2f8a63; background:#1f6b4c; color:#fff; }
body[data-theme="dark"] .save-choice-list button { border-color:rgba(255,255,255,.16); background:#262a2e; color:#d6dce1; }
body[data-theme="dark"] .save-choice-list button:hover { border-color:#2f8a63; background:#2b3035; }
body[data-theme="dark"] .save-choice-list strong { color:#eef2f5; }
body[data-theme="dark"] .save-choice-list span { color:#9aa5ad; }
body[data-theme="dark"] .editor-head label { color:#9aa5ad; }
body[data-theme="dark"] .editor-head>button { border-color:#2f8a63; background:#262a2e; color:#5fd3a0; }
body[data-theme="dark"] .editor-head>button:last-of-type { color:#fff; background:#1f6b4c; }
body[data-theme="dark"] .editor-categories button { border-color:rgba(255,255,255,.16); background:#262a2e; color:#d6dce1; }
body[data-theme="dark"] .editor-categories button[aria-pressed="true"] { border-color:#a34d32; background:#a34d32; color:#fff; }
body[data-theme="dark"] .editor-categories button[data-mode="select"] { color:#d06a4a; }
body[data-theme="dark"] .editor-mode { background:rgba(47,138,99,.12); }
body[data-theme="dark"] .editor-mode strong { color:#eef2f5; }
body[data-theme="dark"] .editor-mode span { color:#9aa5ad; }
body[data-theme="dark"] .editor-properties label { color:#9aa5ad; }
body[data-theme="dark"] .editor-properties input[type="number"], body[data-theme="dark"] .editor-properties select { background:#23272b; border-color:rgba(255,255,255,.16); color:#e5eaee; }
body[data-theme="dark"] .editor-properties output { color:#eef2f5; }
body[data-theme="dark"] .editor-transform button { border-color:rgba(255,255,255,.16); background:#262a2e; color:#d6dce1; }
body[data-theme="dark"] .editor-transform button[aria-pressed="true"] { border-color:#1f6b4c; background:#1f6b4c; color:#fff; }
body[data-theme="dark"] .editor-delete { border-color:#a34d32; background:#262a2e; color:#e07b5a; }
body[data-theme="dark"] .editor-special-option { border-color:rgba(47,138,99,.35); background:rgba(47,138,99,.08); color:#d6dce1; }
body[data-theme="dark"] .editor-special-option strong { color:#eef2f5; }
body[data-theme="dark"] .editor-special-option small { color:#9aa5ad; }
body[data-theme="dark"] .editor-selection-box { border-color:#6a9ed6; background:rgba(74,131,190,.15); }
body[data-theme="dark"] .editor-selection-box.is-crossing { border-color:#3fa86e; background:rgba(47,138,99,.2); }
body[data-theme="dark"] .editor-mullion-mode { border-color:#2f8a63; background:#262a2e; color:#5fd3a0; }
body[data-theme="dark"] .editor-mullion-mode[aria-pressed="true"] { background:#1f6b4c; color:#fff; }
body[data-theme="dark"] .editor-view-camera { border-color:#2f8a63; background:#1f6b4c; }
body[data-theme="dark"] .output-frame { border-color:rgba(255,255,255,.85); box-shadow:0 0 0 9999px rgba(10,14,12,.72); }
body[data-theme="dark"] .focal-control input, body[data-theme="dark"] .sun-controls input[type="range"] { accent-color:#2f8a63; }
body[data-theme="dark"] .mode-button-primary { background:#a34d32; border-color:#a34d32; }
body[data-theme="dark"] .mode-button-primary:hover { background:#8d3f29; border-color:#8d3f29; }
"""


def _build_roomspace_html():
    """Bundle the roomspace (EROOM) web app into one self-contained HTML page.

    roomspace ships as ES-module sources that assume a bundler/server
    (CSS imports, `import 'three'`, fetch('/models.json')). Here we inline
    everything so it can run inside a desktop iframe served by pywebview:
    three.js is loaded from CDN via an import map, models.json is embedded,
    and saving falls back to localStorage.
    """
    root = _ROOMSPACE_ROOT
    index = (root / "index.html").read_text(encoding="utf-8")
    style_css = (root / "style.css").read_text(encoding="utf-8")
    overrides_css = (root / "overrides.css").read_text(encoding="utf-8")
    panel_css = (root / "panel-scroll.css").read_text(encoding="utf-8")
    editor_js = (root / "editor.js").read_text(encoding="utf-8").lstrip("\ufeff")
    main_js = (root / "main.js").read_text(encoding="utf-8").lstrip("\ufeff")
    models = (root / "public" / "models.json").read_text(encoding="utf-8")

    editor_js = "\n".join(
        line
        for line in editor_js.splitlines()
        if "import * as THREE from 'three'" not in line
    ).replace("export function createPlanEditor(", "function createPlanEditor(")

    main_lines = main_js.splitlines()
    while main_lines and main_lines[0].lstrip().startswith("import "):
        main_lines.pop(0)
    main_js = "\n".join(main_lines)

    old_save = (
        "async function saveModelsToSystem() {\n"
        "  const response = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models: loadedModels }, null, 2) });\n"
        "  if (!response.ok) throw new Error(await response.text() || '系统保存失败');\n"
        "  dataFileButton.textContent = 'models.json';\n"
        "  dataFileButton.title = 'models.json';\n"
        "  document.querySelector('.hint').textContent = '已保存到 public/models.json';\n"
        "}"
    )
    new_save = (
        "function saveModelsToSystem() {\n"
        "  return new Promise((resolve, reject) => {\n"
        "    const id = 'save-' + Date.now() + '-' + Math.random().toString(36).slice(2);\n"
        "    const timeout = setTimeout(() => { window.removeEventListener('message', handler); reject(new Error('保存超时')); }, 15000);\n"
        "    const handler = event => {\n"
        "      if (event.data && event.data.type === 'roomspace-save-models-result' && event.data.id === id) {\n"
        "        clearTimeout(timeout);\n"
        "        window.removeEventListener('message', handler);\n"
        "        if (event.data.ok) { resolve(); }\n"
        "        else reject(new Error(event.data.error || '系统保存失败'));\n"
        "      }\n"
        "    };\n"
        "    window.addEventListener('message', handler);\n"
        "    window.parent.postMessage({ type: 'roomspace-save-models', id, models: loadedModels }, '*');\n"
        "  }).then(() => {\n"
        "    dataFileButton.textContent = 'models.json';\n"
        "    dataFileButton.title = 'models.json';\n"
        "    document.querySelector('.hint').textContent = '已保存到 public/models.json';\n"
        "  });\n"
        "}"
    )
    if old_save in main_js:
        main_js = main_js.replace(old_save, new_save)

    old_fetch = (
        "fetch(`/models.json?v=${Date.now()}`, { cache: 'no-store' })\n"
        "  .then(response => {\n"
        "    if (!response.ok) throw new Error(`模型数据请求失败：${response.status}`);\n"
        "    return response.json();\n"
        "  })\n"
        "  .then(data => {\n"
        "    if (!Array.isArray(data.models) || data.models.length === 0) throw new Error('models.json 中没有可用模型');\n"
        "    populateModels(data.models);\n"
        "    document.querySelector('#loading').classList.add('done');\n"
        "  })\n"
        "  .catch(error => {\n"
        "    console.error(error);\n"
        "    document.querySelector('#loading').textContent = '模型数据加载失败';\n"
        "  });"
    )
    new_fetch = (
        "(function loadInitialModels() {\n"
        "  let source = EMBEDDED_MODELS;\n"
        "  try {\n"
        "    if (!Array.isArray(source.models) || source.models.length === 0) throw new Error('内置模型数据为空');\n"
        "    populateModels(source.models);\n"
        "    document.querySelector('#loading').classList.add('done');\n"
        "  } catch (error) {\n"
        "    console.error(error);\n"
        "    document.querySelector('#loading').textContent = '模型数据加载失败';\n"
        "  }\n"
        "})();"
    )
    if old_fetch in main_js:
        main_js = main_js.replace(old_fetch, new_fetch)

    app_start = index.find('<main id="app">')
    app_end = index.find("</main>")
    if app_start == -1 or app_end == -1:
        raise RuntimeError('roomspace/index.html: 找不到 <main id="app"> 结构')
    app_markup = index[app_start : app_end + len("</main>")]

    export_integration = "\n".join(
        [
            "",
            "/* ---- 输出到图片编辑 ---- */",
            "(function integrateExportToImageEdit() {",
            "  const outputPanel = document.querySelector('#outputPanel');",
            "  if (!outputPanel) return;",
            "  const exportButton = document.createElement('button');",
            "  exportButton.id = 'exportToImageEdit';",
            "  exportButton.type = 'button';",
            "  exportButton.className = 'save-image';",
            "  exportButton.textContent = '输出到图片编辑';",
            "  exportButton.style.marginTop = '7px';",
            "  exportButton.addEventListener('click', async event => {",
            "    const button = event.currentTarget;",
            "    const width = Math.min(8192, Math.max(64, Number(outputWidth.value)));",
            "    const height = Math.min(8192, Math.max(64, Number(outputHeight.value)));",
            "    button.disabled = true;",
            "    button.textContent = '正在导出…';",
            "    try {",
            "      const blob = await renderOutputBlob(width, height);",
            "      const imageData = await new Promise((resolve, reject) => {",
            "        const reader = new FileReader();",
            "        reader.onload = () => resolve(reader.result);",
            "        reader.onerror = () => reject(new Error('图片读取失败'));",
            "        reader.readAsDataURL(blob);",
            "      });",
            "      window.parent.postMessage({ type: 'roomspace-export', imageData, width, height }, '*');",
            "      document.querySelector('.hint').textContent = '已发送到图片编辑';",
            "    } catch (error) {",
            "      console.error(error);",
            "      document.querySelector('.hint').textContent = '导出失败：' + (error.message || error);",
            "    } finally {",
            "      button.disabled = false;",
            "      button.textContent = '输出到图片编辑';",
            "    }",
            "  });",
            "  const closeOutput = document.querySelector('#closeOutput');",
            "  outputPanel.insertBefore(exportButton, closeOutput);",
            "})();",
        ]
    )

    theme_sync = "\n".join(
        [
            "",
            "/* ---- 主题同步 ---- */",
            "function applyRoomspaceTheme(theme) {",
            "  const isDark = theme === 'dark';",
            "  document.body.dataset.theme = isDark ? 'dark' : 'light';",
            "  const background = isDark ? 0x1e2124 : 0xdfe4df;",
            "  scene.background.setHex(background);",
            "  if (scene.fog) scene.fog.color.setHex(background);",
            "  renderer.setClearColor(background, 1);",
            "  renderer.render(scene, activeCamera);",
            "}",
            "window.addEventListener('message', event => {",
            "  const data = event.data;",
            "  if (data && data.type === 'roomspace-theme') {",
            "    applyRoomspaceTheme(data.theme);",
            "  }",
            "});",
            "applyRoomspaceTheme('light');",
            "window.parent.postMessage({ type: 'roomspace-ready' }, '*');",
        ]
    )

    module = "\n".join(
        [
            "import * as THREE from 'three';",
            "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';",
            "",
            "/* ---- editor.js ---- */",
            editor_js,
            "",
            "/* ---- main.js ---- */",
            main_js,
            export_integration,
            theme_sync,
        ]
    )

    three = "https://unpkg.com/three@%s" % _THREE_VERSION
    return "\n".join(
        [
            "<!doctype html>",
            '<html lang="zh-CN">',
            "<head>",
            '  <meta charset="UTF-8" />',
            '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
            "  <title>roomspace | 空间设计</title>",
            "  <style>"
            + style_css
            + overrides_css
            + panel_css
            + _ROOMSPACE_DARK_THEME
            + "</style>",
            "</head>",
            "<body>",
            "  " + app_markup,
            "  <script>window.EMBEDDED_MODELS = " + models + ";</script>",
            '  <script type="importmap">',
            '    { "imports": { "three": "'
            + three
            + '/build/three.module.js", "three/addons/": "'
            + three
            + '/examples/jsm/" } }',
            "  </script>",
            '  <script type="module">',
            module,
            "  </script>",
            "</body>",
            "</html>",
        ]
    )


def main():
    api = ImageEditorAPI()
    index_html = (Path(__file__).with_name("index.html")).read_text(encoding="utf-8")
    roomspace_html = _build_roomspace_html()
    placeholder = 'const ROOMSPACE_SRCDOC = "";'
    roomspace_js = json.dumps(roomspace_html, ensure_ascii=True).replace("</", "<\\/")
    if placeholder in index_html:
        index_html = index_html.replace(
            placeholder, "const ROOMSPACE_SRCDOC = " + roomspace_js + ";"
        )
    window = webview.create_window(
        "图片编辑", html=index_html, js_api=api, width=1440, height=900
    )
    api._window = window
    webview.start(debug=False)


if __name__ == "__main__":
    main()
