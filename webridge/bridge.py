import argparse
import base64
import json
import os
import subprocess
import sys
import time

import requests

sys.stdout.reconfigure(encoding="utf-8")

DAEMON_URL = "http://127.0.0.1:10086"
IMAGE_PATH = (
    r"C:\Users\Administrator\Desktop\Gemini_Generated_Image_92wruh92wruh92wr.jpg"
)
TEXT = "黑色背景改成暗红色"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads")


def webbridge_cmd(action, args=None, session="leaderai"):
    payload = {"action": action, "session": session}
    if args:
        payload["args"] = args
    resp = requests.post(f"{DAEMON_URL}/command", json=payload, timeout=120)
    data = resp.json()
    print(f"[{action}] {json.dumps(data, ensure_ascii=False)[:600]}")
    return data


def evaluate(code, session):
    return webbridge_cmd("evaluate", {"code": code}, session=session)


def click_js(selector, session):
    code = f"""(() => {{
      const el = document.querySelector({json.dumps(selector)});
      if (!el) return JSON.stringify({{ err: 'not found', selector: {json.dumps(selector)} }});
      el.click();
      return JSON.stringify({{ clicked: true, disabled: el.disabled }});
    }})()"""
    return evaluate(code, session)


def wait_until(check_code, session, timeout=30, interval=1, desc="condition"):
    # 轮询页面状态直到条件满足，优于固定 sleep：加载快时立即继续，慢时不会提前失败
    start = time.time()
    last = None
    while time.time() - start < timeout:
        r = evaluate(check_code, session)
        try:
            val = json.loads(r["data"]["value"])
            if val.get("ready"):
                print(f"[wait] {desc} ready ({time.time() - start:.1f}s)")
                return True
            last = val
        except Exception as e:
            print(f"[wait] {e}")
        time.sleep(interval)
    print(f"[wait] timeout waiting for {desc}: {last}")
    return False


def read_b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


def file_mime(path):
    # JS 里 File 的 type 必须与文件实际扩展名一致，
    # 否则 ChatGPT/Gemini 会因名实不符静默丢弃附件
    return MIME_BY_EXT.get(os.path.splitext(path)[1].lower(), "image/png")


# ============ ChatGPT ============

CHATGPT_EDITOR = "#prompt-textarea"


def chatgpt_wait_ready(session):
    code = """(() => JSON.stringify({ ready: !!document.querySelector('#prompt-textarea') }))()"""
    return wait_until(code, session, timeout=60, desc="chatgpt editor")


def _file_entries(image_paths):
    entries = []
    for image_path in image_paths:
        b64 = read_b64(image_path)
        filename = os.path.basename(image_path)
        mime = file_mime(image_path)
        entries.append((b64, filename, mime))
    return entries


def chatgpt_upload_image(session, image_paths=IMAGE_PATH):
    if isinstance(image_paths, str):
        image_paths = [image_paths]
    files = _file_entries(image_paths)
    expected = len(files)
    # 确认附件缩略图是否已出现在输入区（composer 内非头像的可见图片）
    check_code = """(() => {
      const ed = document.querySelector('#prompt-textarea');
      const form = ed ? ed.closest('form') : document;
      const imgs = Array.from(form.querySelectorAll('img')).filter(i => i.naturalWidth > 0 && !/profile/i.test(i.alt || ''));
      return JSON.stringify({ n: imgs.length });
    })()"""

    def build_code():
        parts = []
        for i, (b64, filename, mime) in enumerate(files):
            parts.append(
                f"""  const bin{i} = atob({json.dumps(b64)});
  const bytes{i} = new Uint8Array(bin{i}.length);
  for (let j = 0; j < bin{i}.length; j++) bytes{i}[j] = bin{i}.charCodeAt(j);
  const file{i} = new File([bytes{i}], {json.dumps(filename)}, {{ type: {json.dumps(mime)} }});"""
            )
        dt_lines = "\n".join(f"  dt.items.add(file{i});" for i in range(expected))
        return f"""(() => {{
{chr(10).join(parts)}
  const dt = new DataTransfer();
{dt_lines}
  const inputs = Array.from(document.querySelectorAll('input[type=file]'));
  const results = inputs.map((input, idx) => {{
    input.files = dt.files;
    input.dispatchEvent(new Event('change', {{ bubbles: true }}));
    return {{ idx, afterSet: input.files ? input.files.length : null }};
  }});
  return JSON.stringify({{ results }});
}})()"""

    # 页面刚就绪时 React 事件处理器可能尚未挂载，重试可兜住偶发丢事件
    for attempt in range(3):
        evaluate(build_code(), session)
        for _ in range(6):
            time.sleep(0.5)
            try:
                val = json.loads(evaluate(check_code, session)["data"]["value"])
                if val.get("n", 0) >= expected:
                    print(f"[upload] attachment mounted (attempt {attempt + 1})")
                    return {"ok": True, "attached": True, "n": val.get("n")}
            except Exception:
                pass
        print(f"[upload] attachment not detected, retry {attempt + 1}/3")
    print("[upload] attachment mount failed after retries")
    return {"ok": False, "attached": False}


def confirm_upload_dialog(session):
    # ChatGPT 会弹出 "You've already uploaded this file." 确认框，自动点 OK
    for _ in range(5):
        r = evaluate(
            """(() => {
          const dlg = document.querySelector('[role="dialog"]');
          if (!dlg) return JSON.stringify({ found: false });
          const ok = Array.from(dlg.querySelectorAll('button')).find(b => /ok|confirm/i.test(b.textContent || ''));
          if (ok) { ok.click(); return JSON.stringify({ found: true, clicked: true }); }
          return JSON.stringify({ found: true, clicked: false });
        })()""",
            session,
        )
        try:
            val = json.loads(r["data"]["value"])
            if not val["found"]:
                return
        except Exception as e:
            print(f"[confirm] {e}")
        time.sleep(1)
    print("[confirm] dialog still present after retries")


def chatgpt_fill_text(session, text=TEXT):
    return webbridge_cmd(
        "fill", {"selector": CHATGPT_EDITOR, "value": text}, session=session
    )


def chatgpt_send(session):
    return click_js("button[data-testid='send-button']", session)


def chatgpt_pick_new_gen(session, text):
    # 以我的文本提示所在用户消息为锚点，取其之后的助手回复生成图；
    # 复用会话时历史图片也符合 src 特征，必须按消息顺序而非"不在 before 里"来筛选
    code = f"""(() => {{
      const users = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      let anchor = null;
      for (let i = users.length - 1; i >= 0; i--) {{
        if ((users[i].textContent || '').includes({json.dumps(text)})) {{ anchor = users[i]; break; }}
      }}
      if (!anchor) return JSON.stringify({{ err: 'no matching user msg' }});
      let started = false;
      const imgs = Array.from(document.querySelectorAll('main img'));
      for (const img of imgs) {{
        if (!started) {{ started = (img === anchor || anchor.contains(img)); continue; }}
        const src = img.src || img.getAttribute('src') || '';
        const alt = img.alt || '';
        if (src.includes('estuary') && alt.startsWith('Generated image')) {{
          return JSON.stringify({{ src, alt, cls: (img.className || '').toString(), w: img.naturalWidth }});
        }}
      }}
      return JSON.stringify({{ pending: true }});
    }})()"""
    r = evaluate(code, session)
    try:
        val = json.loads(r["data"]["value"])
        if "pending" in val or "err" in val:
            return None
        return val
    except Exception:
        return None


def download_via_fetch(src, session):
    # 图片 URL 带鉴权，必须在页面内用浏览器 fetch 下载，再以 base64 返回
    code = f"""(async () => {{
      const resp = await fetch({json.dumps(src)}, {{ credentials: 'include' }});
      if (!resp.ok) return JSON.stringify({{ err: resp.status }});
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      return JSON.stringify({{ ok: true, len: bytes.length, mime: resp.headers.get('content-type') || '', b64: btoa(bin) }});
    }})()"""
    r = evaluate(code, session)
    try:
        val = json.loads(r["data"]["value"])
    except Exception:
        return None
    if not val.get("ok"):
        print(f"[download] failed: {val}")
        return None
    return save_image(val["b64"], val.get("mime") or "image/png")


def save_image(b64, mime, dest_dir=OUT_DIR):
    os.makedirs(dest_dir, exist_ok=True)
    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(
        mime.split(";")[0], ".png"
    )
    path = os.path.join(dest_dir, f"generated_{int(time.time())}{ext}")
    with open(path, "wb") as f:
        f.write(base64.b64decode(b64))
    print(f"[download] saved {path}")
    return path


# ============ Gemini ============

GEMINI_EDITOR = '.ql-editor[contenteditable="true"]'


def gemini_wait_ready(session):
    # 等待页面稳定而非仅存在：连续两次(间隔>1s)读到同一 timeOrigin 且编辑器在，
    # 确保没有踩在"导航进行中"的旧 DOM 上传附件/填词后被 reload 清掉
    code = """(() => {
      const ed = document.querySelector('.ql-editor[contenteditable="true"]');
      return JSON.stringify({ ready: !!ed && document.readyState === 'complete', t: ed ? String(performance.timeOrigin) : null });
    })()"""
    start = time.time()
    last_t = None
    while time.time() - start < 60:
        try:
            val = json.loads(evaluate(code, session)["data"]["value"])
            if val.get("ready"):
                t = val.get("t")
                if last_t is not None and t == last_t:
                    print(f"[wait] gemini editor stable ({time.time() - start:.1f}s)")
                    return True
                last_t = t
            else:
                last_t = None
        except Exception:
            last_t = None
        time.sleep(1.5)
    print("[wait] gemini page not stable within 60s")
    return False


def gemini_reset(session):
    # 复用同一标签页时页面可能处于"导航中/上次残留"状态，上传前强制清理输入区；
    # 若残留附件清不掉则整页刷新后重等编辑器
    code = """(() => {
      const ed = document.querySelector('.ql-editor[contenteditable="true"]');
      if (!ed) return JSON.stringify({ err: 'no editor' });
      ed.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete');
      const chips = Array.from(document.querySelectorAll('.file-preview-container'));
      let removed = 0;
      for (const chip of chips) {
        const btns = Array.from(chip.querySelectorAll('button')).filter(b => !b.disabled);
        btns.forEach(b => { try { b.click(); removed++; } catch (e) {} });
      }
      return JSON.stringify({ cleared: ed.textContent.trim() === '', chips: chips.length, removed });
    })()"""
    r = evaluate(code, session)
    try:
        val = json.loads(r["data"]["value"])
    except Exception:
        val = {}
    if val.get("chips"):
        time.sleep(1)
        still = evaluate(
            """(() => JSON.stringify({ left: document.querySelectorAll('.file-preview-container').length }))()""",
            session,
        )
        try:
            if json.loads(still["data"]["value"]).get("left", 0) > 0:
                print("[reset] stale attachment stuck, reloading page")
                evaluate(
                    "(() => { location.reload(); return JSON.stringify({ reloaded: true }); })()",
                    session,
                )
                return gemini_wait_ready(session)
        except Exception:
            pass
    print(f"[reset] input cleared ({val})")
    return True


def gemini_upload_image(session, image_paths=IMAGE_PATH):
    # Gemini 没有持久 input[type=file]，且忽略合成 drop 事件；对聚焦的 Quill 编辑器派发 paste 事件可挂载附件，
    # 随后在 JS 内轮询 .file-preview-container img 确认挂载完成
    if isinstance(image_paths, str):
        image_paths = [image_paths]
    files = _file_entries(image_paths)
    expected = len(files)

    def build_code():
        parts = []
        for i, (b64, filename, mime) in enumerate(files):
            parts.append(
                f"""  const bin{i} = atob({json.dumps(b64)});
  const bytes{i} = new Uint8Array(bin{i}.length);
  for (let j = 0; j < bin{i}.length; j++) bytes{i}[j] = bin{i}.charCodeAt(j);
  const file{i} = new File([bytes{i}], {json.dumps(filename)}, {{ type: {json.dumps(mime)} }});"""
            )
        dt_lines = "\n".join(f"  dt.items.add(file{i});" for i in range(expected))
        return f"""(async () => {{
  const ed = document.querySelector('.ql-editor[contenteditable="true"]');
  if (!ed) return JSON.stringify({{ err: 'no editor' }});
{chr(10).join(parts)}
  const dt = new DataTransfer();
{dt_lines}
  ed.focus();
  ed.dispatchEvent(new ClipboardEvent('paste', {{ bubbles: true, cancelable: true, clipboardData: dt }}));
  for (let i = 0; i < 15; i++) {{
    await new Promise(r => setTimeout(r, 1000));
    if (document.querySelectorAll('.file-preview-container img').length >= {expected}) break;
  }}
  const thumbs = Array.from(document.querySelectorAll('.file-preview-container img'));
  return JSON.stringify({{ attached: thumbs.length >= {expected}, n: thumbs.length }});
}})()"""

    return evaluate(build_code(), session)


def gemini_wait_upload_done(session, timeout=60):
    # 上传转圈期间发送按钮是半透明灰色，上传完成变为不透明色（黑/蓝）。
    # color() 不带透明度的检测比自然宽度可靠：预览图一出现宽度就固定，转圈仍会继续。
    code = """(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => /send/i.test(b.getAttribute('aria-label') || ''));
      if (!btn) return JSON.stringify({ ready: true, err: 'no send button' });
      const c = getComputedStyle(btn).color;
      const a1 = c.match(/\\/\\s*([\\d.]+)\\s*\\)/);
      const a2 = c.match(/rgba\\([^)]*,\\s*([\\d.]+)\\s*\\)/);
      const alpha = a1 ? parseFloat(a1[1]) : (a2 ? parseFloat(a2[1]) : 1);
      return JSON.stringify({ ready: alpha >= 0.9, color: c, alpha });
    })()"""
    start = time.time()
    while time.time() - start < timeout:
        try:
            val = json.loads(evaluate(code, session)["data"]["value"])
            if val.get("ready"):
                print(
                    f"[upload] send button solid, upload done ({time.time() - start:.1f}s)"
                )
                return True
        except Exception as e:
            print(f"[upload] {e}")
        time.sleep(1)
    print("[upload] send button still translucent after 60s")
    return False


def gemini_fill_text(session, text=TEXT):
    return webbridge_cmd(
        "fill", {"selector": GEMINI_EDITOR, "value": text}, session=session
    )


GEMINI_ACTIVATE_PS = r"""
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Chrome_WidgetWin_1')
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
foreach ($win in $wins) {
    if ($win.Current.Name -notmatch 'Google Chrome') { continue }
    $tabCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
    $tabs = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
    foreach ($tab in $tabs) {
        if ($tab.Current.Name -eq 'Google Gemini') {
            $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
            Start-Sleep -Milliseconds 800
            Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FG {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
            [FG]::SetForegroundWindow([IntPtr]$win.Current.NativeWindowHandle) | Out-Null
            Write-Output 'ACTIVATED'
            exit 0
        }
    }
}
Write-Output 'NOT_FOUND'
"""

GEMINI_ENTER_PS = r"""
$wshell = New-Object -ComObject wscript.shell
Start-Sleep -Milliseconds 300
$wshell.SendKeys('~')
Write-Output 'SENT'
"""


def _run_ps(script, name):
    path = os.path.join(os.environ.get("TEMP", "."), name)
    with open(path, "w", encoding="utf-8-sig") as f:
        f.write(script)
    result = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path],
        capture_output=True,
        text=True,
        timeout=30,
    )
    lines = [l for l in (result.stdout or "").strip().splitlines() if l.strip()]
    return lines[-1] if lines else ""


def _wait_submitted(session, timeout, cancel_event=None):
    start = time.time()
    while time.time() - start < timeout:
        if cancel_event is not None and cancel_event.is_set():
            print("[wait] cancelled by user")
            return False
        r = evaluate(
            """(() => {
          const ed = document.querySelector('.ql-editor[contenteditable="true"]');
          const userTurn = document.querySelectorAll('.user-query-container, [class*="user-query"]').length;
          return JSON.stringify({ submitted: userTurn > 0 || !ed || ed.textContent.trim() === '' });
        })()""",
            session,
        )
        try:
            if json.loads(r["data"]["value"]).get("submitted"):
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


def gemini_send(session, manual_wait=180, cancel_event=None):
    # 三级降级：合成 click -> OS 级回车(UIA 激活标签页后 SendKeys) -> 提示用户手动按 Enter。
    # Gemini 已对发送动作启用 isTrusted 校验，合成事件随时可能被忽略，故逐级兜底保证流程可完成。
    evaluate(
        """(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => /send/i.test(b.getAttribute('aria-label')||'') && !b.disabled);
      if (!btn) return JSON.stringify({ err: 'no send button' });
      btn.click();
      return JSON.stringify({ clicked: true });
    })()""",
        session,
    )
    print("[send] try 1/3: synthetic click")
    if _wait_submitted(session, 6):
        print("[send] message submitted")
        return {"sent": True}
    print("[send] synthetic click ignored")

    status = _run_ps(GEMINI_ACTIVATE_PS, "gemini_activate.ps1")
    print(f"[send] activate gemini tab ({status})")
    if status == "ACTIVATED":
        evaluate(
            """(() => {
          const ed = document.querySelector('.ql-editor[contenteditable="true"]');
          if (!ed) return JSON.stringify({ err: 'no editor' });
          ed.focus();
          return JSON.stringify({ focused: document.activeElement === ed });
        })()""",
            session,
        )
        status = _run_ps(GEMINI_ENTER_PS, "gemini_enter.ps1")
        print(f"[send] trusted Enter via OS ({status})")
        if _wait_submitted(session, 8):
            print("[send] message submitted")
            return {"sent": True}
    print("[send] OS-level Enter ignored")

    print("[send] " + "=" * 46)
    print("[send] 自动发送失败，需要你手动操作：")
    print("[send]   1. 在浏览器中切换到 Google Gemini 标签页")
    print("[send]   2. 点击输入框（保持光标在里面）")
    print("[send]   3. 按 Enter 发送")
    print(f"[send] 脚本将自动等待提交，最多 {manual_wait} 秒...")
    if _wait_submitted(session, manual_wait, cancel_event):
        print("[send] message submitted")
        return {"sent": True}
    print("[send] 等待超时，未检测到发送动作")
    return None


def gemini_pick_new_gen(session, text):
    # Gemini 生成图 blob URL 且 alt 含 "ai generated"；必须以我的文本提示所在轮为锚点，
    # 只取其后的助手回复里的图，避免把历史轮(复用会话)的老图当新图返回
    code = f"""(() => {{
      const users = Array.from(document.querySelectorAll('.user-query-container'));
      let anchor = null;
      for (let i = users.length - 1; i >= 0; i--) {{
        if ((users[i].textContent || '').includes({json.dumps(text)})) {{ anchor = users[i]; break; }}
      }}
      if (!anchor) return JSON.stringify({{ err: 'no matching user msg' }});
      let started = false;
      const imgs = Array.from(document.querySelectorAll('main img'));
      for (const img of imgs) {{
        if (!started) {{ started = (img === anchor || anchor.contains(img)); continue; }}
        const src = img.src || '';
        const alt = (img.alt || '').toLowerCase();
        if (src.startsWith('blob:') && alt.includes('ai generated')) {{
          return JSON.stringify({{ src, alt: img.alt, cls: (img.className || '').toString(), w: img.naturalWidth }});
        }}
      }}
      return JSON.stringify({{ pending: true }});
    }})()"""
    r = evaluate(code, session)
    try:
        val = json.loads(r["data"]["value"])
        if "pending" in val or "err" in val:
            return None
        return val
    except Exception:
        return None


def download_via_canvas(src, session):
    # Gemini 生成图是 blob: URL，fetch 可能失败；改用 canvas 绘制后 toDataURL 导出
    code = f"""(async () => {{
      const img = Array.from(document.querySelectorAll('main img')).find(i => i.src === {json.dumps(src)});
      if (!img) return JSON.stringify({{ err: 'img gone' }});
      for (let t = 0; t < 10 && !(img.complete && img.naturalWidth); t++) await new Promise(r => setTimeout(r, 500));
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      const data = c.toDataURL('image/png');
      return JSON.stringify({{ ok: true, len: data.length, mime: 'image/png', b64: data.split(',')[1] }});
    }})()"""
    r = evaluate(code, session)
    try:
        val = json.loads(r["data"]["value"])
    except Exception:
        return None
    if not val.get("ok"):
        print(f"[download] failed: {val}")
        return None
    return save_image(val["b64"], val.get("mime") or "image/png")


# ============ 流程编排 ============

SITES = {
    "chatgpt": {
        "url": "https://chatgpt.com/",
        "session": "leaderai-chatgpt",
        "pre_navigate": lambda s: None,
        "wait_ready": chatgpt_wait_ready,
        "reset": lambda s: True,
        "upload": chatgpt_upload_image,
        "after_upload": confirm_upload_dialog,
        "fill": chatgpt_fill_text,
        "send": chatgpt_send,
        "pick_new_gen": chatgpt_pick_new_gen,
        "download": download_via_fetch,
    },
    "gemini": {
        "url": "https://gemini.google.com/app",
        "session": "leaderai-gemini",
        "pre_navigate": lambda s: None,
        "wait_ready": gemini_wait_ready,
        "reset": gemini_reset,
        "upload": gemini_upload_image,
        "after_upload": lambda s: None,
        "fill": gemini_fill_text,
        "send": gemini_send,
        "pick_new_gen": gemini_pick_new_gen,
        "download": download_via_canvas,
    },
}


def wait_for_generation(site, session, text, timeout=300, cancel_event=None):
    pick = SITES[site]["pick_new_gen"]
    start = time.time()
    while time.time() - start < timeout:
        if cancel_event is not None and cancel_event.is_set():
            print("[wait] cancelled by user")
            return None
        gen = pick(session, text)
        if gen:
            print(
                f"[wait] new image ready under my prompt: {(gen.get('alt') or '')[:40]}"
            )
            return gen
        time.sleep(5)
    print("[wait] timeout, no new image generated")
    return None


def run(site, image_paths, text, manual_wait=180, cancel_event=None, anchor=None):
    print("[cfg] DAEMON_URL =", DAEMON_URL)
    print("[cfg] IMAGE_PATH  =", IMAGE_PATH)
    print("[cfg] TEXT        =", TEXT)
    print("[cfg] OUT_DIR     =", OUT_DIR)
    if isinstance(image_paths, str):
        image_paths = [image_paths]
    print("[cfg] 本次实际使用 image_paths =", image_paths)
    cfg = SITES[site]
    session = cfg["session"]
    # 定位生成图时按 anchor 匹配用户消息，可区别于实际发送的 text：
    # 发送给 AI 的提示词可能被追加尺寸等信息，而页面中显示的文本未必能精确匹配，故单独指定锚点文本
    anchor = anchor or text
    if anchor != text:
        print(
            f"[cfg] anchor 文本与发送文本不同：anchor 长度 {len(anchor)}，发送文本长度 {len(text)}"
        )

    # 优先复用已控制的标签页（不重新导航刷新）；find_tab 仅匹配本会话打开的标签页
    cfg["pre_navigate"](session)
    reused = bool(
        (
            webbridge_cmd("find_tab", {"url": cfg["url"]}, session=session).get("data")
            or {}
        ).get("success")
    )
    if reused:
        print(f"[main] {site} tab reused (no reload)")
    else:
        webbridge_cmd("navigate", {"url": cfg["url"]}, session=session)
    if not cfg["wait_ready"](session):
        if reused:
            # 复用的标签页未就绪（可能被用户导航走/页面崩溃），回退为重新导航
            print(f"[main] {site} reused tab not ready, navigating fresh")
            webbridge_cmd("navigate", {"url": cfg["url"]}, session=session)
            if not cfg["wait_ready"](session):
                print(f"[main] {site} page not ready, abort")
                return
        else:
            print(f"[main] {site} page not ready, abort")
            return

    cfg["reset"](session)
    # 页面就绪到上传之间留 1 秒，等 React 挂好文件输入的事件处理器，避免合成 change 被丢弃
    time.sleep(1.0)
    cfg["upload"](session, image_paths)
    cfg["after_upload"](session)
    # Gemini 转圈期间发送按钮半透明，等它变实色即上传完成（比写死 sleep 更快更稳）
    if site == "gemini" and not gemini_wait_upload_done(session):
        print("[main] upload not ready, continuing with 1s grace anyway")
    time.sleep(1.0)
    cfg["fill"](session, text)

    send = cfg["send"]
    if site == "gemini":
        result = send(session, manual_wait, cancel_event)
    else:
        result = send(session)
    if not result:
        print("[main] message not sent, abort")
        return

    gen = wait_for_generation(site, session, anchor, cancel_event=cancel_event)
    if not gen:
        print("[main] no generated image to download")
        return None
    return cfg["download"](gen["src"], session)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", choices=list(SITES), default="gemini")
    ap.add_argument("--image", default=IMAGE_PATH, nargs="*")
    ap.add_argument("--text", default=TEXT)
    ap.add_argument(
        "--manual-wait", type=int, default=180, help="Gemini 手动发送兜底的等待秒数"
    )
    args = ap.parse_args()
    run(args.site, args.image, args.text, args.manual_wait)


if __name__ == "__main__":
    main()
