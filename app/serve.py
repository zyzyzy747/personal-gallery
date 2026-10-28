"""写真图库 · 本地预览服务器

用法：
    python serve.py [端口] [--open] [--token=XXXX]

    --open        启动后自动打开默认浏览器
    --token=XXXX  指定访问令牌；不传则自动生成，打印在控制台
    --lan         允许局域网直接访问（默认只放行本机与带令牌的请求）

默认端口 8777。双击上一级目录的「启动图库.bat」即可，无需手敲命令。

访问控制：
    本机（Host 为 127.0.0.1/localhost）直通，方便自己用；
    其他来源（Cloudflare 隧道、局域网）必须带令牌 —— 首次用 ?t=<令牌> 打开，
    之后靠 Cookie 记住，手机上不用每次输。
    这样把服务暴露到公网时，随机 URL 被别人猜到也进不来。
"""
import http.server, socketserver, os, sys, json, urllib.parse, threading, webbrowser
import secrets, urllib.error, hashlib, subprocess, time

args = [a for a in sys.argv[1:] if not a.startswith('--')]
FLAGS = {a for a in sys.argv[1:] if a.startswith('--')}
PORT = int(args[0]) if args else 8777
ROOT = os.path.dirname(os.path.abspath(__file__))

# 访问令牌：优先命令行，其次环境变量，再次复用上次生成的，最后才随机生成。
# 复用很重要 —— 否则每次重启服务令牌都变，手机上已登录的 Cookie 立刻失效，
# 又得重新输一次 key。
TOKEN = os.environ.get('GALLERY_TOKEN', '')
for f in FLAGS:
    if f.startswith('--token='):
        TOKEN = f[len('--token='):]
if not TOKEN:
    _tf = os.path.join(os.path.dirname(ROOT), '.gallery-token.txt')
    if os.path.isfile(_tf):
        try:
            with open(_tf, encoding='utf-8') as _f:
                TOKEN = _f.read().strip()
        except OSError:
            TOKEN = ''
if not TOKEN:
    TOKEN = secrets.token_urlsafe(9)
LAN_OPEN = '--lan' in FLAGS

# 允许前端直接读原始大图（磁盘真实路径），通过 /raw/ 路由
# 与 build.py 用同一个环境变量；默认值按自己机器改
RAW_ROOTS = [os.environ.get('GALLERY_ROOT') or r'E:\download\Telegram']

# 小说来源（可能多个根）由 novel_roots 统一声明，build.py 与本服务共用一份，
# 否则会出现「索引里列着这本书，点开却 404」。
sys.path.insert(0, ROOT)
import novel_roots


def resolve_novel(rel):
    """把索引里的 p（"<根序号>/<相对路径>"）还原成 (根目录, 绝对路径)。

    路径穿越在这一层统一挡掉：解析后的绝对路径必须仍在那个根之内。
    解析失败返回 (None, None)。
    """
    parts = rel.split('/', 1)
    try:
        idx = int(parts[0])
    except ValueError:
        idx, sub = 0, rel            # 兼容没有根序号的旧数据
    else:
        sub = parts[1] if len(parts) > 1 else ''

    r = novel_roots.root_by_index(idx)
    if not r:
        return None, None
    base = os.path.abspath(r[0])
    fp = os.path.abspath(os.path.join(base, sub.replace('/', os.sep)))
    if not (fp == base or fp.startswith(base + os.sep)):
        return None, None
    return base, fp


def read_novel_text(fp, limit=16 * 1024 * 1024):
    """把一本小说读成 UTF-8 文本。

    fp 可以是单个 txt，也可以是「书目录」——book18 爬虫的输出结构是
    <分类>/<书名>/chapters/<章节>.txt，一本由几十上百个章节文件组成，
    这里按文件名排序拼接成一整篇，并按章节插分隔标题。

    中文 txt 编码很杂：老站多 GBK/GB18030，新站 UTF-8，还有 UTF-16，
    逐个尝试，都不行才用 replacement 兜底，避免整篇乱码。
    """
    def decode(raw):
        for enc in ('utf-8', 'gb18030', 'big5', 'utf-16'):
            try:
                return raw.decode(enc)
            except (UnicodeDecodeError, LookupError):
                continue
        return raw.decode('utf-8', errors='replace')

    if os.path.isfile(fp):
        with open(fp, 'rb') as f:
            return decode(f.read(limit))

    parts = []
    total = 0
    for root, dirs, files in os.walk(fp):
        dirs.sort()
        for name in sorted(files):
            if not name.lower().endswith('.txt'):
                continue
            sub = os.path.join(root, name)
            try:
                with open(sub, 'rb') as f:
                    chunk = decode(f.read(limit))
            except OSError:
                continue
            total += len(chunk)
            if total > limit:
                parts.append('\n\n（内容过长，已截断）')
                return '\n\n'.join(parts)
            title = os.path.splitext(name)[0]
            parts.append('\n\n【%s】\n\n%s' % (title, chunk))
    return ''.join(parts)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        pass  # 静默

    def end_headers(self):
        """给代码类资源加 no-cache，图片则放长缓存。

        不这么做的话 app.js 更新后，手机会继续用旧版本脚本（Cloudflare 默认缓存
        js/css 数小时），出现「索引是新的但界面逻辑还是旧的」这种错位。
        图片文件名是 t{id}.jpg，同一套图的封面内容不会变，长缓存是安全的。
        """
        try:
            path = urllib.parse.urlparse(self.path).path.lower()
            if path.endswith(('.html', '.js', '.css', '.json')):
                self.send_header('Cache-Control', 'no-cache')
            elif path.endswith(('.jpg', '.jpeg', '.png', '.webp', '.mp4', '.webm')):
                self.send_header('Cache-Control', 'public, max-age=2592000')
        except Exception:
            pass
        super().end_headers()

    # ---------------- 访问控制 ----------------
    def _is_local(self):
        host = (self.headers.get('Host') or '').split(':')[0].lower()
        return host in ('127.0.0.1', 'localhost', '[::1]')

    def _authed(self):
        if self._is_local() or LAN_OPEN:
            return True
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if q.get('t', [''])[0] == TOKEN:
            # 首次带令牌访问，写 Cookie，省得手机上每次拼参数
            return 'set-cookie'
        if ('gt=' + TOKEN) in (self.headers.get('Cookie') or ''):
            return True
        return False

    def _deny(self):
        msg = ('需要访问令牌。请在地址后加 ?t=<令牌>，令牌在服务器控制台启动时打印。'
               .encode('utf-8'))
        self.send_response(401)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(msg)))
        self.end_headers()
        self.wfile.write(msg)

    def do_GET(self):
        auth = self._authed()
        if not auth:
            return self._deny()

        if auth == 'set-cookie':
            # 令牌正确：种 Cookie 后重定向到不带令牌的地址，避免 URL 里长期带密钥
            parsed = urllib.parse.urlparse(self.path)
            qs = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query) if k != 't']
            clean = parsed.path + (('?' + urllib.parse.urlencode(qs)) if qs else '')
            self.send_response(302)
            self.send_header('Location', clean)
            self.send_header('Set-Cookie',
                             'gt=%s; Path=/; Max-Age=31536000; SameSite=Lax' % TOKEN)
            self.end_headers()
            return

        p = urllib.parse.urlparse(self.path).path

        # 预压缩的 JSON（索引 8+ MB，gzip 后约 1/6）：客户端支持就直接发 .gz
        if p.endswith('.json') and 'gzip' in (self.headers.get('Accept-Encoding') or ''):
            gz = os.path.join(ROOT, p.lstrip('/').replace('/', os.sep)) + '.gz'
            if os.path.isfile(gz):
                return self.send_gz(gz)

        # /novel-text/<相对路径> → 小说正文（在线预览用，已转成 UTF-8）
        if p.startswith('/novel-text/'):
            rel = urllib.parse.unquote(p[12:])
            base, fp = resolve_novel(rel)
            # 单本 txt 或书目录都接受（书目录会按章节拼接）
            if not fp or not (os.path.isfile(fp) or os.path.isdir(fp)):
                self.send_error(404)
                return
            try:
                text = read_novel_text(fp)
            except OSError:
                self.send_error(500)
                return
            body = text.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        # /novel/<相对路径> → 小说 txt（点书名时下载）
        if p.startswith('/novel/'):
            rel = urllib.parse.unquote(p[7:])
            base, fp = resolve_novel(rel)
            # 防路径穿越在 resolve_novel 里已经做掉了
            if fp and os.path.isfile(fp):
                return self.send_file(fp)
            # 书目录：打包太麻烦，直接给合并后的整本 txt
            if fp and os.path.isdir(fp):
                try:
                    text = read_novel_text(fp).encode('utf-8')
                except OSError:
                    self.send_error(500)
                    return
                name = os.path.basename(fp.rstrip(os.sep)) + '.txt'
                from urllib.parse import quote as _q
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('Content-Length', str(len(text)))
                self.send_header(
                    'Content-Disposition',
                    "attachment; filename*=UTF-8''%s" % _q(name))
                self.end_headers()
                try:
                    self.wfile.write(text)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            self.send_error(404)
            return

        # /raw/<相对路径>  → 从 E 盘真实库取原图/原视频
        if p.startswith('/raw/'):
            rel = urllib.parse.unquote(p[5:])
            for r in RAW_ROOTS:
                fp = os.path.join(r, rel.replace('/', os.sep))
                if os.path.isfile(fp):
                    return self.send_file(fp)
            self.send_error(404)
            return
        return super().do_GET()

    def send_gz(self, fp):
        """发送预压缩文件。不支持 Range（JSON 是整体加载，不需要分段）。"""
        try:
            size = os.path.getsize(fp)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Content-Length', str(size))
            self.send_header('Vary', 'Accept-Encoding')
            # 索引必须每次回源验证：前端用 ?v=<hash> 破缓存，但如果这里给长 max-age，
            # Cloudflare 边缘和浏览器都会继续吃旧副本（手机上刷新还看到旧数据的元凶之一）。
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            with open(fp, 'rb') as f:
                while True:
                    chunk = f.read(1 << 20)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.send_error(500)

    MIME = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
        '.mkv': 'video/x-matroska', '.m4v': 'video/mp4',
        '.txt': 'text/plain; charset=utf-8',
    }

    def send_file(self, fp):
        """带 Range 支持的文件发送。

        视频必须要 Range：没有它浏览器拿到 200 + 整个文件，进度条拖不动，
        几百 MB 的 mp4 还会被整个读进内存。这里实现 206 分段 + 流式写。
        """
        try:
            size = os.path.getsize(fp)
            ext = os.path.splitext(fp)[1].lower()
            ctype = self.MIME.get(ext, 'application/octet-stream')

            start, end = 0, size - 1
            rng = self.headers.get('Range')
            partial = False
            if rng and rng.startswith('bytes='):
                spec = rng[6:].split(',')[0].strip()
                a, _, b = spec.partition('-')
                try:
                    if a == '':                       # bytes=-500 → 末尾 500 字节
                        start = max(0, size - int(b))
                    else:
                        start = int(a)
                        if b:
                            end = min(int(b), size - 1)
                    if start > end or start >= size:
                        self.send_response(416)
                        self.send_header('Content-Range', 'bytes */%d' % size)
                        self.end_headers()
                        return
                    partial = True
                except ValueError:
                    partial = False

            length = end - start + 1
            self.send_response(206 if partial else 200)
            self.send_header('Content-Type', ctype)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(length))
            if partial:
                self.send_header('Content-Range',
                                 'bytes %d-%d/%d' % (start, end, size))
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.end_headers()

            # 流式写出，避免大视频一次性载入内存
            with open(fp, 'rb') as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(262144, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass          # 用户拖进度条会主动断开，属正常
        except Exception:
            self.send_error(500)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def _write_token_file():
    """令牌落到项目根目录，方便手机访问脚本读取拼地址"""
    try:
        dst = os.path.join(os.path.dirname(ROOT), '.gallery-token.txt')
        with open(dst, 'w', encoding='utf-8') as f:
            f.write(TOKEN)
    except OSError:
        pass


# ---------------------------------------------------------------- 小说库自动重建

# 小说爬虫是长时间批量跑的（几千本要几小时），抓完必须重建 novels.json，
# 否则网页上看不到新书。这里让常驻的服务自己盯着，不指望用户记得手动跑。
WATCH_INTERVAL = 60        # 每 60 秒看一次目录
WATCH_MIN_GAP = 300        # 两次重建至少隔 5 分钟

# 为什么不做「等目录安静下来再重建」：
# 抓取是连续写的，每抓完一本目录就变一次，所谓「安静 3 分钟」在整个抓取期间
# 根本不会出现 —— 那样写的话一次都不会触发。重建本身只要 0.1 秒且是原子替换，
# 抓到一半重建完全安全，所以直接用时间节流就够了。


def _novel_sig():
    """小说来源的结构指纹，覆盖 novel_roots 里的每一个根。

    只看「结构」（存在哪些书），不看内容 —— 列表页只关心书的增删，追更改的是
    书内 txt，不影响目录条目。两个层次要分开看：

      category 模式的根（爬虫书库）：根下面每个子目录是一个分类，
        分类内增删书不会改根的 mtime，必须逐个分类统计。
      flat 模式的根（Telegram 小说包）：根本身就是一分类，直接看根的
        mtime + 直接子项数就够了。

    scandir 顺序不保证，一律排序后再算，否则顺序一变指纹就假变、白重建。
    """
    h = hashlib.md5()
    skip = ('_scripts', '__pycache__', '.git')

    for idx, (root, cat) in enumerate(novel_roots.roots()):
        if not os.path.isdir(root):
            continue
        try:
            st = os.stat(root)
            h.update(('%d|root|%d|%d\n' % (idx, int(st.st_mtime),
                                           len(os.listdir(root)))).encode('utf-8'))
        except OSError:
            continue

        if cat is not None:      # flat 模式，根这一层已经够了
            continue

        try:
            subs = sorted((x for x in os.scandir(root) if x.is_dir()),
                          key=lambda x: x.name)
        except OSError:
            continue
        for e in subs:
            if e.name in skip:
                continue
            try:
                h.update(('%d|%s|%d|%d\n' % (idx, e.name, int(e.stat().st_mtime),
                                             len(os.listdir(e.path)))).encode('utf-8'))
                # 聚合层（如 cool18/cool18）里增删书不改上层 mtime，单独看一层
                for sub in sorted((x for x in os.scandir(e.path) if x.is_dir()),
                                  key=lambda x: x.name):
                    try:
                        h.update(('%d/%s/%s|%d\n' % (idx, e.name, sub.name,
                                                     int(sub.stat().st_mtime))).encode('utf-8'))
                    except OSError:
                        pass
            except OSError:
                continue
    return h.hexdigest()


def novel_watchdog():
    """后台线程：小说目录有新增就自动重建 novels.json + 版本号。"""
    if not any(os.path.isdir(r) for r, _ in novel_roots.roots()):
        return
    try:
        last = _novel_sig()
    except Exception:
        return
    if not last:
        return
    last_build = 0.0
    pending = False
    while True:
        time.sleep(WATCH_INTERVAL)
        try:
            cur = _novel_sig()
        except Exception:
            continue
        if not cur:
            continue
        if cur != last:
            last = cur
            pending = True
        if not pending:
            continue
        # 节流只推迟重建，绝不能丢：pending 会一直挂着，直到真正跑过一次。
        # 旧写法在这里就把 last 更新掉了，于是「上次重建后 5 分钟内加的下一批书」
        # 会被节流拦下、又因为目录已经静止而永远不会补 —— 那批书永久丢失。
        if time.time() - last_build < WATCH_MIN_GAP:
            continue

        stamp = time.strftime('%H:%M:%S')
        try:
            # 用 --novels 只重建小说库：跳过 14 万张图的扫描，一秒内完成
            r = subprocess.run([sys.executable, os.path.join(ROOT, 'build.py'),
                                '--novels'], cwd=ROOT, capture_output=True,
                               timeout=600)
            out = (r.stdout or b'').decode('utf-8', 'replace').strip()
            err = (r.stderr or b'').decode('utf-8', 'replace').strip()
            if r.returncode == 0:
                line = [x for x in out.split('\n') if '小说库：' in x]
                print('[小说库] %s 检测到新书，自动重建 → %s'
                      % (stamp, (line[0].strip() if line else '完成')), flush=True)
            else:
                print('[小说库] %s 自动重建失败: %s' % (stamp, (err or out)[:300]), flush=True)
        except Exception as e:
            print('[小说库] %s 自动重建异常: %s' % (stamp, e), flush=True)
        pending = False
        last_build = time.time()


if __name__ == '__main__':
    url = 'http://127.0.0.1:%d/index.html' % PORT
    _write_token_file()
    # 小说库看门狗：爬虫抓完新书后自动重建索引（否则网页上永远看不到新书）
    if '--no-watch' not in FLAGS:
        threading.Thread(target=novel_watchdog, daemon=True).start()
    if '--open' in FLAGS:
        # 服务起来后再开浏览器，避免打开时连接被拒
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server = Server(('127.0.0.1', PORT), Handler)
    except OSError as e:
        # 最常见的原因：已经开着一个窗口了，再双击一次就会撞端口
        print('')
        print('启动失败：端口 %d 已被占用。' % PORT)
        print('通常是因为图库已经在一个窗口里运行了 —— 直接切到那个窗口即可。')
        print('如果确实没有其他窗口，请先关闭占用 %d 端口的程序再试。' % PORT)
        print('（原始错误：%s）' % e)
        if '--open' in FLAGS:
            webbrowser.open(url)   # 直接把已有实例开出来，省得用户找
        sys.exit(2)

    with server as httpd:
        print('写真图库已启动：%s' % url)
        print('本机访问免令牌；手机/外网访问令牌：%s' % TOKEN)
        print('关闭窗口即可停止服务。')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
