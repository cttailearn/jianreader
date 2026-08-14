# 生成应用图标源图 1024x1024：蓝色渐变圆角方块 + 白色文档 + 文本行
from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# --- 背景：圆角方块，垂直渐变 #5b96ff -> #2f6fed ---
radius = 200
top, bottom = (91, 155, 255), (47, 111, 237)
bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bd = ImageDraw.Draw(bg)
for y in range(S):
    t = y / (S - 1)
    c = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
    bd.line([(0, y), (S, y)], fill=c)
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
img.paste(bg, (0, 0), mask)

# --- 白色文档：圆角矩形 + 折角 ---
sheet = [290, 200, 734, 824]
d.rounded_rectangle(sheet, radius=40, fill=(255, 255, 255, 255))
# 右上折角
fold = 60
d.polygon(
    [(734 - fold, 200), (734, 200), (734, 200 + fold)],
    fill=(214, 228, 255, 255),
)
d.line(
    [(734 - fold, 200), (734 - fold, 200 + fold), (734, 200 + fold)],
    fill=(47, 111, 237, 255),
    width=10,
)

# --- 文本行（灰蓝色横条，首行粗代表标题） ---
line_color = (120, 150, 210, 255)
head_color = (47, 111, 237, 255)
d.rounded_rectangle([350, 320, 620, 372], radius=24, fill=head_color)
for i, (x1, x2) in enumerate(
    [(350, 670), (350, 610), (350, 670), (350, 560), (350, 670)]
):
    y = 430 + i * 78
    d.rounded_rectangle([x1, y, x2, y + 26], radius=13, fill=line_color)

img.save("app-icon.png")
print("saved app-icon.png", img.size)
