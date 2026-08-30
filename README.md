# War3 Rect Edit

War3 Rect Edit 是一个面向 Warcraft III LNI 地图的 VS Code 工具，用于在编辑器内查看地形、管理矩形区域和逻辑点。

## 功能

- 读取并渲染 `map/war3map.w3e` 三维地形。
- 优先使用地图项目中的地形资源，找不到时再从配置的魔兽目录读取原生资源。
- 只读预览地图中的装饰物和可破坏物。
- 读取和写入 `map/war3map.w3r` 矩形区域。
- 在区域页签中创建、移动、缩放和删除矩形区域。
- 在点页签中创建、移动和删除逻辑点。
- 使用 `Ctrl+Z` 撤销、`Ctrl+Y` 前进，最多保留 10 步历史。
- 将逻辑点导出为 Lua 文件，导出路径可在设置中配置。
- 魔兽争霸 III 路径留空时，自动读取 Windows 注册表中的安装路径。

## 文件结构

插件按 LNI 地图的标准目录读取文件，不会要求移动或重命名原始文件：

```text
地图根目录/
├─ map/
│  ├─ war3map.w3e
│  ├─ war3map.w3r
│  └─ 其他地图文件
├─ resource/
├─ table/
└─ *.w3x
```

点位数据默认保存到 `.war3tool/points.json`，Lua 默认导出到 `.war3tool/points.lua`。

## 设置

在 VS Code 设置中搜索 `War3 Rect Edit`：

- `war3MapTools.warcraftPath`：魔兽争霸 III 安装目录。留空时自动读取注册表。
- `war3MapTools.luaExportPath`：点位 Lua 导出路径。相对路径基于当前地图根目录，也支持绝对路径。
- `war3MapTools.textEncoding`：区域名称和环境音字符串编码，中文地图通常使用 `gbk`。

## 使用方式

1. 在 VS Code 中打开包含 LNI 地图的工作区。
2. 单击地图根目录中的 `.w3x` 文件，使用 `War3 LNI 地形与区域` 编辑器打开。
3. 在右侧的“区域”或“点”页签中选择对应模块。
4. 使用页签内的按钮进入新建模式；再次点击按钮可返回编辑模式。
5. 编辑后插件会自动保存，也可以点击“保存”立即写入。

## 开源许可证

本项目使用 MIT License 开源。
