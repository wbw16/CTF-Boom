#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
西湖论剑手动拉题脚本(比赛应急用,独立于 GUI 进程运行)。

是 src/xihulunjian-platform-adapter.ts 中 `acquireChallenges` 的忠实移植:

  GET {serverHost}/slab-match/api/v1/agent/ctf/exercise-list        分批题目列表
  GET {serverHost}/slab-match/api/v1/agent/ctf/exercise?id=<id>     单题详情
  附件直接从 CDN 下载(不转发 AccessKey)

落盘为 Boom 标准布局,GUI 下一次目录扫描即可发现:

  <root>/challenges/<CATEGORY>/<slug>/README.md
  <root>/challenges/<CATEGORY>/<slug>/meta.json
  <root>/challenges/<CATEGORY>/<slug>/files/<附件名>

安全约定(比赛进行中):
  * 绝不触碰 <root>/runs、<root>/relay、<root>/competition;
  * 绝不调用 build-exercise-env / recover-exercise-env,绝不提交 flag;
  * 所有写入均为原子写(唯一临时文件 + rename),并发中的 GUI 扫描不会读到半成品;
  * 请求串行且保持最小间隔(平台按账户限流,GUI 与本脚本共享同一账户),
    HTTP 429 / 业务码 40001 按指数退避重试。

用法:
  python3 scripts/fetch-xihulunjian-challenges.py                 # 默认 root=xihulunjian-ctf
  python3 scripts/fetch-xihulunjian-challenges.py --gap-ms 2500   # 与 GUI 抢限流时放慢
  python3 scripts/fetch-xihulunjian-challenges.py --redownload    # 强制重下已存在附件

凭证来源与 GUI 一致: 环境变量 BOOM_XIHULUNJIAN_ACCESS_KEY 优先,否则
$BOOM_HOME/xihulunjian.json(默认 ~/.config/boom/xihulunjian.json)。
"""

from __future__ import annotations

import argparse
import datetime
import http.client
import json
import os
import random
import re
import socket
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid

API_PREFIX = "/slab-match/api/v1/agent"
SUCCESS_CODE = "00000"
RATE_LIMIT_CODE = "40001"
DEFAULT_SERVER_HOST = "https://pro.dasctf.com"
ADAPTER_ID = "xihulunjian"
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024

# 平台按账户限流(实测连续 3 次详情请求即触发 40001)。GUI 进程共享同一账户,
# 因此默认间隔取得比适配器在进程内的 700ms 更保守。
DEFAULT_GAP_MS = 1_500
RATE_LIMIT_RETRIES = 5
RATE_LIMIT_BASE_DELAY_MS = 2_000

CHALLENGE_CATEGORIES = [
    "WEB", "PWN", "REVERSE", "CRYPTO", "MISC", "MOBILE",
    "FORENSICS", "AI", "HARDWARE", "BLOCKCHAIN", "OSINT", "OTHER",
]

CATEGORY_ALIASES = {
    "WEB": "WEB", "WEBSEC": "WEB",
    "PWN": "PWN", "BINARY": "PWN", "BINARYEXPLOITATION": "PWN",
    "RE": "REVERSE", "REV": "REVERSE", "REVERSE": "REVERSE", "REVERSING": "REVERSE",
    "CRYPTO": "CRYPTO", "CRYPTOGRAPHY": "CRYPTO",
    "MISC": "MISC", "STEG": "MISC", "STEGANOGRAPHY": "MISC",
    "MOBILE": "MOBILE", "ANDROID": "MOBILE", "IOS": "MOBILE",
    "FORENSICS": "FORENSICS", "FORENSIC": "FORENSICS", "DFIR": "FORENSICS",
    "AI": "AI", "ML": "AI", "AIML": "AI",
    "HARDWARE": "HARDWARE", "IOT": "HARDWARE",
    "BLOCKCHAIN": "BLOCKCHAIN", "WEB3": "BLOCKCHAIN",
    "OSINT": "OSINT", "OTHER": "OTHER",
}

# 与适配器 NAME_CATEGORY_RULES 完全同序;平台分类名(如 Web/Pwn/Misc)命中别名时优先。
NAME_CATEGORY_RULES = [
    ("BLOCKCHAIN", ["blockchain", "web3", "solidity", "区块链", "合约", "智能合约"]),
    ("FORENSICS", ["forensic", "dfir", "pcap", "wireshark", "取证", "内存取证", "流量"]),
    ("MOBILE", ["mobile", "android", "apk", "ios", "ipa", "安卓", "手机"]),
    ("PWN", ["pwn", "pwnable", "rop", "shellcode", "heap", "stack", "溢出", "栈溢出", "堆利用", "二进制"]),
    ("REVERSE", ["reverse", "reversing", "crackme", "keygen", "unpack", "vmprotect", "re", "逆向", "反编译", "脱壳"]),
    ("CRYPTO", ["crypto", "cryptography", "rsa", "aes", "des", "ecc", "密码学", "加密", "解密", "椭圆曲线"]),
    ("WEB", ["web", "website", "webapp", "xss", "csrf", "ssrf", "sqli", "注入", "网站", "网页", "反序列化"]),
    ("AI", ["ai", "ml", "llm", "prompt", "adversarial", "机器学习", "深度学习", "模型", "神经网络", "大模型", "对抗"]),
    ("HARDWARE", ["hardware", "iot", "firmware", "硬件", "单片机", "嵌入式", "固件", "电路"]),
    ("OSINT", ["osint", "社工", "情报"]),
    ("MISC", ["misc", "steg", "steganography", "signin", "welcome", "隐写", "杂项", "签到"]),
    # 真实软件审计批次("REAL" 批):附件本身就是题目。脚本语言 CMS/框架属于 Web 漏洞挖掘;
    # 原生服务与数据存储是 C/C++ 源码上的内存安全挖掘,按解题工作归入 PWN。
    ("WEB", ["joomla", "wordpress", "drupal", "ghost", "cmsms", "php", "thinkphp", "laravel",
             "discuz", "spring", "struts", "tomcat", "shiro", "django", "flask", "rails"]),
    ("PWN", ["nginx", "httpd", "openlitespeed", "litespeed", "caddy", "openresty", "redis",
             "memcached", "mysql", "mariadb", "postgres", "postgresql", "clickhouse", "sqlite",
             "openssl", "ffmpeg", "imagemagick", "libpng", "zlib"]),
]


def obj(value):
    return value if isinstance(value, dict) else None


def text(value):
    if isinstance(value, str):
        found = value.strip()
        return found or None
    return None


def numeric(value):
    """`score` 等字段可能是字符串("50.0");统一转数值,整数值转 int 以匹配 TS 序列化。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        found = float(value)
    elif isinstance(value, str) and value.strip():
        try:
            found = float(value)
        except ValueError:
            return None
    else:
        return None
    if found != found or found in (float("inf"), float("-inf")):
        return None
    return int(found) if found.is_integer() else found


def identifier(value, label):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError(f"西湖论剑接口返回的{label}为空")
    found = str(value).strip()
    if not found:
        raise ValueError(f"西湖论剑接口返回的{label}为空")
    if len(found) > 256 or re.search(r"[\0/:]", found):
        raise ValueError(f"西湖论剑接口返回的{label}非法: {found}")
    return found


def category_key(value):
    return re.sub(r"[^A-Z0-9]", "", unicodedata.normalize("NFKC", value).upper())


def recognized_challenge_category(value):
    if not isinstance(value, str):
        return None
    return CATEGORY_ALIASES.get(category_key(value))


def infer_challenge_category(name, platform_category=None, attachments=None):
    known = recognized_challenge_category(platform_category)
    if known and known != "OTHER":
        return known
    for source in [name] + list(attachments or []):
        if not str(source).strip():
            continue
        normalized = unicodedata.normalize("NFKC", str(source)).lower()
        for category, keywords in NAME_CATEGORY_RULES:
            for keyword in keywords:
                # ASCII 关键词必须落在词边界上: 命中 "PWN-01"/"easy_pwn",不命中 "pwnme";
                # 非 ASCII 关键词(中文)用子串匹配。二者互斥,与 TS 的三元判断一致。
                ascii_keyword = keyword.isascii() and all("\x20" <= c < "\x7f" for c in keyword)
                if ascii_keyword:
                    # TS 边界类是 [\W_]: 凡是非字母数字(含下划线)都算词边界,故 "easy_rsa" 命中 "rsa"。
                    pattern = r"(?<![a-z0-9])" + re.escape(keyword) + r"(?![a-z0-9])"
                    if re.search(pattern, normalized):
                        return category
                elif keyword in normalized:
                    return category
    return "OTHER"


def slugify(value):
    normalized = unicodedata.normalize("NFKC", value).strip()
    normalized = re.sub(r"[\0-\x1f/\\:]+", "-", normalized).replace("..", "-")
    trimmed = re.sub(r"^\.+|\.+$", "", normalized)[:160]
    if not trimmed or trimmed in (".", ".."):
        raise ValueError("西湖论剑题目名无法生成合法 slug")
    return trimmed


def iso_millis(ms):
    try:
        moment = datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc)
    except (OverflowError, OSError, ValueError):
        return str(ms)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def select_endpoint(endpoints):
    """端口逻辑照搬 selectEndpoint: isProxy 优先 proxyIps:portMappings.proxy;
    exposeIps 条目自带端口,不能重复拼接。"""
    if not isinstance(endpoints, list) or not endpoints:
        return None

    def strings(value):
        if not isinstance(value, list):
            return []
        return [item for item in (text(entry) for entry in value) if item]

    def port_str(value):
        found = text(value)
        if found:
            return found
        number = numeric(value)
        return str(number) if number is not None else None

    lines = []
    remote = None
    expire_time = None
    for raw in endpoints:
        found = obj(raw)
        if not found:
            continue
        expose_ips = strings(found.get("exposeIps"))
        ports = [item for item in (port_str(entry) for entry in found.get("ports", [])) if item] \
            if isinstance(found.get("ports"), list) else []
        proxy_ips = strings(found.get("proxyIps"))
        mappings = []
        if isinstance(found.get("portMappings"), list):
            for entry in found["portMappings"]:
                mapping = obj(entry)
                if not mapping:
                    continue
                port = port_str(mapping.get("port"))
                proxy = port_str(mapping.get("proxy"))
                if not port or not proxy:
                    continue
                mappings.append({"type": text(mapping.get("type")) or "tcp", "port": port, "proxy": proxy})
        proxied = found.get("isProxy") is True
        if remote is None:
            exposed = expose_ips[0] if expose_ips else None
            bare_proxy_port = mappings[0]["proxy"] if mappings else None
            if proxied and proxy_ips and bare_proxy_port:
                remote = f"{proxy_ips[0]}:{bare_proxy_port}"
            elif exposed is not None and ":" in exposed:
                remote = exposed
            elif exposed is not None and ports:
                remote = f"{exposed}:{re.sub(r'^.*/', '', ports[0])}"
            elif proxy_ips and bare_proxy_port:
                remote = f"{proxy_ips[0]}:{bare_proxy_port}"
        expires = numeric(found.get("expireTime"))
        if expires is not None:
            expire_time = expires if expire_time is None else min(expire_time, expires)
        if expose_ips:
            line = f"- Direct address: {', '.join(expose_ips)}"
            if ports:
                line += f" (open ports: {', '.join(ports)})"
            lines.append(line)
        if proxy_ips:
            lines.append(f"- Proxy IP: {', '.join(proxy_ips)}" + (" (platform recommends the proxy)" if proxied else ""))
        for mapping in mappings:
            lines.append(f"- Port mapping: {mapping['type']} container {mapping['port']} -> proxy {mapping['proxy']}")
        if isinstance(found.get("users"), list):
            for entry in found["users"]:
                user = obj(entry)
                if not user:
                    continue
                username = text(user.get("username"))
                if not username:
                    continue
                password = text(user.get("password"))
                lines.append(f"- Account: {username}" + (f" / password: {password}" if password else ""))
        if expires is not None:
            lines.append(f"- Environment expires: {iso_millis(expires)}")
    if remote is None and not lines:
        return None
    result = {"detail": "\n".join(lines)}
    if remote is not None:
        result["remote"] = remote
    if expire_time is not None:
        result["expire_time"] = expire_time
    return result


def attachments_of(value):
    """`attachment` 有附件时是单个对象、无附件时是空数组;同时容错文档写的 {files:[...]}。"""
    if isinstance(value, list):
        items = value
    else:
        found = obj(value)
        if not found:
            items = []
        elif isinstance(found.get("files"), list):
            items = found["files"]
        else:
            items = [found]
    attachments = []
    for index, raw in enumerate(items):
        item = obj(raw)
        if not item:
            continue
        url = text(item.get("url")) or text(item.get("previewUrl")) or text(item.get("downloadUrl"))
        if not url:
            continue
        extension = text(item.get("extension"))
        fallback = f"attachment-{index + 1}" + (f".{extension}" if extension else "")
        attachments.append({"name": text(item.get("name")) or fallback, "url": url})
    return attachments


class PlatformError(Exception):
    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.URLError(f"unexpected redirect to {newurl}")


_OPENER = urllib.request.build_opener(_NoRedirect)


def _read_bounded(stream, maximum, what):
    chunks = []
    size = 0
    while True:
        chunk = stream.read(64 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > maximum:
            raise PlatformError(f"{what}超过 {maximum} 字节上限", retryable=False)
        chunks.append(chunk)
    return b"".join(chunks)


class XihulunjianClient:
    def __init__(self, server_host, access_key, gap_ms=DEFAULT_GAP_MS, timeout=30):
        if not access_key or not access_key.strip():
            raise SystemExit("西湖论剑未配置 AccessKey(检查 BOOM_XIHULUNJIAN_ACCESS_KEY 或 ~/.config/boom/xihulunjian.json)")
        self.base = server_host.rstrip("/")
        self.access_key = access_key.strip()
        self.gap = gap_ms / 1000
        self.timeout = timeout
        self._last_request_at = 0.0

    def _attempt(self, method, endpoint, query=None):
        url = self.base + API_PREFIX + endpoint
        if query:
            url += "?" + urllib.parse.urlencode(query)
        request = urllib.request.Request(url, method=method, headers={
            "Accept": "application/json",
            # 平台 WAF 封锁 python-urllib 等 UA(返回 403 HTML);使用与 Boom 一致的 UA。
            "User-Agent": "Boom/0.1",
            "X-Agent-AccessKey": self.access_key,
        })
        wait = self._last_request_at + self.gap - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last_request_at = time.monotonic()
        try:
            with _OPENER.open(request, timeout=self.timeout) as response:
                status = response.status
                raw = _read_bounded(response, MAX_RESPONSE_BYTES, "西湖论剑响应")
        except urllib.error.HTTPError as error:
            status = error.code
            try:
                raw = _read_bounded(error, MAX_RESPONSE_BYTES, "西湖论剑响应")
            except Exception:
                raw = b""
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError,
                http.client.HTTPException, OSError) as error:
            raise PlatformError(f"西湖论剑接口 {method} {endpoint} 传输失败: {error}", retryable=True) from error

        body = raw.decode("utf-8", "replace")
        try:
            payload = json.loads(body)
        except ValueError:
            payload = None
        envelope = obj(payload)
        code = text(envelope.get("code")) if envelope else None
        message = (text(envelope.get("message")) if envelope else None) or "无描述"
        if status == 429 or code == RATE_LIMIT_CODE:
            raise PlatformError(
                f"西湖论剑接口 {method} {endpoint} 触发限流 ({status}/{code or '-'}): {message}", retryable=True)
        if status >= 400:
            snippet = re.sub(r"[\0\r\n]+", " ", body)[:400]
            retryable = status in (408, 425) or status >= 500
            raise PlatformError(f"西湖论剑接口 {method} {endpoint} 失败 ({status}): {snippet}", retryable=retryable)
        if not envelope:
            raise PlatformError(f"西湖论剑接口 {method} {endpoint} 返回结构异常: {body[:200]}", retryable=False)
        if code != SUCCESS_CODE:
            raise PlatformError(f"西湖论剑接口 {method} {endpoint} 返回业务失败 (code={code or '缺失'}): {message}",
                                retryable=False)
        return envelope.get("data")

    def call(self, method, endpoint, query=None):
        last = None
        for attempt in range(RATE_LIMIT_RETRIES + 1):
            if attempt:
                delay = RATE_LIMIT_BASE_DELAY_MS * (2 ** (attempt - 1)) / 1000
                delay += random.uniform(0, 0.6)
                time.sleep(delay)
            try:
                return self._attempt(method, endpoint, query)
            except PlatformError as error:
                last = error
                if not error.retryable:
                    raise
        raise last

    def exercise_list(self):
        data = self.call("GET", "/ctf/exercise-list")
        if not isinstance(data, list):
            raise PlatformError("西湖论剑题目列表结构异常", retryable=False)
        open_items, closed = [], []
        for raw in data:
            group = obj(raw)
            if not group:
                continue
            group_id = identifier(group.get("id"), "分类 ID")
            group_name = text(group.get("name")) or group_id
            corpus = group.get("corpus") if isinstance(group.get("corpus"), list) else []
            for entry in corpus:
                item = obj(entry)
                if not item:
                    continue
                try:
                    challenge_id = identifier(item.get("id"), "题目 ID")
                except ValueError as error:
                    print(f"  ! 跳过一条题目: {error}")
                    continue
                preview = {
                    "id": challenge_id,
                    "title": text(item.get("name")) or challenge_id,
                    "category": group_name,
                    "solved": item.get("hasSolved") is True,
                }
                if item.get("isOpen") is False:
                    closed.append(preview)
                else:
                    open_items.append(preview)
        return open_items, closed

    def exercise_detail(self, exercise_id):
        data = obj(self.call("GET", "/ctf/exercise", query={"exerciseId": exercise_id}))
        if not data:
            raise PlatformError(f"西湖论剑题目 {exercise_id} 详情结构异常", retryable=False)
        endpoint_type = text(data.get("endpointType"))
        endpoints_raw = data.get("endpoints")
        endpoint = select_endpoint(endpoints_raw)
        return {
            "id": identifier(data.get("id") or exercise_id, "题目 ID"),
            "name": text(data.get("name")) or exercise_id,
            "description": text(data.get("description")) or "",
            "score": numeric(data.get("score")),
            "difficulty": text(data.get("difficulty")),
            "solved": data.get("hasSolved") is True,
            "attachments": attachments_of(data.get("attachment")),
            "endpoint": endpoint,
            "needs_init": data.get("isNeedInit") is True,
            "needs_check": data.get("isNeedCheck") is True,
            "service_required": data.get("isNeedInit") is True
            or (endpoint_type is not None and endpoint_type != "none")
            or (isinstance(endpoints_raw, list) and len(endpoints_raw) > 0),
        }

    def download(self, url, target, maximum_bytes):
        """流式下载到临时文件后原子改名,超大附件也不会堆在内存里。"""
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise PlatformError(f"附件协议不受支持: {parsed.scheme}", retryable=False)
        # 附件在独立 CDN 域,无需鉴权;绝不把 AccessKey 转发给对象存储。
        directory = os.path.dirname(target)
        os.makedirs(directory, exist_ok=True)
        temporary = os.path.join(directory, f".{os.path.basename(target)}.{os.getpid()}.{uuid.uuid4().hex}.part")
        try:
            request = urllib.request.Request(url, headers={"Accept": "*/*", "User-Agent": "Boom/0.1"})
            try:
                with urllib.request.urlopen(request, timeout=120) as response, open(temporary, "wb") as handle:
                    if response.status >= 400:
                        raise PlatformError(f"附件下载失败 ({response.status})", retryable=False)
                    size = 0
                    while True:
                        chunk = response.read(256 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > maximum_bytes:
                            raise PlatformError(f"附件超过 {maximum_bytes} 字节上限", retryable=False)
                        handle.write(chunk)
                os.replace(temporary, target)
                return size
            except urllib.error.HTTPError as error:
                raise PlatformError(f"附件下载失败 ({error.code})", retryable=False) from error
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError,
                    http.client.HTTPException, OSError) as error:
                raise PlatformError(f"附件下载传输失败: {error}", retryable=True) from error
        finally:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def atomic_write(target, payload):
    directory = os.path.dirname(target)
    os.makedirs(directory, exist_ok=True)
    temporary = os.path.join(directory, f".{os.path.basename(target)}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(handle, payload)
        finally:
            os.close(handle)
        os.replace(temporary, target)
    finally:
        try:
            os.unlink(temporary)
        except OSError:
            pass


def assert_owned(directory, challenge_id):
    """目录已存在时,只有同 adapter 且同 challenge_id 才允许覆盖;外来目录直接跳过。"""
    if not os.path.exists(directory):
        os.makedirs(directory, exist_ok=True)
        return True
    if os.path.islink(directory) or not os.path.isdir(directory):
        print(f"  ! 跳过 {directory}: 不是普通目录")
        return False
    try:
        with open(os.path.join(directory, "meta.json"), encoding="utf-8") as handle:
            metadata = obj(json.load(handle))
    except (OSError, ValueError):
        return True
    owner = obj(metadata.get("platform")) if metadata else None
    if owner and (owner.get("adapter") != ADAPTER_ID or str(owner.get("challenge_id") or "") != challenge_id):
        print(f"  ! 跳过 {directory}: 不属于 {ADAPTER_ID}/{challenge_id}")
        return False
    return True


def remove_stale_copies(challenges_base, challenge_id, current):
    """同题换了分类目录时,删除旧分类下的副本;否则 GUI 的 slug 去重会直接抛错。
    只删除 platform.adapter=xihulunjian 且 challenge_id 相同的目录。"""
    try:
        entries = sorted(os.listdir(challenges_base))
    except OSError:
        return
    for entry in entries:
        if entry.startswith("."):
            continue
        outer = os.path.join(challenges_base, entry)
        if os.path.islink(outer) or not os.path.isdir(outer):
            continue
        if recognized_challenge_category(entry):
            try:
                nested = sorted(os.listdir(outer))
            except OSError:
                continue
            candidates = [os.path.join(outer, child) for child in nested if not child.startswith(".")]
        else:
            candidates = [outer]
        for candidate in candidates:
            if os.path.realpath(candidate) == os.path.realpath(current):
                continue
            try:
                with open(os.path.join(candidate, "meta.json"), encoding="utf-8") as handle:
                    owner = obj(obj(json.load(handle)).get("platform"))
            except (OSError, ValueError):
                continue
            if owner and owner.get("adapter") == ADAPTER_ID and str(owner.get("challenge_id") or "") == challenge_id:
                import shutil
                print(f"  - 移除旧分类副本: {candidate}")
                shutil.rmtree(candidate, ignore_errors=True)


def load_credentials():
    access_key = os.environ.get("BOOM_XIHULUNJIAN_ACCESS_KEY", "").strip()
    home = os.environ.get("BOOM_HOME") or os.path.join(os.path.expanduser("~"), ".config", "boom")
    path = os.path.join(home, "xihulunjian.json")
    stored = {}
    try:
        with open(path, encoding="utf-8") as handle:
            stored = obj(json.load(handle)) or {}
    except (OSError, ValueError) as error:
        if not access_key:
            raise SystemExit(f"无法读取西湖论剑凭证 {path}: {error}")
    access_key = access_key or (stored.get("accessKey") or "").strip()
    server_host = (stored.get("serverHost") or "").strip() or DEFAULT_SERVER_HOST
    return access_key, server_host


def main():
    parser = argparse.ArgumentParser(description="手动拉取西湖论剑最新题目(不影响正在运行的 GUI/解题)")
    parser.add_argument("--root", default="xihulunjian-ctf", help="比赛根目录(默认 xihulunjian-ctf)")
    parser.add_argument("--gap-ms", type=int, default=DEFAULT_GAP_MS,
                        help=f"相邻 API 请求最小间隔毫秒(默认 {DEFAULT_GAP_MS};与 GUI 抢限流时可调大)")
    parser.add_argument("--redownload", action="store_true", help="强制重新下载已存在的附件(默认跳过非空文件)")
    parser.add_argument("--max-attachment-mb", type=int, default=MAX_ATTACHMENT_BYTES // (1024 * 1024),
                        help="单附件大小上限 MB(默认 128 与适配器一致;MISC-01 等超大附件需显式调大)")
    args = parser.parse_args()

    access_key, server_host = load_credentials()
    root = os.path.abspath(args.root)
    challenges_base = os.path.join(root, "challenges")

    print("== 西湖论剑手动拉题 ==")
    print(f"server : {server_host}")
    print(f"root   : {root}")
    print(f"间隔   : {args.gap_ms}ms,限流重试 {RATE_LIMIT_RETRIES} 次(指数退避)")
    print("只读拉题: 不会启动/回收靶机,不会提交 flag,不写 runs/ relay/ competition/")
    print()

    client = XihulunjianClient(server_host, access_key, gap_ms=args.gap_ms)
    try:
        open_items, closed = client.exercise_list()
    except PlatformError as error:
        print(f"拉取题目列表失败: {error}")
        return 1

    print(f"列表拉取成功: 开放 {len(open_items)} 道,未开放 {len(closed)} 道")
    for item in closed:
        print(f"  [未开放] {item['title']} (id={item['id']})")
    print()

    created = refreshed = failed = 0
    failures = []
    used = set()
    for item in open_items:
        label = f"{item['title']} (id={item['id']})"
        try:
            detail = client.exercise_detail(item["id"])
        except PlatformError as error:
            if error.retryable:
                print(f"传输/限流错误中断拉取({error});已完成部分保持有效,可重跑本脚本续拉。")
                failed += 1
                failures.append(f"{label}: {error}")
                break
            failed += 1
            failures.append(f"{label}: {error}")
            print(f"  [失败] {label}: {error}")
            continue

        name = detail["name"] or item["title"] or detail["id"]
        try:
            slug = slugify(name)
            if slug in used:
                slug = slugify(f"{slug}-{detail['id']}")
            used.add(slug)
        except ValueError as error:
            failed += 1
            failures.append(f"{label}: {error}")
            continue

        # 匿名化批次("REAL-XX")的题目名没有信号,附件文件名是唯一的分类依据。
        category = infer_challenge_category(
            name, item["category"], [attachment["name"] for attachment in detail["attachments"]])
        directory = os.path.join(challenges_base, category, slug)
        if not assert_owned(directory, detail["id"]):
            failed += 1
            failures.append(f"{label}: 目录被占用")
            continue
        is_new = not os.path.exists(os.path.join(directory, "meta.json"))

        names = set()
        for attachment in detail["attachments"]:
            attachment_name = slugify(attachment["name"])
            if attachment_name in names:
                attachment_name = slugify(f"{detail['id']}-{attachment_name}")
            names.add(attachment_name)
            target = os.path.join(directory, "files", attachment_name)
            if not args.redownload and os.path.exists(target) and os.path.getsize(target) > 0:
                continue
            try:
                client.download(attachment["url"], target, args.max_attachment_mb * 1024 * 1024)
            except PlatformError as error:
                if error.retryable:
                    raise
                print(f"  ! 附件下载失败 {label}/{attachment_name}: {error}")
                continue

        endpoint = detail["endpoint"]
        readme = [f"# {detail['name']}", "", detail["description"] or "(no challenge description provided by the platform)"]
        if endpoint and endpoint.get("detail"):
            readme += ["", "## Environment connection info", "", endpoint["detail"]]
        elif detail["service_required"]:
            readme += ["", "## Environment connection info", "",
                       "This challenge needs a target environment that has not been started yet. "
                       "The solving scheduler will start it once an environment slot is available "
                       "and write the address here."]
        atomic_write(os.path.join(directory, "README.md"), ("\n".join(readme) + "\n").encode("utf-8"))

        options = {"exercise_id": detail["id"]}
        # 附件清单与 GUI 适配器同格式:GUI 下次同步据此判定本地副本完整,跳过详情与重下。
        # 下载失败的附件也留在清单里 —— GUI 会发现缺文件并自动重新物化,正是期望的自愈。
        options["attachments"] = sorted(names)
        if detail["solved"] or item["solved"]:
            options["solved"] = True
        if detail["score"] is not None:
            options["score"] = detail["score"]
        if detail["difficulty"]:
            options["difficulty"] = detail["difficulty"]
        if endpoint and endpoint.get("expire_time") is not None:
            options["expire_time"] = endpoint["expire_time"]
        meta = {"category": category}
        if detail["difficulty"]:
            meta["difficulty"] = detail["difficulty"]
        if endpoint and endpoint.get("remote"):
            meta["remote"] = endpoint["remote"]
        if detail["service_required"]:
            meta["service_required"] = True
        meta["platform"] = {"adapter": ADAPTER_ID, "challenge_id": detail["id"], "options": options}
        atomic_write(os.path.join(directory, "meta.json"), (json.dumps(meta, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))

        remove_stale_copies(challenges_base, detail["id"], directory)

        status = "新增" if is_new else "刷新"
        if is_new:
            created += 1
        else:
            refreshed += 1
        env = "靶机 " + endpoint["remote"] if endpoint and endpoint.get("remote") else ("需靶机(未启动)" if detail["service_required"] else "本地")
        print(f"  [{status}] {category}/{slug} | 分值 {detail['score'] if detail['score'] is not None else '-'} | "
              f"{detail['difficulty'] or '-'} | {env}{' | 已解出' if detail['solved'] or item['solved'] else ''}")

    print()
    print(f"== 完成: 新增 {created}, 刷新 {refreshed}, 失败 {failed}, 未开放 {len(closed)} ==")
    for failure in failures:
        print(f"  ! {failure}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n手动中断;已写入的题目目录保持有效。")
        sys.exit(130)
