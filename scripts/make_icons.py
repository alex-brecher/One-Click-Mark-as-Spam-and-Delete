#!/usr/bin/env python3
"""Generate the extension's PNG icons without third-party deps."""

import os
import struct
import zlib

OUTDIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

# Solid red-circle on white background with a white "!" mark in the middle.
RED = (217, 48, 37, 255)
WHITE = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def write_png(path, pixels, width, height):
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter: None
        for x in range(width):
            r, g, b, a = pixels[y][x]
            raw.append(r)
            raw.append(g)
            raw.append(b)
            raw.append(a)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def make_icon(size):
    cx = cy = (size - 1) / 2
    radius = size * 0.46
    inner_radius_sq = radius * radius

    # Exclamation mark dimensions
    bar_h = size * 0.36
    bar_w = max(1, size * 0.10)
    bar_top = cy - bar_h / 2 - size * 0.05
    dot_y = cy + bar_h / 2 + size * 0.07
    dot_r = bar_w * 0.7

    pixels = [[TRANSPARENT for _ in range(size)] for _ in range(size)]

    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = y - cy
            dist_sq = dx * dx + dy * dy
            if dist_sq > inner_radius_sq:
                continue

            # Distance from edge -> simple anti-alias on the circle outline.
            d_edge = radius - (dist_sq ** 0.5)
            edge_a = max(0.0, min(1.0, d_edge))

            color = list(RED)

            # Bar of "!".
            if abs(dx) <= bar_w / 2 and bar_top <= y <= bar_top + bar_h:
                color = list(WHITE)

            # Dot of "!".
            ddx = x - cx
            ddy = y - dot_y
            if ddx * ddx + ddy * ddy <= dot_r * dot_r:
                color = list(WHITE)

            color[3] = int(255 * edge_a)
            pixels[y][x] = tuple(color)

    return pixels


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    for size in (16, 48, 128):
        pixels = make_icon(size)
        out = os.path.join(OUTDIR, f"icon{size}.png")
        write_png(out, pixels, size, size)
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
