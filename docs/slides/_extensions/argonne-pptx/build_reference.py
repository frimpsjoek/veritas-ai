"""Build reference-light.pptx and reference-dark.pptx for `format: argonne-pptx` from pandoc's default
reference.pptx: 16:9, IBM Plex Sans, Argonne colours, logos and a date/number line on the slide master.

    uvx --from python-pptx python build_reference.py        # run inside this folder

pandoc keeps the layouts and theme of the reference document and fills its placeholders, so everything
set here on the master and layouts carries into every exported deck.
"""
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.oxml.ns import qn
from pptx.oxml.shapes.picture import CT_Picture
from pptx.util import Emu, Inches, Pt

HERE = Path(__file__).resolve().parent
BASE = HERE / "reference-base.pptx"
LOGOS = HERE.parent / "argonne" / "logos"
LOGO_DARK_TEXT = HERE.parent / "argonne-light" / "logos" / "argonne_logo_dark.svg"

THEMES = {
    "light": dict(bg=RGBColor(0xFF, 0xFF, 0xFF), fg=RGBColor(0x1A, 0x1A, 0x1A), accent=RGBColor(0x00, 0x82, 0xCA),
                  logo=HERE / "argonne_logo_dark.png"),
    "dark": dict(bg=RGBColor(0x00, 0x00, 0x00), fg=RGBColor(0xFF, 0xFF, 0xFF), accent=RGBColor(0xF5, 0xCB, 0xA7),
                 logo=HERE / "argonne_logo_white.png"),
}
FONT = "IBM Plex Sans"


def set_background(part, rgb):
    """Solid background on a master or layout (python-pptx has no high-level API for masters)."""
    cSld = part._element.find(qn("p:cSld"))
    bg = cSld.find(qn("p:bg"))
    if bg is not None:
        cSld.remove(bg)
    bg = cSld.makeelement(qn("p:bg"), {})
    bgPr = bg.makeelement(qn("p:bgPr"), {})
    solid = bgPr.makeelement(qn("a:solidFill"), {})
    clr = solid.makeelement(qn("a:srgbClr"), {"val": str(rgb)})
    solid.append(clr)
    bgPr.append(solid)
    bgPr.append(bgPr.makeelement(qn("a:effectLst"), {}))
    bg.append(bgPr)
    cSld.insert(0, bg)


def style_placeholders(shapes, fg, accent):
    for sh in shapes:
        if not sh.has_text_frame:
            continue
        is_title = sh.is_placeholder and sh.placeholder_format.type is not None and \
            "TITLE" in str(sh.placeholder_format.type)
        if sh.is_placeholder:
            ensure_lststyle(sh, fg, accent, is_title)
        for para in sh.text_frame.paragraphs:
            for run in para.runs:
                run.font.name = FONT
                run.font.color.rgb = accent if is_title else fg
                if is_title:
                    run.font.bold = True
            # default run properties for text pandoc will insert
            pPr = para._p.get_or_add_pPr()
            for tag in ("a:defRPr",):
                d = pPr.find(qn(tag))
                if d is None:
                    d = pPr.makeelement(qn(tag), {})
                    pPr.append(d)
                latin = d.find(qn("a:latin"))
                if latin is None:
                    latin = d.makeelement(qn("a:latin"), {})
                    d.append(latin)
                latin.set("typeface", FONT)
        # bodyPr-level list style: set font on lstStyle levels so pandoc runs inherit it
        txBody = sh.text_frame._txBody
        lst = txBody.find(qn("a:lstStyle"))
        if lst is not None:
            for lvl in lst:
                d = lvl.find(qn("a:defRPr"))
                if d is None:
                    d = lvl.makeelement(qn("a:defRPr"), {})
                    lvl.append(d)
                for old in d.findall(qn("a:solidFill")):
                    d.remove(old)
                fill = d.makeelement(qn("a:solidFill"), {})
                fill.append(fill.makeelement(qn("a:srgbClr"), {"val": str(accent if is_title else fg)}))
                d.insert(0, fill)
                latin = d.find(qn("a:latin"))
                if latin is None:
                    latin = d.makeelement(qn("a:latin"), {})
                    d.append(latin)
                latin.set("typeface", FONT)
                if is_title:
                    d.set("b", "1")


def fix_titles(shapes):
    """Two-line titles overflow upwards in pandoc's layouts (bottom-anchored, large font): anchor at the
    top, give the box room, 28 pt, shrink-on-overflow."""
    from pptx.enum.text import MSO_ANCHOR
    for sh in shapes:
        if not (sh.is_placeholder and sh.has_text_frame):
            continue
        if "TITLE" not in str(sh.placeholder_format.type) or "CENTER" in str(sh.placeholder_format.type):
            continue
        sh.top, sh.height = Inches(0.2), Inches(1.0)
        sh.left, sh.width = Inches(0.4), Inches(9.2)
        tf = sh.text_frame
        tf.vertical_anchor = MSO_ANCHOR.TOP
        tf.word_wrap = True
        bodyPr = tf._txBody.find(qn("a:bodyPr"))
        for old in bodyPr.findall(qn("a:normAutofit")) + bodyPr.findall(qn("a:spAutoFit")):
            bodyPr.remove(old)
        bodyPr.append(bodyPr.makeelement(qn("a:normAutofit"), {"fontScale": "90000"}))
        lst = tf._txBody.find(qn("a:lstStyle"))
        if lst is not None:
            for lvl in lst:
                d = lvl.find(qn("a:defRPr"))
                if d is not None:
                    d.set("sz", "2800")
        for para in tf.paragraphs:
            for run in para.runs:
                run.font.size = Pt(28)
    # body placeholders: start a little lower so they clear the title box
    for sh in shapes:
        if sh.is_placeholder and sh.has_text_frame and "BODY" in str(sh.placeholder_format.type) and sh.top is not None:
            if sh.top < Inches(1.3):
                delta = Inches(1.3) - sh.top
                sh.top = Inches(1.3)
                sh.height = max(sh.height - delta, Inches(2.5))


def ensure_lststyle(sh, fg, accent, is_title):
    """Create a:lstStyle/a:lvl1pPr/a:defRPr on a placeholder so pandoc's runs (which carry no formatting)
    inherit colour, font, size; body text gets shrink-on-overflow."""
    txBody = sh.text_frame._txBody
    bodyPr = txBody.find(qn("a:bodyPr"))
    lst = txBody.find(qn("a:lstStyle"))
    if lst is None:
        lst = txBody.makeelement(qn("a:lstStyle"), {})
        bodyPr.addnext(lst)
    sizes = {1: "2800"} if is_title else {1: "1600", 2: "1400", 3: "1200"}
    for lvl, sz in sizes.items():
        tag = qn(f"a:lvl{lvl}pPr")
        pPr = lst.find(tag)
        if pPr is None:
            pPr = lst.makeelement(tag, {})
            lst.append(pPr)
        d = pPr.find(qn("a:defRPr"))
        if d is None:
            d = pPr.makeelement(qn("a:defRPr"), {})
            pPr.append(d)
        d.set("sz", sz)
        if is_title:
            d.set("b", "1")
        for old in d.findall(qn("a:solidFill")):
            d.remove(old)
        fill = d.makeelement(qn("a:solidFill"), {})
        fill.append(fill.makeelement(qn("a:srgbClr"), {"val": str(accent if is_title else fg)}))
        d.insert(0, fill)
        latin = d.find(qn("a:latin"))
        if latin is None:
            latin = d.makeelement(qn("a:latin"), {})
            d.append(latin)
        latin.set("typeface", FONT)
    if not is_title:
        for old in bodyPr.findall(qn("a:normAutofit")) + bodyPr.findall(qn("a:spAutoFit")) + bodyPr.findall(qn("a:noAutofit")):
            bodyPr.remove(old)
        bodyPr.append(bodyPr.makeelement(qn("a:normAutofit"), {}))


def set_theme_fonts(prs):
    """Major/minor theme fonts -> IBM Plex Sans (covers every run without an explicit font)."""
    for rel in prs.slide_master.part.rels.values():
        if rel.reltype.endswith("/theme"):
            theme = rel.target_part
            from lxml import etree
            root = etree.fromstring(theme.blob)
            ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
            for tag in ("a:majorFont", "a:minorFont"):
                for latin in root.findall(f".//{tag}/a:latin", ns):
                    latin.set("typeface", FONT)
            theme._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def add_master_picture(master, path, left, top, height):
    """Insert a picture on the slide master (python-pptx MasterShapes has no add_picture)."""
    from PIL import Image
    with Image.open(path) as im:
        w, h = im.size
    width = int(height * w / h)
    image_part, rId = master.part.get_or_add_image_part(str(path))
    shape_id = max([int(s.shape_id) for s in master.shapes] + [1]) + 1
    pic = CT_Picture.new_pic(shape_id, path.stem, "", rId, left, top, width, height)
    master.shapes._spTree.insert_element_before(pic, "p:extLst")


def add_master_line(master, fg, y, x0, x1):
    from pptx.enum.shapes import MSO_CONNECTOR
    # masters have no add_connector either; draw a thin rectangle via XML
    from pptx.oxml.shapes.autoshape import CT_Shape
    shape_id = max([int(s.shape_id) for s in master.shapes] + [1]) + 1
    sp = CT_Shape.new_autoshape_sp(shape_id, "footer-line", "rect", x0, y, x1 - x0, Emu(19050))
    master.shapes._spTree.insert_element_before(sp, "p:extLst")
    spPr = sp.find(qn("p:spPr"))
    fill = spPr.makeelement(qn("a:solidFill"), {})
    fill.append(fill.makeelement(qn("a:srgbClr"), {"val": str(fg)}))
    spPr.append(fill)
    ln = spPr.makeelement(qn("a:ln"), {})
    ln.append(ln.makeelement(qn("a:noFill"), {}))
    spPr.append(ln)


def build(theme):
    cfg = THEMES[theme]
    prs = Presentation(str(BASE))
    # pandoc's reference is already 16:9 (10 x 5.625 in); keep its size and placeholder geometry
    master = prs.slide_master
    set_theme_fonts(prs)
    set_background(master, cfg["bg"])
    style_placeholders(master.shapes, cfg["fg"], cfg["accent"])
    for layout in master.slide_layouts:
        set_background(layout, cfg["bg"])
        style_placeholders(layout.shapes, cfg["fg"], cfg["accent"])
        fix_titles(layout.shapes)
    fix_titles(master.shapes)
    # footer: thin line, logos centred (slide is 10 x 5.625 in)
    add_master_line(master, cfg["fg"], Inches(5.12), Inches(0.4), Inches(8.6))
    add_master_picture(master, cfg["logo"], Inches(4.05), Inches(5.22), Inches(0.28))
    add_master_picture(master, HERE / "miccom_logo.png", Inches(5.55), Inches(5.24), Inches(0.24))
    out = HERE / f"reference-{theme}.pptx"
    prs.save(str(out))
    print("wrote", out)


if __name__ == "__main__":
    for t in THEMES:
        build(t)
