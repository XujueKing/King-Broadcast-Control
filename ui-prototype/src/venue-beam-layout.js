const fixturePoint = ({ id, number, x, y, zone, type, titanId = null, status = "unverified", observation = "待现场确认" }) => Object.freeze({
  id,
  label:id,
  number,
  x,
  y,
  zone,
  type,
  titanId,
  status,
  observation,
});

const beamPoint = (number, x, y, zone, state = {}) => fixturePoint({
  id:`A${number}`,
  number,
  x,
  y,
  zone,
  type:"beam",
  ...state,
});

const movingWashPoint = (number, x, y, zone) => fixturePoint({
  id:`B${number}`,
  number,
  x,
  y,
  zone,
  type:"moving-wash",
});

const ledBarPoint = (number, x, y, zone) => fixturePoint({
  id:`C${number}`,
  number,
  x,
  y,
  zone,
  type:"led-bar",
});

// Physical positions measured from the onsite A/B/C reference plan supplied
// on 2026-09-03. Venue-facing labels must not be treated as Titan user
// numbers until a fixture-by-fixture locate pass binds each point to a
// verified TitanId.
export const venueBeamPoints = Object.freeze([
  beamPoint(1,24.47,24.66,"北区第一排",{titanId:3703,status:"weak-output",observation:"Locate 实测 · 可摇头 · 非白弱光 · 单灯组 10"}),
  beamPoint(2,35.84,24.66,"北区第一排",{titanId:3706,status:"output-fault",observation:"现场确认 · 灯源亮但朝上 · Pan/Tilt 无响应 · 单灯组 11"}),
  beamPoint(3,57.89,24.66,"北区第一排",{titanId:3512,status:"verified",observation:"Locate 实测 · 单灯组 12"}),
  beamPoint(4,68.81,24.66,"北区第一排",{titanId:3513,status:"output-fault",observation:"Pan/Tilt 正常 · 完全无光"}),
  beamPoint(5,24.45,35.54,"北区第二排",{titanId:3704,status:"verified",observation:"Locate 实测 · 单灯组 18"}),
  beamPoint(6,35.81,35.54,"北区第二排",{titanId:3705,status:"verified",observation:"Locate 实测 · 单灯组 19"}),
  beamPoint(7,57.90,35.54,"北区第二排",{titanId:3511,status:"verified",observation:"Locate 实测 · 单灯组 20"}),
  beamPoint(8,68.80,35.54,"北区第二排",{titanId:3514,status:"verified",observation:"Locate 实测 · 单灯组 21"}),
  beamPoint(9,83.10,35.55,"北区第二排",{titanId:15676,status:"verified",observation:"Locate 实测 · 直接选灯 43"}),
  beamPoint(10,47.20,48.45,"中区第一排",{titanId:3521,status:"verified",observation:"Locate 实测 · 单灯组 29"}),
  beamPoint(11,57.90,48.45,"中区第一排",{titanId:3519,status:"verified",observation:"Locate 实测 · 单灯组 28"}),
  beamPoint(12,68.82,48.45,"中区第一排",{titanId:3518,status:"verified",observation:"Locate 实测 · 单灯组 27"}),
  beamPoint(13,83.11,48.59,"中区第一排",{titanId:3515,status:"output-fault",observation:"DMX 085 · CH21 · 蓝灯同正常 A9 · 待机光无花 · Pan/Tilt 无响应 · 单灯组 26"}),
  beamPoint(14,47.21,58.07,"中区第二排",{titanId:3522,status:"verified",observation:"Locate 实测 · 单灯组 37"}),
  beamPoint(15,57.89,58.07,"中区第二排",{titanId:3520,status:"verified",observation:"Locate 实测 · 单灯组 36"}),
  beamPoint(16,68.81,58.07,"中区第二排",{titanId:3517,status:"verified",observation:"Locate 实测 · 单灯组 35"}),
  beamPoint(17,83.12,58.07,"中区第二排",{titanId:3516,status:"verified",observation:"Locate 实测 · 单灯组 34"}),
  beamPoint(18,24.44,76.68,"南区第一排",{titanId:3526,status:"verified",observation:"Locate 实测 · 单灯组 45"}),
  beamPoint(19,35.85,76.68,"南区第一排",{titanId:3525,status:"verified",observation:"Locate 实测 · 单灯组 44"}),
  beamPoint(20,47.20,76.68,"南区第一排",{titanId:3524,status:"verified",observation:"Locate 实测 · 单灯组 43"}),
  beamPoint(21,57.90,76.68,"南区第一排",{titanId:3523,status:"verified",observation:"Locate 实测 · 单灯组 42"}),
  beamPoint(22,24.47,86.67,"南区第二排",{titanId:3527,status:"verified",observation:"Locate 实测 · 单灯组 46"}),
  beamPoint(23,35.86,86.68,"南区第二排",{titanId:3528,status:"verified",observation:"Locate 实测 · 单灯组 47"}),
  beamPoint(24,47.21,86.67,"南区第二排",{titanId:3529,status:"verified",observation:"Locate 实测 · 单灯组 48"}),
  beamPoint(25,57.89,86.68,"南区第二排",{titanId:3530,status:"verified",observation:"Locate 实测 · 单灯组 49"}),
]);

export const venueMovingWashPoints = Object.freeze([
  movingWashPoint(1,24.49,20.62,"北区"),
  movingWashPoint(2,35.86,20.62,"北区"),
  movingWashPoint(3,57.91,20.62,"北区"),
  movingWashPoint(4,68.84,20.62,"北区"),
  movingWashPoint(5,47.27,44.29,"中区"),
  movingWashPoint(6,57.93,44.29,"中区"),
  movingWashPoint(7,68.85,44.30,"中区"),
  movingWashPoint(8,83.31,44.30,"中区"),
  movingWashPoint(9,24.80,71.62,"南区"),
  movingWashPoint(10,35.46,71.60,"南区"),
  movingWashPoint(11,47.12,71.60,"南区"),
  movingWashPoint(12,57.85,71.60,"南区"),
]);

export const venueLedBarPoints = Object.freeze([
  ledBarPoint(1,24.45,29.90,"北区"),
  ledBarPoint(2,36.10,29.90,"北区"),
  ledBarPoint(3,57.96,29.90,"北区"),
  ledBarPoint(4,68.82,29.90,"北区"),
  ledBarPoint(5,47.31,53.15,"中区"),
  ledBarPoint(6,57.99,53.15,"中区"),
  ledBarPoint(7,68.83,53.15,"中区"),
  ledBarPoint(8,83.20,53.15,"中区"),
  ledBarPoint(9,24.42,81.67,"南区"),
  ledBarPoint(10,35.83,81.67,"南区"),
  ledBarPoint(11,47.38,81.67,"南区"),
  ledBarPoint(12,57.80,81.67,"南区"),
]);

export const venueFixturePoints = Object.freeze([
  ...venueBeamPoints,
  ...venueMovingWashPoints,
  ...venueLedBarPoints,
]);
