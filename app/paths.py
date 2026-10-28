# -*- coding: utf-8 -*-
"""库根目录的唯一声明处（build.py / serve.py / novel_roots.py 共用）。

2026-10-29 整理后的布局：

    E:\\Download\\
    ├── 01-图库\\<分组>\\<套图>\\<文件>      ← build.py 扫描的两层契约，分组名不可再拆层
    ├── 02-小说\\<分类>\\...                 ← novel_roots.py 的唯一起点
    ├── 04-工具\\                            ← 爬虫脚本与元数据（不参与索引）
    ├── _quarantine\\                        ← 隔离区：杂物 / 压缩包 / 重复套图
    └── _reports\\                           ← 盘点与移动审计日志

环境变量可覆盖，换盘或做备份副本时不用改代码：

    GALLERY_MEDIA_ROOT   图片根，默认 E:\\Download\\01-图库
    GALLERY_NOVEL_ROOT   小说根，默认 E:\\Download\\02-小说
"""
import os

MEDIA_ROOT = (os.environ.get('GALLERY_MEDIA_ROOT')
              or r'E:\Download\01-图库')
NOVEL_ROOT = (os.environ.get('GALLERY_NOVEL_ROOT')
              or r'E:\Download\02-小说')

# 整理前的旧路径，迁移脚本与兼容判断用
LEGACY_MEDIA_ROOT = r'E:\download\Telegram'
LEGACY_NOVEL_ROOT = r'E:\Download\novel_download'
