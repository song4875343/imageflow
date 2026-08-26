# 图片编辑 + 空间设计（EROOM）桌面应用

基于 `pywebview` 的 Windows 桌面应用，把「AI 图片编辑」和「3D 空间设计」两个模块拼接到同一个界面中：

- **图片编辑**：打开图片后框选区域，用文本描述调用多家图像大模型进行局部修改或整图生成。
- **空间设计（EROOM）**：基于 JSON 房间模型的 three.js 3D 查看与平面编辑，可渲染输出效果图并直接发送到图片编辑模块。

## 功能特性

### 图片编辑
- 打开 / 保存图片（PNG、JPG/JPEG、WebP、BMP、GIF），透明背景图片全程保留 RGBA，不会填充黑底
- 专家模式：框选区域 + 修改描述，调用 AI 模型局部编辑；支持蒙版保护、参考图片、整图生成
- 通过「＋」加载其他图片作为独立图层（参考图），可移动定位并作为补丁图源
- 生成尺寸预设（1K/2K/4K 等）与宽高比选择，支持自定义尺寸
- 生成结果预览列表：主图管理、删除/隐藏、**拖拽缩略图调整图层叠放顺序**；图层「微调」开关解锁后即可自由移动/缩放，默认锁定防误触
- 返回尺寸与请求不一致时可选择「使用返回尺寸 / 强制缩放一致 / 放弃」
- 蒙版与高级蒙版、颜色吸管、填充、文字标注、画笔标注（涂鸦 / PLINE线 / 矩形 / 箭头 四模式，图标化屏幕菜单）、标记点、撤销/重做（最近 20 步）
- 深色 / 浅色主题，切换后持久化到 `image_eidt/theme.json`
- 模型管理：添加、修改、删除、切换多个服务商的图像模型

### 空间设计（EROOM）
- three.js 3D 房间展示：透视 / 俯视、东南西北四方向视角、焦距、日照与环境光、墙体/天花显隐
- 相机机位记录与恢复（机位、墙体、天花、日照参数一并保存）
- 平面编辑器：导入底图，按类别绘制墙体、门窗、家具等构件，正交磁吸，撤销/重做
- 输出渲染图：1K/2K/4K、多种宽高比，保存 PNG 或「输出到图片编辑」
- 空间列表管理：新增空白空间、导入本地 JSON、另存 JSON、写入 `roomspace/public/models.json`

## 目录结构

```text
image_edit/
├── image_eidt/                 # 图片编辑模块（pywebview 应用主体）
│   ├── app.py                  # 桌面入口 + JS API + roomspace 页面打包嵌入
│   ├── image_edit.py           # 图像处理与 AI 模型调用核心（OpenCV/Pillow）
│   ├── index.html              # 图片编辑界面（fabric.js 画布）
│   ├── image_models.json       # AI 图像模型配置（含 API Key）
│   └── theme.json              # 主题偏好（light/dark）
├── roomspace/                  # 空间设计（EROOM）3D 应用源码
│   ├── index.html              # 空间设计界面
│   ├── main.js                 # three.js 场景、相机、光照、输出渲染
│   ├── editor.js               # 平面编辑器（底图、构件绘制、撤销/重做）
│   ├── style.css / overrides.css / panel-scroll.css
│   └── public/models.json      # 空间模型数据
├── webridge/
│   └── bridge.py               # WebBridge 浏览器生图桥接（上传/发送/全尺寸下载）
├── 启动图片微调.bat             # Windows 一键启动脚本
├── pyproject.toml              # uv 项目配置与依赖
└── uv.lock
```

> 启动时 `app.py` 会把 `roomspace/` 的 HTML/CSS/JS 和 `models.json` 打包成单个 HTML 注入到主界面 iframe，因此修改 `roomspace/` 源码后需重启应用生效。

## 环境要求

- Windows（使用 pywebview + 原生文件对话框）
- Python 3.9+
- [uv](https://docs.astral.sh/uv/)（推荐）或 pip
- 首次运行需联网：安装 Python 依赖，并从 CDN 加载 `fabric.js` 与 `three.js`

## 启动

双击根目录的 `启动图片微调.bat`，或在项目根目录运行：

```powershell
uv run python image_eidt/app.py
```

不使用 uv 时，手动安装 `pyproject.toml` 中列出的依赖：

```powershell
pip install pywebview Pillow numpy opencv-python requests openai
python image_eidt/app.py
```


## 使用说明

### 图片编辑流程
1. 左侧工具栏切到「图片调整」，点击「打开图片」选择图片。
2. 在画布上框选要修改的区域（或用蒙版涂抹指定范围），填写修改描述。
3. 可在「专家」面板选择模型、添加参考图片、设置输出尺寸与宽高比。
4. 点击「生成图片」，从底部预览列表中选择满意结果置为主图，最后「保存图片」。

### 空间设计流程
1. 左侧工具栏切到「空间设计」，在顶部选择或新增空间。
2. 「编辑」模式导入底图并绘制构件；「参数」面板调整层高、墙体/天花、焦距与日照。
3. 「记录相机」保存机位，「输出」选择规格与宽高比渲染，保存 PNG 或直接发送到图片编辑。

## 模型配置

- `image_eidt/image_models.json`：图片编辑用 AI 模型列表，字段为 `id / model / provider / baseurl / key`，可在应用内「专家」面板添加、修改、删除。
- `roomspace/public/models.json`：空间模型列表，字段为 `id / name / width / depth / height / walls / windows / doors / zones / editor / cameraPresets` 等，可在应用内新增、导入、另存或写入系统。

### 生成方式：API 模式 / WebBridge 模式

「图片编辑」面板的设置（齿轮按钮 → 生成方式）支持两种生图途径：

- **API 模式（默认）**：走 `image_models.json` 中配置的图像模型接口。
- **WebBridge 模式**：通过本仓库内 `webridge/` 模块（`webridge/bridge.py`）驱动浏览器（Gemini / ChatGPT 站点）完成图文修改，下拉选择站点后生图走 `bridge.run` 流程。全尺寸下载以浏览器原生下载为基准：先接管浏览器原生下载目录并轮询收编真图（与默认下载目录大小一致），捕获的候选 URL 按像素探测取最大，页面 fetch / CDP 网络双通道取回时仅作降级且「取大保留」，避免水印压缩图或小图误交。

`image_eidt/image_models.json` 中会持久化 `generation_mode`（`api` / `webridge`）与 `webridge_site`（`gemini` / `chatgpt`）两个字段。使用 WebBridge 模式前需启动 webridge 桥接服务（`127.0.0.1:10086`）并确保浏览器已登录对应站点。WebBridge/API 返回的透明 PNG 会保留 alpha 通道，不填充黑底。

## 技术栈

- 后端：Python 3.9+、pywebview、Pillow、numpy、opencv-python、requests、openai
- 前端：原生 HTML/CSS/JS、fabric.js 5.3（CDN）、three.js 0.162 + OrbitControls（CDN）

## 安全提醒

`image_eidt/image_models.json` 中包含真实的 API Key，请勿将该文件提交到公开仓库或分享给他人；建议改为仅保留本地使用，必要时在提交前脱敏或加入 `.gitignore`。

