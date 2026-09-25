# My Workbench

一个**完全离线**的桌面资料库：把经历、工作资料、阅读笔记和灵感收进同一个地方，随时搜得到，
还能一键导出成 Markdown 交给 AI 阅读；另外配一条时间轴（日历与日程），
让「事后的记录」和「事前的安排」互相引用。

- Electron + 原生 HTML / CSS / JavaScript，**没有构建步骤**
- 数据是本地的一个目录（JSON + 附件文件），不联网、不需要账号、不调用任何模型
- macOS（Apple Silicon）实测通过

完整说明见 **[使用说明.md](./使用说明.md)**（含功能细节、快捷键、数据位置、实测结果与未验证事项）。

## 快速开始

```bash
npm install
npm start          # 开发模式运行
npm run pack       # 打包出 dist/My Workbench-darwin-arm64/My Workbench.app
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
| 日历 | 月视图（6×7，跨天画色带、溢出「+N」）+ 议程视图（7 / 30 / 90 天）；双击空白格新建、拖拽色条改期、点圆圈完成 |
| 日程 | 全天 / 定时 / 跨天；分类、色标（固定 6 色）、标签；每天 / 每周 / 每月 / 每年重复（只存规则，含月末钳制）；单次提醒（提前 N 分钟 / 准点）；「只改这一次」把某次拆出来 |
| 关联 | 日程可以挂 1..n 条资料，资料详情里反向显示「相关日程」，双向可跳 |
| 提醒 | 应用运行期间每 30 秒检查，应用内提示条 + 左栏今日角标；可选同步 macOS 通知中心（可关）；应用没开不提醒，如实说明 |
| 导出 | 勾选后导出 Markdown（合并单文件或每条一个文件，可选带附件副本与「相关日程」）；单条复制 Markdown；日程可导出标准 `.ics` |
| 备份 | 一键备份到资料库 `backups/`、备份到任意位置、带预览的恢复（恢复前自动留保险副本） |
| 外观 | 5 套配色主题（暖沙 / 雾蓝 / 陶土橙 / 鼠尾草绿 / 深酒红）；左栏与列表栏可收缩；专注编辑 |

明确不做：账号系统、云同步、模型接口、自动抓取网页、解析附件内容；
日历侧不做订阅外部日历 / 双向同步系统日历、不做周视图、不做多人共享、不做日程附件。

## 数据放在哪

默认 `~/Documents/My Workbench 资料库/`：

```
My Workbench 资料库/
├── archive.json          全部文字资料 + 全部日程
├── archive.json.bak      上一次写入前的自动备份
├── attachments/<资料id>/ 附件副本
└── backups/              备份包与恢复保险副本
```

配置与偏好（资料库路径、主题、各栏收起状态、日历视图、系统通知开关）在
`~/Library/Application Support/My Workbench/config.json`。
资料库目录**独立于应用安装位置**，重装或移动 app 都不影响数据。

`archive.json` 的 `version`：1 只有资料，**2 起带日程**；老文件没有 `schedules` 字段也能直接读。

## 源码结构

```
src/
├── main/
│   ├── main.js        主进程：窗口、菜单、archive:// 协议、全部 IPC、日程提醒定时器
│   ├── store.js       数据层：archive.json 原子读写、资料与日程 CRUD、附件复制、回收站、分类
│   ├── library.js     备份 / 恢复 / Markdown 导出 / .ics 导出 / 旧目录迁移
│   └── devtools.js    开发期自测钩子（不设环境变量就不加载）
├── preload/preload.js contextBridge 暴露受控 API
└── renderer/
    ├── index.html     三栏骨架、日历工具条、提醒条
    ├── styles.css     视觉与主题变量、日历网格与日程色条
    ├── themes.js      5 套配色主题
    ├── markdown.js    轻量 Markdown 渲染器（无依赖）
    ├── schedule.js    日期计算、重复规则展开、冲突检测、.ics 生成（纯函数，两边共用）
    └── app.js         界面逻辑
```

## 自测

```bash
node scripts/smoke-test.js        # 数据层，143 项断言

LA_LIBRARY_PATH=/tmp/la-test LA_SHOT_DIR=/tmp/la-shots LA_TEST_SCRIPT=scripts/ui-check.js \
  env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --no-sandbox --disable-gpu
```

界面自测会驱动真实窗口走完整流程（含日历：切视图、建日程、勾完成、拖拽改期、议程、反向关联、
回收站分组、.ics 弹层、提醒条）并逐步截图，同时把渲染进程的报错收集起来。
`LA_LIBRARY_PATH` 会把资料库指到临时目录，不会写进你的真实数据。
