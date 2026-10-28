"""小说库看门狗（独立进程版）

serve.py 里已内置同名看门狗，这个可以单独跑 —— 用于「图库服务已经在运行、
不想为了一段新代码就重启它」的场景。逻辑完全复用 serve.py，不重复实现。

它盯着 E:\\Download\\novel_download，一旦发现书的增删就自动跑
build.py --novels 重建索引（约 1 秒）并刷新版本号，手机刷新即可看到新书。

用法：
    python novel_watcher.py       # 前台，日志打到控制台
    pythonw novel_watcher.py      # 无窗口后台常驻
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# serve.py 顶层会解析 sys.argv 拿端口，这里给个空参数，
# 它只会读完 token 文件就停（启动逻辑在 __main__ 里，import 不会触发）
sys.argv = [sys.argv[0]]

spec = importlib.util.spec_from_file_location('srv', os.path.join(HERE, 'serve.py'))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    if not os.path.isdir(srv.NOVEL_ROOT):
        print('小说目录不存在：%s' % srv.NOVEL_ROOT)
        sys.exit(1)
    print('小说库看门狗已启动')
    print('  监控目录：%s' % srv.NOVEL_ROOT)
    print('  检查间隔：%d 秒；两次重建间隔 >= %d 秒'
          % (srv.WATCH_INTERVAL, srv.WATCH_MIN_GAP))
    sys.stdout.flush()
    try:
        srv.novel_watchdog()
    except KeyboardInterrupt:
        print('\n已停止')
