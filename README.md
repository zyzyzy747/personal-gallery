# 个人图库

把 `E:\download\Telegram` 里的素材和几个目录里的小说，变成一个能在浏览器和手机上浏览、搜索、阅读的私有图库。没有数据库、没有云存储，全部由本机两个 Python 脚本 + 一个静态前端驱动。

---

## 这个仓库有什么

只放**代码与文档**：脚本、前端、部署记录、启动脚本。

| 入库 | 不入库（本地生成或私有） |
|---|---|
| `app/` 下的 py / js / css / html、`docs/`、`.vbs` 与 `.bat` 启动脚本 | 原图与原视频、`index.final.json`（10 MB）、`assets/` 里的缩略图与小说清单、`.gallery-token.txt`、`tools/cloudflared.exe`、各类日志 |

索引和缩略图是**本地生成物**，不跟着仓库走：素材放好后跑一次 `python build.py` 就会重建（见下节）。所以 Clone 下来是不能直接打开页面的，必须先建索引。

## 快速开始

```bat
pip install numpy pillow
cd app
python build.py          :: 扫盘建索引 + 生成缩略图，首次要跑一阵（18 万张）
python serve.py 8777     :: 起服务，浏览器打开 http://127.0.0.1:8777
```

素材根目录默认 `E:\download\Telegram`，不一样就设环境变量 `GALLERY_ROOT`（`build.py` 与 `serve.py` 读同一个）；小说来源在 `app/novel_roots.py` 里改。

---

## 一、现在有什么

| | 规模 |
|---|---|
| 图片套图 | **7,807 套 / 188,379 张 / 55 个视频** |
| 小说 | **70,170 本 / 16.81 GB / 17 个分类** |
| 索引体积 | 图片 9.74 MB（gzip 1.34 MB）· 小说 10.54 MB（gzip 2.37 MB） |
| 前端首屏 | 本机实测 0.90 s（含 7 万本小说的解析） |

素材来源两处，互不干扰：

```
E:\download\Telegram\         图片 + 部分小说（Telegram 下载的素材包）
E:\Download\novel_download\   小说（爬虫抓的，cool18 / xbookcn）
```

---

## 二、数据是怎么变成网页的

```
        磁盘                          build.py                       浏览器
┌──────────────────┐          ┌────────────────────┐        ┌──────────────┐
│ 8 千个套图目录    │  扫描    │ index.final.json   │  加载   │ 虚拟滚动网格  │
│ 18.8 万张图      │ ───────► │ assets/thumbs/*.jpg│ ─────► │ 只渲染可视行  │
│ 7 万本 txt       │          │ assets/novels.json │        │ 灯箱 / 阅读器 │
└──────────────────┘          └────────────────────┘        └──────────────┘
                                        │                            ▲
                                        │        serve.py            │
                                        └──── 静态文件 + /raw + /novel-text ────┘
```

关键点：**没有数据库**。目录名就是唯一元数据（`#coser名 - #作品 #角色 #主题`），`build.py` 负责把它解析成结构化索引，前端只读索引。原图不复制、不转码，浏览时通过 `/raw/` 直接从 E 盘读。

---

## 三、三个组成部分

### 1. `app/build.py` — 索引构建

扫盘 → 解析目录名 → 生成运行时数据。三种模式：

```bash
python build.py            # 增量构建（日常用，只处理新增）
python build.py --force    # 强制重建全部缩略图（缩略图有问题时才用）
python build.py --novels   # 只重建小说库 + 版本号（0.1~1 秒）
```

产出：

| 文件 | 用途 |
|---|---|
| `index.final.json` | 套图清单：标签、coser、日期、文件列表 |
| `assets/thumbs/t*.jpg` | 封面 240×308，另有 `@2x` 480×616 供高 DPR 屏 |
| `assets/lqip/t*.jpg` | 24×32 模糊占位图，秒出骨架 |
| `assets/files/{id}.json` | 单套图的文件清单分片，详情页按需加载 |
| `assets/novels.json` | 小说清单（书名/分类/字数/路径） |
| `assets/version.json` | 内容指纹，见 §6.3 |

### 2. `app/serve.py` — 本地服务

标准库 `http.server`，跑在 `127.0.0.1:8777`。负责四件事：

- 发静态文件（带 gzip 预压缩、分级缓存头）
- `/raw/<路径>` → E 盘原图、原视频（支持 HTTP Range 206，视频能拖进度条）
- `/novel-text/<路径>` → 小说正文，自动处理 UTF-8 / GB18030 / Big5 / UTF-16
- 令牌鉴权：本机直通，外部需 `?t=<令牌>`，之后靠 Cookie 记住

内置一个**看门狗线程**：每 60 秒算一次小说目录的结构指纹，发现新书就自动跑 `build.py --novels` 重建索引，最多 5 分钟一次。

### 3. `app/app.js` + `index.html` + `style.css` — 前端

原生 JS，无框架、无构建步骤。**3,414 行**。核心是虚拟滚动：只渲染视口内的行，7,807 套图滚起来不掉帧。

页面结构：

```
图库（网格） / 标签云 / 漫画 / 小说 / 最近
  └ 点套图 → 详情页（懒加载文件清单，视频最快）
      └ 点图 → 灯箱（键盘翻页、原图、面板）
  └ 点小说 → 阅读器（自动分页、字号调节、下载原文）
```

---

## 四、目录结构

```
2026-10-25-19-09-03/
├── app/                    前端 + 两个 Python 脚本（真正跑的东西）
│   ├── build.py            索引构建
│   ├── serve.py            服务 + 看门狗
│   ├── novel_roots.py      小说来源声明（build 与 serve 共用）
│   ├── app.js / style.css / index.html
│   ├── index.final.json(.gz)
│   └── assets/             thumbs / lqip / files / dims / novels.json
├── docs/                   设计文档
│   ├── 00-visual-style-handbook.md  视觉风格手册
│   ├── 01-visual-direction.md   视觉规范（暗房里的档案柜）
│   ├── 02-ux-spec.md            体验与信息架构
│   ├── 03-frontend-notes.md     实现说明 + 踩坑记录
│   └── 04-云端访问部署.md       域名与隧道
├── tools/cloudflared.exe   Cloudflare 隧道
├── start-gallery.vbs       启动（无窗口）
├── stop-gallery.vbs        停止
├── 更新图片.bat             加图片/视频后跑（增量）
├── 更新小说.bat             加小说后跑（秒级）
└── 重启服务.bat             带窗口的备用启动（能看到错误）
```

> 上图是**本机完整目录**。仓库里只有代码与文档那几层：`index.final.json`、`assets/`、`tools/` 与各类日志都不入库，跑 `build.py` 后本地生成。

---

## 五、日常怎么用

### 加图片或视频

```
1. 放进 E:\download\Telegram\（按原来的目录习惯）
2. 双击 更新图片.bat
3. 刷新页面
```

服务不用重启——它每次请求都读磁盘，索引更新后刷新就生效。

### 加小说

```
1. 放进 E:\Download\novel_download\<分类>\<书名>.txt
   或   E:\download\Telegram\<小说包目录>\<书名>.txt
2. 什么都不用做，5 分钟内自动出现
   想立刻看到 → 双击 更新小说.bat
```

新增**小说包目录**（不是小说文件）需要在 `app/novel_roots.py` 的 `EXTRA_ROOTS` 里加一行，格式是 `(路径, 分类名)`。

### 手机看

```
https://yourname.ccwu.cc/?t=<令牌>
```

第一次带令牌，之后靠 Cookie 记住。令牌存在项目根目录 `.gallery-token.txt`。

前提是**电脑开着**：手机 → Cloudflare 边缘 → 隧道 → 本机 `serve.py` → E 盘。电脑关机或睡眠，手机立刻打不开。

### 启动 / 停止

```
双击 start-gallery.vbs   # 启动，无窗口
双击 stop-gallery.vbs    # 停止
```

完全无窗口运行。日志在 `last-serve.log`（服务）和 `tools/service.log`（隧道）。出问题想看错误时用 `重启服务.bat`，它会带一个可见的窗口。

---

## 六、几个关键设计

### 6.1 稳定 id：`path → id` 一旦分配就永不重排

索引里每套图有一个整数 `id`，新增套图追加 `max+1`，**已有 id 绝不重排**。分配方式是从上一版 `index.final.json` 里沿用（`load_id_map()`），没有独立的映射文件。

为什么重要：缩略图文件名是 `t{id}.jpg`。如果 id 重排，所有缩略图 URL 全变，浏览器缓存全废，且手机上会看到错图。

### 6.2 虚拟滚动用 `spacer + 绝对定位行`

```
grid.spacer (高度 = 总行数 × 行高)
  └ 只渲染可视区附近的 5~8 行，行内是固定数量的卡片槽
     └ 滚出视口的行回收进 pool，复用 DOM
```

`makeRow(cols)` 按当前列数建槽——一个曾经踩过的坑：不管几列都建 6 个槽，导致手机 2 列布局下多出的 4 张卡被 `hidden` 却仍占位。

### 6.3 两个版本号，不是一个

`assets/version.json`：

```json
{"v": "68599c4dd6f6", "nv": "ebd6630bf0e3", "at": 1793041975}
```

- **`v`** = 图片索引 + 前端代码（app.js / style.css / index.html）
- **`nv`** = 只算 `novels.json`

前端分别用作 `index.final.json?v=...` 和 `novels.json?nv=...` 的查询参数。

为什么不合成一个：图片索引 gzip 后 1.34 MB，小说清单 2.37 MB。小说经常变（爬虫在跑、加书），共用一个版本号意味着**每加一本书手机就要重下 1.34 MB 完全没变的图片索引**。

`index.html` 里的 `app.js?v=` 也要跟着 `v` 刷新，否则浏览器会一直跑缓存里的旧脚本——而旧脚本根本不会去请求 `version.json`。

### 6.4 小说多根 + 根序号

小说放在两处结构完全不同：

```
novel_download\          子目录 = 分类（cool18 / xbookcn / 催眠 …）
Telegram\成人长篇小说…\   整个目录 = 一个分类，6 万个 txt 平铺
```

索引里的 `p` 字段带根序号：

```
0/cool18/cool18/某本书        ← 根 0（爬虫书库）
1/20260615_xxx.txt            ← 根 1（Telegram 小说包）
```

服务端按 `p.split('/', 1)` 还原绝对路径，不同根下的同名书不会撞。路径穿越在这一层统一挡掉。

### 6.5 原子写 + 重试

`novels.json` 每次重建都是「写 `.tmp` → `os.replace`」。Windows 上 `os.replace` 要求目标文件没被打开，而 1 MB 级的 json 刚被浏览器读过之后句柄释放有延迟，Defender 也会短暂占住新文件。

实测占用窗口 **1~2 秒**。不重试的话看门狗会毫无规律地失败（"拒绝访问"），而且失败时前端拿到的还是旧数据，很难察觉。所以 `_atomic_replace()` 会重试 20 次 × 0.25 秒。

### 6.6 无窗口运行

`serve.py` 和 `cloudflared` 都是控制台程序，正常启动必然带窗口。用 VBScript 的 `Run(cmd, 0, False)`（窗口样式 0）启动，任务栏里什么都不留。

配套代价：没有窗口可看状态，所以提供了 `stop-gallery.vbs`（弹框确认结果）和日志文件。

---

## 七、踩过的坑

这些是真实修过的 bug，记录下来避免重犯。

| 现象 | 根因 | 修法 |
|---|---|---|
| 小说点哪本都打开同一本 | `for (var i...)` 里用 `var n` 绑事件，闭包共享一个变量，循环结束后指向最后一行 | 用 IIFE 把当前值绑进去 |
| 漫画只有 10 个（应为 260） | 分类的 `manga` 标记没继承到子套图 | `'manga': bool(RE_MANGA_GROUP.search(d0))` |
| 卡片标题全是"漫画" | `#媚黑 #漫画 #potion` 解析出 `themes:['漫画']`，取到了类型词 | 加 `GENERIC_TAGS` 泛词表，跳过类型词取第一个具体标签 |
| 新建小说"抓了但没生效" | 爬虫多套了一层 `cool18/cool18/<书名>`，整个聚合层被当成 **1 本书** | 判据改为「子目录含 txt 且不像章节容器 ≥ 2 个 → 当聚合层展开」 |
| 手机刷新一直是旧数据（三层缓存） | `force-cache` + `max-age=3600` + Cloudflare 给 js/css 的 4 小时 TTL | 内容指纹 + `?v=` + 分级缓存头 |
| 加书后 5 分钟内第二批永久丢失 | 节流时先更新了 `last`，被拦下的那批再也不会补 | 改成 `pending` 标记，节流只推迟不丢弃 |
| 小说重建从 1 秒变成 **140 秒** | 6 万个文件逐个 `os.path.getsize`，每次都触发 Defender 扫描 | 改用 `os.scandir`，DirEntry 自带大小 |
| `重启服务.bat` 静默失败，服务没起也没报错 | `start "" /min "exe" args` 里 cmd 把带引号的 exe 当成窗口标题 | 改成前台运行（失败能看见），或 `start "标题" /min 无引号路径` |
| 差点删掉 3,000 多张写真 | 按目录名判断内容类型——`更多TG搜索@xxx_bot` 这种名字的目录里全是正常 cosplay 写真 | **名字是广告 ≠ 内容是广告**，改为一律只清洗显示名，不动文件 |
| Node 检查通过但页面白屏 | Python heredoc 写 JS，`\n` 变成了真换行 | 改文件后用 `node --check`，浏览器测试必须监听 `pageerror` |

---

## 八、已知限制

- **电脑必须开着**。不是云盘，是电脑上的服务通过隧道暴露出去。睡眠/关机 = 手机断。
- **开机自启大约要等 2 分钟**。启动脚本先跑增量 build（扫描 18 万张图），完事才起服务。
- 小说库 7 万本，列表默认只显示 80 本，"加载更多"每次 +80。数量大时建议用搜索或分类过滤，而不是一直翻页。
- 小说列表是**全量加载**（10.54 MB / gzip 2.37 MB）。首次打开要下载完才能搜索，4G 下约 3~5 秒。
- 追更（往已有 txt 里追加章节）**不会**触发索引更新——看门狗只盯目录结构。正文本身是实时读磁盘的，能读到最新内容，只是列表里的字数不会变。要更新字数就随便新建个空目录再删掉。
- 索引里约 1.6% 的书小于 4 KB，是站点上的残帖；小于 1 KB 的直接被丢弃（`scan_novels` 里的阈值）。
- 图片库和小说库完全独立：图片走 `index.final.json`，小说走 `novels.json`，加一种是另一种不会重扫。

---

## 九、当前运行状态

写这份文档时（2026-10-28 16:54）的状态：

| | |
|---|---|
| 服务 `serve.py` | 运行中，监听 127.0.0.1:8777 |
| 隧道 `cloudflared` | **未运行**（12:29 启动后连接失败退出，`cloudflared.err` 里有 `control stream error`） |
| 开机自启 | `startup-gallery.vbs` 被改名为 `.disabled`，当前不生效 |

排查顺序：

```bash
# 1. 本地服务是否活着
netstat -ano | findstr ":8777"

# 2. 隧道是否有进程
tasklist | findstr cloudflared

# 3. 隧道为什么挂
type tools\service.log
```

如果本地服务正常但手机打不开，问题一定在隧道这一层，不在图库本身。
