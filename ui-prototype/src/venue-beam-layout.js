const beamPoint = (number, x, y, zone) => Object.freeze({
  id:`A${number}`,
  label:`A${number}`,
  number,
  x,
  y,
  zone,
  type:"beam",
  titanId:null,
  status:"unverified",
});

// Physical positions measured from the onsite A1-A25 reference plan supplied
// on 2026-09-03. A labels are venue-facing identifiers; they must not be
// treated as Titan user numbers until a fixture-by-fixture locate pass binds
// each point to a verified TitanId.
export const venueBeamPoints = Object.freeze([
  beamPoint(1,24.20,21.48,"北区第一排"),
  beamPoint(2,35.74,21.48,"北区第一排"),
  beamPoint(3,58.17,21.48,"北区第一排"),
  beamPoint(4,69.28,21.48,"北区第一排"),
  beamPoint(5,24.20,34.35,"北区第二排"),
  beamPoint(6,35.74,34.35,"北区第二排"),
  beamPoint(7,58.17,34.35,"北区第二排"),
  beamPoint(8,69.28,34.35,"北区第二排"),
  beamPoint(9,83.80,34.35,"北区第二排"),
  beamPoint(10,47.30,45.60,"中区第一排"),
  beamPoint(11,58.17,45.60,"中区第一排"),
  beamPoint(12,69.28,45.60,"中区第一排"),
  beamPoint(13,83.80,45.60,"中区第一排"),
  beamPoint(14,47.30,55.52,"中区第二排"),
  beamPoint(15,58.17,55.52,"中区第二排"),
  beamPoint(16,69.28,55.52,"中区第二排"),
  beamPoint(17,83.80,55.52,"中区第二排"),
  beamPoint(18,24.20,75.08,"南区第一排"),
  beamPoint(19,35.74,75.08,"南区第一排"),
  beamPoint(20,47.30,75.08,"南区第一排"),
  beamPoint(21,58.17,75.08,"南区第一排"),
  beamPoint(22,24.20,84.98,"南区第二排"),
  beamPoint(23,35.74,84.98,"南区第二排"),
  beamPoint(24,47.30,84.98,"南区第二排"),
  beamPoint(25,58.17,84.98,"南区第二排"),
]);
