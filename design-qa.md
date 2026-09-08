# Design QA - A/B/C venue fixture map

- Source visual truth: `C:\Users\leadb\Downloads\_cgi-bin_mmwebwx-bin_webwxgetmsgimg__&MsgID=1375692281528341712&skey=@crypt_c8087f27_325bd37307729b3670359ab785106299&mmweb_appid=wx_webfilehelper.jpg`
- Source pixels: 1352 x 1634
- Installed desktop full screenshot: `C:\Users\leadb\AppData\Local\Temp\king-light-layout-qa.png` (2561 x 1601)
- Installed desktop focused screenshot: `C:\Users\leadb\AppData\Local\Temp\king-light-layout-focus-qa.png` (1127 x 1353)
- Desktop CSS viewport: 1707 x 1067 at 1.5 device scale
- State: installed `king-broadcast-control.exe`, Avolites Tiger Touch Pro page, live Patch loaded

## Full-view comparison evidence

The source plan and installed desktop screenshot were opened together at original detail. The desktop page preserves the existing graphite control-shell hierarchy while the left venue-plan panel reproduces the source's three visual groups: red circular A1-A25, green circular B1-B12, and blue rectangular C1-C12. The complete page remains within the native fullscreen viewport with no clipped controls.

## Focused region comparison evidence

The source plan and the focused installed venue-plan capture were opened together at original detail. All 49 markers follow the same north/middle/south row groupings and column relationships as the reference. A1, A2, A4, and A13 remain readable while also carrying distinct observation styling. The selection row and three-item legend fit without horizontal overflow.

## Findings

- No P1 or P2 visible fidelity issues remain in the venue-plan panel.
- The SVG floor outline intentionally keeps the product's existing dark venue-map treatment; fixture coordinates and group geometry, rather than the source raster's white drafting background, are the matched surfaces.
- The live Patch banner overlaps only the empty northwest service-room area and does not cover B1/A1/C1.

## Required fidelity surfaces

- Fonts and typography: passed; existing product typography retained and all A/B/C labels remain legible.
- Spacing and layout rhythm: passed; three fixture types remain separated and preserve reference row order.
- Colors and visual tokens: passed; A red, B green, and C blue group identity is visible without changing the surrounding graphite theme.
- Image quality and asset fidelity: passed; existing vector floor outline remains crisp at 1.5 device scale.
- Copy and content: passed; 25/12/12 counts, field observations, and the unbound-TitanId warning are visible.

## Comparison history

- Pass 1: previous A-only build was blocked before native capture.
- Pass 2: installed desktop build captured at 2561 x 1601 and focused at 1127 x 1353; source and both captures compared at original detail; no P1/P2 mismatch found.

final result: passed
