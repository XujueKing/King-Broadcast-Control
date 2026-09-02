# KING CLUB 控制台设计验收

## 演出编排双监看方案（2026-09-01）

- Source visual truth: `C:\Users\leadb\.codex\generated_images\01a043c1-e7fa-76d3-9df3-b6012d79ca0e\exec-bd00c78b-5d8e-48b5-bed0-93ff6c069829.png`
- Implementation screenshot: `D:\WEB3_AI\KINGCLUB-Broadcast-Control\ui-prototype\artifacts\show-editor-option-3-tauri.png`
- Side-by-side comparison: `D:\WEB3_AI\KINGCLUB-Broadcast-Control\ui-prototype\artifacts\show-editor-option-3-comparison.png`
- Runtime: real `king-broadcast-control.exe` Tauri control window; no standalone browser preview was opened.
- Viewport: 1707 × 1067 CSS px at device scale factor 1.5; captured implementation is 2561 × 1601 px. Source is 1600 × 1000 px. The comparison normalizes both sides to 1600 × 1000 px.
- State: 演出编排 active; two Decks not loaded; PVW and PGM visible; a real cached video asset selected; `重复次数` selected; project saved; live output remains safety-locked.
- Full-view evidence: the comparison preserves the selected concept's compact header, asset rail, dual PVW/PGM monitors, Deck/crossfader status, property inspector, timeline toolbar, locked song waveform, V1/V2/image/text/light lanes, and professional graphite/cyan/mint KING CLUB styling.
- Focused evidence: the implementation screenshot keeps both monitor safe frames readable, exposes the mutually exclusive lighting owner, distinguishes source duration from timeline duration, and renders all seven timeline lanes without clipping persistent controls.
- Fonts and typography: existing Inter / Noto Sans SC / Microsoft YaHei stack preserves the dense bilingual workstation hierarchy; truncation is used for long real media names.
- Spacing and layout rhythm: final pass fills the timeline region with seven proportional lanes; the persistent bottom navigation remains visible and aligned with the existing desktop application.
- Colors and visual tokens: graphite surfaces, cool-gray dividers, cyan monitor labels, mint selection/safety states, blue Deck 2 status, and restrained red PGM border match the approved direction.
- Image quality and asset fidelity: existing full-resolution KING CLUB stage/laser assets and cached local video thumbnails are used. No browser placeholders, emoji, inline SVG stand-ins, or fake media frames were introduced.
- Copy and content: Chinese labels cover PVW/PGM, Deck state, Crossfader follow, lighting ownership, source in/out, timeline duration, short-video fill modes, track names, preload state, and output lock.
- Primary interactions tested through the Tauri WebView: bottom-nav entry, V1 clip drag to V2, editable source in/out and timeline duration, short-video repeat mode/count, explicit save, leaving the page, returning, and restoring the moved/trimmed clip from the song-specific project. Entering or editing did not issue playback, PGM Take, or Titan trigger actions.
- Runtime error evidence: no Vite error overlay was present; production web asset build completed successfully.

### Comparison history

1. First pass found two P2 visual issues: unused blank space below the timeline lanes and bright native scrollbars in the asset/inspector rails.
2. Fixes: converted the timeline to seven proportional grid rows and applied the app's dark scrollbar tokens to the editor scroll regions.
3. Post-fix evidence: `artifacts/show-editor-option-3-tauri.png` shows the timeline filling its allotted height and dark scrollbars. No actionable P0/P1/P2 findings remain.
4. Functional follow-up added the persistent show-project model and real clip drag/drop. The final Tauri capture shows the moved `Neon Stage` clip restored in V2 after navigating away and back; the inspector exposes numeric trim controls and delete without disturbing the approved layout.

### Follow-up polish

- P3: replace the deterministic waveform visualization with cached real song peaks when the show-runtime renderer consumes the project model.

final result: passed

## 基础控制台验收

- Source visual truth: the approved KING CLUB console reference captured during design review.
- Implementation screenshot: `D:\WEB3_AI\KINGCLUB-Broadcast-Control\ui-prototype\implementation-1528x828.png`
- Comparison surface: `http://127.0.0.1:4173/qa-comparison.html`
- Browser viewport / CSS viewport: 1528 × 828 px
- Source pixels: 1440 × 1024 px; implementation pixels: 1528 × 828 px; density normalization: both displayed at equal column width in the browser comparison surface.
- State: dark emerald Home console; Deck 1 playing; Deck 2 ready; 2号曲库 selected; green geometry video and purple lighting preset selected.
- Full-view comparison: source and implementation were rendered side-by-side. Both preserve the header / L / C1 / C2 / split-R / B composition, dark emerald hierarchy, T-shaped preview, dual decks, thumbnail selection, lighting presets, and six-item navigation.
- No actionable P0/P1/P2 findings remain.
- Fonts and typography: Inter + Noto Sans SC maintains the compact console hierarchy and readable bilingual labels.
- Spacing and layout rhythm: adaptive three-column grid preserves all persistent controls without horizontal viewport overflow at 1528 × 828.
- Colors and visual tokens: low-glare black/emerald palette, active green, muted text, and red blackout state match the source intent.
- Image quality and asset fidelity: supplied SVG logo and LED mask are used; three generated stage/video assets are sharp, consistently art-directed, and correctly cropped.
- Behavior: library switching, playlist selection, track selection/loading, Deck transport, crossfader, video selection, lighting selection, and bottom navigation active state were exercised.
- Browser console: zero errors.

## Qu-16 Mixer UI Design QA

- Reference: `C:\Users\leadb\Desktop\u=259078731,1938936980&fm=253&app=138&f=JPEG.jpg`
- Prototype capture: `artifacts/qu16-mixer-actual.png`
- Side-by-side comparison: `artifacts/qu16-reference-comparison.png`
- Verified state: bottom navigation `调音台`, Allen & Heath Qu-16 model package active.

## Visual checks

- Hardware hierarchy matches the reference: top brand rail, SuperStrip processing, central touchscreen, processing buttons, stereo meter, USB/monitor block, 16-channel fader bank, LR master, and Mix Select.
- Cyan enclosure lines, charcoal hardware surface, white Mute keys, green Select keys, pink active Mute state, blue channel labels and blue mix keys follow the supplied console.
- All 16 input strips remain visible without horizontal overflow at the production fullscreen viewport.
- The software surface intentionally fills the available control workspace instead of reproducing the reference photo's white studio background.

## Interaction checks

- Channel Select changes the active strip.
- Channel Mute toggles independently.
- Channel and LR faders accept live values.
- Mix Select changes the active bus.
- Desktop smoke test confirms 16 channel strips, 17 total faders, 8 mix keys, the model name, and driver-package status.
- Official reference-guide pages 21-23, 28-30, 67-68, 75 and 78 were reviewed together with the two-page V5.72.0 driver help. The model now states USB-B for 24x22 audio, Ethernet TCP port 51325 for control, one control client, and Active Sense timing.
- Rotary controls accept pointer/keyboard range input and mouse-wheel adjustment; Shift + wheel applies a five-step coarse adjustment.

## AP9372 front-panel fidelity iteration

- Source visual truth: `C:\Users\leadb\Desktop\u=259078731,1938936980&fm=253&app=138&f=JPEG.jpg` (1050 x 800 px) plus the annotated operational overview on AP9372 page 21 and the processing-panel reference on page 28.
- Implementation: `artifacts/qu16-mixer-actual.png` (1554 x 1356 physical px; 1036.36 x 904.60 CSS px at device scale 1.5).
- Full comparison: `artifacts/qu16-reference-comparison.png` (both surfaces normalized to 900 px height).
- Focused upper-panel comparison: `artifacts/qu16-upper-panel-comparison.png` (source and implementation upper control regions normalized to 430 px height).
- State: Qu-16 model active, CH1 selected, LR mix selected, Processing screen active.

### Comparison history

- Earlier P2: the processing blocks were arranged as unrelated horizontal cards and omitted TouchChannel, Fn/Copy/Paste/Reset, SoftKeys, channel Mix/Pan controls and Master Sel/PAFL. This changed the real console's operational hierarchy.
- Fix: regrouped Preamp over HPF, Gate over GEQ and Comp over Pan around the four-band PEQ; inserted TouchChannel to the left of the screen; placed screen function keys below it; restored Processing/Routing/Home/FX/Scenes/Setup, SoftKeys, per-channel Mix/Pan and Master Sel/PAFL in their manual positions.
- Post-fix evidence: the focused comparison now shows the same left-to-right processing order, cyan region boundaries, central screen, vertical screen-select strip, meter/monitor area and fader-control row as the reference.

### Required fidelity surfaces

- Typography: condensed small hardware labels remain readable at the production scale; long processing labels use short face captions and full accessible names/tooltips.
- Spacing/layout: all 16 channels, LR master and eight Mix keys remain visible with no horizontal overflow; upper hardware blocks follow the AP9372 grouping and separation rhythm.
- Colors/tokens: charcoal panel, cyan enclosure lines, white Mute, green Sel, grey PAFL, pink muted state and blue Mix keys match the reference semantics.
- Image/asset quality: the supplied real-console photograph and official manual diagrams are comparison sources only; the interactive surface uses real controls and the existing icon library, with no rasterized control-panel substitute.
- Copy/content: button captions and tooltips match AP9372 terminology; cabling labels remain USB-B Audio and Ethernet Control TCP 51325.
- Remaining P3: software labels are intentionally slightly larger and higher contrast than the photographed silk-screen text for dark-room touchscreen legibility.

## True-rotary and SuperStrip proportion correction

- User-reported P1: the earlier circular skin still wrapped native horizontal `input[type=range]` elements, so pointer interaction and control semantics did not match a rotary encoder. The PEQ also had only eight controls instead of the photographed 4 x 3 matrix, and button/text proportions drifted from the real panel.
- Source detail: `artifacts/qu16-superstrip-reference-crop.png`, cropped from the supplied Qu-16 photograph without redrawing controls.
- Implementation detail: `artifacts/qu16-superstrip-actual.png` at 439.04 x 244.46 CSS px (aspect 1.796 versus the manual panel's measured 1.820), device scale 1.5.
- Normalized focused evidence: `artifacts/qu16-superstrip-comparison.png`, both control regions normalized to 450 px height.
- Fix: replaced every skinned range with a focusable rotary control that maps pointer coordinates through `atan2` around the knob center over 360 degrees. Wheel, Shift-wheel and keyboard input remain available.
- Fix: rebuilt PEQ as LF/LM/HM/HF columns with Width/Freq/Gain rows (12 rotaries); restored the shared oval `In` key between LM/HM; resized USB/In keys; added the angled PEQ title, three-row labels, vertical band dividers, Gate/Comp threshold and In geometry, Pk/GR indicators, GEQ Fader Flip and the Pan LED arc/L-R order.
- Runtime evidence: focused capture contains 17 SuperStrip rotary controls and zero range inputs. Real CDP mouse movement from the knob's right edge to its bottom changed the value from 25 to 50; a wheel-up event changed 50 to 51.
- Post-fix assessment: control type, matrix count, label placement, section proportions, button geometry and divider rhythm now follow the supplied detail image. Remaining P3 is the slightly cleaner software antialiasing compared with the low-resolution product photograph.
- Follow-up user correction: standardized every SuperStrip rotary to the Gate control's 36 x 36 CSS px diameter; channel-strip, touchscreen and monitor controls retain their compact sizes. Pointer-angle and wheel QA still passes at the new diameter.
- Follow-up PEQ detail correction: the cyan `Parametric EQ` tab now hands off to the enclosure line at the tab's lower edge; the three band dividers only span the rotary matrix instead of entering the label/button footer; oval keys have a clean, unmarked face and the shared PEQ `In` key keeps a visible inset above the bottom frame. The focused comparison artifact was regenerated after these changes.
- User-reported P1 follow-up: the clipped PEQ tab still exposed the section's dark header fill to its right, Gate/GEQ lamps were non-interactive, generic button hover styling darkened oval keys, and the SuperStrip controls remained undersized for the operator's preferred production view.
- Fix: made the PEQ title cap float over a transparent console-bed area and began the black framed PEQ body at the cap's lower edge. Increased the SuperStrip rotary diameter from 36 to 40 CSS px (35 px in the compact-height mode) and raised processing labels by 1 CSS px without enlarging channel-strip, touchscreen, or monitor rotaries.
- Interaction-state fix: all oval function keys expose explicit control state, while only Gate `In` and GEQ `Fader Flip` render a centered 4 px lamp. Their off state is `rgb(20, 23, 25)` and their on state is red `rgb(228, 70, 77)`. Every oval shell remains the same grey-white surface in off/on/hover/pressed states; ordinary HPF/PEQ/Comp keys do not acquire a glow or selected fill.
- Manual verification: AP9372 pages 28 and 32-34 establish the SuperStrip grouping, Gate/Comp processing and GEQ Fader Flip behavior; page 37 defines Pan as LR main pan, disabled for FX/Mono Mix1-4, Stereo Mix5-10 send pan, and linked-pair Width. The right processing bank therefore uses equal Gate/Comp columns on top and an approximately 35/65 GEQ/Pan split below.
- Comp/Pan correction: Comp GR moved below its threshold knob and is a separate near-black/green indicator; clicking `Comp In` toggles that lamp in the current UI demo, ready to be replaced by live gain-reduction state. Pan is width-locked as a true 40 x 40 circle and now drives seven arc ticks (left 3, center, right 3) from the rotary value.
- Evidence: default/off-state focused capture and normalized comparison are `artifacts/qu16-superstrip-actual.png` and `artifacts/qu16-superstrip-comparison.png`; the clicked Gate/GEQ/Comp state is `artifacts/qu16-superstrip-lamps-on.png`. CDP QA confirms exact red Gate/GEQ lamps, an unchanged oval shell through hover and state changes, Comp GR off/on color changes, 7 Pan ticks selecting indices 0/3/6 at Home/center/End, Pan width greater than 1.5 x GEQ, a 40 x 40 Pan rotary, 17 total SuperStrip rotaries and zero range inputs.
- Post-fix assessment: the focused source/implementation comparison shows no clipped controls or actionable P0/P1/P2 drift for the requested lamp colors, ordinary button behavior, Comp GR placement, Pan geometry/semantics, or GEQ/Pan proportions. Remaining P3 is the intentionally sharper software rendering versus the low-resolution product photograph.

## Qu-16 Touch Screen fidelity and remote-control boundary

- Source visual truth: the supplied Qu-16 Touch Screen photographs, the original console crop in `artifacts/qu16-touchscreen-reference.png`, and AP9372 issue 10 pages 28 and 46.
- Implementation evidence: `artifacts/qu16-touchscreen-processing.png`; the normalized source/implementation comparison is `artifacts/qu16-touchscreen-comparison.png`; `artifacts/qu16-touchscreen-routing.png` verifies a second Screen Select page.
- Earlier P1: TouchChannel was modelled as an independent hardware column, the display shell did not preserve the photographed proportions, Fn/Copy/Paste/Reset and Screen Rotary were placed inside the LCD, and the six Screen Select keys were stretched into equal rows.
- Fix: TouchChannel now occupies the left 13.35% of the active LCD; the display shell is 62.64% of the SuperStrip bank width and 89.80% of its height; the LCD content ratio is 1.6733 (the 5:3 target is 1.6667); the physical control band is 21.87% of the screen shell; the 37 x 37 CSS px Screen Rotary and four physical edit controls sit below the LCD; the six Screen Select key gaps are 35/47/33/33/33 CSS px, preserving the photographed group break.
- Interaction evidence: all six Screen Select keys render distinct clickable pages with exactly one active lamp; PREAMP/GATE/PEQ/COMP each expose their own five-parameter local model; block-specific Copy/Paste/Reset, Routing Apply/Cancel and contextual Fn selections are exercised. Touch parameter boxes select the Screen Rotary target; a real CDP wheel event changed the focused value from 67 to 68 and changed the rendered frequency from `2.05kHz` to `2.19kHz`; Reset restores both the LCD and rotary to 67 / `2.05kHz`.
- Product boundary: the physical Qu-16 has a 5-inch 800 x 480 colour touchscreen. The official USB and Ethernet/MIDI interfaces expose audio and parameter messages, not the physical display framebuffer. This implementation is therefore a clickable parameter-state digital twin, not a pixel-stream mirror of the console LCD.
- Sync boundary: documented parameters are intended for later bidirectional MIDI/NRPN state sync over Ethernet TCP port 51325. Screen-page navigation and local Copy/Paste/Reset workflow must not be represented as remote physical-screen commands unless the protocol exposes them.
- Post-fix assessment: no actionable P0/P1/P2 issue remains in the requested Touch Screen hierarchy, proportions, physical-control placement, Screen Select layout, or local interaction. Remaining P3 is the sharper software antialiasing and representative graph contents compared with the low-resolution product photograph.

### Physical-key alignment, legibility and state correction

- User-reported P1: the Fn/Copy/Paste/Reset row sat too close to the lower frame, both cyan Screen Rotary rails were below the knob centre, physical labels were too small, global hover styling turned the hardware keys nearly black, and the active Screen Select lamp was not red.
- Layout fix: the physical control row now leaves 11.67 CSS px below the lowest key; the two-rail pair centre and 37 px rotary centre both measure y=354.323 CSS px. The compact-height rule preserves the same relationship without replacing the existing scale transform.
- Typography fix: FN/COPY/PASTE/RESET render at 7 px / weight 700 uppercase; PROCESSING/ROUTING/HOME/FX/SCENES/SETUP render at 6.5 px / weight 700 uppercase; the top TOUCH SCREEN label is 6 px uppercase. LCD parameter values, metadata and status text were also increased, and CH1/VOX1 were separated into readable rows.
- State fix: explicit physical-key selectors keep Fn `rgb(203,208,209)`, Copy `rgb(216,218,218)`, Paste/Reset `rgb(223,75,83)`, Screen Select green `rgb(43,149,116)` and grey `rgb(203,208,209)` unchanged through real mouse hover. Disabled Paste keeps its red hardware keycap.
- Lamp fix: each of the six Screen Select pages was clicked in CDP; exactly one active lamp remained and every active lamp resolved to red `rgb(228,70,77)`. This intentionally follows the operator's requested red state rather than the yellow-green appearance in the low-resolution source photo.
- Visual evidence: final default state is `artifacts/qu16-touchscreen-processing.png`; fixed Copy and Home hover states are `artifacts/qu16-touchscreen-processing-hover-copy.png` and `artifacts/qu16-touchscreen-processing-hover-home.png`; the refreshed normalized reference comparison is `artifacts/qu16-touchscreen-comparison.png`.
- Post-fix assessment: no actionable P0/P1/P2 issue remains for lower-row placement, rotary-rail centring, label legibility, hover surfaces, disabled Paste appearance, CH/VOX overlap or red Screen Select lamps.

### Screen Rotary size and centre-line correction

- User-reported P2: the 37 × 37 CSS px Screen Rotary was smaller than the 40 × 40 Parametric EQ encoders, and the lower row was aligned by its bottom edge. Runtime geometry placed the rotary centre at y=354.323 while the four adjacent key centres were y=362.823–363.323, a maximum 9 px vertical mismatch.
- Rejected iteration: the first correction moved Fn/Copy/Paste/Reset upward to the rotary. The operator correctly identified that this reversed the physical reference: it made the whole key row top-heavy instead of preserving the real key positions and moving only the rotary.
- Final fix: Fn/Copy/Paste/Reset no longer receive any vertical transform and retain 10.667–11.167 CSS px of lower-frame clearance. Only the Screen Rotary moves downward; it keeps the same 40 × 40 visible diameter and 11 px pointer length as Parametric EQ, while its cyan rail pair follows the rotary centre.
- Post-fix runtime evidence: Screen Rotary and Parametric EQ both measure exactly 40 × 40 CSS px. The complete FN/COPY/PASTE/RESET label-and-key groups resolve to y=359.323–359.823 CSS px and the Screen Rotary resolves to y=359.323, for a 0.5 px optical-centre spread. Both cyan rails resolve around that rotary centre. The physical key faces intentionally sit 4.5–5 px lower than the group centres because their labels remain above; the rotary keeps 5.167 CSS px lower-frame clearance without clipping.
- Regression rule: Touch Screen QA separately asserts the four fixed key-bottom gaps at 10–12 CSS px before comparing the four complete label-and-key group centres with the rotary centre. This prevents a future implementation from passing alignment by lifting the keys or by aligning only the key faces.
- Visual evidence: `artifacts/qu16-touchscreen-processing.png` and refreshed `artifacts/qu16-touchscreen-comparison.png`; the focused side-by-side comparison now shows the lower physical-key rhythm and rotary placement following the source photograph.
- Post-fix assessment: no actionable P0/P1/P2 issue remains for the requested rotary size, fixed key positions, rotary-only vertical alignment or rail alignment.

## Qu-16 main meter and engineer monitor correction

- Source visual truth: the supplied Qu-16 photograph, `artifacts/qu16-monitor-reference.png`, and the L/R meter / engineer-monitor callouts on AP9372 issue 10 page 21. Focused side-by-side evidence is `artifacts/qu16-monitor-comparison.png`; the implementation crop is `artifacts/qu16-monitor-actual.png`.
- Earlier P1: the panel contained one shared 18-bar meter with reversed `R/L` captions and a generic `Qu-Drive / Monitor` card. It omitted the second meter, shared scale, PAFL status, Talk key, ST3 input, phones jack and separate Alt Out level.
- Layout fix: the left column now uses independent L/R 12-segment stacks around the exact shared `Pk/+12/+6/0/-3/-6/-9/-12/-16/-20/-30/-40` scale. The meter block occupies 73% of the column and the separate Talk block about 23%. The right column is divided into 41% ST3/Qu-Drive, 36% Phones and 22% Alt Out, matching the photographed vertical structure.
- Hardware fix: ST3 is a non-button 3.5 mm port; Qu-Drive is a vertical USB-A socket with the USB icon above; the blue Phones region contains its own jack and level; Alt Out is isolated below. The obsolete generic Monitor rotary was removed. Phones and Alt Out are true 360-degree controls and both exactly match the 40 × 40 PEQ rotary; compact-height mode keeps all three at 35 × 35 without overflow.
- Interaction fix: a channel PAFL selection changes the main-meter source from LR to PAFL and lights the red PAFL indicator; pressing the same PAFL again restores LR. Talk is momentary by default and exposes the green `T` in the LCD status bar only while held. Both level rotaries respond independently to wheel, Shift-wheel and keyboard input.
- Precision pass: the unchanged 110 × 244.458 CSS px bank now uses 51 px / 55 px columns with a 4 px gap, matching the photographed slightly wider I/O/monitor strip. The Qu-16 badge spans the two-column cluster; the Phones steel-blue surface is desaturated; its icon moved to the jack's upper-right; the Qu-Drive socket gained a darker metal cavity and amber status lamp. Meter LEDs are short rectangular lamps rather than pills, while the central scale and PAFL silk-screen were enlarged just enough to remain readable at the production viewport.
- Alignment fix: explicit descendant typography prevents the workspace-wide 11 px `span` rule from leaking into the hardware silk-screen. Talk label/key, Phones jack, Phones and Alt Out share their intended optical centre lines; L/R headings align to their matching lamp columns; every scale row aligns to the corresponding LED row; and the PAFL lamp/text union is centred as one mark. The generic horizontal rotary guide is suppressed for both monitor knobs.
- Runtime evidence: `artifacts/qu16-monitor-detail-actual.png` captures the Qu-16 badge and full bank without the adjacent Processing keys. Automated QA verifies two ordered meter columns, 12 non-zero segments per side, exact scale text and font sizes, sub-pixel heading/LED and scale-row alignment, panel proportions, port order/non-button semantics, PAFL/Talk state transitions, two independent monitor rotaries, 40 px normal / 35 px compact parity with PEQ, no monitor-knob guide and no panel overflow.
- Post-fix assessment: refreshed `artifacts/qu16-monitor-comparison.png` shows no actionable P0/P1/P2 drift in the hardware order, column balance, cyan enclosure rhythm, Talk separation, port geometry or Phones/Alt Out hierarchy. Software silk-screen remains deliberately sharper than the low-resolution product photograph for operator legibility.

## Qu-16 lower fader surface and Mix Select fidelity

- Source visual truth: the supplied full-console photograph, AP9372 issue 10 pages 21-24, 34, 43-45, 61 and 66-67, plus the focused source/implementation comparison `artifacts/qu16-surface-comparison.png`.
- Layout fix: rebuilt the lower surface as four explicit hardware regions: the narrow Layer rail, sixteen equal channel strips, the independent LR Master strip and the nine-key Mix Select column. The bright cyan layer/name bands, dark scribble-strip windows, enclosure dividers and right-bank spacing now follow the physical Qu-16 instead of a generic browser mixer grid.
- Fader detail: each channel and Master uses a long black slot, dense major/minor ticks, the documented `+10/+5/0/-5/-10/-20/-30/-40/-∞` scale order, a compact metal cap with a white datum line and a separate channel-number foot. The surface remains contained at the production viewport and the 1366 × 820 / 1366 × 800 compact checks.
- Channel controls: every strip preserves the physical `Mute → Sel → PAFL → Pk/0/Sig → layer labels → fader` order. Mute is a global source state, PAFL selections are additive, signal lamps follow the selected source and the channel meters remain pre-fader/pre-mute in the local model.
- Layer mapping: Lower addresses CH1-CH16; Upper addresses ST1-ST3, FX1-FX4 Return, FX1-FX2 Send and Mix1-Mix10 masters exactly as the manual labels them. Custom is a remapping of existing entities rather than sixteen invented audio sources. Upper-layer master slots and the dedicated Master strip share one state object.
- Mix Select wiring: LR remains the independent Master selection while the right column contains exactly FX1, FX2, Mix1-Mix4, Mix5-6, Mix7-8 and Mix9-10. Selecting a mix swaps the sixteen faders to that bus's sends and the Master to that bus master; selecting the active mix returns to LR. Routing Assign/Pre-Fade and GEQ availability follow the selected-bus rules, including no GEQ on FX1/FX2.
- SoftKeys: the four rectangular keys are modelled as factory-default Mute Groups 1-4 and expose explicit group state. Master PAFL remains available while GEQ Fader Flip owns the sixteen channel faders.
- Automated evidence: `scripts/test-surface-function-qa.mjs` verifies lower/upper/custom mapping, all ten bus targets, shared master state, Mute/PAFL semantics, routing, GEQ, SoftKeys and geometry at 1707 × 1067, 1366 × 820 and 1366 × 800.
- Historical boundary at this visual-fidelity pass: the controls were still a local digital twin because NRPN control write/readback had not yet been implemented. The later lower-surface TCP control/readback pass below supersedes that boundary for fader/send, Mute and PAFL only.
- Post-fix assessment: the normalized comparison shows no actionable P0/P1/P2 drift in the requested strip order, surface proportions, fader size, scale density, layer bands, Master separation or Mix Select layout. Remaining P3 is the intentionally sharper text and higher contrast needed for touchscreen operation.

## Qu-16 SuperStrip typography, compact-layout and local-function pass

- Source visual truth: the supplied SuperStrip photograph, AP9372 issue 10 pages 28-37, and the normalized focused comparison `artifacts/qu16-superstrip-manual-comparison.png`.
- Typography/layout fix: every blue block title is optically centred; Preamp `Pk`, Gate/Comp `Thresh` and `GR`, PEQ `In`, band names and Pan `L/R` now have independent silk-screen metrics instead of inheriting the workspace-wide letter spacing. The PEQ columns share exact knob/label/band centre axes, and the 17 rotary controls remain equal circles.
- Compact-height fix: the previous 166 px upper-row allocation was smaller than the SuperStrip's actual contents and let them spill into the fader surface. At 820 px and 800 px view heights the upper row now reserves 254 px; all direct children remain inside the frame, Pan is not clipped, and all SuperStrip rotaries remain 35 x 35 CSS px.
- Geometry evidence: `scripts/test-superstrip-layout-qa.mjs` checks normal, 820 px and 800 px heights for containment, label/control intersections, PEQ centre axes, Panel Lamp typography, Preamp peak-lamp clearance, Gate/Comp threshold and GR clearance, Pan containment and exact rotary parity. The compact visual evidence is `artifacts/qu16-superstrip-compact-800.png`.
- Local-function wiring: Processing state is now stored separately for every selected channel. Preamp USB Select/Gain, HPF Freq/In, all 12 PEQ Width/Freq/Gain encoders plus PEQ In, Gate Threshold/In, Comp Threshold/In and Pan share one state model with the reconstructed LCD, so a change on either surface updates the other and survives channel changes.
- Manual semantics: HPF, PEQ, Gate and Comp use the documented parameter ranges; LR and stereo Mix5-10 enable Pan, while mono Mix1-4 disable it. GEQ Fader Flip now cycles normal → lower 16 bands (`31.5Hz–1kHz`) → upper 16 bands (`500Hz–16kHz`) with the documented four-band overlap. In either GEQ layer the 16 physical faders address their displayed 1/3-octave bands over ±12dB, each strip `Sel` lights at flat and resets its band to 0dB, and exiting restores the untouched channel/mix fader layer.
- GEQ evidence: `artifacts/qu16-mixer-geq-low.png` shows the lower frequency layer; `scripts/test-superstrip-function-qa.mjs` verifies the three-state cycle, both range endpoints, all 16 mapped faders, gain changes, `Sel` flat/reset behaviour and return to normal mode.
- Integration boundary: Processing controls and the reconstructed LCD deliberately remain `data-sync-mode="local-ui-only"`. The later lower-surface TCP control/readback pass does not broaden that scope to Preamp, HPF, PEQ, Gate, Comp, GEQ, Pan, Routing, Scenes or FX.

## Qu-16 full-width surface and lower-control readability pass

- User-reported P1: the lower channel, Master, SoftKey and Mix Select captions were too small for live operation, while their keycaps were visibly smaller than the physical keys already established in the upper console. The whole console also left avoidable unused width.
- Source/implementation evidence: the real lower-console crop and the current interactive surface are normalized together in `artifacts/qu16-surface-readability-comparison.png`. The previous narrow implementation is retained as `artifacts/qu16-surface-actual-readability-before.png`; the corrected focused capture is `artifacts/qu16-surface-actual-readability-after-v4.png`; the complete console is `artifacts/qu16-mixer-actual.png`.
- Width fix: the console is now centred at `calc(100% - 12px)` with a 1100 CSS px ceiling, preserving equal 6 px minimum side margins while expanding the production capture from the previous 890 px ceiling to 1024.36 CSS px in the current workspace.
- Hardware-size fix: lower Mute and SoftKey faces now measure 31×22 CSS px, Sel and Mix Select faces 29×20 CSS px, and PAFL faces 22×22 CSS px. The upper Gate oval remains 29×20 CSS px, so the lower surface now uses the same established hardware size family rather than a reduced miniature set.
- Typography fix: at normal height the lower surface resolves to 7.5 px control labels, 6.5 px signal labels, 7 px strip/scale/SoftKey/Mix Select labels and 8 px channel indices. The compact profile preserves the full keycap dimensions and retains 7/6/6.5/6.5/7 px minimums for the same text classes.
- Proportion safeguard: widening initially exposed a 2.01:1 stretched LCD content area. Raising the normal upper-panel share to 33% restores the measured LCD content to 302×182 CSS px (1.659:1), inside the Qu-16 5:3 tolerance, while preserving the 0.626 Touch Screen/SuperStrip width relationship.
- Responsive evidence: geometry and overflow assertions pass at 1707×1067 and 1366×1041/1040/980/900/841/840/821/820/800. The compact lower template now remains active through 1040px because the normal right rail needs its full content height; 1041px and 1040px are both explicit boundary gates. Captures `artifacts/qu16-surface-actual-readability-1041.png`, `artifacts/qu16-surface-actual-readability-1040.png`, `artifacts/qu16-surface-actual-readability-841.png`, `artifacts/qu16-surface-actual-readability-821-v3.png`, `artifacts/qu16-surface-actual-readability-820-v3.png` and `artifacts/qu16-surface-actual-readability-800-v3.png` show all sixteen channels, Master and the complete right rail without clipping.
- Interaction boundary: only layout and legibility changed. Mute, Sel, PAFL, layers, buses, GEQ Fader Flip, routing, SoftKeys and fader state continue to use the existing local digital-twin model.
- Post-fix assessment: no actionable P0/P1/P2 issue remains for the requested console width, symmetric side clearance, upper/lower key-size parity, control-label readability or compact-height containment. At compact heights, right-rail labels sit inside their full-size key faces to preserve both legibility and physical key geometry.

## Qu-16 full-screen operation-distance and live-meter pass

- Full-screen evidence: the complete interface was captured at a 1707×1067 CSS viewport with device scale 1.5, producing the operator's 2561×1601 physical-pixel surface in `artifacts/qu16-mixer-fullscreen-actual.png`. The physical Qu-16 source photograph and the implementation were inspected in the same comparison input.
- Spacing fix: the non-functional lower metal-board reserve is now `clamp(28px, 3.2vh, 36px)` at normal height, 10px through the compact profile and 4px at 800px and below, preserving the physical enclosure edge without leaving a large empty field.
- Control-size fix: PAFL faces are 24×24 CSS px normally and 23×23 CSS px in compact mode. Every lower oval/round-key centre indicator is 4×4 CSS px, matching the established upper-panel lamp family.
- Readability fix: the blue source-strip main/sub labels are 8.5/7 CSS px normally and 8/6.75 CSS px in compact mode, with a darker cyan surface, stronger white contrast and controlled text shadow. The full sixteen-channel bank, Master and right rail remain visible without horizontal clipping.
- Meter semantics: `Sig`, `0` and `Pk` now use cumulative official thresholds of `-48`, `-18` and `-3 dBFS`; therefore two or all three lamps may legitimately be on at once. The former static percentage generator and the selector bug that painted every lamp as lit were removed. Disconnected or stale frames turn all lamps off instead of falling back to an animated demo.
- Live path: the desktop runtime now negotiates Qu-16 TCP MIDI on port 51325, performs Get System State, tracks the returned MIDI channel, sends Active Sense and Meter On/Off, deframes fragmented SysEx, decodes 7-bitized 7Q8 meter values, maps input/master/monitor/RTA blocks, clears on stale/disconnect and reconnects. UI events are capped at 20 FPS so meters cannot starve fader interaction.
- Session hardening: stop/join/start is serialized behind one lifecycle lock and every worker receives a monotonic `sessionId`. Generation checks reject stale worker writes; React listener setup checks disposal both before and after async registration, filters by host/session and uses session-conditional cleanup so changing the Qu IP cannot leave an orphan connection or stop a newer one.
- Protocol correction: the 31-band `20Hz–20kHz` RTA is offset by two bins before addressing the 28-band `31.5Hz–16kHz` GEQ. GEQ mode reports the actual band dBFS through ARIA/data, lights only one dominant red Pk and never falls back to channel lamps. RackFX Post-PEQ values now feed all four FX Return strips; FX1/2 RackFX input meters carry a visible `FX IN` boundary because they equal an FX Send bus only under the factory same-name Mix→Return patch.
- Driver-probe fix: Windows ASIO registry checks launch `reg.exe` with `CREATE_NO_WINDOW`, serialize concurrent requests and cache the result for 30 seconds. A desktop smoke burst of eight concurrent driver-status requests completes without opening Windows Terminal.
- Automated evidence: the functional surface matrix verifies cumulative states at `-60/-48/-18/-3 dBFS`, stale/disconnected darkness, final geometry and all responsive boundaries. Rust protocol tests cover handshake, framing, decoding, mapping and reconnect-state helpers. Build, desktop smoke, Qu-16 controls, Sites regression and `git diff --check` are required to stay clean.
- Hardware boundary at this live-meter pass: no physical Qu-16 was connected. The later lower-surface pass adds bounded NRPN/Note write and readback handling, but it likewise remains unverified on a physical console.

## Qu-16 lower oval-key active-state correction

- Source visual truth: the user's focused oval-key report, the supplied console photograph at `C:/Users/leadb/Desktop/u=259078731,1938936980&fm=253&app=138&f=JPEG.jpg`, and the PAFL/Mix Select regions in AP9372 issue 10 pages 21-23. The source photograph is 1050x800 pixels.
- Earlier P1: selecting a right-bank Mix applied an active colour to the oval keycap and a legacy rule could also paint the transparent rectangular hit area. Channel and Master PAFL similarly changed the complete grey-white round key to a red glowing face instead of changing its centre indicator.
- Fix: the right-bank outer button is now permanently transparent with no border, background or shadow; its light-blue oval face retains exactly the same background, border and shadow in off/on/hover/pressed states. Only the 4x4 centre lamp changes to a luminous blue-white. PAFL keeps its grey-white circular face and only its 4x4 centre lamp changes to red. Keyboard focus is drawn around the inner oval/round face rather than the rectangular hit box.
- Implementation evidence: `artifacts/qu16-surface-actual-lamp-state-final.png` captures a selected right-bank Mix and an active channel PAFL at the production 1707x1067 CSS viewport. The clipped surface is 1009.03x571.16 CSS px and the saved image is 1514x857 pixels at device scale 1.5. The source photograph and this implementation were opened together in one comparison input; the complete surface remains the corresponding full-view context.
- Required fidelity surfaces: typography, copy, strip spacing and fader layout are unchanged; the state-token correction removes the unintended rectangular blue field while preserving the established light-blue keycap, grey-white PAFL cap and 4px hardware lamp size. No image asset, logo or icon was replaced in this correction.
- Automated evidence: `scripts/test-surface-function-qa.mjs` now uses real CDP pointer move/down/up events and compares computed off/hover/pressed/on styles. It fails if Mix Select or PAFL changes its outer hit area or keycap background, border, shadow or filter, while separately requiring the centre lamp colour and glow to change. It then repeats the existing 1041/1040/980/900/841/840/821/820/800px geometry matrix. The production build passes.
- Post-fix assessment: the focused active-state comparison shows no remaining P0/P1/P2 issue; the unwanted rectangular background and whole-button illumination are gone.

## Qu-16 lower-surface TCP control and readback pass

- Protocol source of truth: the locally archived official `Qu MIDI Protocol V1.9` and `Qu Mixer Reference Guide AP9372 issue 10`. The implemented allowlist is intentionally limited to source/master fader level, selected-mix send level, Mute and additive PAFL; arbitrary NRPN numbers, remote shutdown and undocumented writes cannot be represented by the UI command model.
- Runtime integration: writes use the existing TCP 51325 session and worker. The worker performs Get System State, waits for the matching-channel End Sync (`0x14`), then enables meters and accepts control writes. Fader motion is coalesced to approximately 26 Hz; Mute and PAFL are immediate. Active Sense is scheduled ahead of the bounded control drain.
- State authority: the UI may show an optimistic in-flight value, but a matching or conflicting console readback clears pending state and the hardware value wins. Rejected writes roll back to the last observed snapshot. Session id, connection epoch, generation and monotonic revision checks reject stale frames; reconnect clears parameters and pending writes and never replays commands from the previous connection.
- Surface semantics: LR uses fader writes; a non-LR Mix selection addresses send level; Master addresses the selected master fader. Mix Select itself remains a local UI routing context and emits no hardware write. Processing/LCD, Sel, layers, Routing, GEQ Fader Flip, SoftKeys and all other unsupported controls remain explicitly local-only.
- Automated evidence: 54 Rust library tests cover encoding, fragmented/running-status decoding, End Sync atomicity, NRPN observation, pending match/conflict, invalid/duplicate batch rejection, reconnect isolation and Active Sense fairness. Nine pure frontend protocol tests plus the CDP control harness cover canonical mapping, coalescing, immediate keys, optimistic/readback merge and rejected-write rollback. Production build, desktop runtime smoke, surface-function QA, existing Qu-16 visual/function matrices and `git diff --check` pass.
- Hardware boundary: this is protocol-, unit-, mock-runtime- and desktop-verified only. No physical Qu-16 was available, so actual console movement, lamp response, network timing and firmware compatibility must be confirmed during the next real-device acceptance pass.

## Qu-16 physical rail, lamp-colour and brand-header fidelity pass

- Source visual truth: the operator's four focused crops, the official Allen & Heath 2800 x 1867 Qu-16 product photograph, and AP9372 issue 10. A direct unscaled crop from the official photograph is stored as `src/assets/hardware/allen-heath-qu16/qu16-brandbar.png`; its source coordinates are documented under `docs/hardware/allen-heath-qu16/README.md`.
- Header correction: the previous software-drawn ALLEN & HEATH / Qu-16 marks and disconnected divider treatment were replaced by the continuous photographed hardware brand rail. The runtime-only USB-B / Ethernet / TCP wording no longer competes with the physical silk-screen.
- Layer correction: the left rail is now one printed hardware bank with only the two real Layer keys, their separate status lamps, the Custom silk-screen/status mark, the ST/FX/MIX and CH1-16 legends, and the GEQ 31/500 boundary. The cyan layer strips continue across the channel bank instead of reading as unrelated browser buttons.
- Master/right-bank correction: LR, SoftKeys and Mix Select now share the same printed enclosure rhythm and dividers as the photographed console. LR separates its label, physical lens and centre lamp; the Mix keys are grouped as FX1-2, Mix1-4 and stereo Mix5-10 with distinct icy-cyan, cyan and blue face colours.
- State/material correction: key faces retain their physical material through off, hover, pressed and active states. Only the centre or side indicator changes: SoftKey active is red, PAFL is amber, LR/Layer/Mix use their documented family colour, and Pk/0/Sig remain red/amber/green. The generic black-hover and whole-button-glow regressions are excluded by the surface interaction matrix.
- Compact correction: the revised wrapper structure keeps full-size physical keys and readable labels at the 1040 px breakpoint and below. The focused normal and compact captures are `artifacts/qu16-surface-actual.png` and `artifacts/qu16-surface-actual-compact-840.png`.
- Comparison evidence: `artifacts/qu16-hardware-fidelity-clean-final.png` places the official console and the current implementation in one clean same-state review; `artifacts/qu16-mixer-actual.png` is the final full-console capture. No actionable P0/P1 mismatch remains in the requested rail grouping, printed lines, key/lamp colour semantics or brand-header treatment. Remaining P2/P3 differences are photo-material depth and the deliberately sharper software text required for operator legibility.
- Automated evidence: the complete `test:qu16-controls` suite, the production build, desktop runtime smoke and the responsive surface geometry matrix pass. The local preview remains reachable at port 1420.
- Hardware boundary: no physical Qu-16 was connected during this visual pass. UI interactions, local protocol handling and desktop integration are verified; real Ethernet readback, console lamp response and firmware-specific timing still require the physical-device acceptance run.

## Qu-16 lower-key red centre-lamp correction

- Target definition: the physical keycap shapes/material families come from `artifacts/qu16-surface-reference.png` and AP9372 issue 10 pages 22-23, while the operator's explicit software rule overrides the photographed factory illumination behaviour: Mute, Sel, PAFL, LR and all Mix Select active states must preserve their resting keycap material and light only the centre indicator in red.
- Earlier P1: Mute changed the complete white-grey keycap to pink; Sel changed and glowed the complete green keycap; PAFL used an amber centre light; LR and Mix Select used white/blue centre lights. The prior QA only required the lamp to change and therefore could not reject the wrong active colour.
- Fix: channel and Master Mute/Sel/PAFL no longer have active keycap background, border or shadow overrides. Their common 4 px centre indicator uses `#d94f58` with the matching red halo. LR and all FX/mono/stereo Mix Select keys use the same centre-lamp token while retaining each family's blue/cyan keycap. The lamp transition was removed so the physical LED state is immediate instead of briefly passing through a muddy intermediate colour.
- Source/implementation dimensions: the reference image is 690 x 470 px. The rendered implementation clip is 1514 x 839 px for a 1009.03 x 559.16 CSS px surface at device scale 1.5 in the 1707 x 1067 desktop viewport. `artifacts/qu16-red-centre-lamps-comparison.png` normalizes both full surfaces to 700 px content height; `artifacts/qu16-red-centre-lamps-focused-comparison.png` is the focused upper-control comparison.
- Tested state: CH1 Mute, Sel and PAFL are active together; Mix 5-6 is the selected bus. `artifacts/qu16-surface-actual-red-centre-lamps.png` visibly confirms four unchanged keycap materials with red centre indicators, no whole-button fill change and no rectangular hover/active background.
- Interaction evidence: the surface QA now compares outer shell and keycap background, background image, border, shadow, filter, opacity and transform through off, hover, pointer-down, active, active-hover and active-pointer-down states. It explicitly requires red centre lamps for channel and Master Mute/Sel/PAFL and verifies all ten LR/FX/Mix targets, including every FX, mono and stereo keycap family.
- Regression evidence: the complete `test:qu16-controls` suite and production build pass. The responsive geometry matrix remains clean at 1707 x 1067 and 1366 px widths through 1041/1040/980/900/841/840/821/820/800 px heights.
- Final comparison: fonts/copy, strip spacing, printed dividers, key dimensions, family colours and supplied raster assets are unchanged. The only intended visual delta is the operator-defined red centre-lamp state. No actionable P0/P1/P2 issue remains; the official console's native illumination semantics are intentionally not reproduced for these specific software states.

## Qu-16 clean proportional brandbar and panel-offset pass

- Source visual truth: the official Allen & Heath 2800 x 1867 `Qu-16-Page.jpg` product photograph. The final source crop is `src/assets/hardware/allen-heath-qu16/qu16-brandbar-clean.png`, taken without scaling at `x=686, y=212, width=1407, height=70`.
- Earlier P1: the previous 1458 x 72 crop began and ended through the two chassis screws, so each end showed half a screw; its cyan artwork also had visibly unequal 12 px / 47 px horizontal insets. The fixed 38 px / 30 px `cover` rows then cropped the photograph again and kept the upper controls too close to the rail.
- Fix: the replacement crop excludes both screws and the lower control field, preserves the complete left plaque, dual cyan lines and right plaque, and resolves to equal 4 px cyan-art insets. The grid now derives the first row from the asset's 1407:70 ratio and displays it with `object-fit: contain`; the upper controls follow the full rail height. Lower non-functional metal reserve was reduced from 28-36 / 10 / 4 px to 18-26 / 4 / 2 px so the visible hardware controls move down without clipping the fader bank.
- Full-view implementation evidence: `artifacts/qu16-mixer-actual.png` is the running 1024.36 x 904.60 CSS px console at the 1707 x 1067 desktop viewport and device scale 1.5, saved as 1536 x 1356 pixels. It shows the complete console after the proportional rail and vertical-offset correction.
- Focused normalized evidence: `artifacts/qu16-brandbar-reference-actual-comparison.png` places the official crop and the running rail in one 1514 x 214 px comparison. Both rail rows are normalized to 1514 x 75 px; the running result preserves both complete plaque ends, contains no screw fragments, and aligns the dual cyan lines without horizontal stretch.
- Tested state: mixer view, Upper layer, LR selected, no pointer hover. Runtime geometry verifies the 1407 x 70 natural asset, `contain` fit, original aspect ratio within 1.5 CSS px, symmetric console insets, zero bright neutral screw pixels in the outer four pixel columns, balanced 4 px cyan insets, and non-overlap between the rail and SuperStrip.
- Required fidelity surfaces: typography/copy are the original photographed `ALLEN&HEATH` and `Qu-16` marks with no software text overlay; spacing follows the source crop and symmetric panel frame; source colours and double-line treatment are unchanged; image quality is the direct official raster crop rendered at device scale 1.5 without secondary cropping or distortion; no app-specific connection wording is added to the hardware rail.
- Responsive evidence: the surface interaction/geometry matrix passes at 1707 x 1067 and 1366 px widths through 1041/1040/980/900/841/840/821/820/800 px heights. The complete Qu-16 control suite, production build and desktop runtime smoke pass after the rail change.
- Post-fix assessment: the earlier screw fragments, unequal end crop, secondary cover crop and cramped vertical placement are resolved. No actionable P0/P1/P2 visual issue remains in the requested brandbar region.

final result: passed

## Deck source-category queue lock

- Reported regression: a track started from the L-region 周一 category advanced into the complete Music Management library instead of the next 周一 item.
- Corrected state model: each Deck now owns a playback source containing the originating library number and playlist ID. Changing the L-region library/category selection only changes the browsed view and does not mutate either Deck source.
- Queue behavior: sequence, shuffle, manual previous and manual next all resolve the originating category's current `trackPaths` order. A missing/deleted source or a category without another playable item stops instead of falling back to the complete library.
- Complete-library safety: loading a song from Music Management “全部歌曲” is single-track preparation and cannot establish an automatic complete-library queue.
- Automated evidence: the source-resolution test keeps a 1号曲库/周一 source on `monday-1.mp3 → monday-2.mp3` while a separate 周二 list exists. The runtime queue test verifies non-contiguous library indexes `126 → 169 → 729`, including wrap, exclusion and previous/next behavior. The focused test suite passes 19/19 and the production WebView build passes.
- Desktop safety evidence: no end-of-song playback was forced during verification. Both live mpv IPC endpoints for desktop process 15856 returned `pause=true` after the change.
- Cold-start correction: the desktop no longer initializes Deck indexes from complete-library positions 0/1. Each Deck now independently resolves the strictly first ordered row of today's named category in its matching library. A missing secondary-library song cannot block Deck 1, and a partial media scan cannot skip an unresolved first row and permanently select the second row. The resolver retries when the stable media index changes; an empty category leaves only that Deck empty and paused.
- Cold-start automated evidence: a two-library fixture resolves Deck 1 to `library-1-monday.mp3` and Deck 2 to `library-2-monday.mp3`. The focused suite now passes 20/20.
- Startup race correction: the startup resolver now publishes the selected media paths to the scanner's Deck-preservation ref before committing React state, so a concurrent/resumed scan cannot overwrite the default selection with `null`. The running desktop process then reported Deck 1 path `05.【中文】林薇琪 - 爱已不是你想珍惜的事(DjAlex.x Dance Rmx 2014).mp3`, matching the first visible 周一 row, with `pause=true`. Deck 2 also remained paused; its 2号曲库/周一 category is currently empty.

final result: passed

## Dual-Deck automatic song transition

- Reported experience issue: sequence playback waited for EOF and then loaded the next song into the same Deck, leaving an audible break between playlist items.
- Desktop mpv behavior: sequence and shuffle modes now reserve the opposite idle Deck, preload the next track from the same locked source category at 15 seconds remaining with zero gain, start it at 6 seconds remaining, and run a six-second equal-power crossfade before pausing the outgoing Deck.
- Operator precedence: repeat-one is unchanged. Automatic handoff is suppressed while the opposite Deck is already playing or CUE is active, and manual Deck transport or Crossfader input cancels automation immediately. No tempo or pitch matching is applied.
- Queue safety: the prepared track is resolved from the playing Deck's locked library/category queue; browsing another category and Music Management's complete library cannot affect the handoff.
- Closed-loop correction: sequence mode treats each source category as a ring. Its last song resolves to the first song early enough for the same opposite-Deck preload and six-second crossfade. The EOF fallback excludes the opposite Deck only while that Deck is actually playing, so a paused first-song preload can no longer make a two-song list stop at its end.
- Automated evidence: the transition planner covers wait, normal next-song preload/crossfade, last-to-first preload/crossfade, repeat-one suppression and occupied-opposite-Deck suppression. The focused playlist/media suite passes 22/22 and the production WebView build passes.
- Live safety: verification did not start, seek or alter either Deck. A user-started Deck 1 track reached EOF during the hot-update window and did not hand off; afterward both mpv instances reported paused. Because that run began before the updated scheduler had a full 15-second preload window, a fresh desktop playback pass is still required before calling the audible transition validated.

final result: blocked

## Dual-Deck operator arbitration

- Operator rule: automatic handoff may occupy the opposite Deck only when that target Deck is not playing and has no active CUE. Manual playback or CUE keeps the two Decks independent; once the target stops and its CUE is off, it becomes eligible again at the source Deck's next end-of-track window without an extra release click. The Deck header shows “人工运行 · 空闲后自动” while it is under manual control.
- Independent-main behavior: manually sending Deck 2 to the main output does not stop or take ownership of Deck 1. Both Decks continue independently. When Deck 1 reaches EOF while Deck 2 remains occupied, Deck 1 advances within its own locked source-category queue on Deck 1, including last-to-first wrap.
- CUE behavior: a CUE-occupied opposite Deck is never overwritten. The main Deck uses same-Deck continuation because two visible playback engines cannot overlap a third track while the other engine is reserved for headphones.
- Mid-transition behavior: changing the automatic target during an active crossfade cancels the automation, returns the original source Deck to its full endpoint over approximately 400 ms, pauses the abandoned automatic target and only then applies the manual operation. An in-flight automatic mpv load is awaited before the manual load, preventing stale completion from overwriting the operator's track.
- Automated evidence: the pure arbitration test covers automatic availability, operator reservation, CUE occupancy and simultaneous independent main playback. Focused media/playlist tests pass 25/25 and the production build passes. Live playback is not started for this safety-sensitive validation.

final result: blocked

## Independent 1/2 library category suites

- Product rule: 1号曲库与2号曲库各自拥有完整且独立的星期、节日、自定义分类、排序、歌曲归属和每日播放计划；曲库切换只改变当前编辑目标，不复制数据、不装载 Deck、不触发播放。
- Migration rule: existing single-library persisted data migrates only to 1号曲库. 2号曲库 starts with the same category skeleton but empty song membership, so the original library is preserved without silently duplicating it.
- Desktop evidence: `artifacts/dual-library-one-suite.png` records 1号曲库 restoring its own 周三 selection; `artifacts/dual-library-two-suite.png` records 2号曲库 restoring its own 七夕 selection; `artifacts/dual-library-management-library2.png` records the Music Management target and every “加入” action changing to `2号曲库 / 七夕` while the real Home L region remains unchanged.
- Viewport and density: captures were taken from the running Tauri desktop window at 2560 x 1600 physical px, approximately 1707 x 1067 CSS px at Windows 150% scaling.
- Interaction evidence: the sequence 2号/七夕 → 1号/周三 → 2号/七夕 was exercised in the desktop app. The final Music Management capture shows the restored 2号/七夕 selection in both L and the right-side target badge. Both mpv IPC endpoints returned `pause=true` after every checked transition.
- Automated evidence: focused playlist tests pass 8/8, including independent mutation and legacy migration coverage. Production WebView asset compilation passes and targeted whitespace validation has no error.
- Findings: the prior shared-single-suite interpretation is removed. No actionable P0/P1/P2 issue remains for library isolation, per-library selection restoration, legacy-data ownership or non-autoplay switching.

final result: passed

## L-region track context management

- Requested behavior: Music Management keeps the real Home L region uncluttered. Song ordering and removal live in a right-click menu instead of adding more buttons to the selected row.
- Desktop evidence: `artifacts/track-context-menu-desktop.png` records the running Tauri app at 2560 x 1600 physical px. The first song in `1号曲库 / 周一` was right-clicked while already loaded in Deck 1; the custom menu opened without changing the Deck or the right-side section.
- Menu behavior: the menu provides 上移, 下移 and 从当前列表移除. Because the captured list has one song, both ordering directions are correctly disabled while removal remains enabled. The fixed table hint reads `歌曲 · 右键管理`.
- Data and safety behavior: ordering operates on the active playlist's persisted `trackPaths`; removal only removes that path from the current library/current category and never deletes the source file. Loaded or playing Deck state is not modified.
- Automated evidence: playlist tests cover reorder and removal behavior; production WebView compilation and targeted whitespace validation pass. Both mpv IPC endpoints remained paused during the interaction.
- Findings: no row-level control clutter was introduced, and no actionable P0/P1/P2 issue remains for the requested list ordering and removal entry point.
- Alignment correction: the initial menu was rendered inside the transform-capable L region, making a fixed-position menu inherit the wrong containing block. Both category and track menus now render through a `document.body` portal. `artifacts/track-context-menu-aligned.png` records the corrected desktop state; a right click at physical `(300, 470)` places the menu origin at the matching viewport location under Windows 150% scaling.
- Visible-order correction: `artifacts/playlist-visible-ordinal-desktop.png` records the user's three-song `爱` result in the running Tauri app. L now numbers the filtered/current-playlist rows `1, 2, 3` instead of exposing their complete-library indexes `127, 170, 730`; the right-side complete library intentionally retains its own independent `01, 02...` result order.
- On-air removal correction: removing the currently playing L-row now captures the successor from the pre-removal order and the visible library/category source before mutating playlist state. An idle opposite Deck is preloaded at zero gain and receives an immediate 2.5-second equal-power crossfade; the removed-song Deck is paused after the handoff. With no successor it fades to silence and stops. If the opposite Deck is already under operator playback, its loaded song is preserved and receives the fade instead. Source audio files are never deleted.
- On-air removal automated evidence: the queue test covers middle-item successor, last-item wrap and single-item no-successor behavior. Production compilation is required below; no live song is started solely for this check, so audible timing remains an operator validation item.

final result: passed

## Music Management all-playlists and category-management correction

- Source visual truth: `C:/Users/leadb/AppData/Local/Temp/codex-clipboard-c1af368c-3092-4622-9cf4-a52f3e190cc3.png` (2483 x 1459 px) plus the user's explicit information-architecture correction: L is the sole current-category selector; right-side tabs start with 全部歌单 and 分类管理; L right-click exposes up/down sorting.
- Desktop implementation evidence: `artifacts/music-management-all-desktop.png` (2560 x 1600 physical px), `artifacts/music-management-categories-desktop.png`, and `artifacts/music-management-l-context-menu.png`. The Tauri window ran at approximately 1707 x 1067 CSS px with device scale factor 1.5; no standalone browser preview was opened.
- Combined comparison: `artifacts/music-management-reference-comparison.png` (2400 x 820 px) places the supplied 2483 x 1459 source and the 2560 x 1600 desktop implementation into equal 1200 px-wide columns without cropping.
- Full-view result: L remains the existing Home playback-library business at its original 786 physical px width, including library switch, two category rows, search, track table and real 762-song data. The right side begins with 全部歌单 and 分类管理, followed by 每日播放, 歌曲编辑, 导入导出 and 歌手包; no right-side category selector duplicates L.
- Interaction evidence: 全部歌单 renders the real library and targets only the L-selected category; already-added songs are disabled and identified. 分类管理 separates weekly, event and custom groups, synchronizes selection back to L, exposes bounded same-group ordering, custom creation and custom deletion. L right-click and keyboard context-menu affordances open the persisted up/down menu; a continuous desktop interaction confirmed that opening it does not change the active right-side section. No ordering button was pressed, so existing user data was not mutated during QA.
- Safety evidence: both mpv child processes were queried through their IPC pipes after desktop interaction and returned `data: true` for the `pause` property. No Deck play or load control was exercised. Tauri close/exit now calls the shared player shutdown path before terminating the application.
- Automated evidence: production WebView asset compilation passes; Rust desktop compilation passes; 14 focused playlist/media tests pass, including same-kind category ordering; whitespace validation passes.
- Required fidelity surfaces: typography, graphite/cyan/green tokens, Phosphor icons, dense table rhythm, fixed bottom navigation and the real L dimensions remain consistent with the supplied desktop reference. No raster asset was introduced into the product UI. Copy explicitly states that category insertion does not load or play audio.
- Findings: no actionable P0/P1/P2 issue remains for the requested desktop information architecture, L-region preservation, category insertion target, category-management layout, right-click ordering or non-autoplay behavior.

final result: passed

## Music Management folder filtering and category CRUD

- All-library navigation: “全部歌单” now derives a folder index from each song's real path below `media/audio`, removes the internal `.king-imported` implementation segment, shows per-folder counts and applies folder selection before text search. `artifacts/music-management-folder-category.png` records the running Tauri desktop with the new “全部文件夹 · 762 首” control; the existing Home L region and its width remain unchanged.
- Library scope: “分类管理” now contains an explicit 1号曲库 / 2号曲库 management switch. It changes the same active library state used by L, so it exposes the second library's independent category suite instead of creating a duplicate editor-only copy.
- Category operations: the create form explicitly selects 节日活动 or 自定义分类. Both kinds support creation, stable-ID rename, deletion and bounded same-kind up/down sorting. Weekday names remain fixed because cold-start weekday routing and daily defaults depend on them.
- Data safety: rename preserves category ID, track membership, Deck source references and daily-plan references. Deletion never removes audio files; daily assignments pointing at a deleted category fall back to their matching weekday category.
- Automated evidence: focused media/playlist tests pass 24/24, including event/custom add, stable rename, same-kind reorder, deletion fallback and weekday immutability. Production WebView asset compilation passes. No category was created, renamed, reordered or deleted in the user's persisted desktop data during QA.

final result: passed

## Music Management C+R entrance motion

- Source visual truth: `artifacts/home-vs-music-real-l-comparison.png` (5118 x 1528 px) remains the same-state visual reference for the invariant Home L region and the Music Management C+R layout. The user's motion request adds behavior to that accepted composition; it does not change the static target.
- Implementation screenshot: `artifacts/music-management-motion-final.png` (1280 x 720 px) records the settled animation state in the running browser preview.
- Viewport and normalization: 1280 x 720 CSS px, browser DPR 1.5; the browser screenshot API produced a normalized 1280 x 720 PNG. The earlier L-region comparison remains a same-density, same-crop pair. Motion timing was inspected from live computed styles rather than inferred from static frames.
- State: demo media loaded, 周六 selected, 1号曲库 active, 歌单编排 visible. The management C+R region enters with `music-management-enter` for 280 ms from 24 px rightward offset and reduced opacity. Each functional workspace enters with `music-management-panel-enter` for 190 ms from a 12 px offset.
- Full-view comparison evidence: the final screenshot preserves the accepted graphite shell, top/bottom navigation, real Home L business and C+R management proportions. No new image asset, typography, color, spacing or copy drift was introduced.
- Focused motion evidence: the Home L region measured `{x:0,y:48,width:418,height:630}` before navigation, during the C+R animation and after completion. Only `.music-management-main` reported `animation-name: music-management-enter`; tab content reported `music-management-panel-enter`. L does not receive either animation.
- Required fidelity surfaces: fonts and copy are unchanged; spacing and grid tracks remain unchanged; graphite/cyan/green tokens remain unchanged; no raster or icon substitution was introduced; functional safety copy remains visible. `prefers-reduced-motion: reduce` explicitly disables both transforms and fades.
- Interaction and runtime evidence: Home to Music Management entrance, 歌单编排 to 每日播放 tab transition and return to 歌单编排 were exercised. Vite error overlay count: zero. Document dimensions equal the viewport. Production build passes; 13 focused playlist/media tests pass; `git diff --check` reports no whitespace error.
- Findings: no actionable P0/P1/P2 mismatch. The motion is intentionally short and limited to C+R so it adds orientation without making the fixed operational L region appear to reload.
- Comparison history: the first motion implementation passed the live geometry and interaction check; no corrective visual iteration was required.

final result: passed

## Music Management playlist workspace

- Source visual truth: `C:/Users/leadb/AppData/Local/Temp/codex-clipboard-d4f3c2be-a29d-469d-a5d5-3b3416d6f14e.png` establishes the existing KING shell, graphite palette and Music Management state; `C:/Users/leadb/AppData/Local/Temp/codex-clipboard-40fce850-05e4-4cf7-9a61-013b4a7dbda3.png` identifies the package controls that must leave Home. The requested information architecture intentionally differs from the singer-package source state.
- Implementation evidence: `artifacts/music-management-final-2554x1596.png` is the final full viewport; `artifacts/music-management-playlists-actual.png`, `artifacts/music-management-editor-actual.png` and `artifacts/music-management-packages-actual.png` cover the playlist, song-link and package states. `artifacts/music-management-reference-comparison.png` records the source-versus-implementation review.
- Viewport and geometry: final review ran at 2554 x 1596 CSS px, device pixel ratio approximately 1, with document width/height exactly matching the viewport and no page-level overflow. A separate 1440 x 900 regression kept all four tabs and the bottom navigation visible while the work regions scroll internally.
- Information architecture: the left operation region owns playlist selection/creation, song counts and seven-day default scheduling. The right region owns searchable library insertion, drag/button sorting, non-destructive removal and Deck preparation. Song editor, import/export and singer package are secondary tabs inside Music Management.
- Required fidelity surfaces: the global top and bottom shell remains fixed; typography was enlarged after the first pass; spacing preserves a dense broadcast-console rhythm; graphite, cyan and green tokens match the existing product; iconography reuses the installed Phosphor set; copy states that Deck loading does not autoplay and lighting mapping does not trigger the live rig.
- Interaction evidence: playlist selection, search/add, drag and button reordering, removal, daily assignment, song video/light binding, Deck 1/2 preparation, all four Music Management tabs and package action placement were inspected in the running browser. Home contains zero `.song-package-tools` elements. Browser console errors: zero.
- Comparison history: first pass exposed P2-small table/sidebar typography; font sizes and row hierarchy were increased, then recaptured. The revised state has no remaining P0/P1/P2 visual issue for the supplied brief.

final result: blocked

## Music Management real L-region preservation correction

- Source visual truth: the live Home screen captured as `artifacts/home-real-l-reference.png`, plus the user's correction screenshot `C:/Users/leadb/AppData/Local/Temp/codex-clipboard-0d717083-c447-480e-aac2-954402925960.png`. The user clarified that Home `UI-R02 / L` is real playback business and must remain unchanged rather than becoming a management sidebar.
- Implementation screenshot: `artifacts/music-management-real-l-final.png`. The focused same-state comparison is `artifacts/home-vs-music-real-l-comparison.png` and places Home beside Music Management.
- Viewport and normalization: both Home and Music Management were rendered at 2559 x 1599 CSS px with DPR approximately 1. The focused browser screenshots are 2559 x 1528 px because the in-app browser excludes its own 71 px chrome; both captures use the same crop and density.
- State: browser demo media, 周三 selected, 1号曲库 active, empty 周三 published playlist. Selecting 周三 in the preserved L region synchronizes the right editor title to 周三.
- Full-view evidence: the Home and Music Management captures use the same real `homeLibraryPanel` React element. The L region keeps the same x=0 origin, y=56 origin, 810.51 px width and 1489.33 px height; the management header and tabs begin at x=810.51 and occupy only C+R.
- Focused comparison evidence: `artifacts/home-vs-music-real-l-comparison.png` confirms the L header, Deck target switch, two playlist rows, search, table header, empty/list region, typography, borders and selected states are visually identical. No separate management copy of L remains.
- Findings history: the previous implementation introduced a P1 fixed 310 px vertical management sidebar and pushed L below a full-width header. The first correction matched the frame but still duplicated L business. The final correction reuses the same live Home component, preserves the measured Home C1-derived grid width across navigation, and synchronizes L playlist selection to the right editor.
- Required fidelity surfaces: typography, spacing, graphite/cyan/green tokens, Phosphor icons and app-specific copy are inherited directly from Home. There are no new raster assets in L. The right-side controls retain explicit non-autoplay and non-triggering safety copy.
- Interaction and console evidence: real 1/2 号曲库 switching, published playlist selection, search, track selection/Deck preparation handlers and playlist-to-editor synchronization remain connected. Vite error overlay count: zero. Production build and 13 focused runtime/playlist tests pass.

final result: passed

## Lighting management A/B floor-plan panel

- Source visual truth: `C:/Users/leadb/Downloads/资源+2.svg` (`viewBox 0 0 762.75 930.05`) for the building outline, plus `C:/Users/leadb/AppData/Local/Temp/codex-clipboard-ca656997-14b9-47be-b279-816a47f76e48.png` (1667 × 1175 px) for approximate fixture distribution and inventory labels. The dimensioned P-01 image was used as supporting spatial reference.
- Implementation screenshot: `artifacts/lighting-panel-ab-v2.png` (1920 × 1080 px).
- Combined comparison evidence: `artifacts/lighting-panel-reference-comparison.png`.
- Browser viewport / CSS viewport: 1920 × 1080 px; device density 1; no density normalization was needed for the implementation capture. The source and implementation were fitted into equal comparison columns without cropping.
- State: bottom navigation `Avolites Tiger Touch Pro`; Titan offline configuration mode; A-area first reference fixture selected; B-area mapping and adjustment controls visible.
- Full-view comparison: the supplied vertical floor geometry remains the dominant A-area surface, while the B area groups quick slots, static SWOP mirror, safe semantic adjustment controls and the complete effect registry. Both regions remain visible together without horizontal overflow.
- Focused evidence: a `VIP 东侧` reference point was clicked; the selection card changed to `260W 光束摇头灯 · 设计数量 54 · 当前为参考位置`. A separate crop was unnecessary because the 844 px-wide plan and 1076 px-wide control region are both readable in the full 1920 px capture.

### Comparison history

- Earlier P2: the first A/B split exposed the plan and existing registry, but offline mode left the lower B area visually empty and did not present a persistent adjustment surface.
- Fix: added a dedicated B-area `现场效果调节` rack for floor target, color family, energy, motion, beat sync, continuous mode and automatic eligibility. Controls stay disabled without a selected Titan Playback and never Fire a cue.
- Post-fix evidence: `artifacts/lighting-panel-ab-v2.png` shows the control rack between the quick mapping and complete registry, with the A-area selection reflected in B.

### Required fidelity surfaces

- Fonts and typography: the existing compact KING console type scale and bilingual Titan terminology are preserved; A/B labels establish clear hierarchy without enlarging the global header.
- Spacing and layout rhythm: the viewport is divided into stable left/right regions; A retains a tall plan aspect and B keeps dense console controls in aligned rows. No persistent control is cropped.
- Colors and visual tokens: the established graphite/cyan console palette remains intact. Fixture families use restrained blue, cyan, green, lilac, amber and laser-purple icon colors corresponding to the P-11 legend.
- Image quality and asset fidelity: the user's SVG is copied as a real vector asset and rendered without raster stretching. Fixture marks use the existing Phosphor icon library; no replacement floor plan or invented inline SVG is used.
- Copy and content: P-11 fixture names and quantities are shown as design-reference inventory. The interface explicitly states that locations are approximate and Titan Fixture Patch is the only authoritative address source.
- Interaction and safety: navigation, 65 floor points and the A-to-B selection readout were exercised. Configuration controls do not trigger Titan Playback. Browser console errors: zero.
- Remaining P3: exact coordinates, fixture handles and grouping must be refined after a successful live Titan Patch read; this does not block the current layout or reference-map workflow.

final result: passed

## Deck embedded-cover replacement pass

- Source visual truth: `C:/Users/leadb/AppData/Local/Temp/codex-clipboard-58b745c6-ee92-4c3f-ae57-acba6e7d426a.png` (645 x 80 px), showing the existing Deck title row and the exact music-note slot to replace.
- Implementation evidence: `artifacts/deck-cover-full-actual.png` is the full running mixer region; `artifacts/deck-cover-actual.png` is the focused Deck 1 title row. The desktop viewport is 1707 x 1067 CSS px at device pixel ratio 1.5. The focused clip is 319.15 x 54 CSS px and 479 x 81 saved pixels.
- Tested state: the real decoded `Eric周兴哲 - 怎么了.flac` is loaded in Deck 1. Its embedded 480 x 480 JPEG resolves through the Tauri asset protocol and renders in `.cover.cover-one.has-artwork`; the source icon remains the fallback for Deck 2, which has no cover.
- Full-view comparison: the full mixer capture confirms that adding the image does not change Deck widths, header/action alignment, waveform position, transport rows, crossfader or lower controls.
- Focused comparison: the source and implementation title-row crops were opened in one comparison input. At device scale 1.5 the 38 x 38 CSS cover becomes 57 x 57 pixels, matching the source's approximately 56 px slot. The original radius, gap, title baseline and artist/BPM baseline remain aligned.
- Required fidelity surfaces: typography and copy are unchanged; spacing/layout retains the established Deck rhythm; side-specific green/blue tokens remain on the fallback icon; the real square cover uses `object-fit: cover`, keeps its native aspect ratio and has no stretching or placeholder treatment.
- Regression evidence: the Rust embedded-cover extraction test, the Deck data-chain/fallback test and the production Web build pass. No P0/P1/P2 mismatch remains in the requested Deck cover slot. The pre-existing Deck 2 mojibake visible in both the supplied state and running full view is unrelated to this change.
- Comparison history: the first rendered comparison passed; no visual correction loop was required.

final result: passed

## LED physical-size and complete-B-region correction

- Source visual truth: the user's onsite sketch `C:/Users/leadb/Downloads/default (1).jpg`, onsite wall photograph `C:/Users/leadb/Downloads/default.jpg`, and the explicit confirmed physical size `5120 mm(W) × 5760 mm(H)`.
- Geometry: the P2.5 modules are landscape 320 × 160 mm / 128 × 64 px units. A is 8 columns × 18 rows (`2560 × 2880 mm`, `1024 × 1152 px`); B is 16 columns × 18 rows (`5120 × 2880 mm`, `2048 × 1152 px`). Together they form the 8:9 outer canvas `2048 × 2304 px`.
- Corrected regression: the 4:9 logical-canvas interpretation was removed, but the first correction still sent only a centred 960 × 1080 aperture. Because the DVP processor maps the complete 1920 × 1080 HDMI raster to the wall, that lit only 2560 mm of the 5120 mm B width and left 1280 mm black at each side. The final transport keeps the 2048 × 2304 authoring canvas and pre-stretches only the finished output 2× horizontally across the complete HDMI raster.
- Runtime evidence: `artifacts/led-physical-geometry-output.png` captures the active 1920 × 1080 LED HDMI frame. The output screen and transformed transport canvas both cover x=0..1920; the inner 8:9 canvas is 960 × 1080 before a `matrix(2,0,0,1,0,0)` transform. Both B edges reach the HDMI edges. The 2048 × 2304 resolution test is currently sent to the physical second screen for onsite confirmation.
- Automated evidence: the production web build passes; second-display routing asserts the output aperture is 8:9; C1/output normalized text parity passes after a clean WebView reload.

final result: passed

## Library weekday startup and two-library divider correction

- Source visual truth: `C:/Users/leadb/AppData/Local/Temp/codex-clipboard-cc2079de-dfe5-4626-979d-1b01796de56c.png` (788 x 188 px), showing the two library targets above the weekday and event-category rows.
- Desktop implementation evidence: `artifacts/library-weekday-cold-start-full.png` (2560 x 1600 physical px) records a cold Tauri launch; `artifacts/library-weekday-divider-actual.png` is the focused 788 x 188 px implementation crop; `artifacts/library-weekday-divider-comparison.png` places the source and implementation side by side at identical pixel dimensions.
- Viewport and density: the desktop window is 2560 x 1600 physical px, approximately 1707 x 1067 CSS px at device scale factor 1.5. The focused source and implementation are both 788 x 188 px, so no density normalization or resampling was required for the detailed comparison.
- State: the cold launch occurred on Monday, 2026-08-31, and selected 周一 automatically. The focused implementation was then switched manually to 七夕 to match the supplied source state; after capture it was restored to 周一.
- Full-view regression evidence: the cold-start desktop capture preserves the complete L/C/R/B shell, fixed L width, real 762-song library, Deck layout and bottom navigation. No surrounding component moved when the divider was restored.
- Focused comparison evidence: both images preserve the same two equal library columns, seven equal weekday columns, seven equal event columns, compact typography and graphite selection surfaces. The implementation adds the requested neutral one-pixel divider continuously beneath both library columns, while the active library overlays its existing two-pixel cyan channel line.
- Comparison history: the previous implementation initialized the current category with a hard-coded 周六 value and relied on the active library underline, leaving the inactive library side visually without a bottom separator. Startup now resolves the local `Date.getDay()` through a tested Monday-first mapping; manual category buttons continue to update state without any timer resetting the selection. A positioned neutral divider is painted above both library buttons and the active button paints its channel line above that divider.
- Required fidelity surfaces: the existing Inter/Noto Sans SC typography, row heights, column spacing, graphite tokens, cyan active state and all app-specific labels are unchanged. No image or icon asset was added to the product UI. The new line uses the existing neutral structure-line family and does not introduce another semantic color.
- Interaction and safety evidence: manual selection of 七夕 succeeded, then 周一 was restored. Both mpv Deck IPC endpoints returned `pause=true` after the interaction; no load or playback control was exercised. The focused playlist tests pass 6/6, production WebView asset compilation passes and whitespace validation has no error.
- Findings: the earlier startup-selection and missing-divider issues are resolved. No actionable P0/P1/P2 issue remains for the requested weekday initialization, manual category selection or two-library separator.

final result: passed
