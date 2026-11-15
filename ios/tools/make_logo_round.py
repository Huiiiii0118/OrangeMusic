#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 tools/logo_source.png 生成「橙子音乐」全部 logo 资源（替换旧 logo 时改这一处即可）。

新源图是「圆橙 + 绿叶，米色实底」的方形插画；这里：
  - 居中裁切为正方形，缩放到 512，**裁成 WorkBuddy 那种圆角方形（squircle，半径约 22%）**；
    **保留源图原有米色实底**（用户要求「原样替换」），实心插画在任何背景
    （浅色卡片 / 任务栏 / 托盘 / 深色闪屏 / .exe 图标）都真实可见，
    不会像透明圆那样在浅色 UI 上显得「空白」或加载失败；
    四角透明靠 ICO 的 AND 掩码正确写入，小尺寸图标也不会出现黑角；
  - **两套输出**：界面里显示的 `logo.png`（侧栏 / 关于 / 登录页）抠掉米色底，只留橙子 + 绿叶
    （用户第 12 项「这里的底纹也不要」）；ico / 托盘 / PWA icon / favicon 仍用米色圆角实底，
    保证任务栏与 .exe 图标在浅色/深色下都真实可见（透明图标曾导致图标失效，勿改）；
  - 输出 logo.png、icon-180/192/512.png、icon.svg；
  - 输出 Windows 用的 icon.ico（16~256 多尺寸，小尺寸用 BMP、256 用 PNG 的混合格式——
    NSIS / 资源管理器 / electron-builder 都能正常嵌入与显示）。

产物：
  shared/pwa/logo.png、icon-180.png、icon-192.png、icon-512.png、icon.svg
  windows/electron/build/icon.ico

可重复执行：永远从 tools/logo_source.png 重新生成。
用法：python tools/make_logo_round.py
"""

import os
import io
import base64
import struct
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PWA = os.path.join(ROOT, 'shared', 'pwa')
SRC = os.path.join(ROOT, 'tools', 'logo_source.png')
ICO = os.path.join(ROOT, 'windows', 'electron', 'build', 'icon.ico')


CORNER_RATIO = 0.22   # WorkBuddy 风格圆角方形的半径占比（512px 时约 113px）


def round_mask(size, ratio=CORNER_RATIO):
    """4 倍超采样生成抗锯齿圆角遮罩，四角 alpha=0，其余保持米色实底不透明。"""
    ss = 4
    big = size * ss
    r = int(size * ratio) * ss
    m = Image.new('L', (big, big), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, big - 1, big - 1), radius=r, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def load_square():
    """居中裁切为正方形并缩放到 512，保留源图原有像素（含米色实底），只把四角裁成圆弧。"""
    im = Image.open(SRC).convert('RGBA')
    w, h = im.size
    s = min(w, h)
    left = (w - s) // 2
    top = (h - s) // 2
    im = im.crop((left, top, left + s, top + s)).resize((512, 512), Image.LANCZOS)
    im.putalpha(round_mask(512))
    return im


def save_ico(out_path, image, sizes):
    """手工拼装 ICO：小尺寸（<256）用 BMP（未压缩 32-bit BGRA），256 用 PNG 压缩。
    这是 Windows 最通用的混合 ICO —— 小尺寸 BMP 保证 NSIS / 旧资源管理器 / 任务栏小图标
    都能渲染；256 PNG 是高分标准帧，electron-builder(rcedit) 与现代 Windows 都认；
    避免出现「全 BMP 大帧臃肿」或「全 PNG 小帧不显示」两种极端。
    PNG 帧在目录里的宽高写 0（ICO 规范：>255 时占位 0，真实尺寸在 PNG 头里）。"""
    def bmp_frame(im):
        im = im.convert('RGBA')
        w, h = im.size
        # BGRA 像素行（自下而上）+ 对应的 AND 掩码（1 = 透明，MSB 在前）
        px = im.load()
        rows = []
        and_rows = []
        and_pitch = ((w + 31) // 32) * 4
        for y in range(h - 1, -1, -1):
            row = bytearray()
            bits = bytearray(and_pitch)
            for x in range(w):
                r, g, b, a = px[x, y]
                row += bytes((b, g, r, a))
                if a < 128:
                    bits[x // 8] |= (0x80 >> (x % 8))
            # 每行 4 字节对齐
            pad = (4 - (w * 4) % 4) % 4
            row += b'\x00' * pad
            rows.append(bytes(row))
            and_rows.append(bytes(bits))
        xor = b''.join(rows)
        # 圆角四角必须在这里标成透明，否则 16~128 的 BMP 小帧会露出黑角
        and_mask = b''.join(and_rows)
        dib = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(xor) + len(and_mask), 0, 0, 0, 0)
        return dib + xor + and_mask

    def png_frame(im):
        buf = io.BytesIO()
        im.convert('RGBA').resize((256, 256), Image.LANCZOS).save(buf, 'PNG')
        return buf.getvalue()

    # 先生成所有帧，再按「目录头 + 目录条目 + 数据」的真实布局顺序算出每个帧的偏移
    frames = []
    for (w, h) in sizes:
        frames.append(png_frame(image) if (w, h) == (256, 256) else bmp_frame(image.resize((w, h), Image.LANCZOS)))
    data = b''.join(frames)
    offsets = []
    acc = 6 + len(frames) * 16          # 数据区起点 = 目录头(6) + 条目(num*16)
    for fr in frames:
        offsets.append(acc)
        acc += len(fr)
    dir_header = struct.pack('<HHH', 0, 1, len(frames))
    dir_entries = b''
    for i, (w, h) in enumerate(sizes):
        bpp = 32
        size = len(frames[i])
        # PNG 帧（256）宽高在目录里写 0，BMP 帧写真实尺寸
        dw = 0 if (w, h) == (256, 256) else (w & 0xFF)
        dh = 0 if (w, h) == (256, 256) else (h & 0xFF)
        dir_entries += struct.pack('<BBBBHHII', dw, dh, 0, 0, 1, bpp, size, offsets[i])
    with open(out_path, 'wb') as f:
        f.write(dir_header + dir_entries + data)


UI_PAD = 0.06   # 抠底后内容四周保留的透明留白


def cutout_ui_logo(solid):
    """UI 里显示的 logo.png：去掉米色实底（用户第 12 项「这里的底纹也不要」），只留橙子与叶子。
    背景是均匀 (255,243,234)，用「从边缘开始的漫水填充 + 颜色容差」识别；
    橙子内部的白色高光不与边缘连通，不会被误抠成透明洞。
    ico / 托盘 / PWA icon 仍用米色实底版本，保证任务栏与 exe 图标在浅色/深色下都可见。
    """
    size = solid.size[0]
    work = solid.convert('RGB').copy()
    MARK = (255, 0, 255)
    seeds = [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1),
             (size // 2, 0), (0, size // 2), (size - 1, size // 2), (size // 2, size - 1)]
    for xy in seeds:
        try:
            if work.getpixel(xy) != MARK:
                # 容差要盖住橙子周围的柔和投影渐变，否则会留一圈米色光晕（看着仍像底纹）
                ImageDraw.floodfill(work, xy, MARK, thresh=48)
        except Exception:
            pass
    alpha = Image.new('L', solid.size, 255)
    ap, wp = alpha.load(), work.load()
    for y in range(size):
        for x in range(size):
            if wp[x, y] == MARK:
                ap[x, y] = 0
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))
    out = solid.convert('RGBA')
    out.putalpha(alpha)
    # 抠掉底后橙子会显小：按 alpha 边界裁成正方形，再留 6% 透明边距铺满画布
    bbox = alpha.getbbox()
    if bbox:
        l, t, r, b = bbox
        cx, cy = (l + r) // 2, (t + b) // 2
        side = max(r - l, b - t)
        crop = out.crop((cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side))
        inner = int(size * (1 - 2 * UI_PAD))
        crop = crop.resize((inner, inner), Image.LANCZOS)
        canvas = Image.new('RGBA', solid.size, (0, 0, 0, 0))
        off = int(size * UI_PAD)
        canvas.paste(crop, (off, off), crop)
        out = canvas
    return out


def main():
    master = load_square()          # 米色实底 + 圆角：系统图标 / PWA 用
    ui_logo = cutout_ui_logo(master)  # 透明底、仅橙子：界面里显示的 logo 用
    ui_logo.save(os.path.join(PWA, 'logo.png'))
    print('logo.png', ui_logo.size, '(transparent UI logo)')

    for s in (180, 192, 512):
        master.resize((s, s), Image.LANCZOS).save(os.path.join(PWA, f'icon-{s}.png'))

    # 托盘专用 PNG（256）：nativeImage 走 createFromBuffer 读取，不依赖 .ico 在 asar 内的解析
    TRAY = os.path.join(ROOT, 'windows', 'electron', 'build', 'icon-tray.png')
    master.resize((256, 256), Image.LANCZOS).save(TRAY)
    print('icon-tray.png', os.path.getsize(TRAY), 'bytes')

    # icon.svg：内嵌 512 PNG（作为 favicon / PWA 图标，浏览器可解析）
    buf = io.BytesIO()
    master.save(buf, 'PNG')
    b64 = base64.b64encode(buf.getvalue()).decode()
    with open(os.path.join(PWA, 'icon.svg'), 'w', encoding='utf-8') as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
                f'<image width="512" height="512" href="data:image/png;base64,{b64}"/></svg>')
    print('icon.svg ok')

    # icon.ico：多尺寸、混合格式（小尺寸 BMP + 256 PNG；NSIS / 资源管理器 / electron-builder / 任务栏 / 托盘 / Alt-Tab 各取所需）
    save_ico(ICO, master, [(16, 16), (20, 20), (24, 24), (32, 32), (40, 40),
                           (48, 48), (64, 64), (96, 96), (128, 128), (256, 256)])
    print('icon.ico', os.path.getsize(ICO), 'bytes')


if __name__ == '__main__':
    main()
