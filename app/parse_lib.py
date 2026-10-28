"""写真图库 · 目录名解析与全库索引构建

目录名是本库唯一的元数据来源，形如：
    #纸悦Etsu_ko - #鸣潮 #爱弥斯
    #星之迟迟 - 25年12月计划A #明日方舟 #霍尔海雅
    #九柒喵 - #碧蓝航线 #柴郡 #兔女郎
    #星黛鹿鹿 - #私房 #黑丝 #女仆[39P-390MB]
    #真宝 - #圣诞🎄
    #CosV5 #日式 cos - #泳装[120P-1.02GB]
    #📌 近期精选（点击预览 👀）
    #YoKei 约柯 - #鸣潮 #爱弥斯
"""
import os, re, json, collections

ROOT = r'E:\download\Telegram'
IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp')

# 噪声：方括号规格 [68P-749MB] / [39P-390MB] / [120P-1.02GB]
RE_SPEC = re.compile(r'\[[^\]]*\]')
# 噪声：日期前缀 26年04月 / 25年12月计划A / 26年07月订阅
RE_DATE = re.compile(r'^\s*\d{2}\s*年\s*\d{1,2}\s*月')
# 噪声：纯数量标记如 "26年04月"，以及尾部的孤立 " - "
RE_TRAIL_DASH = re.compile(r'\s*[-–—]\s*$')
# 运营/广告类伪标签（不是内容标签）
PSEUDO_TAGS = {
    '近期精选', '近期相关精选', '近期部分相关流出', '近期相关流出', '部分相关资源',
    '精选', '套图', '写真', '合集', '资源', '持续更新', '欢迎使用阿福',
    '月票特典', '月票专属特典', '限时', '置顶', '推荐', '合集推荐', '原创',
}
# coser 名里常见的括号/连接符噪声
RE_CLEAN_NAME = re.compile(r'[（(]\s*[#]?\s*$')


def parse_dirname(raw: str):
    """解析单个目录名，返回 dict。

    返回键: coser, tags, series, specs, date, noise
    """
    name = raw.strip()
    noise = []

    # 1. 剥离规格方括号
    specs = RE_SPEC.findall(name)
    name = RE_SPEC.sub(' ', name)

    # 2. 剥离日期前缀
    date = None
    m = RE_DATE.match(name)
    if m:
        date = m.group(0).strip()
        name = name[m.end():]

    # 3. 头部 = 第一个分隔符之前
    sep = re.search(r'\s*[-–—]\s*', name)
    if sep:
        head = name[:sep.start()]
        tail = name[sep.end():]
    else:
        head, tail = name, ''

    # 4. 头部抽 coser 名：去掉所有 # 号与首尾符号
    coser = head.replace('#', ' ').strip()
    coser = re.sub(r'\s{2,}', ' ', coser)
    coser = RE_CLEAN_NAME.sub('', coser).strip()
    # 名字里若含 & 之类，保留原样（双 coser 合集）
    if not coser:
        coser = ''

    # 5. 尾部抽标签 + 系列名
    #    先按 # 切：#tag 连续部分为标签，非 # 开头的一段是"系列/计划名"
    series = ''
    tags = []
    # 拆成 # 前后片段
    parts = re.split(r'(#)', tail)
    cur = ''
    for i, seg in enumerate(parts):
        if seg == '#':
            if cur.strip():
                # cur 是上一个非#片段，可能是系列名
                series = cur.strip()
                cur = ''
            cur = '#'
            continue
        if cur == '#':
            cur += seg
        else:
            # 连续的纯文本片段并入 series
            if cur.strip():
                series = (series + ' ' + cur.strip()).strip()
            cur = seg
    if cur == '#':
        cur = ''
    if cur.strip():
        series = (series + ' ' + cur.strip()).strip()

    # 6. 重新解析标签：head 里也可能带标签（#CosV5 #日式 cos - #泳装）
    #    用统一正则在全名上抓，抓到的都进 tags，head 段归 coser
    all_tags = []
    for part in re.split(r'\s*[-–—]\s*', name):
        for t in re.findall(r'#([^\s#\[\]]+)', part):
            t = t.strip('()（） ')
            if t:
                all_tags.append(t)
    # head 段的 #tag 属于 coser 的一部分（#CosV5 是频道名），不作为内容标签
    head_tags = set()
    for t in re.findall(r'#([^\s#\[\]]+)', head):
        head_tags.add(t.strip('()（） '))
    content_tags = [t for t in all_tags if t not in head_tags]

    # 7. 清洗标签：去噪、去空
    clean_tags, seen = [], set()
    for t in content_tags:
        t = t.strip()
        if not t:
            continue
        if t in PSEUDO_TAGS:
            noise.append(t)
            continue
        if re.fullmatch(r'[\d\.]+[PpGgMmKk]?', t):      # 68P 12MB 之类
            noise.append(t)
            continue
        if t in seen:
            continue
        seen.add(t)
        clean_tags.append(t)

    # 8. series 清洗：去掉残留 # 号与多余空白
    series = re.sub(r'#', ' ', series)
    series = re.sub(r'\s{2,}', ' ', series).strip(' -–—')
    if series and series.lower() in PSEUDO_TAGS:
        noise.append(series)
        series = ''

    return {
        'coser': coser,
        'tags': clean_tags,
        'series': series,
        'specs': specs,
        'date': date or '',
        'noise': noise,
        'raw': raw,
    }


# 角色名特征：作品库之外的「角色」多为 2–4 个汉字且在库中常与具体作品绑定出现
RE_CJK_SHORT = re.compile(r'^[一-鿿]{2,4}$')
RE_LATIN = re.compile(r'^[A-Za-z][A-Za-z0-9\.\-\s]{1,14}$')


    # 主题词：高频但语义泛化（泳装/女仆/JK/精选…）→ 不算作品也不算角色
GENERIC = {'泳装', '女仆', 'JK', '兔女郎', '黑丝', '白丝', '透视', '写真', '私房',
           '体操', '旗袍', '汉服', '圣诞', '新年', '夏日', '温泉', '瑜伽',
           '夜景', '海边', '咖啡', '花', '猫娘', '护士', '教师', '学生',
           '运动', '健身', '泳', '内衣', '睡衣', '和服', '婚纱', 'Lolita',
           '连体衣', '网袜', '丝袜', '比基尼', '丁字裤', '兔娘', '兽耳',
           '水下', '无水印', '原版', '正片', '返图', '资源', '合集', '持续更新',
           '定制', '约拍', '返图', '日常', '写真集', '生誕写真集', '生日写真',
           '水着', '小恶魔', '自拍', '制服', '学妹', '花嫁', '古装', '原图',
           '冥', '信仰', '巫女', '魔女', '骑士', '公主', '偶像', '教师装',
           '水手服', '运动服', '家居服', '浴衣', '汉服', '旗袍装', '礼服',
           '少女', '少年', '女子', '男子', '人偶', '机械', '机器人', '人型',
           '白丝黑丝', '肉丝', '吊带', '抹胸', '开衫', '背心', '短裤',
           '可爱', '漂亮', '美女', '美腿', '翘臀', '大长腿', '好身材',
           '高清', '无修', '修图', '直出', '摄影', '约片', '返图', '素人'}


def classify_tags(tags, series, work_vocab, role_vocab):
    """基于全库统计做三分类：作品 / 角色 / 主题。

    判定不靠硬编码白名单，而是数据驱动：
      - work_vocab : 全库频次高、且跨多个 coser 复用的标签 → 作品名
      - role_vocab : 与某个作品强绑定（在同一套图内与作品标签共现）的标签 → 角色名
      - 其余 → 主题词
    """
    works, roles, themes = [], [], []
    for t in tags:
        if t in work_vocab:
            works.append(t)
        elif t in role_vocab:
            roles.append(t)
        else:
            themes.append(t)
    return {'works': works, 'roles': roles, 'themes': themes}


def build():
    # ---- 第一遍：解析所有目录名 ----
    raw_sets = []
    for d0 in sorted(os.listdir(ROOT)):
        p0 = os.path.join(ROOT, d0)
        if not os.path.isdir(p0):
            continue
        for d1 in sorted(os.listdir(p0)):
            p1 = os.path.join(p0, d1)
            if not os.path.isdir(p1):
                continue
            try:
                files = [f for f in os.listdir(p1)
                         if f.lower().endswith(IMG_EXT)]
            except OSError:
                continue
            if not files:
                continue
            files.sort()
            meta = parse_dirname(d1)
            meta['group'] = d0
            meta['count'] = len(files)
            meta['path'] = p1
            meta['files'] = files
            raw_sets.append(meta)

    # ---- 第二遍：数据驱动地学习作品词表与角色词表 ----
    # 作品特征：出现频次高，且横跨多个不同 coser（一个作品会有很多 coser 拍）
    tag_coser = collections.defaultdict(set)
    tag_freq = collections.Counter()
    for s in raw_sets:
        cn = re.split(r'\s+-\s+', s['coser'])[0].strip(' #-')
        for t in s['tags']:
            tag_freq[t] += 1
            tag_coser[t].add(cn or '?')

    work_vocab = set()
    for t, n in tag_freq.items():
        if n >= 8 and len(tag_coser[t]) >= 5 and t not in GENERIC:
            work_vocab.add(t)
    # 人工兜底：少量但确定的知名作品（频次可能低于阈值）
    work_vocab |= {
        '碧蓝航线', '原神', '鸣潮', '明日方舟', '绝区零', '蔚蓝档案', 'NIKKE', 'Nikke',
        'FGO', '崩坏3', '星穹铁道', '胜利女神', '少女前线', '尘白禁区', '白荆回廊',
        '二重存在', '机动战姬', '重装武器', '交错战线', '东方', 'CookieRun', 'PJS',
    }
    work_vocab -= GENERIC

    # 角色特征：在同一套图内与某个作品标签共现，且自身频次中等（不是通用主题词）
    role_vocab = set()
    for s in raw_sets:
        tags = s['tags']
        ws = [t for t in tags if t in work_vocab]
        if not ws:
            continue
        for t in tags:
            if t in work_vocab:
                continue
            # 与作品共现 + 频次 2~60 + 长度像角色名
            if 2 <= tag_freq[t] <= 60 and (RE_CJK_SHORT.match(t) or RE_LATIN.match(t)):
                role_vocab.add(t)

    # 角色词表二次清洗：
    #  ① 排除泛化主题词
    #  ② 排除「与作品名共用」的词（如 柴郡 既是角色也可能是误判的作品名）
    #  ③ 排除出现次数远高于其共现次数的词——说明它其实是通用词不是角色
    cooccur = collections.Counter()
    for s in raw_sets:
        ws = set(t for t in s['tags'] if t in work_vocab)
        for t in s['tags']:
            if t in work_vocab:
                continue
            if ws:
                cooccur[t] += 1
    for t in list(role_vocab):
        if t in GENERIC:
            role_vocab.discard(t)
            continue
        # 该词出现于套图数远多于与作品共现数 → 泛化用法
        if tag_freq[t] >= 12 and cooccur[t] * 3 < tag_freq[t]:
            role_vocab.discard(t)
            continue
        # 与某个作品名完全同形（如 柴郡 / 大凤 / 修女 既在作品表也在角色表）
        # 若它在作品表中出现次数 >= 角色表，则以作品身份为准
        if t in work_vocab and len(work_vocab) > 0:
            inwork = sum(1 for s in raw_sets if t in s['tags'] and
                         any(x in work_vocab for x in s['tags']))
            if inwork >= 2:
                role_vocab.discard(t)

    # 主题词：高频但语义泛化（泳装/女仆/JK/精选…）→ 排除出角色
    role_vocab -= GENERIC

    sets = []
    for s in raw_sets:
        s['kinds'] = classify_tags(s['tags'], s['series'], work_vocab, role_vocab)
        sets.append(s)

    sets.sort(key=lambda s: (-s['count'], s['raw']))
    for i, s in enumerate(sets):
        s['id'] = i
    return sets, tag_freq, work_vocab, role_vocab


if __name__ == '__main__':
    sets, tag_freq, work_vocab, role_vocab = build()
    print('sets:', len(sets))
    print('total images:', sum(s['count'] for s in sets))

    no_coser = sum(1 for s in sets if not s['coser'])
    no_tags = sum(1 for s in sets if not s['tags'])
    print('no coser: %d (%.1f%%)' % (no_coser, 100 * no_coser / len(sets)))
    print('no tags : %d (%.1f%%)' % (no_tags, 100 * no_tags / len(sets)))
    print('work vocab: %d   role vocab: %d' % (len(work_vocab), len(role_vocab)))

    cosers = collections.Counter()
    for s in sets:
        c = re.split(r'\s+-\s+', s['coser'])[0].strip(' #-')
        if c:
            cosers[c] += 1
    print('unique cosers:', len(cosers))
    print('top works:', [t for t, _ in tag_freq.most_common(400)
                          if t in work_vocab][:12])

    out = os.path.join(os.path.dirname(__file__), 'library-index.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({
            'sets': [{**{k: v for k, v in s.items() if k != 'files'},
                      'files': s['files'][:60]} for s in sets],
            'tagStats': tag_freq.most_common(500),
            'coserStats': cosers.most_common(500),
            'works': sorted(work_vocab),
        }, f, ensure_ascii=False, separators=(',', ':'))
    print('wrote', out, os.path.getsize(out) // 1024, 'KB')

    print('\n--- 解析抽样 ---')
    for s in sets[:2] + sets[600:602] + sets[2000:2002] + sets[4000:4002]:
        k = s['kinds']
        print('raw=%-40s\n   coser=%-16s series=%-14s\n   works=%s roles=%s themes=%s n=%d' % (
            s['raw'][:40], s['coser'][:16], s['series'][:14],
            ','.join(k['works']) or '-', ','.join(k['roles']) or '-',
            ','.join(k['themes'][:3]) or '-', s['count']))
