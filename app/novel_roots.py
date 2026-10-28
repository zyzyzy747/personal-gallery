"""小说来源目录的统一声明。

build.py（生成索引）和 serve.py（提供正文）都必须知道「小说放在哪些目录」，
写一份在这里，免得两边各写一套、改一处忘另一处。

索引里的 p 字段格式：**<根序号>/<相对该根的路径>**
服务端用根序号还原出绝对路径，这样不同根下的书不会撞名。

2026-10-29 整理：三个根合并成一个根
------------------------------------
原来小说散在三处、两套结构，索引里 p 的根序号 0/1/2 混用：

    0  E:\\Download\\novel_download\\              子目录 = 分类（cool18 / xbookcn / 催眠…）
    1  E:\\download\\Telegram\\成人长篇小说…\\      整个目录 = 一个分类，6 万个 txt 平铺
    2  E:\\download\\Telegram\\开心书库…\\          整个目录 = 一个分类

整理后统一放进 `E:\\Download\\02-小说\\`，每个子目录就是一个分类，
所以现在只有根 0，分类名直接看子目录名。旧索引里的 1/、2/ 前缀
在首次重建后自然消失（novels.json 每次全量重建，没有稳定 id 的问题）。

目录形态由 build.py 的 _scan_category_dir 处理：
    02-小说\\<分类>\\<书名>.txt            平铺
    02-小说\\<分类>\\<书名>\\<书名>.txt     书目录
    02-小说\\<分类>\\<书名>\\chapters\\*.txt 分章
"""

import paths

# 唯一的根：根下每个子目录是一个分类（cool18 / xbookcn / 成人长篇 / 开心书库 …）
CRAWL_ROOT = paths.NOVEL_ROOT

# 其余根：目录自己就是一个分类。合并后没有这种根了，保留接口以便以后
# 再把别处的书挂进来（格式仍是 (路径, 分类名)）。
EXTRA_ROOTS = []


def roots():
    """[(绝对路径, 分类名)]；分类名为 None 表示「按子目录当分类」。"""
    out = [(CRAWL_ROOT, None)]
    for path, cat in EXTRA_ROOTS:
        out.append((path, cat))
    return out


def root_by_index(i):
    """按 p 字段里的根序号取 (路径, 分类名)；越界返回 None。"""
    rs = roots()
    return rs[i] if 0 <= i < len(rs) else None
