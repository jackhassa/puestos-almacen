const CODE39: Record<string, string> = {
  "0": "nnnwwnwnn",
  "1": "wnnwnnnnw",
  "2": "nnwwnnnnw",
  "3": "wnwwnnnnn",
  "4": "nnnwwnnnw",
  "5": "wnnwwnnnn",
  "6": "nnwwwnnnn",
  "7": "nnnwnnwnw",
  "8": "wnnwnnwnn",
  "9": "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  "$": "nwnwnwnnn",
  "/": "nwnwnnnwn",
  "+": "nwnnnwnwn",
  "%": "nnnwnwnwn",
  "*": "nwnnwnwnn",
};

function normalize(value: string) {
  return value
    .toUpperCase()
    .split("")
    .filter((character) => character !== "*" && CODE39[character])
    .join("");
}

export function Code39Barcode({
  value,
  height = 54,
}: {
  value: string;
  height?: number;
}) {
  const normalized = normalize(value);
  const encoded = `*${normalized}*`;
  const narrow = 2;
  const wide = 5;
  const gap = 2;

  let x = 10;
  const bars: { x: number; width: number }[] = [];

  for (const character of encoded) {
    const pattern = CODE39[character];
    if (!pattern) continue;

    for (let index = 0; index < pattern.length; index += 1) {
      const width = pattern[index] === "w" ? wide : narrow;
      if (index % 2 === 0) bars.push({ x, width });
      x += width;
    }

    x += gap;
  }

  const width = x + 8;

  return (
    <div className="inline-flex max-w-full flex-col items-center gap-1">
      <svg
        aria-label={`Código de barras ${normalized}`}
        className="max-w-full bg-white"
        height={height}
        role="img"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
      >
        {bars.map((bar, index) => (
          <rect
            key={`${bar.x}-${index}`}
            fill="currentColor"
            height={height}
            width={bar.width}
            x={bar.x}
            y={0}
          />
        ))}
      </svg>
      <span className="font-mono text-xs font-semibold tracking-wider text-slate-700">
        {normalized}
      </span>
    </div>
  );
}
