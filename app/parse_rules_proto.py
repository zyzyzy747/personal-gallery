# -*- coding: utf-8 -*-
"""目录名 → 元数据 解析规则原型 v3（两级：先建词表，再逐目录解析）

Pass 1（一次性）：扫描全部套图目录名 → 产出
    COSER_TABLE  : coser 名字表（来自每个目录的 head 首块）
    TAG_FREQ     : 标签频次
    TAG_PARTNERS : 标签共现伙伴数（用于作品/角色判定）
Pass 2（逐目录）：S0..S8 解析管线，分类依赖 Pass 1 词表
"""
import os, re, json, collections, unicodedata, sys

# ================= 人工种子库（只给锚点，其余靠 Pass1 统计补齐） =================
SEED_WORKS = {
    '碧蓝航线', '原神', '鸣潮', '明日方舟', '绝区零', '蔚蓝档案', 'NIKKE', 'Nikke', 'FGO',
    '崩坏', '星穹铁道', '胜利女神', '少女前线', '重返未来1999', '刀剑神域', '无职转生',
    '白荆回廊', '尘白禁区', '机动战姬', '交错战线', '战双', '尼尔', '东方', 'genshin',
    'genshin impact', '碧蓝', '少女前线2', 'nikke', 'azur lane', 'blue archive',
    'honkai', 'wuthering waves', 'punishing gray ravens', 'girls frontline',
}
SEED_ROLES = {
    '爱弥斯', '霍尔海雅', '柴郡', '拉菲兔', '爱宕', '甘雨', '芙宁娜', '风堇', '守岸人',
    '长离', '流萤', '南宫羽', '华甲', '金狮', '大黑塔', '樱小路', '露娜', '艾玛',
    '信浓', 'Shinano', '可畏', '圣路易斯', '约克城', '安克雷奇', '早濑优香',
    '明日奈', '莫奈', '黎厄', '莱伊', '布洛妮娅', '简杜', '雷姆', '拉姆', '希娜',
    '雪衣', '美游', '伊莉雅', '妮可', '枣子姐', '拉菲', '菲比', '爱丽榭',
}
SEED_THEMES = {
    '女仆', '兔女郎', '黑丝', '白丝', '泳装', '水着', 'JK', '旗袍', '古装', '花嫁',
    '修女', '私房', '黑网蕾丝', '白网蕾丝', '白纱', '内衣', '圣诞', '新年', '春节',
    '万圣节', '护士', '洛丽塔', '汉服', '运动服', '职业装', '婚纱', '白婚纱', '礼服',
    '和服', '巫女', '忍者', '兔娘', '制服', '绝对领域', '体操服', '啦啦队', '女仆装',
    '日常', '常服', '哥特', '辣妹', '纯欲', '御姐', '萝莉', '原皮', '写真集',
    '单马尾', '双马尾', '黑长直', '过膝袜', '眼镜', '黑肉丝', '白肉丝', '浴室',
    '卧室', '客厅', '厨房', '海边', '泳池', '温泉', '雪景', '花丛', '夜景', '雨中',
    '兔耳', '猫耳', '犬耳', '黑历史', '胸部', '翘臀', '白毛', '黑毛', '银发', '金发',
    '红发', '蓝发', '紫发', '诱惑', '黑丝过膝', '绝对', '泳装比基尼', '死库水',
    '白衬衫', '黑西装', '职场', '运动内衣', '内衣诱惑', '丁字裤', '薄纱',
}
SEED_PSEUDO = {
    '精选', '近期精选', '近期相关精选', '近期相关流出', '近期部分相关流出',
    '部分相关资源', '部分相关流出', '套图', '写真', '合集', '资源', '持续更新',
    '欢迎使用阿福', '月票特典', '月票', '特典', '订阅', '置顶', '推荐', '限时',
    '原创', '资源包', '合集推荐', '点击预览', '分享', '全部', '图集', '周年',
    '新刊', '生肉', '熟肉', '打包', '更新', '售后', '合集系列', '所有资源',
    '免费', '福利', '限时免费',
}
PROMO_DIR = re.compile(
    r'(点击预览|欢迎使用阿福|近期精选|相关流出|相关精选|部分相关|全网流出|'
    r'最全入|资源！|持续更新|合集系列|所有资源|免费分享|福利)')

EMOJI_RE = re.compile(
    '[\U0001F000-\U0001FAFF\U0001F1E6-\U0001F1FF\U0001F900-\U0001F9FF'
    '\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\uFE0F\u20E3\u2764\u2B50]+')
DASH_CHARS = '‐‑‒–—―−－ー~～'
BRACKETS = {'(': ')', '（': '）', '[': ']', '【': '】',
            '「': '」', '『': '』', '《': '》', '{': '}'}

RE_SPEC_BRACKET = re.compile(r'\[[^\[\]]*\]')
RE_SPEC_PAIR = re.compile(r'(\d+\s*[Pp]\s*\d*\s*[Vv]?)\s*[-–]?\s*(\d+(?:\.\d+)?\s*[MmGg][Bb]?)')
RE_COUNT = re.compile(r'(?<![\w.])\d{1,4}\s*[Pp](?:\s*\d{1,2}\s*[Vv])?(?!\w)')
RE_SIZE = re.compile(r'(?<![\w.])\d+(?:\.\d+)?\s*[MmGg][Bb]?(?!\w)')
RE_TIME = re.compile(
    r'(\d{2,4}\s*年\s*\d{1,2}\s*月(?:\s*计划\s*[A-Za-z0-9])?|'
    r'\d{4}\s*[.\-/]\s*\d{1,2}(?:\s*[.\-/]\s*\d{1,2})?|'
    r'\d{1,2}\.\d{1,2}\s*月号|\d{1,2}\s*月号|'
    r'\d{4}\s*年(?:\s*\S{1,4}年?)?|'
    r'计划\s*[A-Za-z0-9]|Tier|Part\s*\d+|第\s*\d+\s*[期回]|'
    r'(?<![\d\w])\d{1,2}\s*[-–]\s*\d{1,2}(?![\d\w])|'
    r'\d{4}[A-Za-z]{3}(?:\d{2})?)')
MULTI_SEP = re.compile(r'\s*(?:&|＆|\+|,|、|／|/|;|；|\bvs\b)\s*', re.I)

# ================= 规范化与工具 =================

def norm_text(s):
    s = unicodedata.normalize('NFKC', s)
    s = s.replace('&amp;', '&').replace('&gt;', '>').replace('&lt;', '<')
    s = s.replace('&quot;', '"').replace('&nbsp;', ' ')
    s = re.sub(r'[\u200b-\u200f\ufeff]', '', s)
    for d in DASH_CHARS:
        s = s.replace(d, '-')
    return re.sub(r'[ \t]+', ' ', s).strip()


def key(s):
    """标签归一化键：去符号、去空格、小写"""
    s = norm_text(s).lower()
    s = re.sub(r'[\s\-_·・.,、\'"\'!?,，。！?]+', '', s)
    return s


def split_groups(s):
    """返回 (去掉括号内容的串, [(组内容, 组在串中的起始位置)])

    注意：未闭合的括号（如 "#Machi (#馬吉 - ..." 缺少右括号），
    其内容不得泄漏回主串 —— 否则括号内的 " - " 会变成假分隔符。
    """
    groups, stack, out = [], [], []
    pos = 0
    for ch in s:
        if ch in BRACKETS:
            stack.append((ch, len(out), pos))
            out.append('')
        elif ch in BRACKETS.values() and stack:
            op, idx, start = stack.pop()
            if BRACKETS[op] == ch:
                groups.append((out[idx], start))
                out[idx] = ''
                pos += 1
                continue
            out.append(ch)
        else:
            if stack:
                out[stack[-1][1]] += ch
            else:
                out.append(ch)
        pos += 1
    # 未闭合的组：内容仍作为组，但不得回填主串
    for op, idx, start in stack:
        groups.append((out[idx], start))
        out[idx] = ''
    return ''.join(out), groups


def depth_split(s):
    depth = 0
    for i, ch in enumerate(s):
        if ch in BRACKETS:
            depth += 1
        elif ch in BRACKETS.values():
            depth = max(0, depth - 1)
        elif depth == 0 and ch == '-' and 0 < i < len(s) - 1:
            if s[i - 1].isspace() and s[i + 1].isspace():
                return s[:i].strip(), s[i + 2:].strip()
    return s.strip(), ''


def blocks_of(text):
    """按 '#' 切块，返回 [(text, had_hash)]"""
    res = []
    for part in re.split(r'(?=#)', ' ' + text):
        part = part.strip()
        if part:
            res.append((part[1:].strip() if part.startswith('#') else part,
                        part.startswith('#')))
    return res


# ================= Pass 1 =================

class Lexicon:
    def __init__(self):
        self.coser = set()
        self.alias = set()
        self.works = set(key(w) for w in SEED_WORKS)
        self.roles = set(key(w) for w in SEED_ROLES)
        self.themes = set(key(w) for w in SEED_THEMES)
        self.pseudo = set(key(w) for w in SEED_PSEUDO)
        self.freq = collections.Counter()
        self.partners = collections.defaultdict(set)
        self.conc = {}
        self.bracket_co = collections.Counter()
        self.set_count = 0

    def add_coser(self, c):
        if c:
            self.coser.add(key(c))

    def build_stats(self, tag_lists):
        self.set_count = len(tag_lists)
        co = collections.defaultdict(collections.Counter)
        for tags in tag_lists:
            self.freq.update(set(tags))
            for t in set(tags):
                self.partners[t] |= set(tags) - {t}
            for t in set(tags):
                for p in set(tags) - {t}:
                    co[t][p] += 1
        for t, c in co.items():
            tot = sum(c.values())
            self.conc[t] = (c.most_common(1)[0][1] / tot) if tot else 0.0
        # 注意：不要在此重置 bracket_co（它在 Pass1 收集阶段已填充）

    def is_work(self, k):
        return k in self.works

    def is_role(self, k):
        return k in self.roles

    def is_theme(self, k):
        return k in self.themes

    def is_pseudo(self, k):
        return k in self.pseudo

    def is_alias(self, k):
        return k in self.alias


# ================= Pass 2 =================

def parse(raw, lex: Lexicon):
    name = norm_text(raw)
    dropped = []

    # S1 规格
    pages = size = ''
    # 先从方括号内提取规格信息（否则整块剥离后 PAIR 匹配不到）
    for blk in RE_SPEC_BRACKET.findall(name):
        inner = blk[1:-1]
        mp = RE_SPEC_PAIR.search(inner)
        if mp:
            pages = pages or mp.group(1).strip()
            size = size or mp.group(2).strip()
        else:
            mc = RE_COUNT.search(inner)
            if mc:
                pages = pages or mc.group(0).strip()
            ms = RE_SIZE.search(inner)
            if ms:
                size = size or ms.group(0).strip()
    dropped += RE_SPEC_BRACKET.findall(name)
    name = RE_SPEC_BRACKET.sub(' ', name)
    if not pages and not size:
        m = RE_SPEC_PAIR.search(name)
        if m:
            pages, size = m.group(1).strip(), m.group(2).strip()
            name = RE_SPEC_PAIR.sub(' ', name)
        else:
            c = RE_COUNT.search(name)
            if c:
                pages = c.group(0).strip(); name = RE_COUNT.sub(' ', name)
            s = RE_SIZE.search(name)
            if s:
                size = s.group(0).strip(); name = RE_SIZE.sub(' ', name)

    # S2+S3 先做深度切分（depth_split 自身感知括号深度），
    #    再分别对 head / tail 抽括号组 —— 这样能区分
    #    「head 括号内 = coser 别名」与「tail 括号内 = 标签」
    head, tail = depth_split(name)
    head_clean, head_groups = split_groups(head)
    tail_clean, tail_groups = split_groups(tail)

    inline_blocks = []          # (text, is_alias_candidate)
    for g, _pos in tail_groups:
        if '#' not in g and g.strip():
            dropped.append(g.strip())
            continue
        for t in re.findall(r'#([^\s#]+)', g):
            inline_blocks.append((t.strip(), False))
    # head 括号组：整组视为「别名或标签候选」，
    #   组内首个 #token 紧跟 coser → 别名；其余 → 标签
    for g, _pos in head_groups:
        if '#' not in g and g.strip():
            dropped.append(g.strip())
            continue
        toks = re.findall(r'#([^\s#]+)', g)
        for ti, t in enumerate(toks):
            inline_blocks.append((t.strip(), ti == 0))

    # head_clean 里若残留 " - "（原括号深度>0，不算真分隔符），
    # 需还原为单个空格，否则会被误当分隔符
    head_clean = re.sub(r'\s+-\s+', ' ', head_clean)
    tail_clean = re.sub(r'\s+-\s+', ' ', tail_clean)
    name = head_clean + ' ' + tail_clean

    # S4 head → coser 主体 / co-coser / 标签候选
    head_blocks = blocks_of(head_clean)
    coser = ''
    coser_more = []
    head_tag_blocks = []
    alias = []
    # head 括号内的 token 已被 inline_blocks 收集；此处 head_clean 中的
    # 残留 token 才是"head 段的显式 #token"（多 coser 写法）
    bracket_tokens = {t for t, is_al in inline_blocks}
    if head_blocks:
        first_text, first_hash = head_blocks[0]
        if first_hash:
            coser = first_text
            rest = head_blocks[1:]
        else:
            # head 无 '#'：整段裸词，可能是 "云溪溪 - &奶桃&奈汐酱nice"
            segs = [x.strip() for x in MULTI_SEP.split(first_text) if x.strip()]
            coser = segs[0] if segs else ''
            coser_more += segs[1:]
            rest = head_blocks[1:]
        for i, (t, h) in enumerate(rest):
            k = key(t)
            if t in bracket_tokens:
                continue          # 已由括号路径处理
            if k in lex.coser:                      # 已知 coser → co-coser
                coser_more.append(t)
            elif k and k in key(coser):             # 与主 coser 近似 → 别名
                alias.append(t)
            else:
                head_tag_blocks.append((t, h))

    # S5 tail → 块
    tail_blocks = blocks_of(tail_clean)
    # tail 中裸词块若以时间词为主 → 归 time，不进标签
    time_hits = []

    # S6 合并标签池
    pool = []
    for t, h in head_tag_blocks:
        pool.append((t, h, 'head'))
    for t, is_alias in inline_blocks:
        pool.append((t, True, 'alias' if is_alias else 'inline'))
    for t, h in tail_blocks:
        pool.append((t, h, 'tail'))

    items = []      # (tag, emoji)
    alias_items = []   # 明确的别名候选（head 括号内）
    for t, h, src in pool:
        if not t:
            continue
        emoji = EMOJI_RE.findall(t)
        t2 = EMOJI_RE.sub('', t).strip()
        t2 = re.sub(r'^[^\w一-鿿]+|[^\w一-鿿]+$', '', t2).strip()
        if not t2:
            if emoji:
                dropped.append(t)
            continue
        # head 括号内的 token → 别名候选（罗马音/括号内真名）
        if src == 'alias':
            kk = key(t2)
            co_n = lex.bracket_co.get((key(coser), kk), 0)
            # 与主 coser 强共现（≥2 个目录）→ 认定为别名
            if kk and (kk in key(coser) or co_n >= 2):
                alias_items.append(t2)
            else:
                items.append((t2, emoji))
            continue
        # 时间/计划词单独剥离
        if src == 'tail' and not h:
            tm = RE_TIME.fullmatch(t2)
            if tm:
                time_hits.append(t2)
                continue
        # 拆词：命中已知词库词独立成项，否则合并
        words = t2.split()
        buf = ''
        for w in words:
            kw = key(w)
            if (kw in lex.works or kw in lex.roles or kw in lex.themes
                    or kw in lex.pseudo or kw in lex.coser):
                if buf:
                    items.append((buf, emoji)); buf = ''
                items.append((w, emoji))
            else:
                buf = (buf + ' ' + w).strip()
        if buf:
            items.append((buf, emoji))

    # S7 归类：三层证据 + 置信度
    coser = coser.strip(' &+,、/;；-')
    content, all_emoji, alias_hits = [], [], list(alias) + alias_items
    for t, em in items:
        all_emoji += em
        k = key(t)
        if k in lex.pseudo:
            dropped.append(t); continue
        if k == key(coser) or (coser and k in key(coser)):
            dropped.append(t)          # coser 名重复泄漏成标签
            continue
        content.append(t)

    anchor = content[0] if content else ''
    ka = key(anchor)
    anchor_work = lex.is_work(ka)

    works, roles, themes, others = [], [], [], []
    conf = {}
    for i, t in enumerate(content):
        k = key(t)
        sc = {'work': 0.0, 'role': 0.0, 'theme': 0.0}

        # 证据 A：硬词库
        if lex.is_work(k):
            sc['work'] += 0.60
        if lex.is_role(k):
            sc['role'] += 0.60
        if lex.is_theme(k):
            sc['theme'] += 0.60

        # 证据 B：位置模式（仅在同目录存在作品锚点时有效）
        if anchor_work and len(content) >= 2:
            if i == 0:
                sc['work'] += 0.25
            elif i == 1:
                sc['role'] += 0.30
            else:
                sc['theme'] += 0.30
        elif len(content) >= 2 and i == 0:
            sc['work'] += 0.15
            sc['theme'] += 0.15
        elif i >= 2:
            sc['theme'] += 0.20

        # 证据 C：全库统计（仅在 A/B 都未定时起辅助作用）
        f = lex.freq.get(t, 0)
        if f >= 3:
            p = len(lex.partners.get(t, ()))
            conc = lex.conc.get(t, 0.0)
            if p >= 25 and f >= 20:
                sc['work'] += 0.15
            if p <= 12 and f <= 60:
                sc['role'] += 0.15
            if conc >= 0.28:
                sc['role'] += 0.20
            if p >= 40 and conc < 0.15:
                sc['theme'] += 0.20

        best = max(sc, key=sc.get)
        top = sc[best]
        second = sorted(sc.values(), reverse=True)[1]
        c = 0.0
        if top >= 0.60:
            c = 0.99
        elif top >= 0.30:
            c = 0.90 if top - second >= 0.25 else 0.65
        elif top > 0:
            c = 0.55 if top - second >= 0.15 else 0.35
        if top < 0.30:
            others.append(t)
            conf[t] = round(c, 2)
        else:
            if best == 'work':
                works.append(t)
            elif best == 'role':
                roles.append(t)
            else:
                themes.append(t)
            conf[t] = round(c, 2)

    # S8 时间
    times = time_hits + [x.strip() for x in RE_TIME.findall(name) if x.strip()]

    return {
        'raw': raw, 'coser': coser, 'coser_more': coser_more,
        'alias': alias + alias_hits,
        'works': works, 'roles': roles, 'themes': themes, 'others': others,
        'tags': content, 'pages': pages, 'size': size, 'times': sorted(set(times)),
        'emoji': sorted(set(all_emoji)), 'dropped': dropped,
        'promo': bool(PROMO_DIR.search(raw)),
    }


# ================= 驱动 =================

ROOT = r'E:\download\Telegram'


def collect():
    sets = []
    for a in sorted(os.listdir(ROOT)):
        pa = os.path.join(ROOT, a)
        if not os.path.isdir(pa):
            continue
        for b in sorted(os.listdir(pa)):
            pb = os.path.join(pa, b)
            if not os.path.isdir(pb):
                continue
            try:
                files = os.listdir(pb)
            except OSError:
                continue
            if not files:
                continue
            sets.append((b, len(files), pb))
    return sets


def build_lexicon(sets):
    """Pass 1：从全库目录名构建 coser 表 / 别名表 / 标签统计"""
    lex = Lexicon()
    tag_lists = []
    for raw, _, _ in sets:
        name = norm_text(raw)
        name = RE_SPEC_BRACKET.sub(' ', name)
        head, tail = depth_split(name)
        head_clean, head_groups = split_groups(head)
        tail_clean, _ = split_groups(tail)
        hb = blocks_of(head_clean)
        coser = hb[0][0] if hb and hb[0][1] else ''
        lex.add_coser(coser)
        # head 内其余 #token（多 coser 写法，如 "#水淼 & #清水由乃"）也进 coser 表
        for t, h in hb[1:]:
            if h:
                lex.add_coser(t)
        # head 括号组内的 #token = 该 coser 的别名候选（罗马音/括号内真名）
        for g, _pos in head_groups:
            for t in re.findall(r'#([^\s#]+)', g):
                if coser:
                    lex.bracket_co[(key(coser), key(t))] += 1
        ts = [t for t, h in blocks_of(tail_clean)]
        tag_lists.append(ts)
    lex.build_stats(tag_lists)
    return lex


if __name__ == '__main__':
    sets = collect()
    print('sets:', len(sets))
    lex = build_lexicon(sets)
    print('coser table:', len(lex.coser), 'distinct tags:', len(lex.freq))

    # 全量解析
    results = [parse(raw, lex) for raw, _, _ in sets]
    nocoser = sum(1 for r in results if not r['coser'])
    notag = sum(1 for r in results if not r['tags'])
    promo = sum(1 for r in results if r['promo'])
    print('no coser: %d (%.1f%%) | no tag: %d (%.1f%%) | promo dirs: %d'
          % (nocoser, 100*nocoser/len(results), notag, 100*notag/len(results), promo))

    SAMPLES = [
        '#纸悦Etsu_ko - #鸣潮 #爱弥斯',
        '#星之迟迟 - 25年12月计划A #明日方舟 #霍尔海雅',
        '#九柒喵 - #碧蓝航线 #柴郡 #兔女郎',
        '#星黛鹿鹿 - #私房 #黑丝 #女仆[39P-390MB]',
        '#咪米 - #碧蓝航线 #拉菲兔',
        '#yoshioka 桃井 - #Eva #天命[57P-17MB]',
        '#真宝 - #圣诞🎄',
        '#CosV5 #日式 cos - #泳装[120P-1.02GB]',
        '#📌 近期精选（点击预览 👀）',
        '#YoKei 约柯 - #鸣潮 #爱弥斯',
        '#洛璃LoLiSAMA - #碧蓝航线 #爱宕 #兔女郎',
        '#九柒喵 - #无职转生 #洛琪希·米格路迪亚 原皮[36P-416MB]',
        '#Machi (#馬吉 - #大黑塔 #水着💜 #Swimsuit The Herta 💜 [42P-1.93GB]',
        '#水淼 & #清水由乃 - #忍者双人 [40P1V-1.15GB]',
        '#九曲Jean #二佐Nisa',
        '#ChuChu♡MAGIC - 🐭🧀 #雷姆(ラム) #写真集 [58P1V-1.18GB]',
        '#饭堂 - 26-8 #精油 #SPA[41P-1.54GB]',
        '#PoppaChan - Frieren Blue Valley Dress [78P9V-1.34G]',
        '#糖糖T - #绝区零 #妮可[20P-99MB]',
        '#虎森森 - #鸣潮 #守岸人 [80P-290MB]',
    ]
    print()
    for s in SAMPLES:
        r = parse(s, lex)
        print('RAW :', s)
        print('  coser=%r co=%r alias=%r' % (r['coser'], r['coser_more'], r['alias']))
        print('  W=%s R=%s T=%s O=%s' % (r['works'], r['roles'], r['themes'], r['others']))
        print('  spec=%s/%s time=%s emoji=%s promo=%s dropped=%s'
              % (r['pages'], r['size'], r['times'], r['emoji'], r['promo'], r['dropped']))
        print()
