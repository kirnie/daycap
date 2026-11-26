"""Chrome Web Store listing images. Run: python3 store/generate.py"""
import sys
from PIL import Image, ImageDraw, ImageFont
import os
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
SS = 4  # supersampling
ORANGE, INK_DARK = (251, 84, 43, 255), (23, 22, 28, 255)
BG, INK, INK2 = (23, 22, 28, 255), (242, 241, 245, 255), (166, 162, 178, 255)
FONTS = {800: '/usr/share/fonts/abattis-cantarell-fonts/Cantarell-ExtraBold.otf', 400: '/usr/share/fonts/abattis-cantarell-fonts/Cantarell-Regular.otf'}

def glyph(d, cx, cy, R):
    """Clock glyph, proportions measured from icons/icon128.png."""
    d.ellipse([cx-R, cy-R, cx+R, cy+R], fill=ORANGE)
    w = 0.237*R; h = w/2
    top, right = cy-0.51*R, cx+0.58*R
    d.rectangle([cx-h, top, cx+h, cy+h], fill=INK_DARK)
    d.rectangle([cx-h, cy-h, right, cy+h], fill=INK_DARK)
    for x, y in ((cx, top), (right, cy), (cx, cy)):
        d.ellipse([x-h, y-h, x+h, y+h], fill=INK_DARK)

def canvas(w, h, bg):
    im = Image.new('RGBA', (w*SS, h*SS), bg); return im, ImageDraw.Draw(im)

def save(im, w, h, name, rgb=False):
    im = im.resize((w, h), Image.LANCZOS)
    if rgb: im = im.convert('RGB')
    im.save(f'{OUT}/{name}'); print(name, im.size, im.mode)

def font(px, wght):
    return ImageFont.truetype(FONTS[wght], px*SS)

# Store icon: 96px artwork inside 128 with 16px transparent padding
im, d = canvas(128, 128, (0, 0, 0, 0)); glyph(d, 64*SS, 64*SS, 48*SS)
save(im, 128, 128, 'store-icon-128.png')

def tile(w, h, R, title_px, sub_px, gap, name):
    im, d = canvas(w, h, BG)
    tf, sf = font(title_px, 800), font(sub_px, 400)
    title, sub = 'Daycap', 'Time per site. Daily limits.'
    tw = max(d.textlength(title, font=tf), d.textlength(sub, font=sf))
    total = 2*R*SS + gap*SS + tw
    x0 = (w*SS - total)/2; cy = h*SS/2
    glyph(d, x0 + R*SS, cy, R*SS)
    tx = x0 + 2*R*SS + gap*SS
    d.text((tx, cy - 0.12*title_px*SS), title, font=tf, fill=INK, anchor='ls')
    d.text((tx, cy + 0.62*sub_px*SS + 0.2*title_px*SS), sub, font=sf, fill=INK2, anchor='ls')
    save(im, w, h, name, rgb=True)

tile(440, 280, 58, 52, 19, 28, 'promo-small-440x280.png')
tile(1400, 560, 150, 132, 44, 72, 'promo-marquee-1400x560.png')
