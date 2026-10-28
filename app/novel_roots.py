"""小说来源目录的统一声明。

build.py（生成索引）和 serve.py（提供正文）都必须知道「小说放在哪些目录」，
写一份在这里，免得两边各写一套、改一处忘另一处。

索引里的 p 字段格式：**<根序号>/<相对该根的路径>**
例如 `0/cool18/某本书.txt` 或 `1/20260615_xxx.txt`。
服务端用根序号还原出绝对路径，这样不同根下的书不会撞名。

⚠️ 下面三条路径是占位值，换成自己机器上的实际目录后再跑 build.py。
   也可以用环境变量覆盖，免得改代码：
       GALLERY_CRAWL_ROOT   主书库（子目录 = 分类）
       GALLERY_EXTRA_ROOT   额外的小说包目录（整个目录 = 一个分类）
"""

import os

# 根 0：主书库。根下每个子目录是一个分类（按站点名 / 题材分）。
CRAWL_ROOT = os.environ.get('GALLERY_CRAWL_ROOT') or r'D:\library\novels'

# 其余根：目录自己就是一个分类。用那种平铺一大堆 txt、没有分类层的小说包时，
# 直接拿整个目录当一分类。需要几个写几个，顺序就是索引里的根序号。
EXTRA_ROOTS = []
_extra = os.environ.get('GALLERY_EXTRA_ROOT')
if _extra:
    EXTRA_ROOTS.append((_extra, 'extra'))

# 不想用环境变量就照这个格式直接写死：
# EXTRA_ROOTS = [
#     (r'D:\library\novel-pack-a', '书库 A'),
#     (r'D:\library\novel-pack-b', '书库 B'),
# ]


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
