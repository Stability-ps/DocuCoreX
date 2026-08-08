// A genuine minimal PPTX (OOXML presentation package).
//
// The previous fixture was `encode("PK\x03\x04minimal-pptx-placeholder")` — the
// ZIP magic number followed by a literal string, which is not a ZIP archive at
// all. Nothing could open it, so the test that used it only ever passed where
// LibreOffice was absent and the assertion helper fell through to its
// "engine unavailable" branch. Once CI gained LibreOffice, soffice correctly
// refused the input, produced no output, and the test failed with
// CONVERSION_OUTPUT_MISSING.
//
// A presentation LibreOffice will actually open needs the full relationship
// chain, not just a slide: package -> presentation -> slideMaster -> slideLayout
// -> slide, plus a theme referenced by the master. Every part below exists
// because omitting it makes Impress reject the file, so this is close to the
// true floor rather than arbitrarily verbose.
import { createZip } from "@/lib/file-output";

const encoder = new TextEncoder();
const xml = (body: string) => encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`);

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const contentTypes = xml(
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
    `</Types>`,
);

const packageRels = xml(
  `<Relationships xmlns="${REL}">` +
    `<Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="ppt/presentation.xml"/>` +
    `</Relationships>`,
);

const presentation = xml(
  `<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>` +
    `<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>` +
    `</p:presentation>`,
);

const presentationRels = xml(
  `<Relationships xmlns="${REL}">` +
    `<Relationship Id="rId1" Type="${DOC_REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
    `<Relationship Id="rId2" Type="${DOC_REL}/slide" Target="slides/slide1.xml"/>` +
    `<Relationship Id="rId3" Type="${DOC_REL}/theme" Target="theme/theme1.xml"/>` +
    `</Relationships>`,
);

/** An empty shape tree — the structural minimum for any slide-like part. */
const emptySpTree =
  `<p:cSld><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
  `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `</p:spTree></p:cSld>`;

const slideMaster = xml(
  `<p:sldMaster xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">` +
    emptySpTree +
    `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
    `</p:sldMaster>`,
);

const slideMasterRels = xml(
  `<Relationships xmlns="${REL}">` +
    `<Relationship Id="rId1" Type="${DOC_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    `<Relationship Id="rId2" Type="${DOC_REL}/theme" Target="../theme/theme1.xml"/>` +
    `</Relationships>`,
);

const slideLayout = xml(
  `<p:sldLayout xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" type="blank" preserve="1">` +
    emptySpTree +
    `</p:sldLayout>`,
);

const slideLayoutRels = xml(
  `<Relationships xmlns="${REL}">` +
    `<Relationship Id="rId1" Type="${DOC_REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
    `</Relationships>`,
);

// One text box, so a converted PDF has something on the page to render.
const slide = xml(
  `<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">` +
    `<p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="838200" y="1600200"/><a:ext cx="7467600" cy="1143000"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:r><a:rPr lang="en-ZA" sz="2400" dirty="0"/><a:t>DocuCoreX fixture slide</a:t></a:r></a:p>` +
    `</p:txBody>` +
    `</p:sp>` +
    `</p:spTree></p:cSld>` +
    `</p:sld>`,
);

const slideRels = xml(
  `<Relationships xmlns="${REL}">` +
    `<Relationship Id="rId1" Type="${DOC_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    `</Relationships>`,
);

// Impress reads the master's colour/font/format scheme, so the theme has to be
// present and well-formed even though nothing here varies from the defaults.
const theme = xml(
  `<a:theme xmlns:a="${A}" name="Office">` +
    `<a:themeElements>` +
    `<a:clrScheme name="Office">` +
    `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
    `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>` +
    `<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>` +
    `<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>` +
    `<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>` +
    `<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>` +
    `</a:clrScheme>` +
    `<a:fontScheme name="Office">` +
    `<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
    `</a:fontScheme>` +
    `<a:fmtScheme name="Office">` +
    `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
    `<a:lnStyleLst>` +
    `<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
    `<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
    `<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
    `</a:lnStyleLst>` +
    `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
    `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
    `</a:fmtScheme>` +
    `</a:themeElements>` +
    `</a:theme>`,
);

/**
 * A real, openable .pptx. `[Content_Types].xml` is written first because the
 * OPC spec requires it to be the first part in the package.
 */
export function createMinimalPptx() {
  return createZip([
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "_rels/.rels", content: packageRels },
    { name: "ppt/presentation.xml", content: presentation },
    { name: "ppt/_rels/presentation.xml.rels", content: presentationRels },
    { name: "ppt/slideMasters/slideMaster1.xml", content: slideMaster },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", content: slideMasterRels },
    { name: "ppt/slideLayouts/slideLayout1.xml", content: slideLayout },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", content: slideLayoutRels },
    { name: "ppt/slides/slide1.xml", content: slide },
    { name: "ppt/slides/_rels/slide1.xml.rels", content: slideRels },
    { name: "ppt/theme/theme1.xml", content: theme },
  ]);
}
