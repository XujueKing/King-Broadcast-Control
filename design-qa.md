# Design QA - A1-A25 beam floor map

- Source visual truth: `C:\Users\leadb\Downloads\_cgi-bin_mmwebwx-bin_webwxgetmsgimg__&MsgID=1625640261098080533&skey=@crypt_c8087f27_325bd37307729b3670359ab785106299&mmweb_appid=wx_webfilehelper.jpg`
- Source pixels: 1330 x 1650
- Implementation screenshot: pending native desktop restart
- Intended viewport: 2559 x 1596 desktop window
- CSS size / density: pending native capture
- State: Avolites Tiger Touch Pro page, live Patch loaded

## Full-view comparison evidence

The source plan was opened at original resolution. The 25 red marker centres were measured from the source and converted to normalized percentages. The updated native desktop build has not been installed or restarted, so a rendered full-view comparison is not yet available.

## Focused region comparison evidence

Blocked with the same native-capture dependency. Source rows and code coordinates were checked for A1-A25 continuity, uniqueness, and row order; this is structural verification, not visual QA.

## Findings

- [P1] Native rendering has not yet been visually compared.
  - Location: Avolites page, left venue-plan panel.
  - Evidence: source is available, but the running installed desktop executable is still the previous build.
  - Impact: label size, overlap, and alignment against the floor outline remain unverified.
  - Fix: restart into the newly built desktop executable, capture the Avolites page at 2559 x 1596, compare it with the source, and correct any visible drift.

## Required fidelity surfaces

- Fonts and typography: blocked pending native capture.
- Spacing and layout rhythm: blocked pending native capture.
- Colors and visual tokens: existing dark application tokens retained; rendered result pending capture.
- Image quality and asset fidelity: existing vector floor outline retained; marker coordinates derive from the supplied raster source.
- Copy and content: A1-A25 labels and the unbound-TitanId warning are present in source and covered by tests.

## Comparison history

- Pass 1: source inspected and marker centres measured; native implementation capture unavailable before restart.

## Implementation checklist

- Restart the native desktop application into the new build.
- Open the Avolites page with the same Patch-loaded state.
- Capture and compare the full venue-plan panel.
- Fix any P1/P2 marker overlap or alignment drift.

final result: blocked
