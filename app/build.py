"""写真图库 · 一键构建管线

从 E:\\download\\Telegram 原始素材重建全部运行时数据：

    python build.py            # 全量构建
    python build.py --index    # 只重建索引
    python build.py --thumbs   # 只重建缩略图 + LQIP

产出：
    index.final.json          索引（含完整文件名清单 + 归一化 alias 表）
    assets/thumbs/*.jpg       5292 张封面缩略图（240×308）
    assets/lqip/*.jpg         5292 张 LQIP 模糊占位图（24×32）
    assets/files/{id}.json    5292 个套图的文件清单分片（详情页按需加载）
    assets/thumbmeta.json     每张封面的主色 + 亮度
    assets/shotdates.json     每套图的拍摄日期（众数）

用法：
    C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe build.py
"""
import os, re, sys, json, time, argparse, collections, importlib.util
import concurrent.futures as cf

import numpy as np
from PIL import Image

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
import paths  # noqa: E402  库根的唯一声明处（整理后是 E:\Download\01-图库）

ROOT = paths.MEDIA_ROOT
ASSETS = os.path.join(BASE, 'assets')
IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp')
# 视频：不生成缩略图（本机没有 ffmpeg 抽帧），前端用 <video> 首帧当封面，
# 播放依赖 serve.py 的 Range 支持（已实现 206 分段）
VID_EXT = ('.mp4', '.webm', '.mov', '.mkv', '.m4v', '.avi', '.wmv')

# ---------------------------------------------------------------- 解析器
# 复用前端成员验证过的解析实现（parse_rules_proto.py）——它能正确抽取
# pages / size / promo / times / emoji，并且用三层证据做 works/roles/themes 分类。
_spec = importlib.util.spec_from_file_location(
    'parse_rules_proto', os.path.join(BASE, 'parse_rules_proto.py'))
_prp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_prp)

RE_DATE8 = re.compile(r'^(\d{4})(\d{2})(\d{2})')
RE_SEP = re.compile(r'[·・\s_]+')


def norm_key(s):
    return RE_SEP.sub('', s).lower()


# ---------------------------------------------------------------- 扫描与分类

def scan():
    """用 parse_rules_proto 的两层流程解析全库。"""
    lex = _prp.Lexicon()
    raw_items = []
    for d0 in sorted(os.listdir(ROOT)):
        p0 = os.path.join(ROOT, d0)
        if not os.path.isdir(p0):
            continue
        for d1 in sorted(os.listdir(p0)):
            p1 = os.path.join(p0, d1)
            if not os.path.isdir(p1):
                continue
            try:
                entries = os.listdir(p1)
            except OSError:
                continue
            files = sorted(f for f in entries if f.lower().endswith(IMG_EXT))
            vids = sorted(f for f in entries if f.lower().endswith(VID_EXT))
            # 只有视频没有图片的套图也要收（否则视频整段消失）
            if not files and not vids:
                continue
            raw_items.append((d0, d1, p1, files, vids))

    # 第一遍：只用标签列表建词表
    prelim = []
    for d0, d1, p1, files, vids in raw_items:
        r = _prp.parse(d1, lex)
        prelim.append(r)
    lex.build_stats([r['tags'] for r in prelim])

    # 第二遍：带完整词表重新解析
    sets = []
    for (d0, d1, p1, files, vids), r in zip(raw_items, prelim):
        r = _prp.parse(d1, lex)
        sets.append({
            'raw': r['raw'], 'coser': r['coser'], 'co': r.get('alias', []),
            'tags': r['tags'], 'works': r['works'], 'roles': r['roles'],
            'themes': r['themes'], 'others': r['others'],
            'series': '', 'pages': r['pages'], 'size': r['size'],
            'times': r['times'], 'emoji': r['emoji'], 'promo': r['promo'],
            'group': d0, 'n': len(files), 'count': len(files), 'path': p1, 'files': files,
            'videos': vids, 'vn': len(vids),
            # 漫画标记必须从**分组名**继承，不能只看散图。
            # 早期版本只在 scan_loose 里判断，导致分组内的 260 个漫画套图
            # 全被当成写真混进主网格（实测：漫画库 260 套只有 10 个散图集被标）。
            'manga': bool(RE_MANGA_GROUP.search(d0)),
            'kinds': {'works': r['works'], 'roles': r['roles'], 'themes': r['themes']},
        })
    sets.sort(key=lambda s: (-s['count'], s['raw']))
    # 注意：这里**不分配 id**。数组顺序（显示顺序）和 id（稳定标识）是两件事，
    # id 在 main() 里按「沿用旧索引 + 新套图追加」的方式稳定分配。
    tf = collections.Counter()
    for s in sets:
        tf.update(s['tags'])
    return sets, tf, lex.works, lex.roles, lex


RE_TG_AD = re.compile(
    r'^(更多)?\s*(tg|telegram)\s*(搜|搜索)?\s*[:：]?\s*@?\w'
    r'|^@\w{5,}$|^完整版\s*[→>]|^douz[ai]\d+$', re.I)


# 广告目录名里的噪音：TG 账号、话术、表情标记。
# 这些目录里装的其实是**真实写真**（实测 226 张的目录全是 cosplay 真人照），
# 只有目录名被发布者当成了广告位。所以清洗显示名，不动文件。
RE_AD_NAME = re.compile(r'^(更多)?\s*(tg|telegram)\s*(搜|搜索)?\s*[:：]?\s*@?\w'
                        r'|^@\w{5,}|^完整版\s*[→>]|^douz[ai]\d+$|^📌|^预览版\s', re.I)
RE_AD_NAME2 = re.compile(
    r'相关资源|相关流出|近期精选|社群精选|高级社群|点击预览'
    r'|入门.*@|接裸聊|接单|裸聊|定制.*@|频道：@|欢迎加群|扫码'
    r'|x账号：@|免费公开频道|蹲蹲入门|线上滴滴|接头霸王', re.I)
RE_AD_STRIP = re.compile(
    r'@[A-Za-z0-9_]{3,}'                      # TG / X 账号
    r'|更多\s*(TG|Telegram)\s*搜索?'          # 更多TG搜索
    r'|(TG|Telegram)\s*(搜|搜索)'              # tg搜
    r'|douz[ai]\d+'                           # 站方机器人号
    r'|完整版\s*[→>]|预览版'
    r'|点击预览|👀|📌'
    r'|接裸聊|接单+|裸聊|定制|入门|蹲蹲|线上|滴滴|接头霸王'
    r'|欢迎加群|扫码|咨询|色色|联系|语音'
    r'|相关资源|相关流出|近期精选|社群精选|高级社群|部分相关|近期部分'
    r'|更多资源|免费公开频道|频道[:：]'
    r'|不入门价格稍贵|找我玩|欢迎您来和咱玩|咱在努力|鉴定转盘等等?'
    r'|精选|资源|流出|相关|部分|服务|账号|频道|等(线上|服务)?'
    r'|付费|收费|红包|转账|私聊|单独',
    re.I)

# 清洗后「看着不像正常标题」的判定：只剩通用词、太短、或仍是一句话术
RE_AD_ONLYGENERIC = re.compile(
    r'^[\s:：,，.。、\-—_·]*(等|服务|近期|资源|精选|相关|部分|频道|账号|入门|定制|线上)+'
    r'[\s:：,，.。、\-—_·]*$')


def clean_ad_names(sets):
    """把广告式目录名洗成人能看的名字，**不动任何文件**。

    为什么改名字而不是删目录：抽样 4 个"广告目录"逐个看图，里面全是真实写真
    （`更多TG搜索@douzi233233_bot` 226 张全是 cosplay 真人照），目录名只是
    发布者的 TG 推广位。删目录等于白丢几千张内容。

    清洗后如果什么都不剩（目录名纯粹是账号+话术），统一叫「匿名合集 · N张」，
    靠张数和封面区分，列表里不再出现 TG 账号。
    """
    n = 0
    for s in sets:
        raw = s.get('raw', '')
        if not raw or s.get('loose'):
            continue
        if not (RE_AD_NAME.search(raw.strip()) or RE_AD_NAME2.search(raw)):
            continue

        cleaned = RE_AD_STRIP.sub(' ', raw)
        cleaned = re.sub(r'[\[\]（）()【】<>《》「」『』·\-—_~|/\\]+', ' ', cleaned)
        cleaned = re.sub(r'\s+', ' ', cleaned).strip(' -·_')

        # 三种情况一律匿名化，宁可叫「匿名合集」也不要留半截广告话术：
        #   ① 清完太短  ② 只剩通用词（"等 服务"）  ③ 原目录名是一整句广告（>28 字）
        looks_bad = (len(cleaned) < 4
                     or re.match(r'^[A-Za-z]{1,6}\d*$', cleaned)   # "dddd" 这类无意义串
                     or RE_AD_ONLYGENERIC.match(cleaned)
                     or (len(raw) > 28 and len(cleaned) > 18))
        if looks_bad:
            cleaned = '匿名合集 · %d张' % s.get('n', len(s.get('files', [])))
        s['raw'] = cleaned
        s['adname'] = raw          # 保留原名供溯源
        n += 1
    return n


def mark_junk(sets):
    """标记「纯引流目录」为隐藏（复用 promo 字段，前端已按 promo 过滤）。

    实测最大的一个引流目录有 226 张，内容全是 TG 账号广告图，混在写真列表里
    很影响浏览。只认「目录名本身就是引流账号」这种明确情况
    —— `社交：@xxx`、`抖音xxx 最全资源` 这类可能含真实内容的目录不动。
    """
    n = 0
    for s in sets:
        if s.get('promo') or s.get('loose'):
            continue
        if RE_TG_AD.match(s['raw'].strip()):
            s['promo'] = True
            s['junk'] = True
            n += 1
    return n


RE_ASCII_TAIL = re.compile(r'^[A-Za-z0-9\.\-\_\s]+$')
RE_SUB_MARK = re.compile(r'^\d{0,4}\s*年?\s*\d{1,2}\s*月?\s*(订阅|自拍|新作|更新)$')
RE_COSER_TAIL = re.compile(r'[\-_·~\s]+$')
RE_CHAT_TAIL = re.compile(r'[,，、]')
RE_DUO = re.compile(r'\s*[&+＋]\s*')


def strip_chat_tail(sets):
    """在第一个逗号处截断 coser 字段。

    实测这批目录名把发布者的口语评价拼在了后面：
      `星之迟迟 芙露德莉斯 鸣潮 这种的我喜欢,圣女真好看😍`
      `一千只猫薄禾 女仆 挺反差,脸也不错`
    逗号前是结构化信息，逗号后是闲聊。截断后前面的部分才能被正常拆解。
    """
    n = 0
    for s in sets:
        if s.get('loose'):
            continue
        c = s['coser']
        if not c or not RE_CHAT_TAIL.search(c):
            continue
        head = RE_CHAT_TAIL.split(c, 1)[0].strip()
        if head and head != c:
            s['coser'] = head
            n += 1
    return n


def rescue_inline_tags(sets, lex=None):
    """把「coser 名里内联了标签」的套图拆开。

    目录名有两种常见写法：
      A. `#coser - #标签`      → 解析器已正确处理
      B. `#coser 标签1 标签2`   → 整串被当成 coser 名，标签全空

    B 的处理分两种匹配：
      B1. `known + 空格`：`封疆疆 原神 久岐忍` → coser=封疆疆
      B2. **中英连写**：`雨波HaneAme 原神 雷电将军` —— 词表里只有 `雨波`，
          但它后面紧跟英文名而非空格，所以还要吃「已知名 + 纯 ASCII 尾段」
          才算 coser（`雨波HaneAme`），否则会漏掉一大批。

    只对 `tags` 为空的套图生效，所以不会误伤 `#Hane Ame - #泳装`
    这类本身含空格但又带标签的 coser 名。
    """
    known = {s['coser'] for s in sets if s['coser'] and ' ' not in s['coser']}
    known_sorted = sorted(known, key=len, reverse=True)

    rescued = 0
    for s in sets:
        if s.get('loose'):
            continue            # 虚拟套图的 coser 是分组简称，不可拆
        c = s['coser']
        if not c or s['tags']:
            continue

        # 双人 coser：`A&B 标签` → coser=A，B 进 co，其余作标签
        duo = RE_DUO.split(c)
        if len(duo) >= 2:
            head = RE_COSER_TAIL.sub('', duo[0].strip())
            rest = [p for p in duo[1].split() if p]
            if head and len(rest) >= 2:
                s['coser'] = head
                s['co'] = [rest[0]]
                tags = [p for p in rest[1:] if not RE_SUB_MARK.match(p)]
                if tags:
                    s['works'], s['roles'], s['themes'], s['others'] = [], [], [], []
                    for p in tags:
                        kk = norm_key(p)
                        if lex is not None and kk in lex.works:
                            s['works'].append(p)
                        elif lex is not None and kk in lex.roles:
                            s['roles'].append(p)
                        else:
                            s['themes'].append(p)
                    s['tags'] = s['works'] + s['roles'] + s['themes']
                    s['kinds'] = {'works': s['works'], 'roles': s['roles'],
                                  'themes': s['themes']}
                    rescued += 1
                    continue

        if ' ' not in c:
            continue

        parts = c.split()
        head, rest_parts = None, None

        for k in known_sorted:
            if len(k) < 2:
                continue
            # B1：已知 coser + 空格
            if c.startswith(k + ' '):
                head = k
                rest_parts = [p for p in c[len(k):].strip().split() if p]
                break
            # B2：中英连写 —— 已知名是首段前缀，其余是纯 ASCII
            if parts[0].startswith(k) and len(parts[0]) > len(k):
                tail = parts[0][len(k):]
                if RE_ASCII_TAIL.match(tail) and len(parts) > 1:
                    head = parts[0]
                    rest_parts = parts[1:]
                    break

        if not head or not rest_parts:
            continue

        # 去掉订阅期标记之类的非内容词
        tags = [p for p in rest_parts if not RE_SUB_MARK.match(p)]
        if not tags:
            continue

        s['coser'] = RE_COSER_TAIL.sub('', head) or head
        s['works'], s['roles'], s['themes'], s['others'] = [], [], [], []
        for p in tags:
            kk = norm_key(p)
            if lex is not None and kk in lex.works:
                s['works'].append(p)
            elif lex is not None and kk in lex.roles:
                s['roles'].append(p)
            else:
                s['themes'].append(p)
        s['tags'] = s['works'] + s['roles'] + s['themes']
        s['kinds'] = {'works': s['works'], 'roles': s['roles'],
                      'themes': s['themes']}
        rescued += 1
    return rescued


# ---------------------------------------------------------------- 小说库

# 小说放另一个根目录，和图片素材完全分开：一个是 30 GB 图片，一个是 2.6 GB 文本，
# 扫描逻辑、展示形态都不一样（小说没有封面和缩略图，只有书名和字数）。
# 小说来源在 novel_roots.py 里统一声明 —— build（生成索引）和 serve（供正文）
# 必须看到同一份列表，否则索引里有书、点开却 404。
sys.path.insert(0, BASE)
import novel_roots

NOVEL_TEXT_EXT = ('.txt',)
# 电子书格式：索引只认 txt 的时候，开心书库里 546 本 epub/chm/mobi 在库里
# 完全看不见（38.9 GB 的分组里一半是它们）。现在统一入库：
#   epub  —— 可以在线读（serve.py 里拆 zip 取正文）
#   其余  —— 只入库可下载（mobi/chm 解析依赖外部库，本轮不做，如实标注格式）
NOVEL_EBOOK_EXT = ('.epub', '.mobi', '.azw3', '.chm', '.pdf', '.doc', '.docx')
NOVEL_EXT = NOVEL_TEXT_EXT + NOVEL_EBOOK_EXT
# 可以在阅读器里直接读的格式
NOVEL_READABLE_EXT = ('.txt', '.epub')
# 这些目录是爬虫工具和元数据，不是书
NOVEL_SKIP_DIRS = {'_scripts', '__pycache__', '.git'}
NOVEL_SKIP_FILES = {'_index.md'}
# 章节容器目录名：书目录里再套一层专门放章节的，不能当成「聚合层」拆开
NOVEL_CHAPTER_DIRS = {'chapters', 'chapter', '章节', '正文', 'txt',
                      'text', 'content', 'contents', 'files'}


def _novel_txts(d):
    """递归收集目录下所有章节 txt（跳过爬虫工具目录和元文件）。"""
    out = []
    for root, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if x not in NOVEL_SKIP_DIRS]
        for f in files:
            if f.lower().endswith(NOVEL_EXT) and f not in NOVEL_SKIP_FILES:
                out.append(os.path.join(root, f))
    return out


def _ebook_words(fp, fallback_bytes):
    """电子书字数估算。

    epub 就是一堆 xhtml 打包，ZipInfo.file_size 是**解压后**大小，
    不读内容就能把正文体积估出来（比 size/3 靠谱得多——epub 本身是
    压缩的 zip，拿压缩后字节数除以 3 会小一大截）。
    其余格式（mobi/chm/pdf）没有通用解压信息，返回 0，前端显示「—」。
    """
    import zipfile
    if fp.lower().endswith('.epub'):
        try:
            with zipfile.ZipFile(fp) as z:
                raw = sum(i.file_size for i in z.infolist()
                          if i.filename.lower().endswith(('.html', '.xhtml', '.htm')))
            if raw:
                return raw // 3
        except Exception:
            pass
    return 0


def _book_fmt(files):
    """一本书的格式：有 txt 就按 txt（可能是一堆章节），否则取第一个电子书后缀。"""
    for f in files:
        if f.lower().endswith(NOVEL_TEXT_EXT):
            return 'txt'
    for f in files:
        ext = os.path.splitext(f)[1].lower().lstrip('.')
        if ext:
            return ext
    return 'txt'


def _novel_item(rel, name, cat, txts, sizes=None):
    """一组章节 txt（或一个电子书文件）→ 一个图库条目。不足 1KB 的视作空书丢弃。

    rel 形如 "<根序号>/<相对该根的路径>"，服务端靠它还原绝对路径。
    字数用 size/3 估算（UTF-8 中文约 3 字节一个字），不读全文 ——
    几万本书 17 GB 全读一遍要几分钟，估算误差对「这本书多长」够用了。
    epub 例外：用解压后体积估，见 _ebook_words。

    sizes 与 txts 一一对应时直接用，省掉每个文件一次 getsize ——
    平铺根下有 6 万个 txt，逐个 stat 会让扫描从 2 秒变成两分钟。
    """
    if not txts:
        return None
    if sizes is None:
        sizes = []
        for x in txts:
            try:
                sizes.append(os.path.getsize(x))
            except OSError:
                sizes.append(0)
    total = sum(sizes)
    if total < 1024:
        return None
    fmt = _book_fmt(txts)
    if fmt == 'txt':
        words = total // 3
    else:
        words = _ebook_words(txts[0], total)
    return {
        't': name,                 # 书名
        'c': cat,                  # 分类（展示用）
        's': total, 'w': words,
        'f': fmt,                  # 格式：txt / epub / mobi / chm / pdf …
        'p': rel,                  # 服务端据此定位正文
        'n': len(txts),            # 章节数（电子书恒为 1）
    }


def _scan_category_dir(cat, dirpath, prefix):
    """扫一个分类目录（根下的一级子目录），产出若干本书。

    目录形态有四种，靠「有没有直接 txt」「子目录像不像章节容器」区分：
        A   <分类>/<书名>.txt               历史数据的平铺结构
        B1  <分类>/<书名>/<书名>.txt        爬虫主流输出
        B2  <分类>/<书名>/chapters/*.txt    分章存储
        B3  <分类>/<聚合层>/<书名>/...       爬虫多套了一层（cool18/cool18）

    B3 曾经是个隐蔽 bug：把整个 cool18/cool18 当成一本书，几十本并成一个
    叫「cool18」的巨大条目。判据是「直接子目录里含 txt 的非章节目录 >= 2」。
    """
    out = []
    # scandir 而不是 listdir：合并三根之后，成人长篇那 6 万个平铺 txt 会走
    # 情况 A，DirEntry 自带 size，省掉每个文件一次 getsize —— 后者在 Defender
    # 实时扫描下会让小说重建从几秒变成两分钟。
    try:
        with os.scandir(dirpath) as it:
            entries = sorted(it, key=lambda e: e.name)
    except OSError:
        return out

    for e in entries:
        entry = e.name
        if entry in NOVEL_SKIP_FILES:
            continue
        ep = e.path
        rel = '%s/%s/%s' % (prefix, cat, entry)

        # 情况 A：分类下直接是 txt（或单文件电子书 epub/mobi/chm…）
        try:
            is_file = e.is_file()
            asize = e.stat().st_size
        except OSError:
            is_file, asize = False, 0
        if is_file and entry.lower().endswith(NOVEL_EXT):
            it = _novel_item(rel, os.path.splitext(entry)[0], cat, [ep], [asize])
            if it:
                out.append(it)
            continue

        if is_file:
            continue          # 分类根下的非书文件（封面、json 之类）直接跳过
        if not os.path.isdir(ep):
            continue

        # 情况 B1：书目录第一层就有 txt
        try:
            own = [f for f in os.listdir(ep)
                   if f.lower().endswith(NOVEL_EXT) and f not in NOVEL_SKIP_FILES
                   and os.path.isfile(os.path.join(ep, f))]
        except OSError:
            own = []
        if own:
            it = _novel_item(rel, entry, cat, _novel_txts(ep))
            if it:
                out.append(it)
            continue

        # 情况 B3：聚合层 —— 子目录各自含 txt 且不像章节容器
        kid_txts = {}
        try:
            subs = sorted(os.listdir(ep))
        except OSError:
            subs = []
        for x in subs:
            xp = os.path.join(ep, x)
            if (not os.path.isdir(xp) or x in NOVEL_SKIP_DIRS
                    or x.lower() in NOVEL_CHAPTER_DIRS):
                continue
            t = _novel_txts(xp)
            if t:
                kid_txts[x] = t
        if len(kid_txts) >= 2:
            for k, t in kid_txts.items():
                it = _novel_item('%s/%s' % (rel, k), k, cat, t)
                if it:
                    out.append(it)
            continue

        # 情况 B2：一本书（章节可能在 chapters/ 之类子目录里）
        it = _novel_item(rel, entry, cat, _novel_txts(ep))
        if it:
            out.append(it)
    return out


def _scan_flat_dir(cat, dirpath, prefix):
    """平铺模式：整个目录就是一分类，里面的 txt / 书目录各自成书。

    Telegram 下载的小说包是这种：几千个 txt 直接堆在一个目录里，
    没有「分类」这一层，所以不能套 _scan_category_dir（那会把每个 txt
    当成一个分类，全都扫不到）。
    """
    out = []
    # scandir 而不是 listdir + isfile：DirEntry 自带类型与大小，
    # 平铺根下有 6 万个 txt，逐个 os.path.getsize 会慢两个数量级
    try:
        with os.scandir(dirpath) as it:
            entries = sorted(it, key=lambda e: e.name)
    except OSError:
        return out
    for e in entries:
        if e.name in NOVEL_SKIP_FILES:
            continue
        rel = '%s/%s' % (prefix, e.name)
        try:
            is_dir = e.is_dir()
        except OSError:
            continue
        if is_dir:
            it = _novel_item(rel, e.name, cat, _novel_txts(e.path))
            if it:
                out.append(it)
            continue
        if not e.name.lower().endswith(NOVEL_EXT):
            continue
        try:
            sz = e.stat().st_size
        except OSError:
            sz = 0
        it = _novel_item(rel, os.path.splitext(e.name)[0], cat, [e.path], [sz])
        if it:
            out.append(it)
    return out


def scan_novels():
    """扫描所有小说来源根，产出精简清单。

    roots() 来自 novel_roots.py：根 0 是爬虫书库（子目录=分类，走
    _scan_category_dir），其余根自己就是一个分类（走 _scan_flat_dir）。
    索引里的 p 带根序号，服务端据此还原绝对路径，不同根下的同名书不会撞。
    """
    items = []
    found = False
    for idx, (root, cat) in enumerate(novel_roots.roots()):
        if not os.path.isdir(root):
            continue
        found = True
        if cat is None:
            try:
                subs = sorted(os.listdir(root))
            except OSError:
                continue
            for d in subs:
                p = os.path.join(root, d)
                if not os.path.isdir(p) or d in NOVEL_SKIP_DIRS:
                    continue
                items.extend(_scan_category_dir(d, p, str(idx)))
        else:
            items.extend(_scan_flat_dir(cat, root, str(idx)))

    if not found:
        return None
    items.sort(key=lambda x: x['t'])
    return {
        'meta': {
            'total': len(items),
            'bytes': sum(x['s'] for x in items),
            'cats': sorted({x['c'] for x in items}),
            'roots': [r for r, _ in novel_roots.roots()],
        },
        'list': items,
    }


def _atomic_replace(tmp, dst, tries=20, wait=0.25):
    """把 tmp 原子替换成 dst，被占用时自动重试。

    Windows 上 os.replace 要求目标文件没有被打开。而 1 MB 级的 json 刚被
    浏览器或服务读过之后，句柄释放有延迟；Defender 的实时扫描也会短暂占住
    新文件。实测占用窗口 1~2 秒 —— 不重试的话，看门狗的重建会毫无规律地
    失败（"拒绝访问"），而且失败时前端拿到的还是旧数据，很难察觉。
    """
    last = None
    for _ in range(tries):
        try:
            os.replace(tmp, dst)
            return True
        except OSError as e:
            last = e
            time.sleep(wait)
    print('  ! 替换 %s 失败（已重试 %d 次，共 %.1fs）: %s'
          % (os.path.basename(dst), tries, tries * wait, last))
    return False


def write_novels(say=print):
    """扫描并写出 assets/novels.json。返回书的本数；目录不存在返回 0，出错返回 -1。

    单独抽出来是为了让爬虫抓完新书后能只跑这一步（--novels），
    不必为了一本小说重扫 14 万张图。
    """
    try:
        novels = scan_novels()
    except Exception as e:
        say('  ! 小说扫描失败（不影响图片库）: %s' % e)
        return -1
    if not novels:
        say('  小说目录都不存在，跳过')
        return 0

    npath = os.path.join(ASSETS, 'novels.json')
    os.makedirs(ASSETS, exist_ok=True)
    # 先写临时文件再原子替换：serve.py 的看门狗会在服务运行时重建，
    # 直接覆盖存在「前端正好读到半个 JSON」的瞬间，会导致小说页整片空白。
    tmp = npath + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(novels, f, ensure_ascii=False, separators=(',', ':'))
    if not _atomic_replace(tmp, npath):
        return -1

    # 预压缩一份 .gz：两万本书的清单 3.7 MB，手机上 4G 首屏要等好几秒。
    # serve.py 只在客户端声明支持 gzip 时才发 .gz，本地调试不受影响。
    try:
        import gzip
        tmpg = npath + '.gz.tmp'
        with open(npath, 'rb') as fi, gzip.open(tmpg, 'wb', compresslevel=6) as fo:
            while True:
                chunk = fi.read(1 << 20)
                if not chunk:
                    break
                fo.write(chunk)
        if _atomic_replace(tmpg, npath + '.gz'):
            say('  预压缩 novels.json  %.2f MB → %.2f MB'
                % (os.path.getsize(npath) / 1048576,
                   os.path.getsize(npath + '.gz') / 1048576))
    except Exception as e:
        say('  ! 预压缩失败（不影响功能）: %s' % e)

    say('  小说库：%d 本 / %.0f MB / %d 个分类 → assets/novels.json'
        % (novels['meta']['total'], novels['meta']['bytes'] / 1048576,
           len(novels['meta']['cats'])))
    return novels['meta']['total']


def write_version(say=print):
    """算内容指纹写 assets/version.json，并把版本号刷进 index.html 的引用。

    输出**两个**版本号，前端分开用 —— 不能合成一个：

      v    图片索引 + 前端代码    索引 gzip 后 1.3 MB，只有它真变了才该重下
      nv   小说库单独一个          爬虫每抓一批就会变；混进 v 会让手机
                                  反复白下 1.3 MB 完全没变的索引

    覆盖范围必须包含所有会被缓存的资源，缺一个就会出现「数据更新了但界面是旧的」：
    index.final.json / app.js / style.css / index.html（先剥掉自己的 ?v= 再算，
    否则版本号里含版本号，自我循环）。
    """
    import hashlib

    def digest(items):
        hh = hashlib.sha256()
        for p, is_text in items:
            if not os.path.exists(p):
                continue
            if is_text:
                with open(p, encoding='utf-8') as f:
                    hh.update(re.sub(r'\?v=[0-9a-z]*', '', f.read()).encode('utf-8'))
            else:
                with open(p, 'rb') as f:
                    hh.update(f.read())
        return hh.hexdigest()[:12]

    idx = os.path.join(BASE, 'index.final.json')
    if not os.path.exists(idx):
        say('  ! 索引不存在，跳过版本号')
        return ''
    html = os.path.join(BASE, 'index.html')
    code = [(os.path.join(BASE, 'app.js'), False),
            (os.path.join(BASE, 'style.css'), False),
            (html, True)]

    h = digest([(idx, False)] + code)
    nv = digest([(os.path.join(ASSETS, 'novels.json'), False)])
    try:
        vpath = os.path.join(ASSETS, 'version.json')
        os.makedirs(ASSETS, exist_ok=True)
        with open(vpath, 'w', encoding='utf-8') as f:
            json.dump({'v': h, 'nv': nv, 'at': int(time.time())}, f)
        say('  版本号 %s（小说 %s）→ assets/version.json' % (h, nv))

        # 同时把版本号写进 index.html 的脚本/样式引用。Cloudflare 对 .js/.css
        # 会套自己的 Browser Cache TTL（默认 4 小时），覆盖源站的 no-cache；
        # URL 带版本号才能让手机立刻拿到新脚本 —— 否则连 version.json 都不会去取。
        if os.path.exists(html):
            with open(html, encoding='utf-8') as f:
                hc = f.read()
            hc2 = re.sub(r'(app\.js|style\.css)\?v=[^"\']*', r'\1?v=' + h, hc)
            if hc2 != hc:
                with open(html, 'w', encoding='utf-8') as f:
                    f.write(hc2)
                say('  index.html 引用版本已刷新')
    except Exception as e:
        say('  ! 写版本号失败（前端会退化为无参数请求）: %s' % e)
    return h


# ---------------------------------------------------------------- 散图（平铺在分组目录下）

RE_MANGA_GROUP = re.compile(r'漫画|同人|画集|CG集|插画|comic', re.I)
RE_LOOSE_DATE = re.compile(r'^(\d{8})')
RE_EMOJI_STRIP = re.compile(
    '[' '\U0001F300-\U0001FAFF' '\U00002600-\U000027BF' '\U0001F000-\U0001F2FF'
    '\u2b00-\u2bff' '\ufe0f' ']+')


def group_short(name):
    """分组目录名 → 展示用简称。去掉 emoji / #数字 后缀 / 长描述。"""
    s = RE_EMOJI_STRIP.sub('', name).strip()
    s = re.sub(r'#\d+.*$', '', s).strip()
    if '_' in s:
        s = s.split('_')[0].strip()
    s = re.sub(r'\[(NSFW|nsfw)\]', '', s).strip()
    return (s or name)[:16]


def scan_loose():
    """扫描**平铺在分组目录下**的图片，按「分组 + 月份」聚合成虚拟套图。

    这些图不在任何套图子目录里（下载时目录结构丢了），早期版本直接跳过，
    等于从图库里消失（实测 20,498 张，占总量 16.7%）。
    它们文件名带 YYYYMMDD 前缀，所以按月归集——按月而非按日，是因为按日中位
    只有 6 张，会碎成几百个低信息量的小卡片。

    分组名含「漫画/同人/画集/CG集/插画」的标记 manga（内容类型不同，
    前端单独成模块）；其余标 loose（写真散图，与普通套图同列浏览）。
    """
    out = []
    for d0 in sorted(os.listdir(ROOT)):
        p0 = os.path.join(ROOT, d0)
        if not os.path.isdir(p0):
            continue
        try:
            entries = [f for f in os.listdir(p0) if os.path.isfile(os.path.join(p0, f))]
        except OSError:
            continue
        files = [f for f in entries if f.lower().endswith(IMG_EXT)]
        vids_all = [f for f in entries if f.lower().endswith(VID_EXT)]
        if not files and not vids_all:
            continue

        short = group_short(d0)
        is_manga = bool(RE_MANGA_GROUP.search(d0))

        by_month = collections.defaultdict(list)
        vids_by_month = collections.defaultdict(list)
        for f in files:
            m = RE_LOOSE_DATE.match(f)
            by_month[m.group(1)[:6] if m else '000000'].append(f)
        for f in vids_all:
            m = RE_LOOSE_DATE.match(f)
            vids_by_month[m.group(1)[:6] if m else '000000'].append(f)

        # 图片与视频各自按月归集；只有视频的月份也要出现在图库里
        for month in sorted(set(by_month) | set(vids_by_month)):
            fs = sorted(by_month.get(month, []))
            vs = sorted(vids_by_month.get(month, []))
            if month == '000000':
                label, dates = '日期未知', []
            else:
                label = '%s年%s月' % (month[:4], month[4:6])
                dates = ['%s-%s-%s' % (f[:4], f[4:6], f[6:8])
                         for f in fs if RE_LOOSE_DATE.match(f)]
            d = collections.Counter(dates).most_common(1)
            out.append({
                'raw': '%s · %s' % (short, label),
                'coser': short, 'co': [], 'series': '',
                'tags': [], 'works': [], 'roles': [], 'themes': [], 'others': [],
                'kinds': {'works': [], 'roles': [], 'themes': []},
                'pages': '', 'size': '', 'times': [], 'emoji': [],
                'promo': False,
                'group': d0, 'n': len(fs), 'count': len(fs),
                'path': p0, 'files': fs,
                'videos': vs, 'vn': len(vs),
                'dates': sorted(set(dates)),
                'date': d[0][0] if d else '',
                'loose': True, 'manga': is_manga,
                'month': month,
                'vkey': '%s#%s' % (p0, month),
            })
    return out


# ---------------------------------------------------------------- 修复层

def repair(sets):
    """归一化去重 / coser 子串 / 拍摄日期 / 跨桶去重。"""
    # 归一化 alias 表（遍历全部五个桶）
    variants = collections.defaultdict(collections.Counter)
    for s in sets:
        for f in ('works', 'roles', 'themes', 'others', 'co'):
            for t in s.get(f, []):
                k = norm_key(t)
                if k:
                    variants[k][t] += 1
    alias = {k: sorted(c.items(), key=lambda x: (-x[1], len(x[0])))[0][0]
             for k, c in variants.items()}

    # coser 子串
    for s in sets:
        if s.get('loose'):
            continue
        ck = norm_key(s.get('coser', ''))
        if not ck or len(ck) < 2:
            continue
        for field in ('others', 'co'):
            keep = []
            for t in s.get(field, []):
                tk = norm_key(t)
                if tk and tk != ck and len(tk) >= 2 and tk.startswith(ck):
                    continue
                keep.append(t)
            s[field] = keep

    # 桶内 + 跨桶去重
    prio = ('works', 'roles', 'themes', 'co', 'others')
    for s in sets:
        for field in prio:
            canon, seen = [], set()
            for t in s.get(field, []):
                c = alias.get(norm_key(t), t)
                k = norm_key(c)
                if k in seen:
                    continue
                seen.add(k)
                canon.append(c)
            s[field] = canon
        claimed = {}
        for field in prio:
            keep = []
            for t in s[field]:
                k = norm_key(t)
                if k in claimed:
                    continue
                claimed[k] = field
                keep.append(t)
            s[field] = keep
        s['tags'] = s['works'] + s['roles'] + s['themes'] + s['co'] + s['others']

    # 拍摄日期（文件名内嵌 YYYYMMDD）
    for s in sets:
        dates = []
        for f in s['files']:
            m = RE_DATE8.match(f)
            if m:
                y, mo, d = m.groups()
                if 2020 <= int(y) <= 2030 and 1 <= int(mo) <= 12 and 1 <= int(d) <= 31:
                    dates.append('%s-%s-%s' % (y, mo, d))
        legacy = [t for t in s.get('times', []) if re.match(r'^\d{4}-\d{2}$', str(t))]
        allv = dates + legacy
        s['dates'] = sorted(set(allv))
        s['date'] = collections.Counter(allv).most_common(1)[0][0] if allv else ''
    return alias


# ---------------------------------------------------------------- 缩略图

def slug(i):
    return '%02x%02x%02x' % ((i * 2654435761 >> 16) & 255,
                             (i * 40503 >> 7) & 255, (i * 97) & 255)


def load_id_map():
    """从已有索引导出 path → 稳定 id。

    id 必须是**稳定标识**而不是排序序号：一旦新增套图导致排序变化，
    序号式 id 会整体平移，所有缩略图/分片文件名随之失配（显示成别人的图）。
    这里沿用旧索引里已分配的 id，新套图追加 max+1，绝不重排。
    """
    p = os.path.join(BASE, 'index.final.json')
    if not os.path.exists(p):
        return {}
    try:
        with open(p, encoding='utf-8') as f:
            old = json.load(f)
        out = {}
        for s in old.get('sets', []):
            if 'id' not in s:
                continue
            # 虚拟套图（散图按月聚合）用 vkey 区分同目录下不同月份
            k = s.get('vkey') or s.get('path')
            if k:
                out[k] = s['id']
        return out
    except Exception as e:
        print('  ! 读取旧索引失败，将重新分配 id（缩略图会重生成）: %s' % e)
        return {}


def build_thumbs(sets, force=False, quiet=False):
    """生成封面/LQIP/文件分片/尺寸分片。

    **幂等**：已存在且内容未变的目标文件直接跳过，因此第二次运行只处理
    新增或变更的套图（新增 10 个套图约 2 秒，而不是重跑全量 3.5 分钟）。
    """
    tdir = os.path.join(ASSETS, 'thumbs')
    ldir = os.path.join(ASSETS, 'lqip')
    fdir = os.path.join(ASSETS, 'files')
    ddir = os.path.join(ASSETS, 'dims')
    for d in (tdir, ldir, fdir, ddir):
        os.makedirs(d, exist_ok=True)

    made = collections.Counter()

    def job(s):
        sid = s['id']
        name = 't%s.jpg' % slug(sid)
        tpath = os.path.join(tdir, name)
        # 2x：手机 DPR 3 下 240px 素材只有 1.44 有效 DPR（封面显示 167px 需 501px），
        # 480px 能把有效 DPR 提到 2.87。桌面 DPR 1 仍只加载 1x，不增加流量。
        tpath2 = os.path.join(tdir, name.replace('.jpg', '@2x.jpg'))
        lpath = os.path.join(ldir, name)
        fpath = os.path.join(fdir, '%d.json' % sid)
        dpath = os.path.join(ddir, '%d.json' % sid)

        # 分片是否需要重建：比对已存分片里记录的文件数与当前实测张数
        n = len(s['files'])
        need_slice = force or not os.path.exists(fpath)
        if not need_slice:
            try:
                with open(fpath, encoding='utf-8') as f:
                    need_slice = len(json.load(f).get('files', [])) != n
            except Exception:
                need_slice = True

        need_img = force or not (os.path.exists(tpath) and os.path.exists(lpath)
                                 and os.path.exists(tpath2))
        if not (need_img or need_slice):
            made['skip'] += 1
            return ('keep', str(sid))

        try:
            col, lum = None, None
            if need_img:
                src = os.path.join(s['path'], s['files'][0])
                im = Image.open(src).convert('RGB')
                w, h = im.size
                if w / h > 0.78:
                    nw = int(h * 0.78)
                    x = (w - nw) // 2
                    im = im.crop((x, 0, x + nw, h))
                else:
                    nh = int(w / 0.78)
                    y = max(0, (h - nh) // 2)
                    im = im.crop((0, y, w, min(h, y + nh)))
                thumb = im.resize((240, 308), Image.LANCZOS)
                thumb.save(tpath, 'JPEG', quality=72, optimize=True)
                # 2x 直接从已裁好的 im 再放大一档，避免重复裁切
                im.resize((480, 616), Image.LANCZOS).save(
                    tpath2, 'JPEG', quality=70, optimize=True)
                thumb.resize((24, 32), Image.LANCZOS).save(lpath, 'JPEG', quality=55)

                # thumbmeta：主色 + 亮度
                a = np.asarray(thumb.resize((16, 20))).reshape(-1, 3).astype(float)
                mx, mn = a.max(1), a.min(1)
                v = mx / 255.0
                sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
                wgt = sat * v
                thr = np.percentile(wgt, 90)
                sel = a[wgt >= thr] if (wgt >= thr).sum() > 5 else a
                col = '#%02X%02X%02X' % tuple(int(x) for x in sel.mean(0))
                lum = float((0.299 * a[:, 0] + 0.587 * a[:, 1] + 0.114 * a[:, 2]).mean() / 255)
                made['img'] += 1

            if need_slice:
                # files 分片
                with open(fpath, 'w', encoding='utf-8') as f:
                    json.dump({'files': s['files'], 'date': s['date']}, f,
                              ensure_ascii=False, separators=(',', ':'))

                # dims 分片：原图宽高（详情页瀑布流按原生比例不裁切，需要真实尺寸）
                dims = []
                for fn in s['files']:
                    try:
                        with Image.open(os.path.join(s['path'], fn)) as im2:
                            dims.append(im2.size)
                    except Exception:
                        dims.append([0, 0])
                with open(dpath, 'w', encoding='utf-8') as f:
                    json.dump({'dims': dims}, f, ensure_ascii=False, separators=(',', ':'))
                made['slice'] += 1

            if col is not None:
                return ('new', str(sid), {'c': col, 'l': round(lum, 4), 't': name})
            return ('keep', str(sid))
        except Exception:
            return None

    # 已有 thumbmeta：跳过图片生成的条目要沿用旧记录，否则会丢主色/亮度
    meta_path = os.path.join(ASSETS, 'thumbmeta.json')
    old_meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, encoding='utf-8') as f:
                old_meta = json.load(f)
        except Exception:
            old_meta = {}

    with cf.ThreadPoolExecutor(max_workers=12) as ex:
        res = [r for r in ex.map(job, sets) if r]
    meta = {}
    for r in res:
        if r[0] == 'new':
            meta[r[1]] = r[2]
        elif r[1] in old_meta:
            meta[r[1]] = old_meta[r[1]]
    for s in sets:
        sid = str(s['id'])
        if sid in meta and 't' not in meta[sid]:
            meta[sid]['t'] = 't%s.jpg' % slug(s['id'])
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, separators=(',', ':'))
    shot = {str(s['id']): (s['date'] or '').replace('-', '') for s in sets if s['date']}
    with open(os.path.join(ASSETS, 'shotdates.json'), 'w', encoding='utf-8') as f:
        json.dump(shot, f, ensure_ascii=False, separators=(',', ':'))
    return made, meta


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true',
                    help='强制重建全部缩略图与分片（改动生成参数时才需要）')
    ap.add_argument('--quiet', action='store_true', help='只输出关键结果')
    ap.add_argument('--novels', action='store_true',
                    help='只重建小说库 + 版本号（抓完新书用，秒级完成）')
    args = ap.parse_args()
    say = (lambda *a: None) if args.quiet else print

    # 只补小说：跳过 14 万张图的扫描和缩略图生成，几秒跑完。
    # serve.py 的看门狗一旦发现小说目录有变化就调这个。
    if args.novels:
        t0 = time.time()
        say('只重建小说库...')
        n = write_novels(say)
        if n < 0:
            return 1
        write_version(say)
        say('  完成，耗时 %.1fs' % (time.time() - t0))
        return 0

    t0 = time.time()
    say('扫描目录...')
    sets, tag_freq, works, roles, lex = scan()
    say('  套图 %d，图片 %d，标签 %d，coser %d'
        % (len(sets), sum(s['count'] for s in sets), len(tag_freq),
           len({re.split(r'\s+-\s*', s['coser'])[0].strip(' #-') for s in sets})))

    # ---- 散图（平铺在分组目录下的图片）按月聚合成虚拟套图 ----
    loose = scan_loose()
    if loose:
        nm = sum(1 for s in loose if s['manga'])
        ni = len(loose) - nm
        say('  散图集：%d 个（写真 %d / 漫画 %d），共 %d 张'
            % (len(loose), ni, nm, sum(s['n'] for s in loose)))
        sets = sets + loose

    # ---- id 稳定化：沿用旧索引的 path→id，新套图追加，绝不重排 ----
    old_ids = load_id_map()
    next_id = max(old_ids.values(), default=-1) + 1
    reused = fresh = 0
    for s in sets:
        k = s.get('vkey') or s['path']
        if k in old_ids:
            s['id'] = old_ids[k]
            reused += 1
        else:
            s['id'] = next_id
            next_id += 1
            fresh += 1
    say('  id 分配：沿用 %d，新增 %d' % (reused, fresh))

    # 缩略图文件名碰撞检测（slug 只有 3 字节，id 增长后需复核）
    seen = {}
    for s in sets:
        k = slug(s['id'])
        if k in seen:
            print('  ! slug 碰撞：id %d 与 %d 都映射到 t%s.jpg'
                  % (s['id'], seen[k], k))
            print('    请把 build.py 的 slug() 扩到 4 字节后重跑 --force')
            sys.exit(1)
        seen[k] = s['id']

    cleaned = clean_ad_names(sets)
    if cleaned:
        say('  清洗广告式目录名：%d 个（只改名，文件不动）' % cleaned)

    junk = mark_junk(sets)
    if junk:
        say('  隐藏引流目录：%d 个（TG 账号广告页）' % junk)

    trimmed = strip_chat_tail(sets)
    if trimmed:
        say('  截断闲聊尾巴：%d 套（目录名逗号后是发布者评价）' % trimmed)

    rescued = rescue_inline_tags(sets, lex)
    if rescued:
        say('  内联标签救援：%d 套（coser 名里内嵌了标签）' % rescued)

    say('修复层...')
    alias = repair(sets)
    say('  归一化组 %d' % len(alias))

    say('缩略图 + LQIP + 文件分片...')
    made, meta = build_thumbs(sets, force=args.force, quiet=args.quiet)
    say('  新增封面 %d，重建分片 %d，跳过 %d  (%.1fs)'
        % (made['img'], made['slice'], made['skip'], time.time() - t0))

    for s in sets:
        s['thumb'] = 'thumbs/t%s.jpg' % slug(s['id'])
        s['thumb2x'] = 'thumbs/t%s@2x.jpg' % slug(s['id'])

    tf = collections.Counter()
    cf_ = collections.Counter()
    for s in sets:
        tf.update(s['tags'])
        if s['coser']:
            cf_[s['coser']] += 1

    out = {
        'meta': {
            'sets': len(sets),
            'totalImages': sum(s['count'] for s in sets),
            'uniqueTags': len(tf),
            'uniqueCosers': len(cf_),
            'setsWithDate': sum(1 for s in sets if s['date']),
            'setsZeroTags': sum(1 for s in sets if not s['tags']),
            'setsWithWorks': sum(1 for s in sets if s['kinds']['works']),
            'setsWithRoles': sum(1 for s in sets if s['kinds']['roles']),
            'setsWithThemes': sum(1 for s in sets if s['kinds']['themes']),
            'setsPromo': sum(1 for s in sets if s.get('promo')),
            'aliasGroups': len(alias),
        },
        'sets': sets,
        'tagStats': tf.most_common(600),
        'coserStats': cf_.most_common(600),
        'works': sorted(works),
        'alias': alias,
    }
    dst = os.path.join(BASE, 'index.final.json')
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    say('写出 %s  %.1f MB  (总耗时 %.1fs)'
        % (dst, os.path.getsize(dst) / 1048576, time.time() - t0))



    # ---- 小说库（独立数据文件，和图片索引分开）----
    # 顺序很重要：必须在版本号之前写，否则小说库进不了内容指纹，
    # 前端会继续吃缓存里的旧 novels.json（手机上看不到新抓的书）。
    write_novels(say)

    # ---- 版本号 ----
    write_version(say)

    # 预压缩一份 .gz 供服务端直接返回：索引 8+ MB，手机 4G 首次加载要等好几秒，
    # gzip 后通常只剩 1/6。服务端只在客户端声明支持 gzip 时才用，不影响本地。
    try:
        import gzip
        gz = dst + '.gz'
        with open(dst, 'rb') as fi, gzip.open(gz, 'wb', compresslevel=6) as fo:
            while True:
                chunk = fi.read(1 << 20)
                if not chunk:
                    break
                fo.write(chunk)
        say('  预压缩 %s  %.1f MB → %.1f MB'
            % (os.path.basename(gz),
               os.path.getsize(dst) / 1048576, os.path.getsize(gz) / 1048576))
    except Exception as e:
        say('  ! 预压缩失败（不影响功能）: %s' % e)


if __name__ == '__main__':
    sys.exit(main() or 0)
