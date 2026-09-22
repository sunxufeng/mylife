# My Life

一个**完全离线**的桌面资料库：把经历、工作资料、阅读笔记和灵感收进同一个地方，随时搜得到，
还能一键导出成 Markdown 交给 AI 阅读。

- Electron + 原生 HTML / CSS / JavaScript，**没有构建步骤**
- 数据是本地的一个目录（JSON + 附件文件），不联网、不需要账号、不调用任何模型
- macOS（Apple Silicon）实测通过

完整说明见 **[使用说明.md](./使用说明.md)**（含功能细节、快捷键、数据位置、实测结果与未验证事项）。

## 快速开始

```bash
npm install
npm start          # 开发模式运行
npm run pack       # 打包出 dist/My Life-darwin-arm64/My Life.app
npm run icon       # 重新生成应用图标
```

> 若环境里存在 `ELECTRON_RUN_AS_NODE=1`，`npm start` 已经写成
> `env -u ELECTRON_RUN_AS_NODE electron .` 把它剥掉；手动执行 electron 命令时记得也剥一下，
> 否则 Electron 会退化成纯 Node 起不来。

## 功能一览

| 分类 | 内容 |
| --- | --- |
| 录入 | 文字 / 链接 / 图片 / 文件四种类型；Markdown 编辑器（工具栏 + 实时预览）；`⌘V` 粘贴截图；拖拽加附件 |
| 整理 | 标题、内容、日期、来源、分类、标签；自定义分类；回收站（还原 / 彻底删除 / 清空） |
| 查找 | 搜索标题 / 正文 / 来源 / 标签 / 附件名并高亮；按类型、标签、时间筛选；五种排序 |
| 导出 | 勾选后导出 Markdown（合并单文件或每条一个文件，可选带附件副本）；单条复制 Markdown |
| 备份 | 一键备份到资料库 `backups/`、备份到任意位置、带预览的恢复（恢复前自动留保险副本） |
| 外观 | 5 套配色主题（暖沙 / 雾蓝 / 陶土橙 / 鼠尾草绿 / 深酒红）；左栏与列表栏可收缩；专注编辑 |

明确不做：账号系统、云同步、模型接口、自动抓取网页、解析附件内容。

## 数据放在哪

默认 `~/Documents/My Life 资料库/`：

```
My Life 资料库/
├── archive.json          全部文字资料
├── archive.json.bak      上一次写入前的自动备份
├── attachments/<资料id>/ 附件副本
└── backups/              备份包与恢复保险副本
```

配置与偏好（资料库路径、主题、各栏收起状态）在 `~/Library/Application Support/My Life/config.json`。
资料库目录**独立于应用安装位置**，重装或移动 app 都不影响数据。

## 源码结构

```
src/
├── main/
│   ├── main.js        主进程：窗口、菜单、archive:// 协议、全部 IPC
│   ├── store.js       数据层：archive.json 原子读写、附件复制、回收站、分类
│   ├── library.js     备份 / 恢复 / Markdown 导出 / 旧目录迁移
│   └── devtools.js    开发期自测钩子（不设环境变量就不加载）
├── preload/preload.js contextBridge 暴露受控 API
└── renderer/
    ├── index.html     三栏骨架
    ├── styles.css     视觉与主题变量
    ├── themes.js      5 套配色主题
    ├── markdown.js    轻量 Markdown 渲染器（无依赖）
    └── app.js         界面逻辑
```

## 自测

```bash
node scripts/smoke-test.js        # 数据层，68 项断言

LA_LIBRARY_PATH=/tmp/la-test LA_SHOT_DIR=/tmp/la-shots LA_TEST_SCRIPT=scripts/ui-check.js \
  env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --no-sandbox --disable-gpu
```

界面自测会驱动真实窗口走完整流程并逐步截图，同时把渲染进程的报错收集起来。
`LA_LIBRARY_PATH` 会把资料库指到临时目录，不会写进你的真实数据。
