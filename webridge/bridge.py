import argparse
import base64
import json
import os
import re
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


def _count_selector(session, selector):
    r = evaluate(
        f"(() => document.querySelectorAll({json.dumps(selector)}).length)()", session
    )
    try:
        return int(r["data"]["value"])
    except Exception:
        return -1


def chatgpt_pick_new_gen(session, n0):
    # 发送前记录用户消息数 n0；发送后只认新增的最后一条用户消息为锚点，
    # 取紧随其后的生成图。不做任何文本比对，彻底摆脱渲染改写导致的不匹配。
    code = f"""(() => {{
      const users = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      if ({json.dumps(n0)} < 0 || users.length <= {json.dumps(n0)}) return JSON.stringify({{ pending: true }});
      const anchor = users[users.length - 1];
      const imgs = Array.from(document.querySelectorAll('main img'));
      for (const img of imgs) {{
        if (!(anchor.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const src = img.src || img.getAttribute('src') || '';
        const alt = img.alt || '';
        const isGen = alt.startsWith('Generated image') || alt.startsWith('已生成图片');
        if (src.includes('estuary') && isGen) {{
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


def _store_and_fetch_b64(store_code, session):
    # 大图 base64 可达数 MB，单次 evaluate 响应会超出守护进程上限被丢弃（返回空体）；
    # 先在页面里把 base64 存入 window.__wb_b64，再分块小请求取回。
    # 返回 (b64, meta) 或 None
    r = evaluate(store_code, session)
    try:
        val = json.loads(r["data"]["value"])
    except Exception:
        return None
    if not val.get("ok"):
        print(f"[download] failed: {val}")
        return None
    total = val["len"]
    CHUNK = 256 * 1024
    parts = []
    try:
        for off in range(0, total, CHUNK):
            r = evaluate(f"window.__wb_b64.slice({off}, {off + CHUNK})", session)
            part = r["data"]["value"]
            if not isinstance(part, str):
                raise RuntimeError(f"chunk at {off} missing")
            parts.append(part)
            print(
                f"[download] fetched chunk {len(parts)} ({min(off + CHUNK, total)}/{total})"
            )
    finally:
        evaluate("(() => { delete window.__wb_b64; return ''; })()", session)
    b64 = "".join(parts)
    if len(b64) != total:
        print(f"[download] size mismatch: got {len(b64)}, want {total}")
        return None
    return b64, val


def _chatgpt_fullsize_url(src):
    # 实测生成图 img.src 即全尺寸 estuary URL，与图片右下角“分享→下载”按钮实际
    # 请求的地址一致（仅差 v=0 查询参数）；缺 v 参数时补上 v=0 对齐官方下载行为。
    # 不走弹窗路径：小视口下该弹窗整体渲染在屏幕外且合成事件无法关闭，会卡死后续任务
    if re.search(r"[?&]v=\d+", src or ""):
        return src
    return src + ("&" if "?" in src else "?") + "v=0"


def chatgpt_download_full(src, session):
    # 页面内 fetch 全尺寸原图；失败再按原 src 兜底一次
    url = _chatgpt_fullsize_url(src)
    if url != src:
        print("[download] appended v=0 for full-size fetch")
    try:
        return download_via_fetch(url, session)
    except Exception as exc:
        print(f"[download] full-size fetch failed ({exc}), retry with raw src")
        return download_via_fetch(src, session)


def download_via_fetch(src, session):
    # 图片 URL 带鉴权，必须在页面内用浏览器 fetch 下载。Gemini 全尺寸 URL 走 fife 的
    # alr=yes 近似重定向：请求返回 text/plain 文本，内容是下一段地址，需逐跳跟随直到
    # 拿到真实图片字节（实测 2 跳后为 image/jpeg 原图）。base64 经 window 变量分块取回
    code = f"""(async () => {{
      let url = {json.dumps(src)};
      let type = '';
      for (let hop = 0; hop < 8; hop++) {{
        const resp = await fetch(url, {{ credentials: 'include' }});
        if (!resp.ok) return JSON.stringify({{ err: resp.status, hop }});
        type = resp.headers.get('content-type') || '';
        const buf = await resp.arrayBuffer();
        if (type.includes('text/plain') && buf.byteLength < 4096) {{
          const text = new TextDecoder().decode(buf).trim();
          if (/^https?:\\/\\//.test(text)) {{ url = text; continue; }}
          return JSON.stringify({{ err: 'bad redirect', type, len: buf.byteLength, hop }});
        }}
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        window.__wb_b64 = btoa(bin);
        return JSON.stringify({{ ok: true, len: window.__wb_b64.length, mime: type }});
      }}
      return JSON.stringify({{ err: 'too many hops' }});
    }})()"""
    got = _store_and_fetch_b64(code, session)
    if not got:
        return None
    b64, val = got
    mime = val.get("mime") or "image/jpeg"
    return save_image(b64, mime)


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


def gemini_pick_new_gen(session, n0):
    # 发送前记录用户消息数 n0；发送后只认新增的最后一条用户消息为锚点，
    # 取紧随其后的生成图（blob URL 且 alt 含 "ai generated"），不做文本比对。
    code = f"""(() => {{
      const users = Array.from(document.querySelectorAll('.user-query-container'));
      if ({json.dumps(n0)} < 0 || users.length <= {json.dumps(n0)}) return JSON.stringify({{ pending: true }});
      const anchor = users[users.length - 1];
      const imgs = Array.from(document.querySelectorAll('main img'));
      for (const img of imgs) {{
        if (!(anchor.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const src = img.src || '';
        const alt = (img.alt || '').toLowerCase();
        // 大图时 Gemini 用持久 https URL（lh3/gg-dl），小图用 blob:，两种都要认
        if ((src.startsWith('blob:') || src.startsWith('http')) && alt.includes('ai generated')) {{
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


def _frame_id(session):
    r = webbridge_cmd(
        "cdp", {"method": "Page.getFrameTree", "params": {}}, session=session
    )
    try:
        return r["data"]["frameTree"]["frame"]["id"]
    except Exception:
        return None


def download_via_network(src, session):
    # lh3/googleusercontent 等持久 https 生成图页面内 fetch 会被 CORS 拦、canvas 会被污染；
    # 用 CDP Network.loadNetworkResource 借浏览器身份（含会话 Cookie）直接拉取资源，
    # 响应体经 stream -> IO.read 分块取回，天然绕过 CORS/认证限制
    fid = _frame_id(session)
    if not fid:
        print("[download] cannot resolve frame id")
        return None
    print(f"[download] https source, loading via CDP network ({src[:50]}…)")
    r = webbridge_cmd(
        "cdp",
        {
            "method": "Network.loadNetworkResource",
            "params": {
                "url": src,
                "options": {"disableCache": True, "includeCredentials": True},
                "frameId": fid,
            },
        },
        session=session,
    )
    res = (r.get("data") or {}).get("resource") or {}
    if not res.get("success") or res.get("httpStatusCode") != 200:
        print(f"[download] loadNetworkResource failed: {res.get('httpStatusCode')}")
        return None
    handle = res.get("stream")
    mime = (res.get("headers") or {}).get("content-type") or "image/jpeg"
    parts = []
    while handle:
        rr = webbridge_cmd(
            "cdp", {"method": "IO.read", "params": {"handle": handle}}, session=session
        )
        data = rr.get("data") or {}
        chunk = data.get("data") or ""
        if chunk:
            parts.append(
                base64.b64decode(chunk) if data.get("base64Encoded") else chunk.encode()
            )
        if data.get("eof"):
            break
    raw = b"".join(parts)
    if not raw:
        print("[download] empty body")
        return None
    path = os.path.join(OUT_DIR, f"generated_{int(time.time())}.jpg")
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(path, "wb") as f:
        f.write(raw)
    print(f"[download] saved {path} ({len(raw)} bytes, {mime})")
    return path


FULL_MIN_SIDE = 900  # Gemini 原图短边 >=1024，会话预览小图远小于此


def _image_min_side(path):
    # 纯解析 PNG/JPEG 文件头拿像素尺寸（不引第三方依赖）；解析不了返回 None
    try:
        with open(path, "rb") as f:
            head = f.read(65536)
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            w = int.from_bytes(head[16:20], "big")
            h = int.from_bytes(head[20:24], "big")
            return min(w, h)
        if head[:2] == b"\xff\xd8":
            i = 2
            while i + 9 < len(head):
                if head[i] != 0xFF:
                    i += 1
                    continue
                marker = head[i + 1]
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                    i += 2
                    continue
                seglen = int.from_bytes(head[i + 2 : i + 4], "big")
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    h = int.from_bytes(head[i + 5 : i + 7], "big")
                    w = int.from_bytes(head[i + 7 : i + 9], "big")
                    return min(w, h)
                i += 2 + seglen
    except Exception:
        pass
    return None


def _probe_dims(url, session):
    # 页面内 new Image() 读 naturalWidth/naturalHeight 探测候选 URL 的真实像素；
    # 只读尺寸不画 canvas，不受跨域污染限制。探测失败返回 None（按未知处理，
    # 不能作为采纳依据）
    code = f"""(async () => {{
      const d = await new Promise((resolve) => {{
        const im = new Image();
        im.onload = () => resolve({{ w: im.naturalWidth, h: im.naturalHeight }});
        im.onerror = () => resolve(null);
        setTimeout(() => resolve(null), 8000);
        im.src = {json.dumps(url)};
      }});
      return JSON.stringify(d || {{ err: 'probe failed' }});
    }})()"""
    try:
        val = json.loads(evaluate(code, session)["data"]["value"])
    except Exception:
        return None
    if not isinstance(val, dict) or "w" not in val:
        return None
    try:
        return int(val["w"]), int(val["h"])
    except Exception:
        return None


def _install_download_capture(session):
    # 在页面里挂钩子，拦截生成图的下载动作取回全尺寸 URL，并 cancel 掉浏览器
    # 真实的落盘下载（我们要自己拉取而不是存进用户下载目录）。
    # 所有来源的候选全部去重记录，谁是真的全尺寸交给像素探测判断——URL 形状
    # 不可靠：预览图可能不带缩放参数、原图可能走 XHR 或 blob:，先到先得必错。
    # a[download] 的 href 无条件捕获（含 blob:，那是 Gemini 自己准备好的成品）；
    # fetch/open/XHR 只记图片 CDN 的 URL（blob 太杂会淹没候选列表）
    code = """(() => {
      window.__wb_dls = [];
      const cap = (url, kind) => {
        if (!url) return;
        const u = String(url);
        if (!window.__wb_dls.some(c => c.u === u)) window.__wb_dls.push({ u, k: kind });
      };
      const isImgUrl = (u) => /gg-dl|googleusercontent|(png|jpe?g|webp)(\\?|$)/i.test(u || '');
      document.addEventListener('click', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
        if (a && a.href) {
          cap(a.href, 'anchor');
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }, true);
      const origOpen = window.open;
      window.open = function (u, ...rest) {
        if (typeof u === 'string' && isImgUrl(u)) {
          cap(u, 'soft');
          return null;
        }
        return origOpen ? origOpen.apply(this, [u, ...rest]) : null;
      };
      const origFetch = window.fetch;
      window.fetch = function (...args) {
        try {
          const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
          if (isImgUrl(u)) cap(u, 'soft');
        } catch (_) {}
        return origFetch.apply(this, args);
      };
      const origXhrOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u, ...rest) {
        try {
          if (typeof u === 'string' && isImgUrl(u)) cap(u, 'soft');
        } catch (_) {}
        return origXhrOpen.apply(this, [m, u, ...rest]);
      };
      return JSON.stringify({ hooked: true });
    })()"""
    return evaluate(code, session)


def _click_image_download(session, src):
    # 以生成图 img 为锚向祖先容器逐层找“下载”按钮，扩图片时按钮在卡片右上角的操作区
    code = """(() => {
      const img = Array.from(document.querySelectorAll('main img')).find(i => (i.src || '') === __SRC__);
      if (!img) return JSON.stringify({ err: 'img gone' });
      let card = img;
      for (let depth = 0; card && card !== document.body && depth < 8; depth++, card = card.parentElement) {
        const btn = Array.from(card.querySelectorAll('button')).find(b => /download|下载/i.test((b.getAttribute('aria-label') || '') + '|' + (b.getAttribute('title') || '') + '|' + (b.getAttribute('data-tooltip') || '') + '|' + (b.innerText || '')));
        if (btn) { btn.click(); return JSON.stringify({ clicked: true, label: (btn.getAttribute('aria-label') || btn.innerText || '').slice(0, 40) }); }
      }
      return JSON.stringify({ err: 'no download button' });
    })()"""
    return evaluate(code.replace("__SRC__", json.dumps(src)), session)


def gemini_download_full(src, session):
    # 只走全尺寸路径，且以真实像素为准：点图片右上角下载按钮 → 捕获候选 URL →
    # 页面内探测每个候选的分辨率，短边 >= FULL_MIN_SIDE 才准下载；落盘后再解析
    # 文件头终审，不达标删文件视为失败。不达标就一直等/补点按钮直到超时返回
    # None——宁可失败也不交小图

    def ordered_urls(cands):
        # anchor（a[download] 点击）最可信，同类取最新捕获优先
        return [c["u"] for c in reversed(cands) if c.get("k") == "anchor"] + [
            c["u"] for c in reversed(cands) if c.get("k") == "soft"
        ]

    try:
        _install_download_capture(session)
        r = _click_image_download(session, src)
        print(
            f"[download] image download button: {json.dumps(r.get('data') or {}, ensure_ascii=False)[:200]}"
        )
        probed = {}
        href = None
        start = time.time()
        next_click = start + 15
        while time.time() - start < 60:
            try:
                val = evaluate("JSON.stringify(window.__wb_dls || [])", session)[
                    "data"
                ]["value"]
                cands = json.loads(val) if isinstance(val, str) and val else []
            except Exception:
                cands = []
            for u in ordered_urls(cands):
                if u not in probed:
                    d = _probe_dims(u, session)
                    probed[u] = d
                    print(f"[download] probe {(u or '')[:80]} -> {d}")
                    if d and min(d) >= FULL_MIN_SIDE:
                        href = u
                        break
            if href:
                break
            # 图片卡片刚生成时下载按钮可能尚未挂好导致点击落空，定期补点
            if time.time() > next_click:
                next_click += 15
                print("[download] no full-res candidate yet, re-click download button")
                _click_image_download(session, src)
            time.sleep(0.5)
        print(f"[download] full-res url picked: {(href or '')[:100]}")
        if not href:
            print("[download] 未捕获达到全尺寸标准的 URL（小图兜底已禁用），放弃")
            return None
        # 同一个全尺寸 URL 的两种传输通道（页面 fetch / CDP 网络），不是换图源；
        # 落盘后按文件头尺寸终审，短边不达标删掉当失败
        for fetcher in (download_via_fetch, download_via_network):
            out = fetcher(href, session)
            if not out:
                continue
            side = _image_min_side(out)
            if side is not None and side < FULL_MIN_SIDE:
                print(f"[download] 文件仅 {side}px < {FULL_MIN_SIDE}px，丢弃")
                try:
                    os.remove(out)
                except OSError:
                    pass
                continue
            return out
        print("[download] 全尺寸下载终审未通过，放弃")
        return None
    except Exception as exc:
        print(f"[download] 全尺寸下载失败：{exc}")
        return None


def gemini_download(src, session):
    return gemini_download_full(src, session)


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
        "user_selector": '[data-message-author-role="user"]',
        "download": chatgpt_download_full,
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
        "user_selector": ".user-query-container",
        "download": gemini_download,
    },
}


def wait_for_generation(site, session, n0, timeout=300, cancel_event=None):
    pick = SITES[site]["pick_new_gen"]
    start = time.time()
    while time.time() - start < timeout:
        if cancel_event is not None and cancel_event.is_set():
            print("[wait] cancelled by user")
            return None
        gen = pick(session, n0)
        if gen:
            print(
                f"[wait] new image ready after user message: {(gen.get('alt') or '')[:40]}"
            )
            return gen
        time.sleep(5)
    print("[wait] timeout, no new image generated")
    return None


def run(site, image_paths, text, manual_wait=180, cancel_event=None):
    print("[cfg] DAEMON_URL =", DAEMON_URL)
    print("[cfg] IMAGE_PATH  =", IMAGE_PATH)
    print("[cfg] TEXT        =", TEXT)
    print("[cfg] OUT_DIR     =", OUT_DIR)
    if isinstance(image_paths, str):
        image_paths = [image_paths]
    image_paths = [p for p in (image_paths or []) if p and os.path.exists(p)]
    text_only = not image_paths
    print(
        "[cfg] 本次实际使用 image_paths =",
        image_paths,
        "(纯文生图)" if text_only else "",
    )
    cfg = SITES[site]
    session = cfg["session"]

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

    # 这行好像没啥用
    # cfg["reset"](session)

    if text_only:
        print(f"[main] 未提供图片，跳过上传，直接文生图")
    else:
        # 页面就绪到上传之间留 1 秒，等 React 挂好文件输入的事件处理器，避免合成 change 被丢弃
        time.sleep(1.0)
        cfg["upload"](session, image_paths)
        cfg["after_upload"](session)
        # Gemini 转圈期间发送按钮半透明，等它变实色即上传完成（比写死 sleep 更快更稳）
        if site == "gemini" and not gemini_wait_upload_done(session):
            print("[main] upload not ready, continuing with 1s grace anyway")
        time.sleep(1.0)
    cfg["fill"](session, text)

    # 发送前记录用户消息数，发送后据此定位"本次新消息"的位置来抓图，不做文本比对
    n0 = _count_selector(session, cfg["user_selector"])
    print(f"[main] 发送前用户消息数 = {n0}")

    send = cfg["send"]
    if site == "gemini":
        result = send(session, manual_wait, cancel_event)
    else:
        result = send(session)
    if not result:
        print("[main] message not sent, abort")
        return

    gen = wait_for_generation(site, session, n0, cancel_event=cancel_event)
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
