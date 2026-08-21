#!/usr/bin/env python3
"""Generate deterministic Chrome Web Store assets for One-Click Spam & Delete."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "store-assets"
OUT.mkdir(exist_ok=True)

RED = (217, 48, 37)
RED_DARK = (176, 32, 24)
RED_LIGHT = (252, 232, 230)
WHITE = (255, 255, 255)
INK = (32, 33, 36)
GRAY = (95, 99, 104)
LINE = (218, 220, 224)
PALE = (248, 249, 250)
BLUE = (26, 115, 232)


def font(size, bold=False):
    paths = [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for path in paths:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default()


def text(draw, xy, value, size, color=INK, bold=False, anchor=None):
    draw.text(xy, value, font=font(size, bold), fill=color, anchor=anchor)


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_spam_icon(draw, cx, cy, radius, fill=RED, mark=WHITE):
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=fill)
    draw.rectangle((cx - 2, cy - 12, cx + 2, cy + 5), fill=mark)
    draw.ellipse((cx - 2.5, cy + 9, cx + 2.5, cy + 14), fill=mark)


def create_store_icon():
    src = Image.open(ROOT / "icons" / "icon128.png").convert("RGBA")
    canvas = Image.new("RGB", (128, 128), WHITE)
    canvas.paste(src, (0, 0), src)
    canvas.save(OUT / "store-icon-128.png")


def draw_gmail_shell(img, selected=(1, 3), show_control=True):
    draw = ImageDraw.Draw(img)
    w, h = img.size
    draw.rectangle((0, 0, w, h), fill=WHITE)
    draw.rectangle((0, 0, w, 64), fill=PALE)
    text(draw, (28, 32), "☰", 24, GRAY, anchor="lm")
    text(draw, (66, 32), "M", 28, RED, bold=True, anchor="lm")
    text(draw, (104, 32), "Gmail", 24, INK, anchor="lm")
    rounded(draw, (255, 10, 920, 54), 22, (234, 238, 246))
    text(draw, (290, 32), "Search mail", 17, GRAY, anchor="lm")
    text(draw, (1180, 32), "⚙", 22, GRAY, anchor="mm")

    draw.rectangle((0, 64, 248, h), fill=(246, 248, 252))
    rounded(draw, (18, 82, 170, 128), 16, (194, 231, 255))
    text(draw, (40, 105), "+  Compose", 16, INK, bold=True, anchor="lm")
    folders = [(154, "▣  Inbox"), (194, "☆  Starred"), (234, "◷  Snoozed"),
               (274, "➤  Sent"), (314, "▱  Drafts"), (354, "!  Spam"), (394, "▢  Trash")]
    for y, label in folders:
        if "Inbox" in label:
            rounded(draw, (8, y - 18, 235, y + 18), 16, (211, 227, 253))
        text(draw, (30, y), label, 15, INK, bold="Inbox" in label, anchor="lm")

    draw.rectangle((248, 64, w, 122), fill=WHITE)
    draw.line((248, 122, w, 122), fill=LINE, width=1)
    text(draw, (276, 93), "←", 25, GRAY, anchor="mm")
    if show_control:
        rounded(draw, (304, 72, 470, 114), 20, RED_LIGHT, outline=(241, 170, 164), width=1)
        draw_spam_icon(draw, 326, 93, 13, RED, WHITE)
        text(draw, (348, 93), "Spam & Delete", 15, RED_DARK, bold=True, anchor="lm")
    text(draw, (500, 93), "▣", 20, GRAY, anchor="mm")
    text(draw, (538, 93), "!", 21, GRAY, bold=True, anchor="mm")
    text(draw, (576, 93), "▢", 20, GRAY, anchor="mm")
    text(draw, (1160, 93), "1–8 of 8", 13, GRAY, anchor="rm")

    senders = ["Project Board", "Store Alerts", "Shipping Team", "Design Review", "Customer Support", "Weekly Report"]
    subjects = [
        "Your weekly task summary",
        "New account security notice",
        "Delivery exception needs review",
        "Updated images are ready",
        "Customer question about an order",
        "Operations report for Friday",
    ]
    snippets = ["View the items assigned to you", "Review this sign-in activity", "Open the shipment details",
                "Examine the latest asset set", "Reply from the support queue", "View the completed work"]
    for i in range(8):
        y0 = 122 + i * 48
        active = i in selected
        fill = (226, 236, 253) if active else WHITE
        draw.rectangle((248, y0, w, y0 + 48), fill=fill)
        draw.line((248, y0 + 47, w, y0 + 47), fill=(235, 237, 240))
        draw.rectangle((272, y0 + 16, 287, y0 + 31), outline=GRAY, width=1)
        if active:
            draw.line((274, y0 + 23, 279, y0 + 28), fill=BLUE, width=2)
            draw.line((279, y0 + 28, 286, y0 + 18), fill=BLUE, width=2)
        text(draw, (310, y0 + 24), "☆", 18, GRAY, anchor="lm")
        text(draw, (350, y0 + 24), senders[i % len(senders)], 15, INK, bold=active, anchor="lm")
        text(draw, (550, y0 + 24), subjects[i % len(subjects)], 15, INK, bold=active, anchor="lm")
        text(draw, (820, y0 + 24), "- " + snippets[i % len(snippets)], 14, GRAY, anchor="lm")
        text(draw, (1215, y0 + 24), f"Aug {21 - i}", 13, GRAY, anchor="rm")
    return draw


def create_screenshot_toolbar():
    img = Image.new("RGB", (1280, 800), WHITE)
    draw = draw_gmail_shell(img, selected=(1, 3), show_control=True)
    rounded(draw, (286, 530, 1195, 684), 18, WHITE, outline=LINE, width=2)
    text(draw, (330, 570), "One action for unwanted messages", 28, INK, bold=True)
    text(draw, (330, 615), "Select one or more messages, then use Spam & Delete.", 19, GRAY)
    draw_spam_icon(draw, 1105, 607, 35)
    img.save(OUT / "screenshot-1-toolbar.png")


def create_screenshot_settings():
    img = Image.new("RGB", (1280, 800), WHITE)
    draw = draw_gmail_shell(img, selected=(), show_control=True)
    rounded(draw, (700, 92, 1198, 730), 18, WHITE, outline=LINE, width=2)
    draw.rectangle((700, 92, 1198, 168), fill=RED)
    text(draw, (738, 128), "One-Click Spam & Delete", 23, WHITE, bold=True, anchor="lm")
    text(draw, (738, 151), "Settings", 14, (255, 220, 217), anchor="lm")
    text(draw, (738, 205), "BEHAVIOR", 12, GRAY, bold=True)
    settings = [
        (246, "Also move the message to Trash", True),
        (294, "Block the sender when Gmail asks", True),
        (342, "Ask before each action", False),
    ]
    for y, label, enabled in settings:
        rounded(draw, (738, y - 13, 770, y + 5), 9, RED if enabled else LINE)
        draw.ellipse((754 if enabled else 740, y - 11, 768 if enabled else 754, y + 3), fill=WHITE)
        text(draw, (790, y - 4), label, 15, INK, anchor="lm")
    text(draw, (738, 397), "PLACEMENT", 12, GRAY, bold=True)
    rounded(draw, (738, 420, 1158, 470), 10, RED_LIGHT, outline=(241, 170, 164))
    text(draw, (760, 445), "●  Gmail toolbar", 16, RED_DARK, bold=True, anchor="lm")
    rounded(draw, (738, 482, 1158, 532), 10, WHITE, outline=LINE)
    text(draw, (760, 507), "○  Floating button", 16, INK, anchor="lm")
    text(draw, (738, 575), "CONTROL STYLE", 12, GRAY, bold=True)
    for i, label in enumerate(["Gmail icon", "Emphasized", "Compact", "Floating"]):
        x = 738 + (i % 2) * 210
        y = 602 + (i // 2) * 56
        rounded(draw, (x, y, x + 190, y + 40), 9, RED_LIGHT if i == 0 else WHITE, outline=RED if i == 0 else LINE)
        text(draw, (x + 18, y + 20), label, 14, RED_DARK if i == 0 else INK, bold=i == 0, anchor="lm")
    img.save(OUT / "screenshot-2-settings.png")


def create_screenshot_safe_action():
    img = Image.new("RGB", (1280, 800), WHITE)
    draw = draw_gmail_shell(img, selected=(0,), show_control=True)
    rounded(draw, (770, 520, 1190, 584), 10, (48, 49, 52))
    text(draw, (794, 552), "Message reported as spam and moved to Trash", 15, WHITE, anchor="lm")
    text(draw, (1165, 552), "UNDO", 14, (138, 180, 248), bold=True, anchor="rm")
    rounded(draw, (292, 632, 1188, 724), 18, PALE, outline=LINE)
    text(draw, (330, 667), "Built-in safety", 23, INK, bold=True)
    text(draw, (330, 700), "The Delete step stops if Gmail opens a different conversation.", 17, GRAY)
    img.save(OUT / "screenshot-3-safety.png")


def create_small_promo():
    img = Image.new("RGB", (440, 280), RED)
    draw = ImageDraw.Draw(img)
    for y in range(280):
        t = y / 279
        color = tuple(int(RED[i] * (1 - t) + RED_DARK[i] * t) for i in range(3))
        draw.line((0, y, 440, y), fill=color)
    draw_spam_icon(draw, 220, 62, 34, WHITE, RED)
    text(draw, (220, 115), "Spam & Delete", 32, WHITE, bold=True, anchor="mm")
    text(draw, (220, 153), "One action in Gmail", 17, (255, 220, 217), anchor="mm")
    rounded(draw, (72, 188, 368, 230), 21, WHITE)
    text(draw, (220, 209), "Report spam  +  Move to Trash", 14, RED_DARK, bold=True, anchor="mm")
    text(draw, (220, 254), "No tracking · Local processing", 12, (255, 210, 206), anchor="mm")
    img.save(OUT / "small-promo-440x280.png")


def create_marquee():
    img = Image.new("RGB", (1400, 560), RED)
    draw = ImageDraw.Draw(img)
    for x in range(1400):
        t = x / 1399
        color = tuple(int(RED_DARK[i] * (1 - t) + RED[i] * t) for i in range(3))
        draw.line((x, 0, x, 560), fill=color)
    draw_spam_icon(draw, 158, 130, 48, WHITE, RED)
    text(draw, (235, 115), "One-Click", 50, WHITE, bold=True)
    text(draw, (100, 190), "Spam & Delete", 62, WHITE, bold=True)
    text(draw, (102, 275), "Remove unwanted Gmail messages", 26, (255, 220, 217))
    text(draw, (102, 316), "with one clear toolbar action.", 26, (255, 220, 217))
    rounded(draw, (100, 380, 520, 436), 28, WHITE)
    text(draw, (310, 408), "Private · Local · No tracking", 18, RED_DARK, bold=True, anchor="mm")

    rounded(draw, (720, 72, 1310, 488), 24, WHITE)
    text(draw, (770, 118), "Gmail", 24, INK, bold=True)
    draw.line((750, 150, 1280, 150), fill=LINE)
    text(draw, (780, 188), "←", 25, GRAY, anchor="mm")
    rounded(draw, (818, 164, 1032, 212), 24, RED_LIGHT, outline=(241, 170, 164))
    draw_spam_icon(draw, 844, 188, 14)
    text(draw, (870, 188), "Spam & Delete", 17, RED_DARK, bold=True, anchor="lm")
    text(draw, (1068, 188), "▣", 23, GRAY, anchor="mm")
    for i, sender in enumerate(["Store Alerts", "Shipping Team", "Customer Support", "Weekly Report"]):
        y = 250 + i * 54
        draw.rectangle((760, y - 17, 777, y), outline=GRAY)
        text(draw, (798, y - 8), "☆", 18, GRAY, anchor="lm")
        text(draw, (835, y - 8), sender, 16, INK, bold=i == 0, anchor="lm")
        text(draw, (1065, y - 8), "Message preview", 15, GRAY, anchor="lm")
        draw.line((760, y + 18, 1270, y + 18), fill=(235, 237, 240))
    img.save(OUT / "marquee-promo-1400x560.png")


if __name__ == "__main__":
    create_store_icon()
    create_screenshot_toolbar()
    create_screenshot_settings()
    create_screenshot_safe_action()
    create_small_promo()
    create_marquee()
    print(f"Created store assets in {OUT}")
