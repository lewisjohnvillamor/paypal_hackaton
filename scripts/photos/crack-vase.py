# Makes demo-photos/2-vase-cracked.jpg from the shop's own catalog photo: the same cylinder vase,
# flowers and setting, with a crack drawn down from the rim and reframed like a buyer's phone shot.
# The earlier generated photo (an empty drinking glass) did not look like the product sold.
# Usage: python3 scripts/photos/crack-vase.py public/assets/catalog-vase.jpg demo-photos/2-vase-cracked.jpg
import random, sys
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance
import numpy as np
random.seed(7)
src = Image.open(sys.argv[1]).convert("RGB")
W, H = src.size
crack = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(crack)
def path(x, y, steps, dy, wobble):
    pts = [(x, y)]
    for _ in range(steps):
        x += random.uniform(-wobble, wobble); y += dy * random.uniform(0.7, 1.3)
        pts.append((x, y))
    return pts
main = path(566, 716, 12, 27, 13)          # from the rim down the front of the glass
branches = [path(*main[3], 4, 16, 12), path(*main[7], 3, 18, 12)]
branches[0] = [(p[0] + i * 11, p[1]) for i, p in enumerate(branches[0])]
branches[1] = [(p[0] - i * 11, p[1]) for i, p in enumerate(branches[1])]
for pts, w in [(main, 3), *[(b, 2) for b in branches]]:
    d.line([(x + 1.5, y + 1) for x, y in pts], fill=(30, 38, 42, 190), width=w)   # shadow edge
    d.line(pts, fill=(250, 252, 255, 235), width=max(1, w - 1))                     # bright fracture
crack = crack.filter(ImageFilter.GaussianBlur(0.45))
img = Image.alpha_composite(src.convert("RGBA"), crack).convert("RGB")
# The buyer's own photo: closer framing, slightly tilted, warmer, a little phone noise.
img = img.rotate(-3, resample=Image.BICUBIC, center=(500, 900), fillcolor=(235, 235, 235))
img = img.crop((250, 330, 760, 1250)).resize((680, 1227), Image.LANCZOS)
img = ImageEnhance.Color(img).enhance(0.92)
arr = np.asarray(img).astype(np.float32)
arr[..., 0] *= 1.03; arr[..., 2] *= 0.96
arr += np.random.default_rng(3).normal(0, 3.0, arr.shape)
Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(sys.argv[2], quality=88)
