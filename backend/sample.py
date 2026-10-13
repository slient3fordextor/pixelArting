from PIL import Image, ImageDraw

from .images import encode_image
from .models import Document, Frame, Layer, Point


def sample_document() -> Document:
    body = Image.new("RGBA", (64, 64))
    draw = ImageDraw.Draw(body)
    outline, teal, bright, skin = "#24343E", "#218F83", "#6DC7A8", "#F3C8A5"
    for box, color in [((20, 27, 43, 49), outline), ((23, 28, 40, 47), teal), ((23, 30, 28, 44), bright), ((16, 31, 22, 43), outline), ((17, 33, 20, 41), skin), ((41, 31, 47, 43), outline), ((43, 33, 45, 41), skin), ((22, 48, 29, 57), outline), ((34, 48, 41, 57), outline), ((19, 55, 29, 59), outline), ((34, 55, 44, 59), outline), ((21, 10, 43, 29), outline), ((24, 14, 40, 27), skin), ((19, 8, 44, 15), outline), ((21, 9, 42, 13), "#596379"), ((21, 14, 25, 21), "#596379"), ((39, 14, 43, 21), "#596379"), ((27, 20, 28, 22), outline), ((36, 20, 37, 22), outline), ((31, 25, 34, 26), "#C67C73"), ((23, 43, 40, 46), outline), ((30, 43, 33, 46), "#EAB96A")]:
        draw.rectangle(box, fill=color)
    gear = Image.new("RGBA", (64, 64))
    draw = ImageDraw.Draw(gear)
    for box, color in [((42, 8, 45, 54), outline), ((43, 10, 44, 52), "#D09B68"), ((39, 3, 48, 12), outline), ((41, 4, 46, 10), "#EAB96A"), ((42, 5, 45, 8), "#F8E4A5"), ((19, 28, 24, 40), outline), ((20, 29, 22, 38), "#C85F74")]:
        draw.rectangle(box, fill=color)
    return Document(name="森林旅者 · 示例", layers=[Layer(id="body", name="角色"), Layer(id="gear", name="装备")], frames=[Frame(id="frame_0", width=64, height=64, pixels={"body": encode_image(body), "gear": encode_image(gear)}, origin=Point(x=32, y=59), baselineY=59)], provenance={"kind": "sample", "licenseStatus": "original"})
