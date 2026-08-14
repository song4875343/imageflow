# 图片编辑 + 空间设计（EROOM）

两个项目拼接的桌面应用：图片编辑（深色/浅色主题）+ 空间设计 3D 建模。

## 目录结构

- `image_eidt/` — 图片编辑应用（app.py / index.html / image_edit.py）
- `roomspace/` — 空间设计（EROOM）3D 应用源码，启动时自动打包嵌入
- `启动图片微调.bat` — 启动入口（放在项目根目录）

## 启动

双击根目录的 `启动图片微调.bat`，或在根目录运行：

```powershell
uv run python image_eidt/app.py
```

首次运行会自动创建虚拟环境并安装依赖（需联网，three.js / fabric.js 从 CDN 加载）。
图片编辑的模型配置保存在 `image_eidt/image_models.json`；空间设计的模型保存在 `roomspace/public/models.json`。
