"""CrewSight briefing for RNZ athletes — navy / gold, 16:9."""

from __future__ import annotations

from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.util import Inches, Pt

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
OUT = HERE / "CrewSight-RNZ-Athletes.pptx"

NAVY = RGBColor(0x0A, 0x16, 0x28)
NAVY_DEEP = RGBColor(0x06, 0x10, 0x18)
NAVY_CARD = RGBColor(0x12, 0x24, 0x3A)
GOLD = RGBColor(0xD4, 0xAF, 0x37)
GOLD_SOFT = RGBColor(0xF4, 0xE4, 0xA6)
TEXT = RGBColor(0xF4, 0xF7, 0xFB)
MUTED = RGBColor(0xB8, 0xC5, 0xD6)
RED = RGBColor(0xDC, 0x26, 0x26)
AMBER = RGBColor(0xD9, 0x77, 0x06)
GREEN = RGBColor(0x16, 0xA3, 0x4A)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

W = Inches(13.333)
H = Inches(7.5)

LOGO = REPO / "assets" / "crewsight" / "crewsight-logo-full-color.png"
ICON = REPO / "assets" / "crewsight" / "crewsight-logo-icon-only-color.png"
RNZ = REPO / "apps" / "recorder-pwa" / "public" / "assets" / "rnz" / "rnz-logomark-white.png"


def _set_run(run, text, size=18, bold=False, color=TEXT, font="Calibri"):
    run.text = text
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.name = font


def _fill(shape, color):
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()


def _text_frame(shape, *, anchor=MSO_ANCHOR.TOP):
    tf = shape.text_frame
    tf.word_wrap = True
    tf.auto_size = None
    try:
        tf._txBody.bodyPr.set("anchor", {MSO_ANCHOR.TOP: "t", MSO_ANCHOR.MIDDLE: "ctr", MSO_ANCHOR.BOTTOM: "b"}[anchor])
    except Exception:
        pass
    return tf


def add_bg(s, color=NAVY):
    box = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, W, H)
    _fill(box, color)
    sp = box._element
    s.shapes._spTree.remove(sp)
    s.shapes._spTree.insert(2, sp)


def add_gold_rule(s, l, t, w=Inches(1.6), h=Inches(0.06)):
    bar = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, l, t, w, h)
    _fill(bar, GOLD)
    return bar


def add_dev_chip(s, l=Inches(0.5), t=Inches(0.28), w=Inches(5.4)):
    chip = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, l, t, w, Inches(0.34))
    _fill(chip, RGBColor(0x3F, 0x2E, 0x0A))
    chip.line.color.rgb = GOLD
    chip.line.width = Pt(1)
    tf = _text_frame(chip, anchor=MSO_ANCHOR.MIDDLE)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    _set_run(r, "UNDER DEVELOPMENT  ·  feedback welcome", 11, True, GOLD_SOFT)


def add_footer(s, page, total=13):
    bar = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, Inches(7.22), W, Inches(0.28))
    _fill(bar, NAVY_DEEP)
    box = s.shapes.add_textbox(Inches(0.45), Inches(7.22), Inches(10.2), Inches(0.28))
    tf = box.text_frame
    tf.word_wrap = False
    p = tf.paragraphs[0]
    r = p.add_run()
    _set_run(r, "CrewSight  ·  Rowing New Zealand  ·  still under development", 10, False, MUTED)
    num = s.shapes.add_textbox(Inches(11.4), Inches(7.22), Inches(1.5), Inches(0.28))
    tf = num.text_frame
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.RIGHT
    r = p.add_run()
    _set_run(r, f"{page}  /  {total}", 10, False, GOLD)


def add_heading(s, title, subtitle=None, top=Inches(0.72)):
    box = s.shapes.add_textbox(Inches(0.5), top, Inches(12.3), Inches(0.55))
    tf = box.text_frame
    p = tf.paragraphs[0]
    r = p.add_run()
    _set_run(r, title, 28, True, TEXT)
    add_gold_rule(s, Inches(0.5), top + Inches(0.52))
    if subtitle:
        sub = s.shapes.add_textbox(Inches(0.5), top + Inches(0.62), Inches(12.3), Inches(0.4))
        tf = sub.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        r = p.add_run()
        _set_run(r, subtitle, 15, False, MUTED)


def add_bullets(s, items, l, t, w, h, size=16, color=TEXT, spacing=10):
    box = s.shapes.add_textbox(l, t, w, h)
    tf = box.text_frame
    tf.word_wrap = True
    for i, item in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.level = 0
        p.space_after = Pt(spacing)
        r = p.add_run()
        _set_run(r, item, size, False, color)
    return box


def add_card(s, l, t, w, h, title, body, accent=GOLD):
    card = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, l, t, w, h)
    _fill(card, NAVY_CARD)
    card.line.color.rgb = RGBColor(0x2A, 0x3F, 0x58)
    card.line.width = Pt(1)
    stripe = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, l, t, Inches(0.08), h)
    _fill(stripe, accent)
    tb = s.shapes.add_textbox(l + Inches(0.28), t + Inches(0.18), w - Inches(0.4), Inches(0.4))
    tf = tb.text_frame
    p = tf.paragraphs[0]
    r = p.add_run()
    _set_run(r, title, 16, True, GOLD_SOFT)
    bb = s.shapes.add_textbox(l + Inches(0.28), t + Inches(0.58), w - Inches(0.4), h - Inches(0.72))
    tf = bb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    r = p.add_run()
    _set_run(r, body, 14, False, TEXT)


def fit_picture(s, path, l, t, max_w, max_h):
    from PIL import Image

    with Image.open(path) as im:
        iw, ih = im.size
    aspect = iw / float(ih)
    mw = max_w.inches
    mh = max_h.inches
    if aspect > (mw / mh):
        w = Inches(mw)
        h = Inches(mw / aspect)
    else:
        h = Inches(mh)
        w = Inches(mh * aspect)
    x = l + (max_w - w) / 2
    y = t + (max_h - h) / 2
    return s.shapes.add_picture(str(path), x, y, w, h)


def picture_frame(s, path, l, t, max_w, max_h):
    # thin gold-ish frame behind image
    pad = Inches(0.04)
    frame = s.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE, l - pad, t - pad, max_w + pad * 2, max_h + pad * 2
    )
    _fill(frame, RGBColor(0x1B, 0x2E, 0x44))
    frame.line.color.rgb = GOLD
    frame.line.width = Pt(1.25)
    return fit_picture(s, path, l, t, max_w, max_h)


# ---------------------------------------------------------------------------
# Slides
# ---------------------------------------------------------------------------

def slide_title(prs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_bg(s, NAVY_DEEP)
    accent = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, Inches(0.16), H)
    _fill(accent, GOLD)

    if LOGO.exists():
        s.shapes.add_picture(str(LOGO), Inches(0.7), Inches(1.15), Inches(2.15), Inches(2.15))
    if RNZ.exists():
        s.shapes.add_picture(str(RNZ), Inches(11.55), Inches(0.4), Inches(1.15), Inches(1.15))

    box = s.shapes.add_textbox(Inches(3.1), Inches(1.35), Inches(8.8), Inches(1.1))
    tf = box.text_frame
    p = tf.paragraphs[0]
    r = p.add_run()
    _set_run(r, "CrewSight", 48, True, TEXT)

    box = s.shapes.add_textbox(Inches(3.1), Inches(2.4), Inches(9.2), Inches(0.7))
    tf = box.text_frame
    p = tf.paragraphs[0]
    r = p.add_run()
    _set_run(r, "On-water briefing for RNZ athletes  ·  Lake Karapiro", 20, False, GOLD_SOFT)

    banner = s.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE, Inches(3.1), Inches(3.3), Inches(8.6), Inches(1.15)
    )
    _fill(banner, RGBColor(0x3F, 0x2E, 0x0A))
    banner.line.color.rgb = GOLD
    banner.line.width = Pt(1.25)
    tb = s.shapes.add_textbox(Inches(3.3), Inches(3.42), Inches(8.2), Inches(0.95))
    tf = tb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    r = p.add_run()
    _set_run(r, "This system is still under development.", 18, True, GOLD)
    p = tf.add_paragraph()
    r = p.add_run()
    _set_run(
        r,
        "Please use it, then tell your coach — or Tom / John — what to improve.",
        16,
        False,
        GOLD_SOFT,
    )

    add_bullets(
        s,
        [
            "Your phone records GPS, stroke rate, and capsize.",
            "Coaches watch the fleet on Manager and the RowSafe safety map.",
            "About 12 minutes. Ask anything as we go.",
        ],
        Inches(3.1),
        Inches(4.7),
        Inches(9.0),
        Inches(1.8),
        size=16,
        spacing=8,
    )
    add_footer(s, 1)


def slide_what(prs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_bg(s)
    add_dev_chip(s)
    add_heading(s, "What CrewSight is", "Three pieces. You mainly use the phone.")
    cards = [
        (
            "1. Your phone — CrewSight",
            "Android app on the boat. Records GPS, stroke rate, optional heart rate, and watches for a capsize. Keeps going if you lock the screen or switch apps.",
            GOLD,
        ),
        (
            "2. Manager — coaches",
            "The coach tablet / phone. Live fleet, who is on the water, and capsize alerts. You do not need to open this.",
            RGBColor(0x3B, 0x82, 0xF6),
        ),
        (
            "3. RowSafe — live safety map",
            "The lake safety map used on the water. Same positions and the same sticky capsize alert your phone sends.",
            GREEN,
        ),
    ]
    for i, (title, body, accent) in enumerate(cards):
        add_card(s, Inches(0.5 + i * 4.2), Inches(2.15), Inches(4.0), Inches(3.6), title, body, accent)
    add_footer(s, 2)


def slide_setup(prs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_bg(s)
    add_dev_chip(s)
    add_heading(s, "Set it up once", "Android phone. A coach can walk you through this in a few minutes.")
    add_bullets(
        s,
        [
            "1.  Install CrewSight.apk — scan the QR or use the link your coach sends. Not on the Play Store yet; tap Install anyway if Android warns.",
            "2.  Open the app. Settings → Password (ingest token). For RNZ that is typically  rnz",
            "3.  Pick your boat / name so coaches can see who you are.",
            "4.  Work through the permission prompts (next slide).",
            "5.  Tap Start session before you leave the pontoon — or use Standby and it can start when you leave the boat park.",
        ],
        Inches(0.5),
        Inches(2.05),
        Inches(7.3),
        Inches(4.6),
        size=16,
        spacing=12,
    )
    img = HERE / "install-page.png"
    if img.exists():
        picture_frame(s, img, Inches(8.15), Inches(2.05), Inches(4.6), Inches(4.7))
    add_footer(s, 3)


def slide_permissions(prs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_bg(s)
    add_dev_chip(s)
    add_heading(
        s,
        "Permissions & background",
        "These keep recording and capsize alerts alive when the phone is in a pocket.",
    )
    items = [
        ("Location — Allow all the time", "GPS must keep running with the screen off. “While using” is not enough."),
        ("Notifications — Allow", "You get a persistent recording notice, and a loud capsize alert if the boat tips."),
        ("Battery — Unrestricted", "Samsung / Android settings → Apps → CrewSight → Battery → Unrestricted."),
        ("Background data — on", "So positions can upload on Spark even when the app is not in front."),
    ]
    for i, (title, body) in enumerate(items):
        col = i % 2
        row = i // 2
        add_card(
            s,
            Inches(0.5 + col * 6.4),
            Inches(2.1 + row * 1.85),
            Inches(6.15),
            Inches(1.7),
            title,
            body,
        )
    note = s.shapes.add_textbox(Inches(0.5), Inches(5.9), Inches(12.3), Inches(1.05))
    tf = note.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    r = p.add_run()
    _set_run(r, "While you row you will see a CrewSight notification. Leave it there. ", 16, True, GOLD_SOFT)
    r = p.add_run()
    _set_run(
        r,
        "You can switch to music or messages — recording continues. Do not swipe the app away from Recents, and do not swipe away that notification.",
        16,
        False,
        TEXT,
    )
    add_footer(s, 4)


def slide_shot(prs, page, title, subtitle, bullets, image_name):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_bg(s)
    add_dev_chip(s)
    add_heading(s, title, subtitle, top=Inches(0.68))
    add_bullets(s, bullets, Inches(0.5), Inches(1.85), Inches(12.3), Inches(0.85), size=15, spacing=4)
    img = HERE / image_name
    if img.exists():
        picture_frame(s, img, Inches(0.55), Inches(2.75), Inches(12.2), Inches(4.25))
    add_footer(s, page)


def slide_on_water(prs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_bg(s)
    add_dev_chip(s)
    add_heading(s, "Using it on the water", "Start it, then let it run. The phone can stay in a pocket or under the slides.")
    left = [
        ("Before you go", "Start session (or leave Standby on). Check the green / gold flow-pattern chip once you are moving."),
        ("During the outing", "Landscape: Metrics · Graph · Map. Pace, time, distance, stroke rate, optional HR. Map shows lanes and hazards."),
        ("When you finish", "Tap Stop. If Standby / boat-park auto-stop is on, coming back into the park can stop it for you."),
    ]
    for i, (title, body) in enumerate(left):
        add_card(s, Inches(0.5), Inches(2.1 + i * 1.5), Inches(7.4), Inches(1.38), title, body)
    add_card(
        s,
        Inches(8.1),
        Inches(2.1),
        Inches(4.7),
        Inches(4.4),
        "Do not",
        "Force-stop CrewSight.\n\n"
        "Swipe it away from Recents.\n\n"
        "Dismiss the recording notification.\n\n"
        "Turn on battery saver for this app.\n\n"
        "Those are the usual reasons GPS or capsize goes quiet.",
        RED,
    )
    add_footer(s, 8)


def slide_capsize_phone(prs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_bg(s)
    add_dev_chip(s)
    add_heading(s, "If the boat capsizes — on your phone", "The phone is already telling RowSafe. Your job is the crew.")

    phone = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.5), Inches(2.1), Inches(5.7), Inches(4.7))
    _fill(phone, NAVY_CARD)
    phone.line.color.rgb = RED
    phone.line.width = Pt(1.75)

    tb = s.shapes.add_textbox(Inches(0.75), Inches(2.25), Inches(5.2), Inches(4.4))
    tf = tb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    r = p.add_run()
    _set_run(r, "On-screen banner", 13, True, MUTED)
    p = tf.add_paragraph()
    r = p.add_run()
    _set_run(r, "⚠  CAPSIZE — boat tipped. Check crew now.", 18, True, RGBColor(0xFE, 0xCA, 0xCA))
    p = tf.add_paragraph()
    p.space_before = Pt(16)
    r = p.add_run()
    _set_run(r, "Phone notification", 13, True, MUTED)
    p = tf.add_paragraph()
    r = p.add_run()
    _set_run(r, "CAPSIZE ALERT", 20, True, WHITE)
    p = tf.add_paragraph()
    r = p.add_run()
    _set_run(r, "Boat tipped past horizontal — check crew immediately", 15, False, GOLD_SOFT)
    p = tf.add_paragraph()
    p.space_before = Pt(16)
    r = p.add_run()
    _set_run(
        r,
        "Sound + vibration, including screen-off. If you are still tipped, it can re-alert. When the boat is upright again the phone notice can clear — the safety map does not.",
        14,
        False,
        TEXT,
    )

    add_card(
        s,
        Inches(6.5),
        Inches(2.1),
        Inches(6.3),
        Inches(2.15),
        "What you do",
        "Look after the crew first. You do not need to find an Acknowledge button on the phone. The alert is already on RowSafe for coaches and safety.",
        RED,
    )
    add_card(
        s,
        Inches(6.5),
        Inches(4.45),
        Inches(6.3),
        Inches(2.35),
        "If you recover, or the phone goes under",
        "RowSafe and Manager keep the CAPSIZE until a coach taps Acknowledge — even if you right the boat or the phone goes offline. That is deliberate.",
        AMBER,
    )
    add_footer(s, 9)


def slide_capsize_rowsafe(prs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_bg(s)
    add_dev_chip(s)
    add_heading(
        s,
        "If the boat capsizes — on RowSafe",
        "Same sticky alert on the coach Manager. Stays until someone takes it.",
    )
    add_bullets(
        s,
        [
            "Red banner: “CAPSIZE — check crew now. Tap Acknowledge when help is on the way.”",
            "The boat stays highlighted on the map. Acknowledge can send you “Help is on the way.”",
        ],
        Inches(0.5),
        Inches(1.85),
        Inches(12.3),
        Inches(0.7),
        size=15,
        spacing=4,
    )
    img = HERE / "manager-live.png"
    if img.exists():
        picture_frame(s, img, Inches(0.55), Inches(2.6), Inches(12.2), Inches(4.4))
    add_footer(s, 10)


def slide_coaches(prs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_bg(s)
    add_dev_chip(s)
    add_heading(s, "What coaches see (briefly)", "You do not need this app. Useful so the map is not a mystery.")
    cards = [
        ("Live fleet", "Who is on the water, roughly where, pace and stroke rate updating every few seconds."),
        ("Your name / boat", "That is why the password and boat pick matter. Wrong boat = wrong label on the safety map."),
        ("Capsize + help", "They get the sticky alert. Acknowledge tells the system — and can tell you — that help is coming."),
    ]
    for i, (title, body) in enumerate(cards):
        add_card(s, Inches(0.5 + i * 4.2), Inches(2.2), Inches(4.0), Inches(3.5), title, body)
    add_footer(s, 11)


def slide_data(prs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_bg(s)
    add_dev_chip(s)
    add_heading(s, "Data on the lake — keep it simple", "This is not a lot of data. A few settings make it reliable.")
    cards = [
        (
            "Turn Wi‑Fi off on the water",
            "Lakeside Wi‑Fi is patchy. The phone will waste time hunting for it. Use mobile data (Spark is fine).",
            GOLD,
        ),
        (
            "About every 3 seconds",
            "The phone sends a position every few seconds. Coaches see you move in near real time — not a live video.",
            RGBColor(0x3B, 0x82, 0xF6),
        ),
        (
            "Gaps are OK",
            "If you go through a dead patch, CrewSight queues and sends when it can. You do not need to babysit the upload.",
            GREEN,
        ),
    ]
    for i, (title, body, accent) in enumerate(cards):
        add_card(s, Inches(0.5 + i * 4.2), Inches(2.2), Inches(4.0), Inches(3.5), title, body, accent)
    add_footer(s, 12)


def slide_feedback(prs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_bg(s, NAVY_DEEP)
    accent = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, Inches(0.16), H)
    _fill(accent, GOLD)
    if ICON.exists():
        s.shapes.add_picture(str(ICON), Inches(0.7), Inches(0.85), Inches(1.05), Inches(1.05))

    box = s.shapes.add_textbox(Inches(1.95), Inches(0.95), Inches(10.5), Inches(0.7))
    tf = box.text_frame
    p = tf.paragraphs[0]
    r = p.add_run()
    _set_run(r, "Still developing — please tell us", 32, True, TEXT)
    add_gold_rule(s, Inches(1.95), Inches(1.7))

    banner = s.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.7), Inches(2.15), Inches(11.9), Inches(1.35)
    )
    _fill(banner, RGBColor(0x3F, 0x2E, 0x0A))
    banner.line.color.rgb = GOLD
    tb = s.shapes.add_textbox(Inches(0.95), Inches(2.3), Inches(11.4), Inches(1.1))
    tf = tb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    r = p.add_run()
    _set_run(
        r,
        "CrewSight is not finished. Your on-water notes are how we make it better for RNZ.",
        18,
        True,
        GOLD_SOFT,
    )
    p = tf.add_paragraph()
    r = p.add_run()
    _set_run(
        r,
        "Talk to your coach, or RNZ staff — Tom or John. No form to fill in.",
        17,
        False,
        TEXT,
    )

    add_card(
        s,
        Inches(0.7),
        Inches(3.75),
        Inches(5.75),
        Inches(2.85),
        "Useful to mention",
        "Did recording stay on in the pocket? Any false capsize? Was the flow-pattern chip right? Battery drain? Anything confusing on the phone.",
    )
    add_card(
        s,
        Inches(6.7),
        Inches(3.75),
        Inches(5.9),
        Inches(2.85),
        "Thank you",
        "Use it like a seat-belt for the outing: start it, grant the permissions, leave the notification alone, and row. We’ll keep tightening the rest.",
        GOLD,
    )
    add_footer(s, 13)


def main():
    prs = Presentation()
    prs.slide_width = W
    prs.slide_height = H

    slide_title(prs)
    slide_what(prs)
    slide_setup(prs)
    slide_permissions(prs)
    slide_shot(
        prs,
        5,
        "On the water — Metrics",
        "Landscape, phone on its side. This is the main screen while you row.",
        [
            "Big number is pace / 500 m (short average). Time, distance, stroke rate, optional heart rate underneath.",
            "The smaller % is pace versus prognostic. Training often sits in the 60–90% band — not a race max.",
        ],
        "metrics-landscape.png",
    )
    slide_shot(
        prs,
        6,
        "On the water — Graph",
        "Same outing, speed over the last few minutes.",
        [
            "Use it between pieces or if you want to see whether pace is holding.",
            "Coloured bands are prognostic (60–90% is typical training). Flow-pattern chip stays top-right.",
        ],
        "graph-landscape.png",
    )
    slide_shot(
        prs,
        7,
        "On the water — Map, flow pattern, hazards",
        "Karapiro lanes and hazard zones on the phone. Follow keeps the map on you.",
        [
            "Green chip = correct flow pattern (right lane for your heading). Off / wrong / no-go are the other states.",
            "Amber “Hazard zone” is an on-screen warning — pylons, dam, bridge, weather buoy — not a capsize.",
        ],
        "map-landscape.png",
    )
    slide_on_water(prs)
    slide_capsize_phone(prs)
    slide_capsize_rowsafe(prs)
    slide_coaches(prs)
    slide_data(prs)
    slide_feedback(prs)

    prs.save(OUT)
    print(f"Wrote {OUT}  ({OUT.stat().st_size // 1024} KB)  slides={len(prs.slides)}")


if __name__ == "__main__":
    main()
